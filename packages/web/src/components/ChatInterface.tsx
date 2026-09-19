import { useState, useRef, useEffect } from 'react'
import { Input, Button, Popover, Tooltip, message as antdMessage } from 'antd'
import { ApiOutlined, PaperClipOutlined, SendOutlined } from '@ant-design/icons'
import './ChatInterface.css'
import { useChatStore } from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { compressImage, MAX_IMAGES } from '../utils/compressImage'
import { useVoiceInput } from '../hooks/useVoiceInput'
import { CapabilityPanel } from './CapabilityPanel'

const { TextArea } = Input

export function ChatInterface() {
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  // 只有"这条会话自己在生成"才锁输入；别的路在跑不影响这里发送
  const isStreaming = useChatStore((s) =>
    currentSessionId ? !!s.bySession[currentSessionId]?.isStreaming : false,
  )
  const sendMessage = useChatStore((s) => s.sendMessage)
  const abortStream = useChatStore((s) => s.abortStream)
  const composerFocusTick = useChatStore((s) => s.composerFocusTick)
  const inputRef = useRef<any>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { state: voiceState, transcript, start: startVoice, stop: stopVoice } = useVoiceInput()
  const lastTranscriptLen = useRef(0)

  useEffect(() => {
    if (!isStreaming) inputRef.current?.focus()
  }, [isStreaming])

  // 复用当前空会话时列表没有变化，靠聚焦输入框给出反馈
  useEffect(() => {
    inputRef.current?.focus()
  }, [composerFocusTick])

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
    <div className="chat-composer">
      {pendingImages.length > 0 && (
        <div className="pending-images">
          {pendingImages.map((src, i) => (
            <div key={i} className="pending-image-chip">
              <img src={src} alt="" className="pending-image" />
              {/* 有意保留原生 button：18px 圆形浮标不是 antd Button 的形态 */}
              {!isStreaming && (
                <button type="button" className="image-remove" onClick={() => removeImage(i)}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="composer-box">
        <TextArea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息...（Shift+Enter 换行）"
          disabled={isStreaming}
          autoSize={{ minRows: 1, maxRows: 6 }}
          variant="borderless"
          className="composer-input"
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="file-input"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
            />
            <Button
              type="text"
              className="attach-btn"
              disabled={!canAttach}
              onClick={() => fileRef.current?.click()}
              icon={<PaperClipOutlined />}
            />
            <Popover trigger="click" placement="topLeft" content={<CapabilityPanel />}>
              <Tooltip title="能力（外部工具 / 技能）">
                <Button type="text" className="capability-btn" icon={<ApiOutlined />} />
              </Tooltip>
            </Popover>
          </div>
          <div className="composer-actions">
            <Button
              type="text"
              className={`voice-btn ${isRecording ? 'is-recording' : ''}`}
              disabled={voiceDisabled}
              onClick={isRecording ? stopVoice : startVoice}
            >
              🎤
            </Button>
            {isStreaming ? (
              <Button
                type="primary"
                danger
                className="send-btn"
                onClick={abortStream}
              >
                停止
              </Button>
            ) : (
              <Button
                type="primary"
                className="send-btn"
                onClick={() => handleSubmit()}
                disabled={(!input.trim() && pendingImages.length === 0) || isStreaming}
                icon={<SendOutlined />}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
