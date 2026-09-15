import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import { buildSrcdoc } from '../preview/buildSrcdoc'
import './PreviewArea.css'

// 没有文件时保持同一个对象引用，避免下游 useMemo / effect 每轮渲染都重算
const EMPTY_FILES: Record<string, string> = {}

// 超大文件只渲染前这么多字符，避免整块 DOM 卡住
const MAX_VIEW_CHARS = 200_000

export function PreviewArea() {
  const filesBySession = useWorkspaceStore((s) => s.filesBySession)
  const currentSessionId = useWorkspaceStore((s) => s.currentSessionId)
  const files = currentSessionId ? (filesBySession[currentSessionId] ?? EMPTY_FILES) : EMPTY_FILES
  const [manualKey, setManualKey] = useState(0)
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const srcdoc = useMemo(() => buildSrcdoc(files), [files])
  const paths = useMemo(() => Object.keys(files).sort(), [files])

  // 切换会话或文件被删后，选中项可能已不存在：回落到 index.html，再没有就取第一个
  useEffect(() => {
    if (selectedPath && paths.includes(selectedPath)) return
    setSelectedPath(paths.includes('index.html') ? 'index.html' : (paths[0] ?? null))
  }, [paths, selectedPath])

  const selectedContent = selectedPath ? (files[selectedPath] ?? '') : ''
  const isTruncated = selectedContent.length > MAX_VIEW_CHARS

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
        <div className="preview-tabs">
          <button
            type="button"
            className={`preview-tab ${view === 'preview' ? 'active' : ''}`}
            onClick={() => setView('preview')}
          >
            预览
          </button>
          <button
            type="button"
            className={`preview-tab ${view === 'code' ? 'active' : ''}`}
            onClick={() => setView('code')}
          >
            代码
          </button>
        </div>
        <div className="preview-actions">
          {view === 'preview' && (
            <button type="button" onClick={() => setManualKey((k) => k + 1)} disabled={srcdoc === null}>
              刷新
            </button>
          )}
          <button type="button" onClick={downloadIndex} disabled={srcdoc === null}>
            下载 index.html
          </button>
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
          <div className="code-file-list">
            {paths.length === 0 && <div className="code-empty">还没有生成文件</div>}
            {paths.map((p) => (
              <button
                key={p}
                type="button"
                className={`code-file ${p === selectedPath ? 'selected' : ''}`}
                onClick={() => setSelectedPath(p)}
              >
                <span className="code-file-path">{p}</span>
                <span className="code-file-size">{files[p].length} 字符</span>
              </button>
            ))}
          </div>
          <div className="code-viewer">
            {selectedPath ? (
              <>
                <div className="code-viewer-path">{selectedPath}</div>
                <pre className="code-content">
                  {isTruncated ? selectedContent.slice(0, MAX_VIEW_CHARS) : selectedContent}
                </pre>
                {isTruncated && (
                  <div className="code-note">
                    文件较大，仅展示前 {MAX_VIEW_CHARS} 字符，下载可查看完整内容
                  </div>
                )}
              </>
            ) : (
              <div className="code-empty">选择左侧文件查看内容</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
