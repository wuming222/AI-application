"""AgentExplorer 目录 / 正文 / references 的只读访问与进程内缓存。

三条与 `app/mcp/` 不同的取值，都写在 docs/origin/26-9-19.md 第 8 节：
- 目录 TTL 6 小时（K7）。MCP 那份是 600s，因为工具清单会随 server 上线变化；目录几乎不变，
  而全量目录要按 18 个类目逐个翻页，重拉的代价高得多。
- **正文与 references 不缓存**。仓库更新后模型照旧版操作手册产出是真会失效的（云 API 参数命名）。
- 目录条数的守卫是**两条独立断言**，不是"总数等于 297"：实测同一天重跑只得 269 条，因为
  `playbooks` 类目返回了 HTTP 400。写死绝对值会让上游抖一次就把目录永久关死。
"""

import asyncio
import time
from typing import Any, Optional

import httpx

from app.skills import sources

# 目录 TTL：6 小时（K7）
CATALOG_TTL_SECONDS = 6 * 3600.0
# 正文截断上界（K4：32,000 字符砍 8% 的份数、p50 完整保留；沿用 MCP 那个 8,000 会砍掉 93%）
MAX_CONTENT_CHARS = 32000
# references 单文件上界（K6：16,000 字符砍 6%）
MAX_FILE_CHARS = 16000
# 全量守卫：新结果不足上次成功结果的 90% 就判为没取全（是比例，不是绝对值）
MIN_COUNT_RATIO = 0.9
# 单类目最多翻多少页。上游 nextToken 正常个位数页，撞到这里就是它不停发。
MAX_PAGES_PER_CATEGORY = 40

_categories_cache: tuple[float, list[str]] | None = None
_category_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_last_good: tuple[float, list[dict[str, Any]]] | None = None


class SkillUpstreamError(Exception):
    """上游不可用或返回不合形状。调用方一律转成 200 + body 里的错误，不往上抛。"""


