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
 *
 * `skill` 一家不在这里出现：它的清单与逐技能开关同在 SkillPanel（技能要占的空间不是一个开关行放得下的）。
 */
function SourceRow({ source, enabled }: { source: CapabilitySourceInfo; enabled: boolean }) {
  return (
    <div className="capability-panel-row">
      <Tooltip title={`能力 ${source.id}`} placement="left">
        <span className="capability-panel-label">{source.label}</span>
      </Tooltip>
      <Switch size="small" checked={enabled} onChange={(on) => setSourceEnabled(source.id, on)} />
    </div>
  )
}

export function CapabilityPanel() {
  const snapshot = useSyncExternalStore(subscribeCapabilities, getCapabilitySnapshot)
  const sources = snapshot.sources.filter((s) => s.kind !== 'skill')

  if (sources.length === 0) {
    return <div className="capability-panel-empty">未接入外部工具</div>
  }

  return (
    <div className="capability-panel">
      <div className="capability-panel-group">
        <div className="capability-panel-title">外部工具</div>
        {sources.map((s) => (
          <SourceRow key={s.id} source={s} enabled={snapshot.enabled[s.id] === true} />
        ))}
      </div>
    </div>
  )
}
