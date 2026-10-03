"""历史参考检索的 HTTP 壳。鉴权不在这里写 —— main.py 给 /api/* 整组挂了 Depends(current_user)，
所以 user_id 只能从 token 解，永远不接受客户端传参。"""

from fastapi import APIRouter, Depends, Query

from app.auth import AuthUser, current_user
from app.database import get_connection
from app.rag import search

router = APIRouter(prefix="/api/rag", tags=["rag"])


@router.get("/search")
def rag_search(
    q: str = Query(default=""),
    exclude: str = Query(default=""),
    limit: int = Query(default=5, ge=1, le=20),
    user: AuthUser = Depends(current_user),
):
    conn = get_connection()
    try:
        return {"results": search(conn, user.id, q, exclude, limit)}
    finally:
        conn.close()
