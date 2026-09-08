import { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'
import { compressImage, MAX_IMAGES } from '../utils/compressImage'

export function ChatInterface() {
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const { isStreaming, sendMessage, abort } = useChatStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isStreaming) inputRef.current?.focus()
  }, [isStreaming])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && pendingImages.length === 0) || isStreaming) return
    sendMessage(input, pendingImages.length > 0 ? pendingImages : undefined)
    setInput('')
    setPendingImages([])
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const remaining = MAX_IMAGES - pendingImages.length
    if (remaining <= 0) return
    const toProcess = Array.from(files).slice(0, remaining)
    const compressed = await Promise.all(toProcess.map(compressImage))
    setPendingImages((prev) => [...prev, ...compressed])
  }

  const removeImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index))
  }

  const canAttach = !isStreaming && pendingImages.length < MAX_IMAGES

  return (
    <form onSubmit={handleSubmit} style={{ padding: '12px 16px', borderTop: '1px solid #eee' }}>
      {pendingImages.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {pendingImages.map((src, i) => (
            <div key={i} style={{ position: 'relative', width: 60, height: 60 }}>
              <img src={src} alt="" style={{
                width: 60, height: 60, objectFit: 'cover', borderRadius: 6, border: '1px solid #ddd',
              }} />
              {!isStreaming && (
                <button type="button" onClick={() => removeImage(i)} style={{
                  position: 'absolute', top: -6, right: -6, width: 18, height: 18,
                  borderRadius: '50%', border: 'none', background: '#ef4444', color: '#fff',
                  fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  lineHeight: 1,
                }}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: '#f5f5f5', borderRadius: 24, padding: '4px 4px 4px 16px',
      }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
        />
        <button type="button" disabled={!canAttach} onClick={() => fileRef.current?.click()} style={{
          border: 'none', background: 'transparent', cursor: canAttach ? 'pointer' : 'default',
          fontSize: 18, padding: '4px 8px', opacity: canAttach ? 0.6 : 0.3, lineHeight: 1,
        }}>
          📎
        </button>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入消息..."
          disabled={isStreaming}
          style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent',
            fontSize: 14, padding: '8px 0', minWidth: 0,
          }}
        />
        {isStreaming ? (
          <button type="button" onClick={abort} style={{
            padding: '8px 20px', border: 'none', borderRadius: 20, cursor: 'pointer',
            background: '#ef4444', color: '#fff', fontSize: 14, fontWeight: 500,
            whiteSpace: 'nowrap',
          }}>
            停止
          </button>
        ) : (
          <button type="submit" disabled={isStreaming} style={{
            padding: '8px 20px', border: 'none', borderRadius: 20, cursor: 'pointer',
            background: '#1a73e8', color: '#fff', fontSize: 14, fontWeight: 500,
            whiteSpace: 'nowrap', opacity: isStreaming ? 0.5 : 1,
          }}>
            发送
          </button>
        )}
      </div>
    </form>
  )
}
