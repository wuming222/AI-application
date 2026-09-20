import sqlite3
import os

# APP_DB_PATH 只为可测而存在：断言脚本要能指向一个临时库，而不是往本地 app.db 写脏数据。
DB_PATH = os.environ.get("APP_DB_PATH") or os.path.join(
    os.path.dirname(__file__), "..", "data", "app.db"
)


def get_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = get_connection()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '新对话',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            images TEXT,
            tool_calls TEXT,
            tool_call_id TEXT,
            reasoning TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

        CREATE TABLE IF NOT EXISTS workspaces (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            files TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            pass_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auth_tokens (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
    """)
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN images TEXT")
    except sqlite3.OperationalError:
        pass
    # 存量行留 NULL = 谁都不属于（见 SDD 的"已知代价"）。不能回填给第一个登录的人：
    # 归属信息在写下的那一刻就没记，现在拿不回来了。
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN user_id TEXT")
    except sqlite3.OperationalError:
        pass
    conn.close()
