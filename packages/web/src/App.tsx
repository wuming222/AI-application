import { ChatInterface } from './components/ChatInterface'
import { MessageList } from './components/MessageList'

export default function App() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 720, margin: '0 auto' }}>
      <header style={{ padding: '12px 16px', borderBottom: '1px solid #eee', fontWeight: 600 }}>
        AI App Generator (MVP-0)
      </header>
      <MessageList />
      <ChatInterface />
    </div>
  )
}
