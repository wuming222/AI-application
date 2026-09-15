import { useState, useRef, useEffect } from 'react'
import { Input, Button, message as antdMessage } from 'antd'
import { PaperClipOutlined, SendOutlined } from '@ant-design/icons'
import { useChatStore } from '../store/chatStore'
import { compressImage, MAX_IMAGES } from '../utils/compressImage'
import { useVoiceInput } from '../hooks/useVoiceInput'

const { TextArea } = Input

export function ChatInterface() {
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const { isStreaming, sendMessage, abort } = useChatStore()
  const inputRef = useRef<any>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { state: voiceState, transcript, start: startVoice, stop: stopVoice } = useVoiceInput()
  const lastTranscriptLen = useRef(0)

  useEffect(() => {
    if (!isStreaming) inputRef.current?.focus()
  }, [isStreaming])

  useEffect(() => {
    if (transcript.length > lastTranscriptLen.current) {
      const newText = transcript.slice(lastTranscriptLen.current)
      setInput((prev) => prev + newText)
      lastTranscriptLen.current = transcript.length
    }
    if (voiceState === 'idle' && transcript.length > 0) {
      lastTranscriptLen.current = 0
    }
  }, [transcript, voiceState])

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if ((!input.trim() && pendingImages.length === 0) || isStreaming) return
    sendMessage(input, pendingImages.length > 0 ? pendingImages : undefined)
    setInput('')
    setPendingImages([])
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const remaining = MAX_IMAGES - pendingImages.length
    if (remaining <= 0) {
      antdMessage.warning(`最多只能上传 ${MAX_IMAGES} 张图片`)
      return
    }
    const toProcess = Array.from(files).slice(0, remaining)
    const compressed = await Promise.all(toProcess.map(compressImage))
    setPendingImages((prev) => [...prev, ...compressed])
  }

  const removeImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index))
  }

  const canAttach = !isStreaming && pendingImages.length < MAX_IMAGES
  const isRecording = voiceState === 'recording'
  const voiceDisabled = isStreaming || voiceState === 'connecting' || voiceState === 'stopping'

  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid #eee' }}>
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
        background: '#f5f5f5',
        borderRadius: 18,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
        padding: '12px 16px',
      }}>
        <TextArea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息...（Shift+Enter 换行）"
          disabled={isStreaming}
          autoSize={{ minRows: 1, maxRows: 6 }}
          variant="borderless"
          style={{
            fontSize: 14,
            resize: 'none',
            marginBottom: 8,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
            />
            <Button
              type="text"
              disabled={!canAttach}
              onClick={() => fileRef.current?.click()}
              icon={<PaperClipOutlined />}
              style={{ fontSize: 18, opacity: canAttach ? 0.6 : 0.3 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              type="text"
              disabled={voiceDisabled}
              onClick={isRecording ? stopVoice : startVoice}
              style={{
                fontSize: 18,
                opacity: voiceDisabled ? 0.3 : 1,
                color: isRecording ? '#ef4444' : 'inherit',
                animation: isRecording ? 'pulse 1s ease-in-out infinite' : 'none',
              }}
            >
              🎤
            </Button>
            {isStreaming ? (
              <Button
                type="primary"
                danger
                onClick={abort}
                style={{ borderRadius: 20 }}
              >
                停止
              </Button>
            ) : (
              <Button
                type="primary"
                onClick={() => handleSubmit()}
                disabled={(!input.trim() && pendingImages.length === 0) || isStreaming}
                icon={<SendOutlined />}
                style={{ borderRadius: 20 }}
              />
            )}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
