import asyncio

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import LLM_API_KEY

router = APIRouter(prefix="/api/voice", tags=["voice"])

UPSTREAM_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime"


@router.websocket("/ws")
async def voice_ws(websocket: WebSocket):
    await websocket.accept()

    headers = {"Authorization": f"Bearer {LLM_API_KEY}"}

    try:
        async with websockets.connect(UPSTREAM_URL, additional_headers=headers) as upstream:

            async def client_to_upstream():
                try:
                    while True:
                        message = await websocket.receive_text()
                        await upstream.send(message)
                except WebSocketDisconnect:
                    pass

            async def upstream_to_client():
                try:
                    async for message in upstream:
                        await websocket.send_text(message)
                except websockets.ConnectionClosed:
                    pass

            done, pending = await asyncio.wait(
                [
                    asyncio.ensure_future(client_to_upstream()),
                    asyncio.ensure_future(upstream_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
    except Exception as e:
        try:
            await websocket.close(code=1011, reason=str(e))
        except Exception:
            pass
