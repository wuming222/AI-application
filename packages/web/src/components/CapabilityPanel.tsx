import { useSyncExternalStore } from 'react'
import { Switch, Tooltip } from 'antd'
import { getCapabilitySnapshot, setSourceEnabled, subscribeCapabilities } from '../agent/capabilityStore'
import type { CapabilitySourceInfo } from '../agent/types'
import './CapabilityPanel.css'

/**
 * 能力开关面板：只有一个状态源（agent/capabilityStore 的快照），按 kind 分组渲染。
 *
 * 刻意不另存"总闸"布尔值 —— 全部关掉就是每个 source 都关，否则会出现
 * "总闸开着但唯一启用的 source 被关了"这种自相矛盾的显示。
 */
function SourceRow({ source, enabled }: { source: CapabilitySourceInfo; enabled: boolean }) {
  return (
    <div className="capability-panel-row">
      <Tooltip title={`${source.kind === 'mcp' ? 'MCP 服务' : '技能库'} ${source.id}`} placement="left">
        <span className="capability-panel-label">{source.label}</span>
      </Tooltip>
      <Switch size="small" checked={enabled} onChange={(on) => setSourceEnabled(source.id, on)} />
    </div>
  )
}

export function CapabilityPanel() {
  const snapshot = useSyncExternalStore(subscribeCapabilities, getCapabilitySnapshot)
  const groups = (['mcp', 'skill'] as const)
    .map((kind) => ({ kind, sources: snapshot.sources.filter((s) => s.kind === kind) }))
    .filter((g) => g.sources.length > 0)

  if (groups.length === 0) {
    return <div className="capability-panel-empty">未接入能力</div>
  }

  return (
    <div className="capability-panel">
      {groups.map((g) => (
        <div key={g.kind} className="capability-panel-group">
          <div className="capability-panel-title">{g.kind === 'mcp' ? '外部工具（MCP）' : '技能库'}</div>
          {g.sources.map((s) => (
            <SourceRow key={s.id} source={s} enabled={snapshot.enabled[s.id] === true} />
          ))}
        </div>
      ))}
    </div>
  )
}
