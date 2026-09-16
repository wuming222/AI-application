import { describe, it, expect } from 'vitest'
import { STICK_THRESHOLD_PX, isPinnedToBottom, followScrollTop } from '../chatScroll'

const geo = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
})

describe('chatScroll — 流式期间的追滚决策', () => {
  it('贴底判定留阈值：差几行也算贴底', () => {
    expect(isPinnedToBottom(geo(800, 1000, 120))).toBe(true)
    expect(isPinnedToBottom(geo(800, 1000, 120 + STICK_THRESHOLD_PX))).toBe(true)
    expect(isPinnedToBottom(geo(700, 1000, 120))).toBe(false)
  })

  it('内容变长且贴底时，目标是新的底部', () => {
    expect(followScrollTop(geo(800, 1000, 120), true)).toBe(880)
    expect(followScrollTop(geo(880, 1400, 120), true)).toBe(1280)
  })

  it('用户往上翻看历史时不追，哪怕内容一直在长', () => {
    expect(followScrollTop(geo(200, 5000, 600), false)).toBeNull()
  })

  it('已在底部时返回 null：写同样的值也会白触发一轮 scroll', () => {
    expect(followScrollTop(geo(880, 1000, 120), true)).toBeNull()
  })

  it('收起长内容导致底部上移时也不写（浏览器已把 scrollTop 夹到底）', () => {
    expect(followScrollTop(geo(140, 260, 120), true)).toBeNull()
  })

  it('内容不足一屏时不产生负数目标', () => {
    expect(followScrollTop(geo(0, 300, 600), true)).toBeNull()
  })
})
