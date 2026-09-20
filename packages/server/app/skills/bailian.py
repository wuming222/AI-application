"""百炼技能接口的只读访问：列目录 / 取整包 / 解包。

三条实测事实决定了这里的形状（见 docs/origin/26-9-19.md 的百炼一节）：

1. **详情端点不给正文。** `GET /skills/{id}` 只回元数据，正文在 zip 包里，所以取一份 SKILL.md
   要"问版本 → 拿预签名 URL → 下 zip → 解包"四步。好处是 `references/` 与正文天然同包 ——
   旧那条匿名通道靠拼 GitHub 路径取附属文件，15% 的引用对不上文件，这个失败模式在这里不存在。
2. **预签名 URL 两小时过期，且鉴权在 URL 里。** 所以它不入库、不缓存，拿到就用；取它时不带 Bearer。
3. **版本号不可变。** 因此解出来的包可以按 `(skill_id, version)` 放心缓存 —— 与旧通道"正文不缓存"
   的理由（仓库更新后旧手册会误导模型）并不冲突：这里"更新"必然是新版本号，缓存键跟着变。

只做读：不创建、不删除、不改状态。挂载到百炼智能体、由它执行，都不是这条通道的用途（本应用不执行命令）。
"""

import io
import re
import time
import zipfile
from collections import OrderedDict
from typing import Any

import httpx

from app.skills import sources

# 上游给的 skillId / latest_version 要拼进**下一个请求的 URL 路径段**，所以它们不能含 `/ ? # \`、
# 也不能是 `..`。这个模块对 `file_url`（同样是上游给的）已经核过 scheme 与 host，这里补齐另一半。
# 不用 `^…$` 而用 fullmatch：`$` 会放过结尾那一个换行，而这串字符要拼进 URL。
_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_VERSION_RE = re.compile(r"[A-Za-z0-9._-]{1,80}")

# 列表 TTL 10 分钟：技能是用户自己随时会上传/换新版的，6 小时太久；单页请求也便宜。
CATALOG_TTL_SECONDS = 600.0
PAGE_LIMIT = 100
MAX_PAGES = 20
# zip 包与单文件的大小闸：防解包炸内存，也挡得住有人把整个仓库塞进技能包
MAX_ZIP_BYTES = 8 * 1024 * 1024
MAX_MEMBER_BYTES = 2 * 1024 * 1024
MAX_PACKAGE_FILES = 200
# 解包结果只留最近几个技能（每个技能一份包，正文 + references 全在里面）
PACKAGE_CACHE_SIZE = 8

_listing: tuple[float, list[dict[str, Any]], list[str]] | None = None
_packages: "OrderedDict[str, dict[str, bytes]]" = OrderedDict()


class BailianError(Exception):
    """上游不可用、未配置或返回不合形状。调用方一律转成 200 + body 里的错误。"""


