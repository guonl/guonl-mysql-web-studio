/* 侧栏底部面板：已保存脚本 + 执行历史 */
import { useMemo, useState } from 'react'
import { useStore } from '../core/store'
import { openQueryTab } from '../core/connOps'
import { timeAgo, fmtDuration, copyText, downloadText } from '../core/utils'
import { IS_DESKTOP } from '../core/storage'
import { confirmDialog } from './ModalHost'
import { toast } from './Toast'
import { openContextMenu } from './ContextMenu'
import { IconDoc, IconHistory, IconTrash, IconEdit, IconCopy, IconPlus, IconDownload } from './icons'

/* ---------------- 已保存脚本 ---------------- */

/** 文件名安全化：去掉文件系统非法字符 */
const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名脚本'

/** 组装导出内容：头部注释标注来源信息，便于归档识别 */
function buildScriptSql(sc: { name: string; sql: string; connName?: string; schema?: string }): string {
  const head = [
    '-- 导出自 MySQL Web Studio',
    `-- 脚本: ${sc.name}`,
    sc.connName ? `-- 关联连接: ${sc.connName}` : null,
    sc.schema ? `-- Schema: ${sc.schema}` : null,
    `-- 导出时间: ${new Date().toLocaleString()}`,
  ].filter(Boolean).join('\n')
  return `${head}\n\n${sc.sql}\n`
}

