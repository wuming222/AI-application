export interface ScrollGeometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// 差一点也算贴底：新行刚插进来时必然差一行高度，阈值太严会在流式途中自己脱钩
export const STICK_THRESHOLD_PX = 120

export function isPinnedToBottom(el: ScrollGeometry, threshold = STICK_THRESHOLD_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/**
 * 该不该追滚、滚到哪。pinned 为 false 表示用户在往上翻看历史，不打扰。
 * 返回 null 表示这次不需要写 scrollTop（写同样的值也会触发 scroll 事件，白跑一轮）。
 */
export function followScrollTop(el: ScrollGeometry, pinned: boolean): number | null {
  if (!pinned) return null
  const target = el.scrollHeight - el.clientHeight
  return target > el.scrollTop ? target : null
}
