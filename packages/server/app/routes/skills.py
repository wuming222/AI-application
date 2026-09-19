"""skill 的四个只读端点（目录 / 检索 / 正文 / references 文件）。

契约与 `routes/mcp.py` 一致：**HTTP 状态码不表达工具成败**，四个端点恒 200，成败在 body 的
`is_error` / `errors` 里。前端因此不需要分两条错误路径 —— 这点在"上游 200 但业务失败"和
"网关 502"混着来的场合值回票价。

上游（AgentExplorer 与 raw.githubusercontent）都是匿名接口，本模块没有任何 key 可泄；
但 `/file` 的 `path` 由请求方给，是本特性唯一的注入面，校验全部在发出外部请求之前完成。
"""

from fastapi import APIRouter, Query

from app.skills import catalog

router = APIRouter(prefix="/api/skills", tags=["skills"])


@router.get("/catalog")
async def get_catalog(refresh: bool = False):
    """全量目录（逐个类目翻页取全 + 去重 + 条数守卫）。前端用它渲染技能列表与常驻索引。"""
    return await catalog.get_catalog(refresh)


@router.get("/search")
async def search_skills(
    keyword: str = Query("", max_length=200),
    maxResults: int = Query(20, ge=1, le=100),
):
    if not keyword.strip():
        return {"skills": [], "errors": [{"source": "agent-skills", "message": "keyword 不能为空"}]}
    return await catalog.search(keyword.strip(), maxResults)


@router.get("/content")
async def get_skill_content(name: str = Query(..., min_length=1, max_length=200)):
    """一份 SKILL.md 正文，已按 K4 的 32,000 字符上界截断。"""
    return await catalog.get_content(name)


@router.get("/file")
async def get_skill_file(
    name: str = Query(..., min_length=1, max_length=200),
    path: str = Query(..., min_length=1, max_length=400),
):
    """该技能包内的一个 references/*.md，已按 K6 的 16,000 字符上界截断。"""
    return await catalog.get_reference(name, path)
