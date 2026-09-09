class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.size = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    this.chunks.push(new Float32Array(channel))
    this.size += channel.length
    if (this.size >= 4096) {
      const frame = new Float32Array(this.size)
      let offset = 0
      for (const chunk of this.chunks) {
        frame.set(chunk, offset)
        offset += chunk.length
      }
      this.port.postMessage(frame, [frame.buffer])
      this.chunks = []
      this.size = 0
    }
    return true
  }
}

registerProcessor('voice-processor', VoiceProcessor)
