import { useSyncExternalStore } from 'react'
import { Switch, Tooltip } from 'antd'
import {
  getExternalToolsSnapshot,
  setServerEnabled,
  subscribeExternalTools,
} from '../agent/externalTools'
import './McpServersPanel.css'

/**
 * 逐 server 的外部工具开关。只有一个状态源（agent/externalTools 的快照），
 * 所以"全部关掉"就是总闸关 —— 不再存一份独立总闸布尔值，也就不会出现
 * "总闸开着但唯一启用的 server 被关了"这种自相矛盾的显示。
 */
export function McpServersPanel() {
  const snapshot = useSyncExternalStore(subscribeExternalTools, getExternalToolsSnapshot)

  if (snapshot.servers.length === 0) {
    return <div className="mcp-panel-empty">未接入外部工具</div>
  }

  return (
    <div className="mcp-panel">
      {snapshot.servers.map((server) => (
        <div key={server.id} className="mcp-panel-row">
          <Tooltip title={`MCP 服务 ${server.id}`} placement="left">
            <span className="mcp-panel-label">{server.label}</span>
          </Tooltip>
          <Switch
            size="small"
            checked={snapshot.enabled[server.id] === true}
            onChange={(on) => setServerEnabled(server.id, on)}
          />
        </div>
      ))}
    </div>
  )
}
