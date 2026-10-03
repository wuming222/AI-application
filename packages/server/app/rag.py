"""历史参考检索的语料与查询。见 docs/SDD/rag-mvp/SDD.md。

只索引两样东西：用户说过的原话（kind='requirement'）与会话里的文件名（kind='path'）。
代码正文不进索引 —— 本版的目标是把"索引→检索→注入→可开关"四个接缝走通，不做正文召回。
"""

import json
import re
from datetime import datetime, timezone

# 标点与空白。中文标点必须一起列进来 —— 用户原话里的逗号几乎都是全角的。
_SPLIT_RE = re.compile(r"[，。？！、,.!?;；:：\s]+")
MAX_FRAGMENTS = 8
MIN_FRAGMENT_LEN = 2

# 极宽松的天花板：它唯一防的是有人把整份 PRD 粘成一句话。见 SDD"实测依据"一节 ——
# 5 条用满是 800 字符 ≈ 267 token = 软限的 0.4%，不值得为它写压缩逻辑，所以这个值不需要调准。
BODY_CHAR_CAP = 160


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cap(text: str) -> str:
    return text[:BODY_CHAR_CAP]


def split_fragments(query: str) -> list[str]:
    """用户原话不是搜索词：整句去做子串匹配永远命中不了，必须先切。"""
    out: list[str] = []
    for piece in _SPLIT_RE.split(query):
        p = piece.strip()
        if len(p) >= MIN_FRAGMENT_LEN:
            out.append(p)
    return out[:MAX_FRAGMENTS]


def score_row(kind: str, frags: list[str], body: str) -> int:
    """命中片段数；需求原话算 2 倍权重，文件名不加权 —— 本地实测 5 个文件全叫
    index.html，信息量为零，给权重只会搅乱结果。

    子串匹配刻意留在 Python 而不是拼进 SQL 的 LIKE：'%' 与 '_' 在 LIKE 里是通配符，
    放进模式就等于给用户开"一个字符读走全库"的后门。这里它只是普通字符。
    """
    hits = sum(1 for f in frags if f in body)
    if hits == 0:
        return 0
    return hits * 2 if kind == "requirement" else hits


def sync_session_docs(conn, user_id: str, session_id: str) -> int:
    """该会话名下全删全插。幂等，所以两个调用点重复触发不会累积。

    json.loads 只发生在这一个会话的 blob 上（实测单 blob 最大 18,281 字符），不是全库 ——
    这是本方案在内存上比"现扫全库"安全的确切原因。
    """
    conn.execute("DELETE FROM rag_doc WHERE session_id = ?", (session_id,))
    written = 0
    rows = conn.execute(
        "SELECT content, created_at FROM messages "
        "WHERE session_id = ? AND role = 'user' ORDER BY id ASC",
        (session_id,),
    ).fetchall()
    for r in rows:
        content = (r["content"] or "").strip()
        if not content:
            continue
        conn.execute(
            "INSERT INTO rag_doc (user_id, session_id, kind, body, created_at) "
            "VALUES (?, ?, 'requirement', ?, ?)",
            (user_id, session_id, cap(content), r["created_at"]),
        )
        written += 1
    ws = conn.execute("SELECT files FROM workspaces WHERE session_id = ?", (session_id,)).fetchone()
    if ws:
        try:
            paths = list(json.loads(ws["files"]).keys())
        except (TypeError, ValueError):
            paths = []  # 坏 blob 不值得把整次写入带走：少一路文件名命中而已
        now = _now()
        for p in paths:
            conn.execute(
                "INSERT INTO rag_doc (user_id, session_id, kind, body, created_at) "
                "VALUES (?, ?, 'path', ?, ?)",
                (user_id, session_id, cap(p), now),
            )
            written += 1
    return written


def backfill_if_empty(conn) -> int:
    """只在 rag_doc 整盘为空时跑一次（存量没别的办法：那时根本没写钩子）。

    `sessions.user_id IS NULL` 的存量行不进索引 —— 沿用既有不变量"NULL 归属谁都不属于"，
    不能因为它们在库里躺着就被谁检索出来。
    """
    if conn.execute("SELECT 1 FROM rag_doc LIMIT 1").fetchone() is not None:
        return 0
    total = 0
    rows = conn.execute(
        "SELECT id, user_id FROM sessions WHERE user_id IS NOT NULL"
    ).fetchall()
    for r in rows:
        total += sync_session_docs(conn, r["user_id"], r["id"])
    conn.commit()
    return total


def search(conn, user_id: str, query: str, exclude_session: str, limit: int = 5) -> list[dict]:
    """top-k 卡片。返回 [{sessionId, title, requirement, paths, score}]，前端只管拼文本。"""
    frags = split_fragments(query)
    if not frags:
        return []
    rows = conn.execute(
        "SELECT d.session_id, d.kind, d.body, d.created_at, s.title "
        "FROM rag_doc d JOIN sessions s ON s.id = d.session_id "
        "WHERE d.user_id = ? AND d.session_id <> ?",
        (user_id, exclude_session),
    ).fetchall()

    best: dict[str, dict] = {}
    req_by_session: dict[str, str] = {}
    paths_by_session: dict[str, list[str]] = {}
    for r in rows:
        sid = r["session_id"]
        if r["kind"] == "path":
            paths_by_session.setdefault(sid, []).append(r["body"])
        elif sid not in req_by_session:
            req_by_session[sid] = r["body"]
        sc = score_row(r["kind"], frags, r["body"])
        if sc == 0:
            continue
        cur = best.get(sid)
        if cur is None or sc > cur["score"] or (sc == cur["score"] and r["created_at"] > cur["created_at"]):
            best[sid] = {
                "sessionId": sid,
                "title": r["title"],
                "kind": r["kind"],
                "matched": r["body"],
                "score": sc,
                "created_at": r["created_at"],
            }

    # 排序与 LIMIT 的顺序有讲究：先按会话取最高分，再截 5 条。反过来的话 5 张卡
    # 会全是同一个会话的不同片段，用户看到"提了 5 遍天气"而不是"做过 5 件事"。
    ranked = sorted(best.values(), key=lambda x: (x["score"], x["created_at"]), reverse=True)
    cards = []
    for hit in ranked[:limit]:
        sid = hit["sessionId"]
        cards.append({
            "sessionId": sid,
            "title": hit["title"],
            # 卡片取文规则：最高分落在 path 时，仍优先显示该会话的一条需求原话。
            "requirement": hit["matched"] if hit["kind"] == "requirement" else req_by_session.get(sid, ""),
            "paths": paths_by_session.get(sid, []),
            "score": hit["score"],
        })
    return cards