async def _get_json(client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> dict[str, Any]:
    try:
        resp = await client.get(f"{sources.AGENT_EXPLORER_BASE}{path}", params=params)
    except Exception as err:  # noqa: BLE001 - httpx 的超时/连接异常种类多，统一收成一个可恢复错误
        raise SkillUpstreamError(f"{type(err).__name__}: {err}") from err
    if resp.status_code != 200:
        raise SkillUpstreamError(f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except Exception as err:  # noqa: BLE001 - 代理/网关回 HTML 时会走到这里
        raise SkillUpstreamError(f"响应不是 JSON: {type(err).__name__}") from err
    if not isinstance(data, dict):
        raise SkillUpstreamError("响应不是对象")
    return data


def _normalize(row: dict[str, Any]) -> dict[str, Any]:
    """只留前端要的字段。description 里含触发词，是常驻索引的全部内容，不要截它。"""
    return {
        "name": row.get("skillName"),
        "displayName": row.get("displayName") or row.get("nameEn") or row.get("skillName"),
        "description": row.get("description") or "",
        "categoryCode": row.get("categoryCode"),
        "subCategoryCode": row.get("subCategoryCode"),
        "githubPath": row.get("githubPath") or "",
        "updatedAt": row.get("updatedAt"),
        "likeCount": row.get("likeCount"),
    }


async def _category_codes(client: httpx.AsyncClient) -> list[str]:
    global _categories_cache
    if _categories_cache and (time.monotonic() - _categories_cache[0]) < CATALOG_TTL_SECONDS:
        return _categories_cache[1]
    data = await _get_json(client, "/openapi/for-agent/categories", {})
    codes = [c["code"] for c in data.get("data") or [] if isinstance(c, dict) and c.get("code")]
    if not codes:
        raise SkillUpstreamError("类目清单为空")
    _categories_cache = (time.monotonic(), codes)
    return codes


async def _fetch_category(client: httpx.AsyncClient, code: str) -> list[dict[str, Any]]:
    """一个类目翻页取全。任何一页失败就整体作废 —— 半份类目比整份缺失更坏：它看起来是成功的。"""
    out: list[dict[str, Any]] = []
    token: Optional[str] = None
    for _ in range(MAX_PAGES_PER_CATEGORY):
        params: dict[str, Any] = {"categoryCode": code, "maxResults": 100}
        if token:
            params["nextToken"] = token
        page = await _get_json(client, "/openapi/for-agent/skills", params)
        rows = page.get("data") or []
        if not isinstance(rows, list):
            raise SkillUpstreamError(f"{code} 的 data 不是数组")
        out.extend(_normalize(r) for r in rows if isinstance(r, dict) and r.get("skillName"))
        token = page.get("nextToken")
        if not token:
            return out
    raise SkillUpstreamError(f"{code} 翻页超过 {MAX_PAGES_PER_CATEGORY} 页仍未结束")


async def _category_skills(client: httpx.AsyncClient, code: str) -> tuple[list[dict[str, Any]], Optional[str]]:
    """带缓存的单类目：失败不抛，回旧缓存（可能为空）+ 错误消息。"""
    cached = _category_cache.get(code)
    if cached and (time.monotonic() - cached[0]) < CATALOG_TTL_SECONDS:
        return cached[1], None
    try:
        skills = await _fetch_category(client, code)
    except SkillUpstreamError as err:
        return (cached[1] if cached else []), f"{code}: {err}"
    _category_cache[code] = (time.monotonic(), skills)
    return skills, None


async def get_catalog(refresh: bool = False) -> dict[str, Any]:
    """全量目录。并发送每个类目（串行时最坏是各类目超时之和，会把前端那次 35s 撑爆）。"""
    global _last_good
    errors: list[dict[str, str]] = []
    if refresh:
        _category_cache.clear()
    try:
        async with sources.make_client() as client:
            codes = await _category_codes(client)
            # gather 按入参顺序返回，所以目录顺序仍跟类目清单一致
            results = await asyncio.gather(*(_category_skills(client, c) for c in codes))
    except SkillUpstreamError as err:
        # 连类目都拿不到：有旧目录就用旧的，一条错误跟着回去
        errors.append({"source": "agent-skills", "message": str(err)[:300]})
        cached = _last_good[1] if _last_good else []
        return {"skills": cached, "errors": errors}

    merged: dict[str, dict[str, Any]] = {}
    for listed, err in results:
        for s in listed:
            merged[str(s["name"])] = s
        if err:
            errors.append({"source": "agent-skills", "message": err[:300]})
    skills = list(merged.values())

    # 守卫二：跌幅。逐类目那条只挡得住"某类目报错"，挡不住"某类目静默返回 0 条"。
    if _last_good and skills and len(skills) < len(_last_good[1]) * MIN_COUNT_RATIO:
        errors.append(
            {
                "source": "agent-skills",
                "message": f"目录条数 {len(skills)} 不足上次成功结果 {len(_last_good[1])} 的 90%，判为未取全，回退旧目录",
            }
        )
        return {"skills": _last_good[1], "errors": errors}
    if skills:
        _last_good = (time.monotonic(), skills)
    return {"skills": skills, "errors": errors}


async def search(keyword: str, max_results: int) -> dict[str, Any]:
    """上游语义检索透传（模型用 skill_search 时走这里，也是面板的搜索框）。"""
    try:
        async with sources.make_client() as client:
            data = await _get_json(
                client,
                "/openapi/for-agent/skills",
                {"keyword": keyword, "searchMode": "semantic", "maxResults": max_results},
            )
    except SkillUpstreamError as err:
        return {"skills": [], "errors": [{"source": "agent-skills", "message": str(err)[:300]}]}
    rows = data.get("data") or []
    return {
        "skills": [_normalize(r) for r in rows if isinstance(r, dict) and r.get("skillName")],
        "errors": [],
    }


async def find_skill(name: str) -> dict[str, Any] | None:
    """按名取目录项（拿 githubPath 用）。目录没命中返回 None，不猜路径。"""
    catalog = await get_catalog()
    for s in catalog["skills"]:
        if s["name"] == name:
            return s
    return None


def _clip(text: str, limit: int, what: str) -> tuple[str, bool, int]:
    original = len(text)
    if original <= limit:
        return text, False, original
    # 不说"可用 skill_file 补齐"：skill_file 只能取该技能的 references/，补不回这份正文的后半段
    tail = (
        f"\n（{what}已截断，原文 {original} 字符。被截掉的部分无法通过 skill_file 取回，"
        f"它只能读该技能的 references/ 文件。）"
    )
    return text[:limit] + tail, True, original


async def get_content(name: str) -> dict[str, Any]:
    """一份 SKILL.md 全文。正文不缓存（K7）：照旧版手册产出是真会失效的。"""
    try:
        async with sources.make_client() as client:
            data = await _get_json(client, f"/openapi/for-agent/skills/{name}", {})
    except SkillUpstreamError as err:
        return {"text": f"技能正文获取失败：{err}", "is_error": True}
    # 实测详情端点的正文在**顶层** content（旧探测脚本有一份按 data.content 读，是错的）
    content = data.get("content")
    if not isinstance(content, str) and isinstance(data.get("data"), dict):
        content = data["data"].get("content")
    if not isinstance(content, str) or not content:
        return {"text": f"技能正文获取失败：{name} 无正文", "is_error": True}
    text, truncated, original = _clip(content, MAX_CONTENT_CHARS, "技能正文")
    return {"text": text, "truncated": truncated, "original_chars": original, "is_error": False}


async def get_reference(name: str, path: str) -> dict[str, Any]:
    """取该技能包内的一个 references/*.md。

    顺序是刻意的：**先**做零 I/O 的语法校验，畸形 path 在这里就回绝 —— 目录查询本身要发外部请求，
    不该为一次注入尝试去发它。通过之后才查目录取 githubPath，拼装时再核一次 host。
    """
    if not sources.validate_reference_path(path):
        return {
            "text": f"引用文件路径不合规则：只允许该技能 references/ 下的 .md 文件（收到 {path[:80]!r}）",
            "is_error": True,
        }
    entry = await find_skill(name)
    if not entry:
        return {"text": f"引用文件未找到：目录里没有技能 {name}", "is_error": True}
    url = sources.reference_url(entry.get("githubPath") or "", path)
    if url is None:
        return {
            "text": f"引用文件路径不合规则：该技能的目录形状无法安全解析（{path[:80]!r}）",
            "is_error": True,
        }
    try:
        async with sources.make_client() as client:
            resp = await client.get(url)
    except Exception as err:  # noqa: BLE001
        return {"text": f"引用文件读取失败：{type(err).__name__}: {err}", "is_error": True}
    if resp.status_code != 200:
        # 实测正文里 2,074 条 references 引用有 15% 在包里对不上文件，这是必然发生的边角
        return {"text": f"引用文件未找到：HTTP {resp.status_code}（{path}）", "is_error": True}
    text, truncated, original = _clip(resp.text, MAX_FILE_CHARS, "引用文件")
    return {"text": text, "truncated": truncated, "original_chars": original, "is_error": False}
