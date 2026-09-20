"""找回密码的唯一实现：只能在本机跑的改密脚本。

    python -m app.scripts.reset_password <username> <newpassword>

为什么是脚本而不是接口：日常的"忘记密码"能成立，靠的是一个本来就证明得了身份的出带通道
（邮件、短信、验证器）。这三样本项目一个都不接，恢复码也被明确否掉，于是只剩"有人担保"这一族
—— 也就是站长本人。做成 HTTP 接口就得给这个接口本身做鉴权，那是新问题；而"能不能在这台机器上
执行命令"已经是那道验证了，且零新增攻击面。界面上对应的位置只放一句"忘记密码？联系站长"。

刻意在同一处调用 `revoke_all_tokens`：改密只改 hash 不清 token，等于给攻击者留了一个仍然有效的
旧登录态，改密就成了"加了一个并行入口"而不是"换掉了钥匙"。
"""

import sys

from app.auth import (
    MAX_PASSWORD_BYTES,
    MIN_PASSWORD_BYTES,
    revoke_all_tokens,
    hash_password,
    validate_credentials,
)
from app.database import get_connection


def reset_password(username: str, password: str) -> int:
    """返回被撤销的 token 数。找不到用户或参数非法时抛异常（调用方按非 0 退出码处理）。"""
    err = validate_credentials(username, password)
    if err:
        raise ValueError(err)

    conn = get_connection()
    row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        conn.close()
        # 措辞与线上一致（不额外确认"这个用户名存在吗"），即使在本机也无必要破例。
        raise LookupError("用户名或密码不对")
    uid = row["id"]
    conn.execute(
        "UPDATE users SET pass_hash = ? WHERE id = ?", (hash_password(password), uid)
    )
    conn.commit()
    cur = conn.execute("DELETE FROM auth_tokens WHERE user_id = ?", (uid,))
    conn.commit()
    revoked = cur.rowcount
    conn.close()
    return revoked


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        print("用法：python -m app.scripts.reset_password <username> <newpassword>")
        return 2
    try:
        revoked = reset_password(argv[1], argv[2])
    except (ValueError, LookupError) as exc:
        print(f"失败：{exc}")
        return 1
    print(f"已重置 {argv[1]} 的密码，撤销 {revoked} 个登录态。")
    print(
        f"提示：密码长度限制是 {MIN_PASSWORD_BYTES}-{MAX_PASSWORD_BYTES} 字节，"
        "旧登录态已全部失效，需要重新登录。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