export function ScriptsPanel() {
  const scripts = useStore((s) => s.scripts)
  const deleteScript = useStore((s) => s.deleteScript)
  const renameScript = useStore((s) => s.renameScript)
  const [kw, setKw] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const list = useMemo(() => {
    const k = kw.trim().toLowerCase()
    const arr = k
      ? scripts.filter((s) => s.name.toLowerCase().includes(k) || s.sql.toLowerCase().includes(k))
      : scripts
    return [...arr].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [scripts, kw])

  const openScript = (id: string) => {
    const sc = scripts.find((s) => s.id === id)
    if (!sc) return
    // 已有该脚本的标签页则直接切换过去，避免重复开新窗口
    const st = useStore.getState()
    const existed = st.tabs.find((t) => t.savedScriptId === sc.id)
    if (existed) { st.setActiveTab(existed.id); return }
    openQueryTab({
      title: sc.name,
      sql: sc.sql,
      connId: sc.connId,
      schema: sc.schema,
      savedScriptId: sc.id,
      savedScriptName: sc.name,
    })
  }

  const commitRename = () => {
    if (editingId && editName.trim()) {
      renameScript(editingId, editName.trim())
      toast.success('已重命名')
    }
    setEditingId(null)
  }

  /** 导出脚本：单脚本走系统另存为；多脚本桌面端选目录批量写，Web 端逐个下载 */
  const exportScripts = async (targets: typeof scripts) => {
    if (!targets.length) { toast.warn('没有可导出的脚本'); return }
    if (targets.length === 1) {
      const sc = targets[0]
      downloadText(`${safeFileName(sc.name)}.sql`, buildScriptSql(sc))
      toast.success(`已导出「${sc.name}」`)
      return
    }
    if (IS_DESKTOP) {
      const files = targets.map((sc) => ({ name: `${safeFileName(sc.name)}.sql`, content: buildScriptSql(sc) }))
      const r = await window.desktopBridge?.invokeApp?.('exportTextFilesToDir', { files })
      if (!r?.ok) { toast.error(r?.error?.message ?? '导出失败'); return }
      const data = r.data as { canceled: boolean; dir?: string; written?: string[] } | undefined
      if (data && !data.canceled) toast.success(`已导出 ${data.written?.length ?? files.length} 个脚本到 ${data.dir}`)
      return
    }
    targets.forEach((sc) => downloadText(`${safeFileName(sc.name)}.sql`, buildScriptSql(sc)))
    toast.success(`已触发下载 ${targets.length} 个脚本（浏览器下载目录）`)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
        <input
          className="input" style={{ height: 26, fontSize: 12, background: 'var(--bg-3)' }}
          placeholder="过滤脚本（名称 / 内容）"
          value={kw} onChange={(e) => setKw(e.target.value)}
        />
        <button
          className="btn sm icon" title="新建空脚本标签页"
          onClick={() => openQueryTab({ title: '新脚本' })}
        ><IconPlus /></button>
        {scripts.length > 0 && (
          <button
            className="btn sm icon" title="导出全部脚本到指定目录"
            onClick={() => void exportScripts(scripts)}
          ><IconDownload /></button>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {!list.length && (
          <div className="tree-empty">
            {scripts.length ? '没有匹配的脚本' : (
              <>还没有保存的脚本<br />编辑器中点击「保存」即可收藏常用 SQL</>
            )}
          </div>
        )}
        {list.map((sc) => (
          <div key={sc.id} className="script-item" title="双击打开脚本" onDoubleClick={() => openScript(sc.id)}>
            <div className="name">
              <IconDoc />
              {editingId === sc.id ? (
                <input
                  className="input" style={{ height: 22, fontSize: 12, padding: '0 6px' }}
                  value={editName} autoFocus
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : sc.name}
              <span className="ops" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="重命名" onClick={() => { setEditingId(sc.id); setEditName(sc.name) }}><IconEdit /></button>
                <button className="icon-btn" title="复制 SQL" onClick={() => { void copyText(sc.sql).then((ok) => ok ? toast.success('SQL 已复制') : toast.error('复制失败')) }}><IconCopy /></button>
                <button className="icon-btn" title="导出为 .sql 文件" onClick={() => void exportScripts([sc])}><IconDownload /></button>
                <button
                  className="icon-btn danger" title="删除"
                  onClick={() => { void confirmDialog({ title: '删除脚本', message: `确定删除「${sc.name}」吗？`, danger: true }).then((ok) => { if (ok) { deleteScript(sc.id); toast.success('已删除') } }) }}
                ><IconTrash /></button>
              </span>
            </div>
            <div className="sql-preview">{sc.sql.replace(/\s+/g, ' ').slice(0, 90)}</div>
            <div className="meta">
              <span>{timeAgo(sc.updatedAt)}</span>
              {sc.connName && <span>· {sc.connName}</span>}
              {sc.schema && <span>· {sc.schema}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------- 执行历史 ---------------- */
export function HistoryPanel() {
  const history = useStore((s) => s.history)
  const clearHistory = useStore((s) => s.clearHistory)
  const [kw, setKw] = useState('')

  const list = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return k ? history.filter((h) => h.sql.toLowerCase().includes(k)) : history
  }, [history, kw])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
        <input
          className="input" style={{ height: 26, fontSize: 12, background: 'var(--bg-3)' }}
          placeholder="过滤历史 SQL"
          value={kw} onChange={(e) => setKw(e.target.value)}
        />
        <button
          className="btn sm icon danger" title="清空历史"
          onClick={() => {
            void confirmDialog({ title: '清空历史', message: '确定清空全部执行历史吗？该操作不可撤销。', danger: true })
              .then((ok) => { if (ok) { clearHistory(); toast.success('历史已清空') } })
          }}
        ><IconTrash /></button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {!list.length && (
          <div className="tree-empty">
            {history.length ? '没有匹配的记录' : (
              <>执行过的 SQL 会自动记录在这里<br />点击任意记录即可重新打开</>
            )}
          </div>
        )}
        {list.map((h) => (
          <div
            key={h.id}
            className="script-item"
            onClick={() => openQueryTab({ title: '历史', sql: h.sql, connId: h.connId, schema: h.schema })}
            onContextMenu={(e) => openContextMenu(e, [
              { label: '复制 SQL', icon: <IconCopy />, onClick: () => { void copyText(h.sql).then((ok) => ok ? toast.success('SQL 已复制') : toast.error('复制失败')) } },
              { label: '在新标签页打开', icon: <IconDoc />, onClick: () => openQueryTab({ title: '历史', sql: h.sql, connId: h.connId, schema: h.schema }) },
            ])}
          >
            <div className="sql-preview" title={h.sql}>{h.sql.replace(/\s+/g, ' ').slice(0, 100)}</div>
            <div className="meta">
              <span className="status-dot" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: h.ok ? 'var(--ok)' : 'var(--err)', flexShrink: 0 }} />
              <span>{h.ok ? '成功' : '失败'}</span>
              <span>· {fmtDuration(h.durationMs)}</span>
              <span>· {timeAgo(h.at)}</span>
              {h.connName && <span>· {h.connName}</span>}
              <span className="ops" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="复制 SQL" onClick={() => { void copyText(h.sql).then((ok) => ok ? toast.success('SQL 已复制') : toast.error('复制失败')) }}><IconCopy /></button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export const SIDE_TAB_DEFS = [
  { key: 'scripts', label: '脚本', icon: <IconDoc />, Comp: ScriptsPanel },
  { key: 'history', label: '历史', icon: <IconHistory />, Comp: HistoryPanel },
] as const

export type SideTabKey = (typeof SIDE_TAB_DEFS)[number]['key']
