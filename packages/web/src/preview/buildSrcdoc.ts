import { useWorkspaceStore } from '../store/workspaceStore'

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
}

function resolveRelative(base: string, href: string): string {
  if (normalizePath(href) === href && !href.startsWith('./') && !href.startsWith('../')) {
    return normalizePath(href)
  }
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const combined = href.startsWith('/') ? href : `${baseDir}/${href}`
  const parts: string[] = []
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

// sandbox="allow-scripts"（无 allow-same-origin）下 iframe 是不透明源，
// 访问 localStorage/sessionStorage 会抛 SecurityError，AI 生成的应用常用到存储，
// 在访问抛错时用内存 Map 顶替，保证应用能继续运行。
const STORAGE_SHIM = `<script>
(function () {
  function makeShim() {
    var store = new Map();
    return {
      getItem: function (k) { return store.has(String(k)) ? store.get(String(k)) : null },
      setItem: function (k, v) { store.set(String(k), String(v)) },
      removeItem: function (k) { store.delete(String(k)) },
      clear: function () { store.clear() },
      key: function (i) { return Array.from(store.keys())[i] ?? null },
      get length() { return store.size },
    }
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { window[name].getItem('__probe__') } catch (e) {
      Object.defineProperty(window, name, { value: makeShim(), configurable: true })
    }
  })
})()
</script>`

export function buildSrcdoc(files: Record<string, string>): string | null {
  const entry = files['index.html']
  if (entry === undefined) return null

  let html = entry

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${STORAGE_SHIM}`)
  } else {
    html = `${STORAGE_SHIM}\n${html}`
  }

  html = html.replace(
    /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,
    (match, href: string) => {
      if (!/stylesheet/i.test(match)) return match
      const css = files[resolveRelative('index.html', href)]
      return css !== undefined ? `<style>\n${css}\n</style>` : match
    },
  )

  html = html.replace(
    /<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (match, src: string) => {
      const js = files[resolveRelative('index.html', src)]
      if (js === undefined) return match
      const isModule = /type=["']module["']/i.test(match)
      return `<script${isModule ? ' type="module"' : ''}>\n${js}\n</script>`
    },
  )

  return html
}

export function getPreviewSrcdoc(): string | null {
  return buildSrcdoc(useWorkspaceStore.getState().files)
}
