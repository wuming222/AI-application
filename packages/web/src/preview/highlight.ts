import hljs from 'highlight.js/lib/common'

const LANGUAGE_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function languageOf(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXT[ext] ?? null
}

/**
 * 返回可渲染的 HTML 字符串。hljs 会转义代码正文，输出里只含它自己生成的 hljs-* span；
 * 扩展名认不出来或语言未注册时退回转义后的纯文本，不返回未转义内容。
 */
export function highlightCode(code: string, path: string): string {
  const lang = languageOf(path)
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code)
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
}
