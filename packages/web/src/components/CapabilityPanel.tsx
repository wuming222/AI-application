import { useEffect, useReducer, useState, useSyncExternalStore } from 'react'
import { Button, Checkbox, Input, Switch, Tooltip } from 'antd'
import { getCapabilitySnapshot, setSourceEnabled, subscribeCapabilities } from '../agent/capabilityStore'
import type { CapabilitySourceInfo } from '../agent/types'
import {
  GENERATE_ONLY_NOTICE,
  SKILL_SOURCE_ID,
  getSelectedSkillNames,
  getSkillCatalogState,
  loadSkillCatalog,
  renderSkillIndex,
  resolveSelectedSkills,
  searchSkills,
  setSkillSelected,
  subscribeSkillsStore,
} from '../agent/providers/skills'
import type { SkillSummary } from '../agent/providers/skills'
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

/**
 * 技能勾选集。
 *
 * 与上面的开关是两件事：开关决定"这三个工具体不体现给模型"，勾选决定"哪些技能常驻系统提示的索引"。
 * 两者都是全局偏好，不进 bySession、不落库。
 */
function SkillPicker({ disabled }: { disabled: boolean }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<SkillSummary[] | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => subscribeSkillsStore(rerender), [rerender])
  useEffect(() => {
    void loadSkillCatalog()
  }, [])

  const catalog = getSkillCatalogState()
  const selected = getSelectedSkillNames()
  // 预算判定复用索引渲染那一份逻辑，面板与注入段不会各算一套
  const usage = renderSkillIndex(resolveSelectedSkills(selected, catalog.skills).found)
  const rows = results ?? catalog.skills

  const runSearch = async (text: string) => {
    const trimmed = text.trim()
    setKeyword(trimmed)
    if (!trimmed) {
      setResults(null)
      return
    }
    setSearching(true)
    try {
      setResults(await searchSkills(trimmed, 30))
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className={`capability-panel-skills${disabled ? ' is-disabled' : ''}`}>
      <div className="capability-panel-notice">{GENERATE_ONLY_NOTICE}</div>
      <div className="capability-panel-sub">
        已选 {selected.length} 个技能
        {usage.omitted > 0 && (
          <span className="capability-panel-over-cap">（索引预算已满，{usage.omitted} 个未列入目录）</span>
        )}
      </div>
      <Input.Search
        placeholder="搜索技能，如 OSS 同步"
        size="small"
        allowClear
        loading={searching}
        onSearch={(v) => void runSearch(v)}
        onChange={(e) => {
          if (!e.target.value) void runSearch('')
        }}
      />
      <div className="capability-panel-list">
        {rows.length === 0 && (
          <div className="capability-panel-empty">
            {catalog.loaded ? (keyword ? '没有匹配的技能' : '目录为空') : '技能目录未加载'}
          </div>
        )}
        {rows.map((s) => {
          const checked = selected.includes(s.name)
          // 预算满时只禁"新勾"，已勾的随时可取消 —— 否则用户会被自己锁死
          const blocked = !checked && usage.omitted > 0
          return (
            <Tooltip
              key={s.name}
              title={blocked ? '常驻索引已达 9,000 字符上限，先取消一些；未列入目录的技能仍可用 skill_search 找到' : s.description}
              placement="left"
            >
              <label className="capability-panel-item">
                <Checkbox
                  checked={checked}
                  disabled={disabled || blocked}
                  onChange={(e) => setSkillSelected(s.name, e.target.checked)}
                />
                <span className="capability-panel-item-name">{s.name}</span>
              </label>
            </Tooltip>
          )
        })}
      </div>
      <div className="capability-panel-actions">
        <Button size="small" type="text" loading={searching} onClick={() => void loadSkillCatalog(true)}>
          刷新目录
        </Button>
        {catalog.errors.length > 0 && (
          <Tooltip title={catalog.errors.join('；')} placement="left">
            <span className="capability-panel-error">目录有 {catalog.errors.length} 处异常</span>
          </Tooltip>
        )}
      </div>
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
          {g.kind === 'skill' && <SkillPicker disabled={snapshot.enabled[SKILL_SOURCE_ID] !== true} />}
        </div>
      ))}
    </div>
  )
}
