// 生成过程中"界面多久没变化"的判定。只产提示文案，不做任何中断决定 ——
// 是否停止仍由人点「停止」按钮决定。
export const STALL_NOTICE_MS = 30_000

export function stallNoticeFor(idleMs: number): string | null {
  if (idleMs < STALL_NOTICE_MS) return null
  const seconds = Math.floor(idleMs / 1000)
  return `已 ${seconds} 秒没有新进展，可能在生成较大的文件。可以继续等待，也可以点「停止」中断本轮。`
}
