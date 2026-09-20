"""会话、消息与工作区的持久化。多租户 P0 之后，这个文件里的每一条 SQL 都要能回答
"它带 user_id 了吗"。

归属只落在 `sessions` 一张表上：`messages` 与 `workspaces` 以 `session_id` 外键挂过去，
经会话继承归属，所以那两张表不加列。由此得出两条纪律：

- **任何跨表读之前先过 `_owned_session`。** `get_messages` 与 `get_workspace` 原来是直接按
  `session_id` 查，连会话存在性都不验 —— 拿到 uuid 就能读走别人的整段对话。
- **"别人的" 与 "不存在的" 必须是同一个答案，而且不能是静默空。** 404 是唯一可接受的形态；
  返回 `{files:{}}` 或 `{messages:[]}` 会让调用方以为"这会话是空的"，既泄露又难查。
  `PATCH`/`DELETE` 本来就把 `rowcount == 0` 当 404 抛，加条件后自动满足，零额外代码。
"""

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import AuthUser, current_user
from app.database import get_connection

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class SessionCreate(BaseModel):
    title: Optional[str] = "新对话"


class SessionUpdate(BaseModel):
    title: str


class MessageCreate(BaseModel):
    role: str
    content: str = ""
    images: Optional[list[str]] = None
    tool_calls: Optional[list] = None
    tool_call_id: Optional[str] = None
    reasoning: Optional[str] = None


class WorkspaceUpdate(BaseModel):
    files: dict[str, str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _owned_session(conn, session_id: str, user_id: str) -> bool:
    """会话存在且属于当前用户。归属为 NULL 的存量行对谁都不属于，因此恒为 False。"""
    row = conn.execute(
        "SELECT 1 FROM sessions WHERE id = ? AND user_id = ?", (session_id, user_id)
    ).fetchone()
    return row is not None


def _not_found():
    return HTTPException(status_code=404, detail="Session not found")


@router.get("")
def list_sessions(user: AuthUser = Depends(current_user)):
    conn = get_connection()
    rows = conn.execute(
        "SELECT id, title, created_at, updated_at FROM sessions "
        "WHERE user_id = ? ORDER BY updated_at DESC",
        (user.id,),
    ).fetchall()
    conn.close()
    return {"sessions": [dict(r) for r in rows]}


@router.post("")
def create_session(body: SessionCreate, user: AuthUser = Depends(current_user)):
    sid = str(uuid.uuid4())
    now = _now()
    title = body.title or "新对话"
    conn = get_connection()
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)",
        (sid, title, now, now, user.id),
    )
    conn.execute(
        "INSERT INTO workspaces (session_id, files) VALUES (?, '{}')",
        (sid,),
    )
    conn.commit()
    conn.close()
    return {"id": sid, "title": title, "created_at": now, "updated_at": now}


@router.patch("/{session_id}")
def update_session(
    session_id: str, body: SessionUpdate, user: AuthUser = Depends(current_user)
):
    conn = get_connection()
    cur = conn.execute(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (body.title, _now(), session_id, user.id),
    )
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise _not_found()
    row = conn.execute(
        "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ? AND user_id = ?",
        (session_id, user.id),
    ).fetchone()
    conn.close()
    return dict(row)


@router.delete("/{session_id}")
def delete_session(session_id: str, user: AuthUser = Depends(current_user)):
    conn = get_connection()
    cur = conn.execute(
        "DELETE FROM sessions WHERE id = ? AND user_id = ?", (session_id, user.id)
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise _not_found()
    return {"ok": True}


@router.get("/{session_id}/messages")
def get_messages(session_id: str, user: AuthUser = Depends(current_user)):
    conn = get_connection()
    if not _owned_session(conn, session_id, user.id):
        conn.close()
        raise _not_found()
    rows = conn.execute(
        "SELECT role, content, images, tool_calls, tool_call_id, reasoning, created_at "
        "FROM messages WHERE session_id = ? ORDER BY id ASC",
        (session_id,),
    ).fetchall()
    conn.close()
    messages = []
    for r in rows:
        msg = {
            "role": r["role"],
            "content": r["content"],
        }
        if r["images"]:
            msg["images"] = json.loads(r["images"])
        if r["tool_calls"]:
            msg["tool_calls"] = json.loads(r["tool_calls"])
        if r["tool_call_id"]:
            msg["tool_call_id"] = r["tool_call_id"]
        if r["reasoning"]:
            msg["reasoning"] = r["reasoning"]
        messages.append(msg)
    return {"messages": messages}


@router.post("/{session_id}/messages")
def add_messages(
    session_id: str, messages: list[MessageCreate], user: AuthUser = Depends(current_user)
):
    now = _now()
    conn = get_connection()
    if not _owned_session(conn, session_id, user.id):
        conn.close()
        raise _not_found()

    for msg in messages:
        tc_json = json.dumps(msg.tool_calls) if msg.tool_calls else None
        images_json = json.dumps(msg.images) if msg.images else None
        conn.execute(
            "INSERT INTO messages (session_id, role, content, images, tool_calls, tool_call_id, reasoning, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, msg.role, msg.content, images_json, tc_json, msg.tool_call_id, msg.reasoning, now),
        )
    conn.execute(
        "UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?",
        (now, session_id, user.id),
    )
    conn.commit()
    conn.close()
    return {"count": len(messages)}


@router.get("/{session_id}/workspace")
def get_workspace(session_id: str, user: AuthUser = Depends(current_user)):
    conn = get_connection()
    if not _owned_session(conn, session_id, user.id):
        conn.close()
        raise _not_found()
    row = conn.execute(
        "SELECT files FROM workspaces WHERE session_id = ?", (session_id,)
    ).fetchone()
    conn.close()
    if not row:
        return {"files": {}}
    return {"files": json.loads(row["files"])}


@router.put("/{session_id}/workspace")
def update_workspace(
    session_id: str, body: WorkspaceUpdate, user: AuthUser = Depends(current_user)
):
    conn = get_connection()
    # 这条 PUT 是全量覆盖，写错目标就是抹掉别人的代码 —— 所以先校验归属再动笔。
    if not _owned_session(conn, session_id, user.id):
        conn.close()
        raise _not_found()

    files_json = json.dumps(body.files)
    conn.execute(
        "INSERT INTO workspaces (session_id, files) VALUES (?, ?) "
        "ON CONFLICT(session_id) DO UPDATE SET files = excluded.files",
        (session_id, files_json),
    )
    conn.execute(
        "UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?",
        (_now(), session_id, user.id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}
