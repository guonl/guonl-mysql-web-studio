/* 全局右键菜单 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export interface CtxItem {
  label?: string
  icon?: ReactNode
  kbd?: string
  danger?: boolean
  disabled?: boolean
  sep?: boolean
  onClick?: () => void
}

let openFn: ((x: number, y: number, items: CtxItem[]) => void) | null = null

/** 在 (x,y) 打开右键菜单（也可由 click 打开：内部会阻断冒泡，避免 window 上的 click 关闭监听把刚打开的菜单立即关掉） */
export function openContextMenu(
  e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation?(): void },
  items: CtxItem[],
) {
  e.preventDefault()
  e.stopPropagation?.()
  openFn?.(e.clientX, e.clientY, items.filter((i) => i.sep || (!i.disabled && i.label)))
}

export function ContextMenuHost() {
  const [st, setSt] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null)

  useEffect(() => {
    openFn = (x, y, items) => setSt({ x, y, items })
    const close = () => setSt(null)
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      openFn = null
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [])

  useEffect(() => {
    if (!st) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSt(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [st])

  if (!st) return null

  // 防止菜单超出视口
  const W = 220
  const h = st.items.reduce((s, i) => s + (i.sep ? 9 : 30), 8)
  const x = Math.min(st.x, window.innerWidth - W - 8)
  const y = Math.min(st.y, window.innerHeight - h - 8)

  return (
    <div className="ctx-menu" style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      {st.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div
            key={i}
            className={`ctx-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
            onClick={() => { setSt(null); it.onClick?.() }}
          >
            {it.icon && <span className="ctx-icon">{it.icon}</span>}
            <span>{it.label}</span>
            {it.kbd && <span className="ctx-kbd">{it.kbd}</span>}
          </div>
        ),
      )}
    </div>
  )
}
