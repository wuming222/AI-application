"""skill 目录 / 正文 / references 的对外门面：内置 + 百炼两家合成一份。

契约与 `routes/mcp.py` 一致：HTTP 状态码不表达工具成败，成败在 body 里。

两条与"合成"绑在一起的纪律，都别在改动时弄丢：

1. **内置先取，且不受上游成败影响**。百炼列表失败只能让百炼那几家消失，不能把随仓库分发的
   技能一起带走 —— 否则"外网抖动"会表现成"你一个技能都没有"。
2. **名字是唯一身份**。同名时内置赢，被遮蔽的那条以 error 形式报出来，不静默丢弃；
   目录、正文、引用三处解析必须走同一个 `_open` 判定，两处各判一次就会出现"目录里没有但它能取到"。

与旧的 agentexplorer 通道相比，这里少了两样东西，理由都在各自文件里：跌幅守卫（百炼一次请求拿全量，
半份目录这个失败模式没了来源）、正文不缓存（见 `bailian.py` 顶部三条事实）。

取不到就显式回"未找到"，不允许让模型假装读过 —— 这条纪律跟通道无关。
"""

from typing import Any

from app.skills import bailian, local, sources

# 正文截断上界（K4：32,000 字符砍 8% 的份数、p50 完整保留）
MAX_CONTENT_CHARS = 32000
# references 单文件上界（K6：16,000 字符砍 6%）
MAX_FILE_CHARS = 16000

SOURCE_LABEL = "skills"


def _err(message: str, source: str = SOURCE_LABEL) -> dict[str, str]:
    return {"source": source, "message": message[:300]}


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


class NotFound(Exception):
    """两家都没有这个技能。"""


async def _collect(refresh: bool = False) -> dict[str, Any]:
    """合成目录。refresh 会连带清掉解包缓存 —— 面板上那个"刷新目录"要的是真的重新取包。"""
    errors: list[dict[str, str]] = []
    try:
        rows: list[dict[str, Any]] = list(local.get_listing())
    except OSError as err:
        # 读本地目录能失败的场合只有权限/坏软链，仍然要报出来而不是一份空目录
        errors.append(_err(f"内置技能目录读取失败：{err}", "local"))
        rows = []

    if refresh:
        bailian.invalidate()
    try:
        remote = await bailian.get_listing()
    except bailian.BailianError as err:
        errors.append(_err(str(err), "bailian"))
        remote = []
    errors.extend(_err(w, "bailian") for w in bailian.get_warnings())

    taken = {r["name"] for r in rows}
    for row in remote:
        if row["name"] in taken:
            errors.append(
                _err(f"百炼技能 {row['name']} 与内置技能同名，已忽略百炼那份（内置优先）", "bailian")
            )
            continue
        rows.append(row)
    return {"skills": rows, "errors": errors}


async def get_catalog(refresh: bool = False) -> dict[str, Any]:
    return await _collect(refresh)


async def search(keyword: str, max_results: int) -> dict[str, Any]:
    """按关键词过一遍合成后的目录。

    不是"上游语义检索"：百炼这个接口没有 keyword 参数。技能量级是"内置几个 + 你自己上传的那些"，
    本地子串匹配够用，而且诚实 —— 索引里没有的技能，我们不会假装搜得到。
    """
    collected = await _collect()
    needle = keyword.lower()
    hits = [
        s
        for s in collected["skills"]
        if needle in s["name"].lower() or needle in str(s["description"]).lower()
    ]
    return {"skills": hits[:max_results], "errors": collected["errors"]}


async def _open(name: str) -> tuple[dict[str, bytes], str]:
    """按名字取整包，返回 (成员, 来源标签)。内置优先 —— 与目录里的同名去重是同一条规则。"""
    if local.has_skill(name):
        return local.get_package(name), "local"
    row = await bailian.find_skill(name)
    if row is None:
        raise NotFound(name)
    return await bailian.get_package(row), "bailian"


async def get_content(name: str) -> dict[str, Any]:
    """一份 SKILL.md 正文，按 K4 上界截断。"""
    try:
        members, origin = await _open(name)
    except NotFound:
        return {"text": f"技能正文未找到：目录里没有 {name}", "is_error": True}
    except (bailian.BailianError, local.LocalSkillError) as err:
        return {"text": f"技能正文获取失败：{err}", "is_error": True}
    blob = members.get("SKILL.md")
    if blob is None:
        return {"text": f"技能正文未找到：{name}（{origin}）的包里没有 SKILL.md", "is_error": True}
    text, truncated, original = _clip(blob.decode("utf-8", "replace"), MAX_CONTENT_CHARS, "技能正文")
    return {"text": text, "truncated": truncated, "original_chars": original, "is_error": False}


async def get_reference(name: str, path: str) -> dict[str, Any]:
    """某个技能包内的一个 references/*.md，按 K6 上界截断。

    顺序照旧：**先**做零 I/O 的语法校验，畸形 path 在这里就回绝，一次外部请求都不发。
    """
    if not sources.validate_reference_path(path):
        return {
            "text": f"引用文件路径不合规则：只允许该技能 references/ 下的 .md 文件（收到 {path[:80]!r}）",
            "is_error": True,
        }
    try:
        members, _origin = await _open(name)
    except NotFound:
        return {"text": f"引用文件未找到：目录里没有 {name}", "is_error": True}
    except (bailian.BailianError, local.LocalSkillError) as err:
        return {"text": f"引用文件读取失败：{err}", "is_error": True}
    blob = members.get(path)
    if blob is None:
        listed = "、".join(sorted(k for k in members if k.startswith("references/"))) or "（这个包里没有 references 文件）"
        return {
            "text": f"引用文件未找到：{name} 的包里没有 {path}。有的文件：{listed}",
            "is_error": True,
        }
    text, truncated, original = _clip(blob.decode("utf-8", "replace"), MAX_FILE_CHARS, "引用文件")
    return {"text": text, "truncated": truncated, "original_chars": original, "is_error": False}
