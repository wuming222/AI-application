import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import get_connection

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class SessionCreate(BaseModel):
    title: Optional[str] = "新对话"


class SessionUpdate(BaseModel):
    title: str


class MessageCreate(BaseModel):
    role: str
    content: str = ""
    tool_calls: Optional[list] = None
    tool_call_id: Optional[str] = None
    reasoning: Optional[str] = None


class WorkspaceUpdate(BaseModel):
    files: dict[str, str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get("")
def list_sessions():
    conn = get_connection()
    rows = conn.execute(
        "SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return {"sessions": [dict(r) for r in rows]}


@router.post("")
def create_session(body: SessionCreate):
    sid = str(uuid.uuid4())
    now = _now()
    conn = get_connection()
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (sid, body.title, now, now),
    )
    conn.execute(
        "INSERT INTO workspaces (session_id, files) VALUES (?, '{}')",
        (sid,),
    )
    conn.commit()
    conn.close()
    return {"id": sid, "title": body.title, "created_at": now, "updated_at": now}


@router.patch("/{session_id}")
def update_session(session_id: str, body: SessionUpdate):
    conn = get_connection()
    cur = conn.execute(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
        (body.title, _now(), session_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Session not found")
    row = conn.execute(
        "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    conn.close()
    return dict(row)


@router.delete("/{session_id}")
def delete_session(session_id: str):
    conn = get_connection()
    cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.get("/{session_id}/messages")
def get_messages(session_id: str):
    conn = get_connection()
    rows = conn.execute(
        "SELECT role, content, tool_calls, tool_call_id, reasoning, created_at "
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
        if r["tool_calls"]:
            msg["tool_calls"] = json.loads(r["tool_calls"])
        if r["tool_call_id"]:
            msg["tool_call_id"] = r["tool_call_id"]
        if r["reasoning"]:
            msg["reasoning"] = r["reasoning"]
        messages.append(msg)
    return {"messages": messages}


@router.post("/{session_id}/messages")
def add_messages(session_id: str, messages: list[MessageCreate]):
    now = _now()
    conn = get_connection()
    # Verify session exists
    sess = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not sess:
        conn.close()
        raise HTTPException(status_code=404, detail="Session not found")

    for msg in messages:
        tc_json = json.dumps(msg.tool_calls) if msg.tool_calls else None
        conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, reasoning, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, msg.role, msg.content, tc_json, msg.tool_call_id, msg.reasoning, now),
        )
    conn.execute(
        "UPDATE sessions SET updated_at = ? WHERE id = ?",
        (now, session_id),
    )
    conn.commit()
    conn.close()
    return {"count": len(messages)}


@router.get("/{session_id}/workspace")
def get_workspace(session_id: str):
    conn = get_connection()
    row = conn.execute(
        "SELECT files FROM workspaces WHERE session_id = ?", (session_id,)
    ).fetchone()
    conn.close()
    if not row:
        return {"files": {}}
    return {"files": json.loads(row["files"])}


@router.put("/{session_id}/workspace")
def update_workspace(session_id: str, body: WorkspaceUpdate):
    conn = get_connection()
    sess = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not sess:
        conn.close()
        raise HTTPException(status_code=404, detail="Session not found")

    files_json = json.dumps(body.files)
    conn.execute(
        "INSERT INTO workspaces (session_id, files) VALUES (?, ?) "
        "ON CONFLICT(session_id) DO UPDATE SET files = excluded.files",
        (session_id, files_json),
    )
    conn.execute(
        "UPDATE sessions SET updated_at = ? WHERE id = ?",
        (_now(), session_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}
