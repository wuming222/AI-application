"""花费记账的接缝：默认只记不拦。

服务端一把共享 `LLM_API_KEY`，注册公开之后"陌生人烧我的钱"是真实的，但用户当前还在调试期，
闸门唯一会挡住的人是他自己。所以这一轮把**记账**与**拦截**拆成两件事：

- 记账现在就在 5 个花钱入口各写一行；
- 拦截由 `SPEND_DAILY_LIMIT` 控制，**默认 0 = 不限**。将来开闸是改一个环境变量，
  不是在这 5 个地方各插一次判断 —— 那才是重构。

计数单位取"每人每天的生成轮数"，不是 token：token 计量本身至今未校（见 `docs/origin/26-9-19.md`
第 10 节），拿没测准的量当闸门是假精确。一轮只会从 `llm_chat_completions` 或 `llm_responses`
起头，所以只有这两个入口计入限额；`title` 与 `mcp_call` 是一轮之内的副产品（一次生成会调
N 次工具），把它们计入同一个数会把限额的含义搅浑 —— 它们仍然记录，只是不进那个计数。

存储是进程内 dict，重启即清零。这在当前阶段无害（不拦任何东西），也避免为一个还没定的上限
先建表；`record` 的签名里 `entry` 是字符串，将来落库不用改调用点。
"""

from __future__ import annotations

import os
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import HTTPException

SPEND_DAILY_LIMIT = int(os.environ.get("SPEND_DAILY_LIMIT", "0") or 0)

# 计入"轮"的入口。其余入口只记录，不占用限额。
COUNTED_ENTRIES = frozenset({"llm_chat_completions", "llm_responses"})

LIMIT_DETAIL = "今天的生成次数用完了，明天再来"


@dataclass
class _Counters:
    turns: int = 0
    entries: dict = field(default_factory=lambda: defaultdict(int))


_by_user: dict[str, _Counters] = {}
_by_day: dict[str, dict[str, _Counters]] = {}


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _bucket() -> dict[str, _Counters]:
    # 跨天时整盘换掉，等于"每人每天"自动归零，不需要定时任务。
    day = _today()
    if _by_day.get("day") != day:
        _by_day.clear()
        _by_day["day"] = day
        _by_user.clear()
    return _by_user


def record(user_id: str, entry: str) -> None:
    """记一笔；只有开了限额且这一笔计入轮数时才可能抛 429。"""
    counters = _bucket().setdefault(user_id, _Counters())
    counters.entries[entry] += 1
    counted = entry in COUNTED_ENTRIES
    if counted:
        counters.turns += 1
    if SPEND_DAILY_LIMIT > 0 and counted and counters.turns > SPEND_DAILY_LIMIT:
        counters.turns -= 1  # 被拒的这一次不该占用额度
        raise HTTPException(status_code=429, detail=LIMIT_DETAIL)


def snapshot(user_id: str) -> dict:
    """给断言脚本和以后的运维看一眼用，不进任何对外响应。"""
    counters = _by_user.get(user_id)
    if counters is None:
        return {"turns": 0, "entries": {}, "limit": SPEND_DAILY_LIMIT}
    return {"turns": counters.turns, "entries": dict(counters.entries), "limit": SPEND_DAILY_LIMIT}
