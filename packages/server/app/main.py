from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import current_user
from app.routes.auth import router as auth_router
from app.routes.llm import router as llm_router
from app.routes.mcp import router as mcp_router
from app.routes.sessions import router as sessions_router
from app.routes.skills import router as skills_router
from app.routes.voice import router as voice_router
from app.database import init_db

app = FastAPI(title="AI App Gen Server")

init_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176", "http://localhost:5177", "http://localhost:5178"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 一条规则收口：/api/* 全要登录。例外只有下面 auth_router 里的 register/login ——
# 免登录清单写在这一个地方，好核对，也免得将来新增 router 时漏挂依赖。
AUTH: list = [Depends(current_user)]

app.include_router(auth_router)
app.include_router(llm_router, dependencies=AUTH)
app.include_router(mcp_router, dependencies=AUTH)
app.include_router(skills_router, dependencies=AUTH)
app.include_router(sessions_router, dependencies=AUTH)
# 语音是 WebSocket，浏览器带不了自定义 header，所以 current_user 在这里解不出东西 ——
# 它的鉴权在 routes/voice.py 里用 query 上的 token 自己做，见 bearer_from_websocket。
app.include_router(voice_router)
