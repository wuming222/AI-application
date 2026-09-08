import { ChatInterface } from './components/ChatInterface'
import { MessageList } from './components/MessageList'
import { AgentProgress } from './components/AgentProgress'
import { PreviewArea } from './components/PreviewArea'
import { useChatStore } from './store/chatStore'

export default function App() {
  const { isStreaming, progress } = useChatStore()

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, maxWidth: 720, margin: '0 auto' }}>
        <header style={{ padding: '12px 16px', borderBottom: '1px solid #eee', fontWeight: 600 }}>
          AI App Generator (MVP-4)
        </header>
        <MessageList />
        {isStreaming && progress && <AgentProgress progress={progress} />}
        <ChatInterface />
      </div>
      <div style={{ width: '45%', minWidth: 380 }}>
        <PreviewArea />
      </div>
    </div>
  )
}
