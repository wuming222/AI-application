import { useEffect, useRef, useState } from 'react'
import type { AgentProgress as AgentProgressState } from '../agent/types'
import { stallNoticeFor } from '../agent/stallWatch'
import './AgentProgress.css'

interface AgentProgressProps {
  progress: AgentProgressState
}

// 对话流内的实时进度块：由 MessageList 渲染在消息末尾，结束后随 isStreaming 卸载。
// 仅第一轮显示 reasoning 内容，后续轮次隐藏推理过程
export function AgentProgress({ progress }: AgentProgressProps) {
  // 无进展计时量的是"界面多久没变过"，不是"上游多久没发帧"：
  // 工具参数流式期间帧一直在来却没有可渲染事件，数帧的计时器永远不会超时。
  const lastChangeAt = useRef(0)
  const [idleMs, setIdleMs] = useState(0)

  useEffect(() => {
    lastChangeAt.current = Date.now()
  }, [progress])

  useEffect(() => {
    const timer = setInterval(() => setIdleMs(Date.now() - lastChangeAt.current), 1000)
    return () => clearInterval(timer)
  }, [])

  const stallNotice = stallNoticeFor(idleMs)

  return (
    <div className="agent-progress-container">
      {progress.steps.map((step, i) => (
        <div key={i} className="agent-step">
          {step.status === 'thinking' && (
            <span className="agent-thinking">
              <span className="agent-spinner" />
              第 {step.round} 轮思考中...
            </span>
          )}
          {step.status === 'tool-call' && step.toolCalls && (
            <div>
              <span>第 {step.round} 轮执行工具:</span>
              {step.toolCalls.map((tc, j) => {
                const isBuiltIn = tc.name === 'web_search'
                const icon = isBuiltIn ? '🔍' : tc.status === 'running' ? '⏳' : '✓'
                const path = typeof tc.args.path === 'string' ? tc.args.path : ''
                return (
                  <div key={j} className={`tool-run ${tc.status === 'done' ? 'is-done' : 'is-running'}`}>
                    <span className="tool-run-icon">{icon}</span>
                    {tc.name}
                    {!isBuiltIn && path && ` (${path})`}
                  </div>
                )
              })}
            </div>
          )}
          {step.status === 'done' && (
            <span className="agent-done">
              ✓ 第 {step.round} 轮完成
            </span>
          )}
          {/* reasoning 与 status 解耦：状态切到执行工具时，不能把用户刚看完的推理文字整块抽走 */}
          {step.round === 1 && step.reasoningText && (
            <div className="agent-reasoning">
              {step.reasoningText}
            </div>
          )}
        </div>
      ))}
      {stallNotice && <div className="agent-stall">{stallNotice}</div>}
    </div>
  )
}
