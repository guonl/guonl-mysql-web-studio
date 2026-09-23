/* 通用弹窗 + SQL 查看弹窗（复制 / 下载），支持右下角拖拽调整大小 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SqlViewer } from './SqlViewer'
import { copyText, downloadText } from '../core/utils'
import { toast } from './Toast'
import { IconCopy, IconDownload } from './icons'

interface ModalProps {
  title: ReactNode
  sub?: string
  width?: number
  /** 启用右下角拖拽调整大小（适合 DDL / SQL 等内容较长的弹窗） */
  resizable?: boolean
  onClose: () => void
  foot?: ReactNode
  children: ReactNode
}

const MIN_W = 380
const MIN_H = 220
const MAX_W_VW = 0.94
const MAX_H_VH = 0.88

export function Modal({ title, sub, width = 520, resizable = false, onClose, foot, children }: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ sx: number; sy: number; w: number; h: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = boxRef.current
    if (!box) return
    e.preventDefault()
    dragRef.current = { sx: e.clientX, sy: e.clientY, w: box.offsetWidth, h: box.offsetHeight }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const w = Math.min(window.innerWidth * MAX_W_VW, Math.max(MIN_W, d.w + e.clientX - d.sx))
    const h = Math.min(window.innerHeight * MAX_H_VH, Math.max(MIN_H, d.h + e.clientY - d.sy))
    setSize({ w: Math.round(w), h: Math.round(h) })
  }
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="modal"
        ref={boxRef}
        style={size ? { width: size.w, height: size.h, maxWidth: '94vw' } : { width, maxWidth: '94vw' }}
      >
        <div className="modal-head">
          <div className="mh-main">
            <div className="m-title">{title}</div>
            {sub && <div className="m-sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
        {resizable && (
          <div
            className="modal-resize-handle"
            title="拖拽调整弹窗大小"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
          />
        )}
      </div>
    </div>
  )
}

interface SqlModalProps {
  title: string
  sub?: string
  sql: string
  filename?: string
  onClose: () => void
  extraFoot?: ReactNode
}

/** 展示 SQL（DDL / INSERT 等），支持复制与下载；可拖拽调整大小避免 SQL 换行 */
export function SqlModal({ title, sub, sql, filename, onClose, extraFoot }: SqlModalProps) {
  return (
    <Modal
      title={title}
      sub={sub}
      width={760}
      resizable
      onClose={onClose}
      foot={
        <>
          {extraFoot}
          <div className="spacer" />
          <button className="btn" onClick={() => { void copyText(sql).then((ok) => ok ? toast.success('已复制到剪贴板') : toast.error('复制失败，请手动选择复制')) }}>
            <IconCopy /> 复制
          </button>
          <button className="btn primary" onClick={() => { downloadText(filename || 'query.sql', sql, 'application/sql'); toast.success('已下载') }}>
            <IconDownload /> 下载 .sql
          </button>
        </>
      }
    >
      <SqlViewer sql={sql} fill />
    </Modal>
  )
}
