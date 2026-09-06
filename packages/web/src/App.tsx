import { useChatStore } from './store/chatStore'
import { ChatInterface } from './components/ChatInterface'
import { MessageList } from './components/MessageList'
import { AgentProgress } from './components/AgentProgress'

export default function App() {
  const { isStreaming, progress } = useChatStore()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 720, margin: '0 auto' }}>
      <header style={{ padding: '12px 16px', borderBottom: '1px solid #eee', fontWeight: 600 }}>
        AI App Generator (MVP-2)
      </header>
      <MessageList />
      {isStreaming && progress && <AgentProgress progress={progress} />}
      <ChatInterface />
    </div>
  )
}
