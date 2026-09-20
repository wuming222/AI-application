import { useState, useRef, useCallback, useEffect } from 'react'
import { message as antdMessage } from 'antd'
import workletUrl from './voice-processor.js?url'
import { voiceWsUrl } from '../api/auth'

type VoiceState = 'idle' | 'connecting' | 'recording' | 'stopping'

interface UseVoiceInputReturn {
  state: VoiceState
  transcript: string
  start: () => Promise<void>
  stop: () => void
}

const SAMPLE_RATE = 16000
const HARD_STOP_MS = 2000

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return buffer
  const ratio = fromRate / toRate
  const newLength = Math.round(buffer.length / ratio)
  const result = new Float32Array(newLength)
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), buffer.length)
    let sum = 0
    for (let j = start; j < end; j++) sum += buffer[j]
    result[i] = sum / (end - start)
  }
  return result
}

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const committedRef = useRef('')
  const openedRef = useRef(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cleanup = useCallback(() => {
    nodeRef.current?.port.close()
    nodeRef.current?.disconnect()
    nodeRef.current = null
    sourceRef.current?.disconnect()
    sourceRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
    }
    audioCtxRef.current = null
  }, [])

  const stop = useCallback(() => {
    cleanup()
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event_id: `event_${Date.now()}`, type: 'session.finish' }))
      setState('stopping')
      timeoutRef.current = setTimeout(() => {
        ws.close()
        wsRef.current = null
        setState('idle')
      }, HARD_STOP_MS)
    } else {
      wsRef.current = null
      setState('idle')
    }
  }, [cleanup])

  const start = useCallback(async () => {
    if (state !== 'idle') return
    setState('connecting')
    setTranscript('')
    committedRef.current = ''
    openedRef.current = false

    const ws = new WebSocket(voiceWsUrl())
    wsRef.current = ws

    ws.onopen = async () => {
      openedRef.current = true
      ws.send(JSON.stringify({
        event_id: `event_${Date.now()}`,
        type: 'session.update',
        session: {
          modalities: ['text'],
          input_audio_format: 'pcm',
          sample_rate: SAMPLE_RATE,
          input_audio_transcription: {
            language: 'zh',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.2,
            silence_duration_ms: 400,
          },
        },
      }))

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream

        const audioCtx = new AudioContext()
        audioCtxRef.current = audioCtx
        await audioCtx.audioWorklet.addModule(workletUrl)
        const source = audioCtx.createMediaStreamSource(stream)
        sourceRef.current = source
        const node = new AudioWorkletNode(audioCtx, 'voice-processor')
        nodeRef.current = node

        node.port.onmessage = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return
          const inputData = e.data as Float32Array
          const downsampled = downsample(inputData, audioCtx.sampleRate, SAMPLE_RATE)
          const int16 = float32ToInt16(downsampled)
          const base64 = arrayBufferToBase64(int16.buffer)
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }))
        }

        source.connect(node)
        node.connect(audioCtx.destination)
        setState('recording')
      } catch (err) {
        console.error('Microphone access denied:', err)
        ws.close()
        setState('idle')
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'conversation.item.input_audio_transcription.text') {
          const full = (msg.text || '') + (msg.stash || '')
          setTranscript(committedRef.current + full)
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          committedRef.current += msg.transcript || ''
          setTranscript(committedRef.current)
        } else if (msg.type === 'session.finished') {
          if (timeoutRef.current) clearTimeout(timeoutRef.current)
          ws.close()
          wsRef.current = null
          setState('idle')
        } else if (msg.type === 'error') {
          console.error('voice ASR error:', msg.error)
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.onerror = (err) => {
      console.error('voice ws error:', err)
      cleanup()
      setState('idle')
    }

    ws.onclose = (event) => {
      if (event.code === 4429) {
        antdMessage.warning('今天的生成次数用完了，明天再来')
      } else if (!openedRef.current) {
        // 握手就被拒：token 缺失或已失效（服务端在 accept 前就 close，拿不到关闭码）
        antdMessage.warning('语音服务连不上，登录可能已过期，刷新页面重新登录')
      } else if (event.code !== 1000) {
        console.warn('voice ws closed:', event.code, event.reason)
      }
      cleanup()
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      setState('idle')
    }
  }, [state, cleanup])

  useEffect(() => {
    return () => {
      cleanup()
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      wsRef.current?.close()
    }
  }, [cleanup])

  return { state, transcript, start, stop }
}
