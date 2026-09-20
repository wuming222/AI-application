"""注册 / 登录 / 登出 / 当前用户。全站唯一不需要登录态的四个端点里的两个在这里。

**防枚举是这一节的主题**，两条规则贯穿到底：

1. `login` 的"用户名不存在"与"密码不对"必须是**同一个响应** —— 同 status、同 detail、同
   `X-Auth-Error` 头。少一条，登录口就成了用户名枚举工具；这条已经落到断言里（auth_check.py）。
   连耗时都要一致，所以 `verify_login` 在查无此人时仍照算一次 scrypt。
2. `该用户名已被占用` 只允许出现在 `register`。

`logout` 无论 token 有没有效都回 200 —— 登出失败不该把用户卡在界面上，服务端该做的
"让这个 token 不再有效"本来就是幂等的。
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.auth import (
    USERNAME_TAKEN,
    AuthUser,
    UsernameTaken,
    bearer_token,
    create_user,
    current_user,
    issue_token,
    revoke_token,
    verify_login,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

BAD_CREDENTIALS = "用户名或密码不对"


class Credentials(BaseModel):
    username: str
    password: str


@router.post("/register")
def register(body: Credentials):
    try:
        user = create_user(body.username, body.password)
    except UsernameTaken as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"token": issue_token(user.id), "user": {"id": user.id, "username": user.username}}


@router.post("/login")
def login(body: Credentials):
    user = verify_login(body.username, body.password)
    if user is None:
        raise HTTPException(status_code=401, detail=BAD_CREDENTIALS)
    return {"token": issue_token(user.id), "user": {"id": user.id, "username": user.username}}


@router.post("/logout")
def logout(request: Request):
    revoke_token(bearer_token(request.headers.get("authorization")))
    return {"ok": True}


@router.get("/me")
def me(user: AuthUser = Depends(current_user)):
    # 401 由 current_user 给，全站同一条文案，这里不多解释原因。
    return {"id": user.id, "username": user.username}
