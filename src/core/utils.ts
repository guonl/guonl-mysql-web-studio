/* 通用小工具 */

let seq = 0
export function uid(prefix = 'id'): string {
  seq = (seq + 1) % 100000
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function timeAgo(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  if (d < 86_400_000 * 30) return `${Math.floor(d / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString()
}

export function fmtTime(ts: number): string {
  const dt = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`
}

export function fmtDateTime(ts: number | Date): string {
  const dt = ts instanceof Date ? ts : new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getMonth() + 1}/${dt.getDate()} ${p(dt.getHours())}:${p(dt.getMinutes())}`
}

export function fmtDuration(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

/** 复制文本到剪贴板（带降级） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

/** 触发浏览器下载 */
export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/** 判断列值是否应按数字渲染 */
export function isNumLike(v: unknown): boolean {
  return typeof v === 'number' || typeof v === 'bigint'
}

export function valueToText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') {
    // Buffer/Uint8Array
    if (v instanceof Uint8Array) return `0x${Array.from(v.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join('')}${v.length > 32 ? '…' : ''}`
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}
