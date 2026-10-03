import { useSyncExternalStore } from 'react'
import { Switch, Tooltip } from 'antd'
import { getCapabilitySnapshot, setSourceEnabled, subscribeCapabilities } from '../agent/capabilityStore'
import type { CapabilityKind, CapabilitySourceInfo } from '../agent/types'
import './CapabilityPanel.css'

/**
 * 能力开关面板：只有一个状态源（agent/capabilityStore 的快照），按 kind 分节渲染。
 *
 * 刻意不另存"总闸"布尔值 —— 全部关掉就是每个 source 都关，否则会出现
 * "总闸开着但唯一启用的 source 被关了"这种自相矛盾的显示。
 *
 * `skill` 一家不在这里出现：它的清单与逐技能开关同在 SkillPanel（技能要占的空间不是一个开关行放得下的）。
 * 剩下的家按 kind 分节，不挤在同一标题下 —— "历史参考"每轮无条件前置、不注册任何工具，
 * 把它列进"外部工具"会让人以为它是第 N 个 MCP 服务。
 */

/** 没在这张表里的 kind 落进"其他"：宁可标题不准，也不要让一个开关静默消失。 */
const GROUP_TITLE: Partial<Record<CapabilityKind, string>> = {
  mcp: '外部工具',
  rag: '检索',
}
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
  const rows = snapshot.sources.filter((s) => s.kind !== 'skill')
  const titles = [...new Set(rows.map((s) => GROUP_TITLE[s.kind] ?? '其他'))]

  if (rows.length === 0) {
    return <div className="capability-panel-empty">未接入外部工具</div>
  }

  return (
    <div className="capability-panel">
      {titles.map((title) => (
        <div className="capability-panel-group" key={title}>
          <div className="capability-panel-title">{title}</div>
          {rows
            .filter((s) => (GROUP_TITLE[s.kind] ?? '其他') === title)
            .map((s) => (
              <SourceRow key={s.id} source={s} enabled={snapshot.enabled[s.id] === true} />
            ))}
        </div>
      ))}
    </div>
  )
}
