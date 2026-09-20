import { useChatStore } from './chatStore'
import { useSessionStore } from './sessionStore'
import { useWorkspaceStore } from './workspaceStore'

/**
 * 换账号（登出、或登录成另一个人）时把**属于会话的一切**清空。
 *
 * 为什么需要它：登录态是全局一份，但会话列表、消息分片、工作区文件都是"上一个人"的数据。
 * 不清的话，下一个人登录后点开的还是前一个人的会话 id —— 服务端现在会回 404，
 * 但界面会停在一个既不是空态也不是有效会话的中间状态里。
 *
 * 顺序上先 abortStream：它会把在飞那一路的代际标记自增，之后的迟到写入都会被挡掉，
 * 再把分片整体清空才安全（反过来会留一条还在往里写的路）。
 *
 * 能力开关（capabilities-enabled / skills-selected）**不在这里清** —— 那是全局偏好，
 * 按定位不归属任何一条会话，也不归属任何一个账号。
 */
export function resetAccountState(): void {
  const chat = useChatStore.getState()
  if (chat.streamSessionId) chat.abortStream()

  useChatStore.setState({ bySession: {}, streamSessionId: null })
  useWorkspaceStore.setState({ filesBySession: {}, currentSessionId: null })
  useSessionStore.setState({ sessions: [], currentSessionId: null, isLoading: false })
}
