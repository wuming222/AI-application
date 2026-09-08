import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import { buildSrcdoc } from '../preview/buildSrcdoc'

export function PreviewArea() {
  const files = useWorkspaceStore((s) => s.files)
  const [manualKey, setManualKey] = useState(0)
  const srcdoc = useMemo(() => buildSrcdoc(files), [files])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid #eee' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>预览</span>
        <button
          type="button"
          onClick={() => setManualKey((k) => k + 1)}
          disabled={srcdoc === null}
          style={{ padding: '4px 12px', fontSize: 13 }}
        >
          刷新
        </button>
      </div>
      {srcdoc !== null ? (
        <iframe
          key={manualKey}
          title="preview"
          srcDoc={srcdoc}
          sandbox="allow-scripts"
          style={{ flex: 1, width: '100%', border: 'none' }}
        />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14 }}>
          生成 index.html 后可预览
        </div>
      )}
    </div>
  )
}