async def _get_json(client: httpx.AsyncClient, url: str, params: dict[str, Any] | None) -> dict[str, Any]:
    try:
        resp = await client.get(url, params=params, headers=sources.auth_headers())
    except Exception as err:  # noqa: BLE001 - httpx 的超时/连接异常种类多，统一收成一个可恢复错误
        raise BailianError(f"{type(err).__name__}: {err}") from err
    if resp.status_code != 200:
        raise BailianError(f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except Exception as err:  # noqa: BLE001 - 网关回 HTML 时会走到这里
        raise BailianError(f"响应不是 JSON: {type(err).__name__}") from err
    if not isinstance(data, dict):
        raise BailianError("响应不是对象")
    return data


def _normalize(row: dict[str, Any]) -> dict[str, Any] | None:
    name = row.get("name")
    if not isinstance(name, str) or not name:
        return None
    return {
        "name": name,
        # 百炼没有独立的中文显示名：name 就是服务端从包里 SKILL.md 的 frontmatter 解析出来的那个
        "displayName": name,
        "description": row.get("description") if isinstance(row.get("description"), str) else "",
        "source": "bailian",
        "skillId": row.get("id"),
        "version": row.get("latest_version"),
        "status": row.get("status"),
        "updatedAt": row.get("updated_at"),
    }


async def _fetch_listing() -> tuple[list[dict[str, Any]], list[str]]:
    """翻页取全。返回 (active 技能, 警告消息)。

    状态不是 active 的（checking / rejected）不列进来：它们的正文取不到，列出来只会让用户勾一个
    必然失败的技能。但**不能静默丢** —— 换成一条警告，"我刚上传的技能怎么没出现"是有解的问题，
    "什么都没有"不是。
    """
    warnings: list[str] = []
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    page_token: Any = None
    try:
        base = sources.base_url()
    except ValueError as err:
        raise BailianError(str(err)) from err
    async with sources.make_client() as client:
        for _ in range(MAX_PAGES):
            params: dict[str, Any] = {"limit": PAGE_LIMIT}
            if page_token:
                params["page"] = page_token
            data = await _get_json(client, f"{base}/skills", params)
            batch = data.get("data") or []
            if not isinstance(batch, list):
                raise BailianError("skills 列表的 data 不是数组")
            for r in batch:
                if not isinstance(r, dict):
                    continue
                if r.get("status") != "active":
                    warnings.append(f"{r.get('name')} 状态为 {r.get('status')}，未列入（仅 active 可用）")
                    continue
                item = _normalize(r)
                if item and item["name"] not in seen:
                    seen.add(item["name"])
                    rows.append(item)
            page_token = data.get("next_page")
            if not page_token:
                return rows, warnings
    raise BailianError(f"技能列表翻页超过 {MAX_PAGES} 页仍未结束")


async def get_listing() -> list[dict[str, Any]]:
    """列表现取现用；刷新走 `invalidate()`（它连解包缓存一起清，才是"重来一遍"的语义）。"""
    global _listing
    if _listing and (time.monotonic() - _listing[0]) < CATALOG_TTL_SECONDS:
        return _listing[1]
    rows, warnings = await _fetch_listing()
    _listing = (time.monotonic(), rows, warnings)
    return rows


def get_warnings() -> list[str]:
    return list(_listing[2]) if _listing else []


def invalidate() -> None:
    """刷新目录时连带丢掉解包缓存 —— 版本号不变但内容被覆盖的情况要能强制重取。"""
    global _listing
    _listing = None
    _packages.clear()


async def find_skill(name: str) -> dict[str, Any] | None:
    for row in await get_listing():
        if row["name"] == name:
            return row
    return None


def _package_key(row: dict[str, Any]) -> str:
    return f"{row.get('skillId')}@{row.get('version')}"


async def _guard_package_host(request: httpx.Request) -> None:
    """每一跳发出前复核目标 host —— 白名单只在第一跳生效等于没有白名单。"""
    if not sources.is_allowed_package_host(str(request.url)):
        raise BailianError(f"目标域名不合规则（跳转后为 {request.url.host!r}），已拒绝请求")


def _extract_members(raw: bytes) -> dict[str, bytes]:
    """解 zip，只留 `SKILL.md` 与 `references/*`。

    纯内存读取，不落盘，所以 zip slip 不会变成写文件越权；但成员名仍要过一遍规则，
    因为解出来的 key 后面会被当路径用。`scripts/` 一律不读（明确不做：不注入脚本源码）。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except Exception as err:  # noqa: BLE001 - 坏 zip 的种类不重要，一律算取包失败
        raise BailianError(f"技能包不是合法 zip: {type(err).__name__}") from err
    out: dict[str, bytes] = {}
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename
        if name.startswith("/") or ".." in name.split("/") or "\\" in name:
            continue
        allowed = name == "SKILL.md" or (name.startswith("references/") and name.endswith(".md"))
        if not allowed:
            continue
        if info.file_size > MAX_MEMBER_BYTES or len(out) >= MAX_PACKAGE_FILES:
            continue
        with zf.open(info) as fh:
            blob = fh.read(MAX_MEMBER_BYTES + 1)
        if len(blob) > MAX_MEMBER_BYTES:
            continue
        out[name] = blob
    if not out:
        raise BailianError("技能包里没有 SKILL.md")
    return out


async def get_package(row: dict[str, Any]) -> dict[str, bytes]:
    """取并解某技能当前版本的整包，按 (id, version) 缓存。"""
    key = _package_key(row)
    cached = _packages.get(key)
    if cached is not None:
        _packages.move_to_end(key)
        return cached

    skill_id, version = row.get("skillId"), row.get("version")
    if not isinstance(skill_id, str) or not isinstance(version, str) or not version:
        raise BailianError(f"技能 {row.get('name')} 缺 skillId 或 latest_version，取不了包")
    # `_VERSION_RE` 的字符类允许点号，所以 `..` 能过正则 —— 而它正是要拼成 URL 路径段的那个值。
    if not _ID_RE.fullmatch(skill_id) or not _VERSION_RE.fullmatch(version) or version in (".", ".."):
        raise BailianError(f"技能 {row.get('name')} 的 skillId/版本号形状不合法，已拒绝请求")
    base = sources.base_url()
    try:
        # follow_redirects 与 host 白名单必须一起用：只在发出前查一次的话，一次 302 就能把请求
        # 送到任意 host（含 169.254.169.254 这类内网元数据地址）。钩子在每一跳发出前都会跑。
        async with sources.make_client(
            follow_redirects=True, event_hooks={"request": [_guard_package_host]}
        ) as client:
            meta = await _get_json(client, f"{base}/skills/{skill_id}/versions/{version}/content", None)
            file_url = meta.get("file_url")
            if not isinstance(file_url, str) or not file_url:
                raise BailianError("响应里没有 file_url")
            if not sources.is_allowed_package_host(file_url):
                raise BailianError("file_url 的域名不合规则，已拒绝请求")
            # 不带 Authorization：预签名地址自带 STS 签名，把 key 发给 OSS 是没有必要的泄露
            resp = await client.get(file_url)
    except BailianError:
        raise
    except Exception as err:  # noqa: BLE001
        raise BailianError(f"{type(err).__name__}: {err}") from err
    if resp.status_code != 200:
        raise BailianError(f"技能包下载失败：HTTP {resp.status_code}")
    raw = resp.content
    if len(raw) > MAX_ZIP_BYTES:
        raise BailianError(f"技能包 {len(raw)} 字节，超出 {MAX_ZIP_BYTES} 上限")
    members = _extract_members(raw)
    _packages[key] = members
    _packages.move_to_end(key)
    while len(_packages) > PACKAGE_CACHE_SIZE:
        _packages.popitem(last=False)
    return members
