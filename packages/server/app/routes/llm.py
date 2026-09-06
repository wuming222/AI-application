import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from app.config import LLM_BASE_URL, LLM_API_KEY

router = APIRouter(prefix="/api/llm")


@router.post("/chat/completions")
async def chat_completions(request: Request):
    body = await request.body()
    upstream_url = f"{LLM_BASE_URL}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            upstream = await client.send(
                client.build_request("POST", upstream_url, content=body, headers=headers),
                stream=True,
            )
    except httpx.ConnectError as e:
        return JSONResponse(status_code=502, content={"error": f"Upstream unreachable: {e}"})
    except httpx.TimeoutException as e:
        return JSONResponse(status_code=504, content={"error": f"Upstream timeout: {e}"})

    if upstream.status_code != 200:
        err_body = await upstream.aread()
        await upstream.aclose()
        return Response(content=err_body, status_code=upstream.status_code, media_type="application/json")

    is_stream = b'"stream":true' in body or b'"stream": true' in body

    if is_stream:
        async def event_generator():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            except Exception:
                # Client disconnected or upstream error during streaming; silently stop
                pass
            finally:
                await upstream.aclose()

        return StreamingResponse(event_generator(), media_type="text/event-stream")
    else:
        data = await upstream.aread()
        await upstream.aclose()
        return Response(content=data, media_type="application/json")
