import type { AgentProgress } from '../agent/types'

interface AgentProgressProps {
  progress: AgentProgress
}

// 对话流内的实时进度块：由 MessageList 渲染在消息末尾，结束后随 isStreaming 卸载。
// 模型思考过程全程不展示（用户决策），reasoning 仍在数据层采集便于调试
export function AgentProgress({ progress }: AgentProgressProps) {
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '75%',
        padding: '10px 14px',
        borderRadius: 12,
        backgroundColor: '#f0f0f0',
        fontSize: 13,
        color: '#666',
      }}
    >
      {progress.steps.map((step, i) => (
        <div key={i} style={{ marginBottom: 4 }}>
          {step.status === 'thinking' && (
            <span>第 {step.round} 轮思考中...</span>
          )}
          {step.status === 'tool-call' && step.toolCalls && (
            <div>
              <span>第 {step.round} 轮执行工具:</span>
              {step.toolCalls.map((tc, j) => (
                <div key={j} style={{ marginLeft: 16, color: tc.status === 'done' ? '#28a745' : '#d68910' }}>
                  {tc.status === 'running' ? '⏳' : '✓'} {tc.name}
                  {tc.args.path && ` (${tc.args.path})`}
                </div>
              ))}
            </div>
          )}
          {step.status === 'done' && (
            <span>✓ 第 {step.round} 轮完成</span>
          )}
        </div>
      ))}
    </div>
  )
}
