import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from app.config import LLM_BASE_URL, LLM_API_KEY, LLM_MODEL

router = APIRouter(prefix="/api/llm")


async def _proxy_to_upstream(upstream_path: str, body: bytes):
    upstream_url = f"{LLM_BASE_URL}{upstream_path}"
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))
    try:
        upstream = await client.send(
            client.build_request("POST", upstream_url, content=body, headers=headers),
            stream=True,
        )
    except httpx.ConnectError as e:
        await client.aclose()
        return JSONResponse(status_code=502, content={"error": f"Upstream unreachable: {e}"})
    except httpx.TimeoutException as e:
        await client.aclose()
        return JSONResponse(status_code=504, content={"error": f"Upstream timeout: {e}"})

    if upstream.status_code != 200:
        err_body = await upstream.aread()
        await upstream.aclose()
        await client.aclose()
        return Response(content=err_body, status_code=upstream.status_code, media_type="application/json")

    is_stream = b'"stream":true' in body or b'"stream": true' in body

    if is_stream:
        async def event_generator():
            try:
                async for chunk in upstream.aiter_bytes(chunk_size=1024):
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(event_generator(), media_type="text/event-stream")
    else:
        data = await upstream.aread()
        await upstream.aclose()
        await client.aclose()
        return Response(content=data, media_type="application/json")


@router.post("/chat/completions")
async def chat_completions(request: Request):
    body = await request.body()
    return await _proxy_to_upstream("/chat/completions", body)


@router.post("/responses")
async def responses(request: Request):
    body = await request.body()
    return await _proxy_to_upstream("/responses", body)


class TitleRequest(BaseModel):
    message: str


@router.post("/title")
async def generate_title(body: TitleRequest):
    upstream_url = f"{LLM_BASE_URL}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": "用不超过10个字概括用户消息的主题，作为会话标题。只输出标题文本，不要引号、标点或解释。"},
            {"role": "user", "content": body.message},
        ],
        "stream": False,
    }

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
    try:
        resp = await client.post(upstream_url, json=payload, headers=headers)
    except Exception as e:
        await client.aclose()
        return JSONResponse(status_code=502, content={"error": str(e)})

    if resp.status_code != 200:
        err = resp.text
        await client.aclose()
        return JSONResponse(status_code=resp.status_code, content={"error": err})

    data = resp.json()
    await client.aclose()
    title = data["choices"][0]["message"]["content"].strip().strip('"').strip("'")[:20]
    return {"title": title}
