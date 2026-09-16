import { describe, it, expect } from 'vitest'
import { STALL_NOTICE_MS, stallNoticeFor } from '../stallWatch'

describe('stallWatch', () => {
  it('阈值是 30 秒', () => {
    expect(STALL_NOTICE_MS).toBe(30_000)
  })

  it('未到阈值不出提示，到阈值才出', () => {
    expect(stallNoticeFor(STALL_NOTICE_MS - 1)).toBeNull()
    expect(stallNoticeFor(STALL_NOTICE_MS)).toContain('30 秒')
  })

  it('提示里报出实际等待秒数', () => {
    expect(stallNoticeFor(75_000)).toContain('75 秒')
  })

  it('文案把处置权留给用户：引导点停止，不宣称会自动中断', () => {
    const notice = stallNoticeFor(40_000) ?? ''
    expect(notice).toContain('停止')
    expect(notice).not.toMatch('已自动')
  })
})
