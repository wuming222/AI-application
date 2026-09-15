import { useMemo, useState } from 'react'
import { Button, Segmented } from 'antd'
import 'highlight.js/styles/github.css'
import { highlightCode } from '../preview/highlight'
import { useWorkspaceStore } from '../store/workspaceStore'
import { buildSrcdoc } from '../preview/buildSrcdoc'
import './PreviewArea.css'

// 没有文件时保持同一个对象引用，避免下游 useMemo 每轮渲染都重算
const EMPTY_FILES: Record<string, string> = {}

// 超大文件只渲染前这么多字符，避免整块 DOM 卡住
const MAX_VIEW_CHARS = 200_000

type PreviewView = 'preview' | 'code'

const VIEW_OPTIONS: { label: string; value: PreviewView }[] = [
  { label: '预览', value: 'preview' },
  { label: '代码', value: 'code' },
]

export function PreviewArea() {
  const filesBySession = useWorkspaceStore((s) => s.filesBySession)
  const currentSessionId = useWorkspaceStore((s) => s.currentSessionId)
  const files = currentSessionId ? (filesBySession[currentSessionId] ?? EMPTY_FILES) : EMPTY_FILES
  const [manualKey, setManualKey] = useState(0)
  const [view, setView] = useState<PreviewView>('preview')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const srcdoc = useMemo(() => buildSrcdoc(files), [files])
  const paths = useMemo(() => Object.keys(files).sort(), [files])

  // 切换会话或文件被删后选中项可能已不存在：直接推导回落，不用副作用同步 state
  const activePath =
    selectedPath && paths.includes(selectedPath)
      ? selectedPath
      : paths.includes('index.html')
        ? 'index.html'
        : (paths[0] ?? null)

  const selectedContent = activePath ? (files[activePath] ?? '') : ''
  const isTruncated = selectedContent.length > MAX_VIEW_CHARS
  const viewContent = isTruncated ? selectedContent.slice(0, MAX_VIEW_CHARS) : selectedContent
  const highlighted = useMemo(
    () => (activePath ? highlightCode(viewContent, activePath) : ''),
    [activePath, viewContent],
  )

  const downloadIndex = () => {
    if (srcdoc === null) return
    const blob = new Blob([srcdoc], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'index.html'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid #eee' }}>
      <div className="preview-header">
        <Segmented options={VIEW_OPTIONS} value={view} onChange={(v) => setView(v as PreviewView)} />
        <div className="preview-actions">
          {view === 'preview' && (
            <Button size="small" onClick={() => setManualKey((k) => k + 1)} disabled={srcdoc === null}>
              刷新
            </Button>
          )}
          <Button size="small" onClick={downloadIndex} disabled={srcdoc === null}>
            下载
          </Button>
        </div>
      </div>

      {/* iframe 始终挂载，只切 display：条件渲染会让它重新加载，丢掉生成应用的内部状态 */}
      <div className="preview-body" style={{ display: view === 'preview' ? 'block' : 'none' }}>
        {srcdoc !== null ? (
          <iframe
            key={manualKey}
            title="preview"
            srcDoc={srcdoc}
            sandbox="allow-scripts"
            style={{ flex: 1, width: '100%', height: '100%', border: 'none' }}
          />
        ) : (
          <div className="preview-placeholder">生成 index.html 后可预览</div>
        )}
      </div>

      {view === 'code' && (
        <div className="code-pane">
          {paths.length === 0 ? (
            <div className="code-empty">还没有生成文件</div>
          ) : (
            <>
              {/* 只在 >1 文件时出现。对应 antd 组件是 Menu，但它自带缩进/内边距，
                  且本机没有多文件会话数据可做视觉验证 —— 有意保留原生 button */}
              {paths.length > 1 && (
                <div className="code-file-list">
                  {paths.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`code-file ${p === activePath ? 'selected' : ''}`}
                      onClick={() => setSelectedPath(p)}
                    >
                      <span className="code-file-path">{p}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="code-viewer">
                <div className="code-viewer-path">{activePath}</div>
                <pre className="code-content">
                  <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                </pre>
                {isTruncated && (
                  <div className="code-note">
                    文件较大，仅展示前 {MAX_VIEW_CHARS} 字符，下载可查看完整内容
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
