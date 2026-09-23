/* 全局 Toast 通知 */
import { useEffect, useState } from 'react'
import { IconInfo, IconWarn } from './icons'
import { uid } from '../core/utils'

export type ToastKind = 'success' | 'error' | 'warn' | 'info'

interface ToastItem { id: string; msg: string; kind: ToastKind }

let listeners: Array<(t: ToastItem) => void> = []

function push(msg: string, kind: ToastKind) {
  const t: ToastItem = { id: uid('t'), msg, kind }
  listeners.forEach((l) => l(t))
}

export const toast = {
  success: (m: string) => push(m, 'success'),
  error: (m: string) => push(m, 'error'),
  warn: (m: string) => push(m, 'warn'),
  info: (m: string) => push(m, 'info'),
}

const KIND_ICON: Record<ToastKind, React.ReactNode> = {
  success: '✓',
  error: <IconWarn />,
  warn: <IconWarn />,
  info: <IconInfo />,
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => {
    const l = (t: ToastItem) => {
      setItems((xs) => [...xs.slice(-4), t])
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id || undefined)), 3800)
    }
    listeners.push(l)
    return () => { listeners = listeners.filter((x) => x !== l) }
  }, [])
  if (!items.length) return null
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span style={{ display: 'flex', marginTop: 1 }}>{KIND_ICON[t.kind]}</span>
          <div className="t-msg">{t.msg}</div>
        </div>
      ))}
    </div>
  )
}
