from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.llm import router as llm_router

app = FastAPI(title="AI App Gen Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(llm_router)
