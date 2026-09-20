"""身份层：密码哈希、登录态 token、鉴权依赖。三件事只在这里做，别处不复刻判据。

三个刻意的选择：

1. **token 是服务端存的不透明随机串，不是 JWT。** 自证 token 无法撤销 —— 改密、登出、
   封号都得立刻生效，而 JWT 做不到（除非再引入一张黑名单，那还不如从一开始就查表）。
2. **scrypt 串里带着自己的参数**（`scrypt$n$r$p$salt$hash`），verify 时按串里的参数算，
   不读模块常量。这样将来把 `n` 调大，存量密码不会突然全部失效。代价是要防"串被换成巨贵
   参数"造成的算 DoS，所以下面 `verify_password` 里有一组参数上限校验 —— 它防的不是有人
   改了库，而是"改了库之后这条函数还照不照得住"。
3. **鉴权失败只回一句话**：`未登录或登录已过期`。不带"token 过期"与"token 无效"的分支，
   免得这里变成一个可以用响应差异探测系统内部状态的 oracle。用户名枚举同理，见 routes/auth.py。

token 目前**原文入库**。`app.db` 是本机文件且已 gitignore，MVP 阶段可接受；
迁到远端数据库之前要改成存 token 的哈希（`auth_tokens.token` 换列 + 签发时返回原文、
入库时存摘要），否则谁读到库就等于拿到全部登录态。
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, Request

from app.database import get_connection

# ---- 参数 ---------------------------------------------------------------

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
TOKEN_TTL_DAYS = 30

# 串里允许出现的上限，见模块 docstring 第 2 条。
_MAX_N = 2**20
_MAX_RP = 2**16

UNAUTHENTICATED = "未登录或登录已过期"
USERNAME_TAKEN = "该用户名已被占用"

# 中文放开，长度收紧即可；不要求邮箱、手机号，因为它们一个都不验。
USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,32}$")
MIN_PASSWORD_BYTES = 8
MAX_PASSWORD_BYTES = 72


@dataclass(frozen=True)
class AuthUser:
    id: str
    username: str


class UsernameTaken(Exception):
    """只有注册这一条路会抛它。登录路径绝不允许出现这个信息。"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat()


# ---- 密码 ---------------------------------------------------------------


def validate_credentials(username: str, password: str) -> Optional[str]:
    """返回错误文案；None 表示通过。只在边界用，不做密码强度打分。"""
    if not USERNAME_RE.match(username or ""):
        return "用户名只能是 1-32 个中英文、数字、下划线或短横线"
    size = len((password or "").encode("utf-8"))
    if size < MIN_PASSWORD_BYTES or size > MAX_PASSWORD_BYTES:
        return f"密码长度要在 {MIN_PASSWORD_BYTES}-{MAX_PASSWORD_BYTES} 字节之间"
    return None


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P
    )
    return "$".join(
        ["scrypt", str(SCRYPT_N), str(SCRYPT_R), str(SCRYPT_P), salt.hex(), digest.hex()]
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n_s, r_s, p_s, salt_s, hash_s = stored.split("$")
        if scheme != "scrypt":
            return False
        n, r, p = int(n_s), int(r_s), int(p_s)
        salt = bytes.fromhex(salt_s)
        expected = bytes.fromhex(hash_s)
    except (ValueError, TypeError):
        return False

    # 畸形串一律拒，不要拿它去喂 scrypt：n 必须是 2 的幂且 > 1。
    if n < 2 or n > _MAX_N or n & (n - 1) or r < 1 or p < 1 or r > _MAX_RP or p > _MAX_RP:
        return False
    if len(salt) < 8 or len(expected) < 16:
        return False

    try:
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=n,
            r=r,
            p=p,
            maxmem=128 * n * r * p + (1 << 20),
        )
    except (ValueError, MemoryError, OverflowError):
        return False
    return hmac.compare_digest(actual, expected)


# 登录时"用户名不存在"这一支也要花差不多的时间，否则响应快慢本身就是一个枚举 oracle。
# 用一个真实的 scrypt 串当垫片，只为了把耗时抹平。
_DUMMY_HASH = hash_password(secrets.token_urlsafe(12))


# ---- 用户与 token -------------------------------------------------------


def create_user(username: str, password: str) -> AuthUser:
    err = validate_credentials(username, password)
    if err:
        raise ValueError(err)
    uid = str(uuid.uuid4())
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)",
            (uid, username, hash_password(password), _iso(_now())),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise UsernameTaken(USERNAME_TAKEN) from exc
    finally:
        conn.close()
    return AuthUser(id=uid, username=username)


def verify_login(username: str, password: str) -> Optional[AuthUser]:
    """查无此人与密码不对**走同一条返回路径**（都回 None）。

    两支合流不只是文案要一致 —— 这里连 scrypt 都要照算一次，否则"秒回"就等于告诉调用方
    这个用户名不存在。
    """
    conn = get_connection()
    row = conn.execute(
        "SELECT id, username, pass_hash FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()

    stored = row["pass_hash"] if row else _DUMMY_HASH
    ok = verify_password(password, stored)
    if not row or not ok:
        return None
    return AuthUser(id=row["id"], username=row["username"])


def issue_token(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    conn = get_connection()
    conn.execute(
        "INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token, user_id, _iso(now), _iso(now + timedelta(days=TOKEN_TTL_DAYS))),
    )
    # 过期行顺手清掉。删过期 token 不依赖任何历史信息，所以不违反"归属信息不可回填"那条。
    conn.execute("DELETE FROM auth_tokens WHERE expires_at < ?", (_iso(now),))
    conn.commit()
    conn.close()
    return token


def user_from_token(token: Optional[str]) -> Optional[AuthUser]:
    if not token:
        return None
    conn = get_connection()
    row = conn.execute(
        "SELECT u.id, u.username, t.expires_at FROM auth_tokens t "
        "JOIN users u ON u.id = t.user_id WHERE t.token = ?",
        (token,),
    ).fetchone()
    conn.close()
    if not row or row["expires_at"] < _iso(_now()):
        return None
    return AuthUser(id=row["id"], username=row["username"])


def revoke_token(token: Optional[str]) -> None:
    if not token:
        return
    conn = get_connection()
    conn.execute("DELETE FROM auth_tokens WHERE token = ?", (token,))
    conn.commit()
    conn.close()


def revoke_all_tokens(user_id: str) -> int:
    """改密之后必须调它。否则旧 token 继续有效，改密就只是多加了一个并行入口。"""
    conn = get_connection()
    cur = conn.execute("DELETE FROM auth_tokens WHERE user_id = ?", (user_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    return deleted


# ---- FastAPI 侧的取用户 -------------------------------------------------


def bearer_token(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    parts = header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


async def current_user(request: Request) -> AuthUser:
    """HTTP 依赖：解不出用户就 401。挂在 router 的 dependencies 上即可全站收口。"""
    user = user_from_token(bearer_token(request.headers.get("authorization")))
    if user is None:
        raise HTTPException(status_code=401, detail=UNAUTHENTICATED)
    return user


def bearer_from_websocket(websocket) -> Optional[str]:
    """浏览器建 WebSocket 时带不了自定义 header，所以语音那一路只能走 query。

    token 出现在 URL 里意味着它会进访问日志 —— 这里没有访问日志，且这条链路的代价是
    "一次 ASR 会话"，与其余端点同级。将来上生产要留日志时，这条要么改子协议握手要么
    改成先换一次性 ticket。
    """
    token = websocket.query_params.get("token")
    return token.strip() if token and token.strip() else None
