import type { AgentProgress } from '../agent/types'
import './AgentProgress.css'

interface AgentProgressProps {
  progress: AgentProgress
}

// 对话流内的实时进度块：由 MessageList 渲染在消息末尾，结束后随 isStreaming 卸载。
// 仅第一轮显示 reasoning 内容，后续轮次隐藏推理过程
export function AgentProgress({ progress }: AgentProgressProps) {
  return (
    <div
      className="agent-progress-container"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '75%',
        padding: '12px 16px',
        borderRadius: 16,
        background: 'linear-gradient(135deg, rgba(240, 240, 240, 0.95) 0%, rgba(245, 245, 245, 0.9) 100%)',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
        fontSize: 13,
        color: '#555',
      }}
    >
      {progress.steps.map((step, i) => (
        <div 
          key={i} 
          style={{ 
            marginBottom: i < progress.steps.length - 1 ? 10 : 0,
            animation: 'slideInBottom 0.3s ease-out',
          }}
        >
          {step.status === 'thinking' && (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ 
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  border: '2px solid #4a9eff',
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                第 {step.round} 轮思考中...
              </span>
              {step.round === 1 && step.reasoningText && (
                <div
                  style={{
                    marginTop: 10,
                    padding: '8px 12px',
                    paddingLeft: 12,
                    background: 'linear-gradient(135deg, #f0f7ff 0%, #e8f4ff 100%)',
                    borderLeft: '4px solid #4a9eff',
                    borderRadius: 6,
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.7,
                    fontSize: 13.5,
                    animation: 'fadeIn 0.2s ease-in',
                    transition: 'all 0.2s ease',
                  }}
                >
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
                const statusColor = tc.status === 'done' ? '#2ecc71' : '#f39c12'
                return (
                  <div 
                    key={j} 
                    style={{ 
                      marginLeft: 16, 
                      color: statusColor,
                      fontWeight: 500,
                    }}
                  >
                    <span style={{ fontSize: 14, marginRight: 4 }}>{icon}</span>
                    {tc.name}
                    {!isBuiltIn && tc.args.path && ` (${tc.args.path})`}
                  </div>
                )
              })}
            </div>
          )}
          {step.status === 'done' && (
            <span style={{ color: '#2ecc71', fontWeight: 500 }}>
              ✓ 第 {step.round} 轮完成
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
