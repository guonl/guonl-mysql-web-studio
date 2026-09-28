/* 会话历史弹窗：按最近交互时间倒序展示，支持关键字搜索 / 重命名 / 删除 / 进入会话 */
import { useMemo, useRef, useState } from 'react'
import { Modal } from '../Modal'
import { confirmDialog } from '../ModalHost'
import { toast } from '../Toast'
import { IconEdit, IconTrash } from '../icons'
import { sessionMessagesOf, useAiStore } from '../../ai/store'

/** 时间展示：今天 HH:mm；今年 MM-DD HH:mm；跨年 YYYY-MM-DD HH:mm */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const sameYear = d.getFullYear() === now.getFullYear()
  if (sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`
}

export function AiSessionHistoryModal({ onClose }: { onClose: () => void }) {
  const sessions = useAiStore((s) => s.sessions)
  const sessionId = useAiStore((s) => s.sessionId)
  const [kw, setKw] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const cancelRef = useRef(false) // Esc 取消重命名时抑制 onBlur 保存

  /* 时间倒序 + 关键字过滤（匹配标题或任一消息内容）；从未产生过对话的空会话不展示 */
  const list = useMemo(() => {
    const q = kw.trim().toLowerCase()
    return [...sessions]
      .filter((s) => sessionMessagesOf(s.id).length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((s) => {
        if (!q) return true
        if (s.title.toLowerCase().includes(q)) return true
        return sessionMessagesOf(s.id).some((m) => m.content.toLowerCase().includes(q))
      })
  }, [sessions, kw])

  const enter = (id: string) => {
    useAiStore.getState().switchSession(id)
    onClose()
  }

  const startEdit = (id: string, title: string) => {
    cancelRef.current = false
    setEditingId(id)
    setEditText(title)
  }

  const saveRename = () => {
    if (cancelRef.current) { cancelRef.current = false; return }
    if (editingId && editText.trim()) {
      useAiStore.getState().renameSession(editingId, editText)
      toast.success('已重命名')
    }
    setEditingId(null)
  }

  const cancelEdit = () => {
    cancelRef.current = true
    setEditingId(null)
  }

  const remove = (id: string, title: string) => {
    void confirmDialog({
      title: '删除会话',
      message: <>确定删除会话「{title}」及其全部消息吗？删除后不可恢复。</>,
      danger: true,
    }).then((ok) => {
      if (!ok) return
      useAiStore.getState().deleteSession(id)
      toast.success('会话已删除')
    })
  }

  return (
    <Modal title="会话历史" sub="按最近交互时间倒序，点击记录继续会话" width={560} onClose={onClose}>
      <div className="ai-hist">
        <input
          className="input ai-hist-search"
          placeholder="搜索会话标题或内容关键字…"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          autoFocus
        />
        {list.length === 0 ? (
          <div className="ai-hist-empty">{kw ? '没有匹配的会话' : '暂无历史会话'}</div>
        ) : (
          <div className="ai-hist-list">
            {list.map((s) => (
              <div
                key={s.id}
                className={`ai-hist-item${s.id === sessionId ? ' is-current' : ''}`}
                onClick={() => { if (editingId !== s.id) enter(s.id) }}
              >
                {editingId === s.id ? (
                  <input
                    className="input ai-hist-edit"
                    value={editText}
                    autoFocus
                    onChange={(e) => setEditText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={saveRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename()
                      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cancelEdit() } // 阻止冒泡到 Modal 的全局 Esc（避免误关弹窗）
                    }}
                  />
                ) : (
                  <div className="ai-hist-main">
                    <div className="ai-hist-title">{s.title}</div>
                    <div className="ai-hist-sub">
                      <span className="ai-hist-time">{formatTime(s.updatedAt)}</span>
                      {s.schema && <span className="ai-hist-schema">{s.schema}</span>}
                      {s.id === sessionId && <span className="ai-hist-cur">当前</span>}
                    </div>
                  </div>
                )}
                <span className="ai-hist-ops" onClick={(e) => e.stopPropagation()}>
                  {editingId === s.id ? (
                    <button className="btn sm primary" onClick={saveRename}>保存</button>
                  ) : (
                    <button className="btn sm icon" title="重命名" onClick={() => startEdit(s.id, s.title)}><IconEdit /></button>
                  )}
                  <button className="btn sm icon" title="删除会话" onClick={() => remove(s.id, s.title)}><IconTrash /></button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
