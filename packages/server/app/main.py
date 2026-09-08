from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.llm import router as llm_router
from app.routes.sessions import router as sessions_router
from app.database import init_db

app = FastAPI(title="AI App Gen Server")

init_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176", "http://localhost:5177", "http://localhost:5178"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(llm_router)
app.include_router(sessions_router)
