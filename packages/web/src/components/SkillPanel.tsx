import { useEffect, useReducer, useState } from 'react'
import { Button, Input, Switch, Tooltip } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import {
  GENERATE_ONLY_NOTICE,
  SKILL_ORIGIN_TAGS,
  SKILL_SOURCE_LABEL,
  getEnabledSkillNames,
  getSkillCatalogState,
  loadSkillCatalog,
  renderSkillIndex,
  resolveEnabledSkills,
  searchSkills,
  setSkillEnabled,
  subscribeSkillsStore,
} from '../agent/providers/skills'
import type { SkillSummary } from '../agent/providers/skills'
import './SkillPanel.css'

/**
 * 技能面板：一行一个技能 + 小开关，形态与「能力」面板里的 MCP 行一致。
 *
 * 这里**没有总闸**（09-20 去掉）：逐技能开关就是唯一状态，一个都不开等于整家关 ——
 * 再放一个"整体开/关"会造出第二个真相源，而且总闸关掉之后那一列按不动的开关比干脆没有更绕。
 * 内置与百炼两家在同一列里各标各的来源标签，开关语义完全相同。
 */
export function SkillPanel() {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<SkillSummary[] | null>(null)
  const [searchError, setSearchError] = useState('')
  const [searching, setSearching] = useState(false)

  useEffect(() => subscribeSkillsStore(rerender), [rerender])
  useEffect(() => {
    void loadSkillCatalog()
  }, [])

  const catalog = getSkillCatalogState()
  const enabledNames = getEnabledSkillNames()
  // 预算判定复用索引渲染那一份逻辑，面板与注入段不会各算一套
  const usage = renderSkillIndex(resolveEnabledSkills(enabledNames, catalog.skills).found)
  const rows = results ?? catalog.skills

  const runSearch = async (text: string) => {
    const trimmed = text.trim()
    setKeyword(trimmed)
    setSearchError('')
    if (!trimmed) {
      setResults(null)
      return
    }
    setSearching(true)
    try {
      setResults(await searchSkills(trimmed, 30))
    } catch (err) {
      // 不能退成空列表：那会把"上游没响应"画成"没有这个技能"
      setResults([])
      setSearchError((err as Error).message)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="skill-panel">
      <div className="skill-panel-head">
        <span className="skill-panel-title">{SKILL_SOURCE_LABEL}</span>
        <span className="skill-panel-count">已开 {enabledNames.length} 个</span>
      </div>
      <div className="skill-panel-notice">{GENERATE_ONLY_NOTICE}</div>
      {usage.omitted > 0 && (
        <div className="skill-panel-over-cap">
          常驻索引预算（9,000 字符）已满，{usage.omitted} 个已开技能未列入目录，模型需用 skill_search 找到它们。
        </div>
      )}
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
      <div className="skill-panel-list">
        {rows.length === 0 && (
          <div className="skill-panel-empty">
            {searchError
              ? `检索失败：${searchError}（这不是"没有匹配的技能"，是这次请求没成）`
              : catalog.loaded
                ? keyword
                  ? '没有匹配的技能'
                  : '目录为空'
                : '技能目录未加载'}
          </div>
        )}
        {rows.map((s) => {
          const on = enabledNames.includes(s.name)
          return (
            <div className="skill-panel-item" key={s.name}>
              <Tooltip title={s.description} placement="left">
                <span className="skill-panel-item-label">
                  <span className="skill-panel-item-tag">{SKILL_ORIGIN_TAGS[s.origin]}</span>
                  <span className="skill-panel-item-name">{s.name}</span>
                </span>
              </Tooltip>
              <Switch size="small" checked={on} onChange={(next) => setSkillEnabled(s.name, next)} />
            </div>
          )
        })}
      </div>
      <div className="skill-panel-actions">
        <Tooltip title="刷新目录" placement="top">
          <Button size="small" type="text" icon={<ReloadOutlined />} loading={searching} onClick={() => void loadSkillCatalog(true)} />
        </Tooltip>
        {catalog.errors.length > 0 && (
          <Tooltip title={catalog.errors.join('；')} placement="left">
            <span className="skill-panel-error">目录有 {catalog.errors.length} 处异常</span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
