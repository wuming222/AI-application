import type { AgentProgress } from '../agent/types'
import './AgentProgress.css'

interface AgentProgressProps {
  progress: AgentProgress
}

// 对话流内的实时进度块：由 MessageList 渲染在消息末尾，结束后随 isStreaming 卸载。
// 仅第一轮显示 reasoning 内容，后续轮次隐藏推理过程
export function AgentProgress({ progress }: AgentProgressProps) {
  return (
    <div className="agent-progress-container">
      {progress.steps.map((step, i) => (
        <div key={i} className="agent-step">
          {step.status === 'thinking' && (
            <>
              <span className="agent-thinking">
                <span className="agent-spinner" />
                第 {step.round} 轮思考中...
              </span>
              {step.round === 1 && step.reasoningText && (
                <div className="agent-reasoning">
                  {step.reasoningText}
                </div>
              )}
            </>
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
        </div>
      ))}
    </div>
  )
}
