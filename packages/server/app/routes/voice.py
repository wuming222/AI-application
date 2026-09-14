import asyncio
import base64
import json
import uuid

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import LLM_API_KEY

router = APIRouter(prefix="/api/voice", tags=["voice"])

# Qwen-Audio-3.0-ASR-Flash-Streaming uses DashScope native protocol
# URL format: wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
# For simplicity, we use the old domain which still works for some models
UPSTREAM_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"


@router.websocket("/ws")
async def voice_ws(websocket: WebSocket):
    await websocket.accept()

    headers = {"Authorization": f"Bearer {LLM_API_KEY}"}
    task_id = str(uuid.uuid4())

    try:
        async with websockets.connect(UPSTREAM_URL, additional_headers=headers) as upstream:
            # Send run-task to initialize
            run_task = {
                "header": {
                    "action": "run-task",
                    "task_id": task_id,
                    "streaming": "duplex",
                },
                "payload": {
                    "task_group": "audio",
                    "task": "asr",
                    "function": "recognition",
                    "model": "qwen-audio-3.0-asr-flash-streaming",
                    "parameters": {
                        "format": "pcm",
                        "sample_rate": 16000,
                        "language_hints": ["zh"],
                        "semantic_punctuation_enabled": False,
                        "max_sentence_silence": 400,
                    },
                    "input": {},
                },
            }
            await upstream.send(json.dumps(run_task))

            # Wait for task-started before sending audio
            first_msg = await upstream.recv()
            first_data = json.loads(first_msg)
            if first_data.get("header", {}).get("event") != "task-started":
                await websocket.close(code=1011, reason="Failed to start task")
                return

            async def client_to_upstream():
                """Convert frontend JSON (base64 audio) to binary PCM for upstream."""
                try:
                    while True:
                        message = await websocket.receive_text()
                        data = json.loads(message)
                        msg_type = data.get("type")
                        if msg_type == "input_audio_buffer.append":
                            # Decode base64 audio and send as binary
                            audio_bytes = base64.b64decode(data["audio"])
                            await upstream.send(audio_bytes)
                        elif msg_type == "session.finish":
                            # Send finish-task
                            finish_task = {
                                "header": {
                                    "action": "finish-task",
                                    "task_id": task_id,
                                    "streaming": "duplex",
                                },
                                "payload": {"input": {}},
                            }
                            await upstream.send(json.dumps(finish_task))
                except WebSocketDisconnect:
                    pass

            async def upstream_to_client():
                """Forward upstream events to frontend as JSON."""
                try:
                    async for message in upstream:
                        # Check if binary or text
                        if isinstance(message, bytes):
                            # Binary audio frames from upstream - skip (not needed for ASR)
                            continue
                        # Text JSON event
                        data = json.loads(message)
                        event_type = data.get("header", {}).get("event")

                        if event_type == "result-generated":
                            sentence = data.get("payload", {}).get("output", {}).get("sentence", {})
                            text = sentence.get("text", "")
                            is_end = sentence.get("sentence_end", False)

                            if is_end:
                                # Final result
                                await websocket.send_text(json.dumps({
                                    "type": "conversation.item.input_audio_transcription.completed",
                                    "transcript": text,
                                }))
                            else:
                                # Partial result
                                await websocket.send_text(json.dumps({
                                    "type": "conversation.item.input_audio_transcription.text",
                                    "text": "",
                                    "stash": text,
                                }))
                        elif event_type == "task-finished":
                            await websocket.send_text(json.dumps({"type": "session.finished"}))
                            break
                        elif event_type == "task-failed":
                            error_msg = data.get("header", {}).get("error_message", "Unknown error")
                            await websocket.send_text(json.dumps({
                                "type": "error",
                                "error": {"message": error_msg},
                            }))
                            break
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
