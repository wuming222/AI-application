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
          {step.status === 'thinking' ? (
            <span>第 {step.round} 轮思考中... {step.thinkingText.slice(-60)}</span>
          ) : (
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
