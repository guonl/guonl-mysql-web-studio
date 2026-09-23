/* 通用弹窗 + SQL 查看弹窗（复制 / 下载） */
import { useEffect, type ReactNode } from 'react'
import { SqlViewer } from './SqlViewer'
import { copyText, downloadText } from '../core/utils'
import { toast } from './Toast'
import { IconCopy, IconDownload } from './icons'

interface ModalProps {
  title: ReactNode
  sub?: string
  width?: number
  onClose: () => void
  foot?: ReactNode
  children: ReactNode
}

export function Modal({ title, sub, width = 520, onClose, foot, children }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width, maxWidth: '94vw' }}>
        <div className="modal-head">
          <div className="mh-main">
            <div className="m-title">{title}</div>
            {sub && <div className="m-sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
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

/** 展示 SQL（DDL / INSERT 等），支持复制与下载 */
export function SqlModal({ title, sub, sql, filename, onClose, extraFoot }: SqlModalProps) {
  return (
    <Modal
      title={title}
      sub={sub}
      width={760}
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
      <SqlViewer sql={sql} />
    </Modal>
  )
}
