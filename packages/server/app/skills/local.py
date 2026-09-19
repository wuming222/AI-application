"""内置技能（随仓库分发的本地技能包）：目录清单 + 整包读取。

与 `bailian.py` 的分工只有一处：**这里的包不在远端，不需要缓存也不需要鉴权**，
所以整个模块就是"校验名字 → 读文件"，没有第二条路径。

技能包布局与百炼那份对齐（对不上就不该放进这个目录）：

    app/skills/local_skills/<name>/SKILL.md
    app/skills/local_skills/<name>/references/*.md

`<name>` 同时是对外身份与磁盘路径的一段 —— 这是本模块唯一的注入面。所以它必须先过
`validate_skill_name` 再拼路径，且拼完还要确认解析后的绝对路径仍落在 ROOT 之内：
名字里带 `..`、绝对路径、盘符、URL 编码分隔符的输入都在这里回绝，不进文件系统。
"""

import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent / "local_skills"

# 与百炼侧的 skill name 同形（小写字母数字与连字符），不接受点号 —— 点上可扩展名容易和路径把戏混在一起。
# 不写 `^…$` 而用 fullmatch：`$` 会放过结尾那一个换行，而这串字符要拼进路径。
_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")

# references/ 之外的文件一律不读；scripts/ 尤其不读（这个特性只生成不执行）。
# 同样用 fullmatch 而不是靠 `$`：Linux 上文件名可以含换行，而 `$` 会放过结尾那一个换行。
_ALLOWED_MEMBER = re.compile(r"(SKILL\.md|references/[^/].*\.md)")


class LocalSkillError(Exception):
    pass


def validate_skill_name(name: str) -> bool:
    return isinstance(name, str) and bool(_NAME_RE.fullmatch(name))


def has_skill(name: str) -> bool:
    """只回答"内置目录里有没有这个技能"，不抛 —— 目录解析要先分流再决定读哪一家。"""
    return validate_skill_name(name) and (ROOT / name).is_dir()


def skill_dir(name: str) -> Path:
    """名字 → 包目录。校验两次：语法一次，解析后的位置一次。"""
    if not validate_skill_name(name):
        raise LocalSkillError(f"技能名不合法：{name[:80]!r}")
    target = (ROOT / name).resolve()
    root = ROOT.resolve()
    if target.parent != root or not target.is_dir():
        # parent 必须正好是 ROOT —— 挡住任何借符号链接或大小写把戏跑出 ROOT 的写法
        raise LocalSkillError(f"内置技能不存在或位置不合法：{name[:80]!r}")
    return target


_BLOCK_MARKERS = {"|", ">", "|-", ">-", "|+", ">+"}


def _fold_description(md: str) -> str:
    """从 frontmatter 取 description 并折成单行。

    百炼服务端替我们做了同一件事（实测它把块标量折叠成一行），两家在面板与索引行里要长得一样，
    否则用户会以为差异是内容差异。只解析这个仓库自己写的技能，所以手搓一个最小扫描：
    顶层 `description:` 的同行值，或紧跟其后那段更深缩进的块。
    """
    lines = md.splitlines()
    if not lines or lines[0].strip() != "---":
        return ""
    in_block = False
    parts: list[str] = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        stripped = line.strip()
        if not in_block:
            if not stripped.startswith("description:"):
                continue
            inline = stripped[len("description:") :].strip()
            if inline and inline not in _BLOCK_MARKERS:
                return _clean(_unquote(inline))
            in_block = True
            continue
        if not stripped:
            continue
        if not line.startswith((" ", "\t")):
            break  # 缩进没了 = 块标量结束，下面已经是别的顶层键
        parts.append(stripped)
    return _clean(" ".join(parts))


def _unquote(text: str) -> str:
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    return text


def _clean(text: str) -> str:
    return " ".join(text.split())


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def get_listing() -> list[dict[str, Any]]:
    """目录条目，形状与 `bailian._normalize` 一致（前端不需要按来源分支取值）。"""
    if not ROOT.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for entry in sorted(ROOT.iterdir()):
        if not entry.is_dir() or not validate_skill_name(entry.name):
            continue
        manifest = entry / "SKILL.md"
        if not manifest.is_file():
            continue
        out.append(
            {
                "name": entry.name,
                "displayName": entry.name,
                "description": _fold_description(_read_text(manifest)),
                "source": "local",
                "skillId": f"local:{entry.name}",
                # 内置技能由 git 版本化：没有"版本号"这个概念，也不会有 checking 这种中间态
                "version": "local",
                "status": "active",
                "updatedAt": None,
            }
        )
    return out


def get_package(name: str) -> dict[str, bytes]:
    """整包成员，键与百炼解包后的一致（SKILL.md / references/xxx.md）。"""
    base = skill_dir(name)
    members: dict[str, bytes] = {}
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(base).as_posix()
        if not _ALLOWED_MEMBER.fullmatch(relative):
            continue
        members[relative] = _read_text(path).encode("utf-8")
    if "SKILL.md" not in members:
        raise LocalSkillError(f"内置技能 {name} 的目录里没有 SKILL.md")
    return members
