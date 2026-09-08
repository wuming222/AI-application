import { useEffect, useRef } from 'react'
import type { AgentProgress } from '../agent/types'

interface AgentProgressProps {
  progress: AgentProgress
}

export function AgentProgress({ progress }: AgentProgressProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [progress.steps])

  return (
    <div style={{ padding: '8px 16px', fontSize: 13, color: '#666', maxHeight: 200, overflowY: 'auto' }}>
      {progress.steps.map((step, i) => (
        <div key={i} style={{ marginBottom: 4 }}>
          {step.status === 'thinking' && (
            <span>第 {step.round} 轮思考中...</span>
          )}
          {step.reasoningText && (
            <details style={{ marginLeft: 16, color: '#999' }}>
              <summary style={{ cursor: 'pointer', fontSize: 12 }}>思考过程</summary>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 4 }}>
                {step.reasoningText}
              </div>
            </details>
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
      {progress.finished && (
        <div style={{ fontWeight: 'bold', color: '#333' }}>生成完成</div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
