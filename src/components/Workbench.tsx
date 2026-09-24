/* 工作台：编辑器标签页 + 工具条 + SQL 编辑器 + 结果面板（可拖拽分隔） */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, getAdapter } from '../core/store'
import { IS_EXTENSION } from '../core/storage'
import { ensureConnected, runTabSql } from '../core/connOps'
import { formatSql } from '../core/sql'
import { copyText, downloadText } from '../core/utils'
import { CodeMirrorEditor, type EditorHandle } from './CodeMirrorEditor'
import { ResultsPanel } from './ResultsPanel'
import { Modal } from './Modal'
import { openContextMenu } from './ContextMenu'
import { toast } from './Toast'
import {
  IconCopy, IconDownload, IconPlay, IconPlus, IconSave, IconTrash, IconWrench,
} from './icons'
import type { QueryTab } from '../core/types'

export function Workbench() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const connections = useStore((s) => s.connections)
  const meta = useStore((s) => s.meta)
  const prefs = useStore((s) => s.prefs)
  const tab = tabs.find((t) => t.id === activeTabId)

  const editorRef = useRef<EditorHandle>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)

  const connMeta = tab?.connId ? meta[tab.connId] : undefined

  /* ---------------- 自动补全 schema：表名/别名 → 列名 ---------------- */
  const schemaHint = useMemo(() => {
    const hint: Record<string, string[]> = {}
    if (!connMeta) return hint
    for (const [schema, tables] of Object.entries(connMeta.tables)) {
      tables?.forEach((t) => {
        const cols = connMeta.columns[`${schema}.${t.name}`]
        if (cols?.length) {
          hint[t.name] = cols.map((c) => c.name)
          hint[`${schema}.${t.name}`] = cols.map((c) => c.name)
        } else if (!(t.name in hint)) {
          hint[t.name] = []
        }
      })
    }
    return hint
  }, [connMeta])

  /* 当前标签页 schema 的列缓存预取（供自动补全）：
     优先整库一条 SQL 拉全列（避免表多时逐表请求塞满桥接队列）；
     依赖只到「表清单引用」，列写入不会触发本 effect 重跑 */
  const colLoadRef = useRef<string | null>(null)
  useEffect(() => {
    const connId = tab?.connId
    const schema = tab?.schema
    if (!connId || !schema) return
    const m = useStore.getState().meta[connId]
    const tables = m?.tables[schema]
    if (!tables?.length) return
    if (tables.every((t) => m?.columns[`${schema}.${t.name}`])) return
    const key = `${connId}:${schema}`
    if (colLoadRef.current === key) return
    colLoadRef.current = key
    const cfg = useStore.getState().connections.find((c) => c.id === connId)
    const ad = cfg ? getAdapter(cfg) : undefined
    if (!ad) return
    if (ad.getSchemaColumns) {
      void ad.getSchemaColumns(schema)
        .then((byTable) => {
          for (const [t, cols] of Object.entries(byTable)) {
            if (!useStore.getState().meta[connId]?.columns[`${schema}.${t}`]) {
              useStore.getState().setColumns(connId, schema, t, cols)
            }
          }
        })
        .catch(() => { colLoadRef.current = null /* 失败允许重试 */ })
    } else {
      /* 不支持整库列查询的适配器：逐表加载，每张表最多一次 */
      tables.forEach((t) => {
        if (m?.columns[`${schema}.${t.name}`]) return
        void ad.getColumns(schema, t.name)
          .then((cols) => useStore.getState().setColumns(connId, schema, t.name, cols))
          .catch(() => { /* 补全数据失败静默 */ })
      })
    }
  }, [tab?.connId, tab?.schema, connMeta?.tables[tab?.schema ?? '']])

  /* ---------------- 快捷键：⌘T 新建 / ⌘S 保存 ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        useStore.getState().newTab({ connId: useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId)?.connId })
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        const t = useStore.getState().tabs.find((x) => x.id === useStore.getState().activeTabId)
        if (t) setSaveOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!tab) return <section className="workbench" />

  const cfg = connections.find((c) => c.id === tab.connId)
  const schemas = tab.connId ? meta[tab.connId]?.schemas : undefined

  /* ---------------- 动作 ---------------- */
  const run = () => {
    const sel = editorRef.current?.getSelection()
    void runTabSql(tab.id, sel)
  }

  const doFormat = () => {
    const doc = editorRef.current?.getDoc() ?? tab.sql
    if (!doc.trim()) return
    useStore.getState().setTabSql(tab.id, formatSql(doc))
    toast.success('SQL 已美化')
  }

  const onConnChange = (v: string) => {
    useStore.getState().updateTab(tab.id, { connId: v || undefined, schema: undefined })
    const c = useStore.getState().connections.find((x) => x.id === v)
    if (!c) return
    void ensureConnected(c)
      .then(() => {
        if (c.database) useStore.getState().updateTab(tab.id, { schema: c.database })
      })
      .catch((e) => toast.error(`连接失败：${e instanceof Error ? e.message : String(e)}`))
  }

  /* 结果面板高度拖拽 */
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = useStore.getState().prefs.resultHeight
    const move = (ev: MouseEvent) => {
      const h = Math.max(120, Math.min(window.innerHeight - 280, startH + (startY - ev.clientY)))
      useStore.getState().setPrefs({ resultHeight: h })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'row-resize'
  }

  /* ---------------- 标签页右键菜单 ---------------- */
  const tabMenu = (t: QueryTab) => [
    { label: '重命名', icon: <IconWrench />, onClick: () => setEditingId(t.id) },
    { label: '复制 SQL', icon: <IconCopy />, onClick: () => { void copyText(t.sql).then((ok) => ok && toast.success('已复制 SQL')) } },
    { sep: true },
    { label: '关闭', onClick: () => useStore.getState().closeTab(t.id) },
    {
      label: '关闭其他标签页', disabled: tabs.length <= 1,
      onClick: () => tabs.filter((x) => x.id !== t.id).forEach((x) => useStore.getState().closeTab(x.id)),
    },
    {
      label: '关闭右侧标签页', disabled: tabs.findIndex((x) => x.id === t.id) >= tabs.length - 1,
      onClick: () => {
        const idx = tabs.findIndex((x) => x.id === t.id)
        tabs.slice(idx + 1).forEach((x) => useStore.getState().closeTab(x.id))
      },
    },
    { sep: true },
    { label: '关闭全部', danger: true, onClick: () => [...tabs].forEach((x) => useStore.getState().closeTab(x.id)) },
  ]

  return (
    <section className="workbench">
      {/* 编辑器标签页 */}
      <div className="editor-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`etab ${t.id === activeTabId ? 'on' : ''}`}
            onClick={() => useStore.getState().setActiveTab(t.id)}
            onDoubleClick={() => setEditingId(t.id)}
            onContextMenu={(e) => openContextMenu(e, tabMenu(t))}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); useStore.getState().closeTab(t.id) } }}
            title={t.savedScriptName ? `脚本：${t.savedScriptName}（双击重命名）` : '双击重命名'}
          >
            {editingId === t.id ? (
              <input
                autoFocus defaultValue={t.title}
                style={{ width: 110, fontSize: 12, background: 'var(--bg-0)', border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--text-1)', padding: '1px 5px', outline: 'none' }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onBlur={(e) => { useStore.getState().updateTab(t.id, { title: e.target.value.trim() || t.title }); setEditingId(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <>
                <span className="t-name">{t.title}</span>
                {t.dirty && <span className="dirty" title="脚本有未保存的修改">●</span>}
                <span
                  className="close" title="关闭 (中键点击同样生效)"
                  onClick={(e) => { e.stopPropagation(); useStore.getState().closeTab(t.id) }}
                >✕</span>
              </>
            )}
          </div>
        ))}
        <button
          className="etab-add" title="新建查询标签页 (⌘/Ctrl+T)"
          onClick={() => useStore.getState().newTab({ connId: tab.connId, schema: tab.schema })}
        ><IconPlus /></button>
      </div>

      {/* 工具条 */}
      <div className="editor-toolbar">
        <button
          className={`run-btn ${tab.running ? 'running' : ''}`}
          onClick={run} disabled={tab.running} title="运行当前语句（⌘/Ctrl+Enter）"
        >
          <IconPlay /> {tab.running ? '运行中…' : '运行'}
        </button>

        <select
          className="select editor-schema-select"
          value={tab.connId ?? ''}
          onChange={(e) => onConnChange(e.target.value)}
          title="当前标签页使用的数据库连接"
        >
          <option value="">— 选择连接 —</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <select
          className="select editor-schema-select"
          value={tab.schema ?? ''}
          onChange={(e) => useStore.getState().updateTab(tab.id, { schema: e.target.value || undefined })}
          disabled={!tab.connId}
          title="活动 Schema（未指定时使用连接默认库）"
        >
          <option value="">— Schema —</option>
          {(schemas ?? (tab.schema ? [tab.schema] : [])).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <span style={{ width: 8 }} />

        <button className="btn sm" onClick={() => setSaveOpen(true)} title="保存为脚本 (⌘/Ctrl+S)">
          <IconSave /> {tab.savedScriptName ? (tab.dirty ? '更新脚本 ●' : '已保存') : '保存脚本'}
        </button>
        <button className="btn sm" onClick={doFormat} title="美化 SQL（按分号拆分多条语句逐条格式化）"><IconWrench /> 美化</button>
        <button
          className="btn sm" disabled={!tab.sql.trim()}
          onClick={() => { void copyText(tab.sql).then((ok) => ok && toast.success('已复制 SQL')) }}
          title="复制全部 SQL"
        ><IconCopy /></button>
        <button
          className="btn sm" disabled={!tab.sql.trim()}
          onClick={() => { downloadText(`${tab.title}.sql`, tab.sql, 'application/sql'); toast.success('已下载 .sql 文件') }}
          title="下载为 .sql 文件"
        ><IconDownload /></button>
        <button
          className="btn sm" disabled={!tab.results.length}
          onClick={() => { useStore.getState().clearResults(tab.id); toast.info('已清空结果') }}
          title="清空结果"
        ><IconTrash /></button>

        <span className="toolbar-hint">
          <span className="kbd">⌘/Ctrl</span>+<span className="kbd">Enter</span> 运行 · 选中语句可只运行选中部分
        </span>
      </div>

      {/* 编辑器 */}
      <div className="editor-host">
        <CodeMirrorEditor
          ref={editorRef}
          value={tab.sql}
          onChange={(v) => useStore.getState().setTabSql(tab.id, v)}
          schemaHint={schemaHint}
          onRun={run}
          placeholder="-- 输入 SQL，按 ⌘/Ctrl + Enter 执行"
        />
      </div>

      {/* 可拖拽分隔条 + 结果面板 */}
      <div className="h-resizer" onMouseDown={onResizeStart} title="拖动调整结果区高度" />
      <div style={{ height: prefs.resultHeight, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <ResultsPanel tab={tab} />
      </div>

      {/* 保存脚本弹窗 */}
      {saveOpen && <SaveScriptModal tab={tab} onClose={() => setSaveOpen(false)} />}
    </section>
  )
}

/* ---------------- 保存脚本弹窗 ---------------- */
function SaveScriptModal({ tab, onClose }: { tab: QueryTab; onClose: () => void }) {
  const [name, setName] = useState(tab.savedScriptName ?? tab.title)
  const [mode, setMode] = useState<'update' | 'new'>(tab.savedScriptId ? 'update' : 'new')

  const submit = () => {
    const n = name.trim()
    if (!n) { toast.warn('请输入脚本名称'); return }
    useStore.getState().saveScript({
      id: mode === 'update' ? tab.savedScriptId : undefined,
      name: n, sql: tab.sql, connId: tab.connId, schema: tab.schema,
    })
    toast.success(mode === 'update' ? `已更新脚本「${n}」` : `已保存脚本「${n}」，可在左下方「脚本」面板查看`)
    onClose()
  }

  return (
    <Modal
      title="保存 SQL 脚本"
      sub={`脚本保存在本地（${IS_EXTENSION ? 'chrome.storage' : 'localStorage'}），可随时从左下方「脚本」面板打开`}
      width={460} onClose={onClose}
      foot={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>保存</button>
        </>
      }
    >
      <div className="form-grid">
        <label className="lbl">脚本名称</label>
        <input
          className="input" autoFocus value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder="例如：订单日活统计"
        />
        {tab.savedScriptId && (
          <>
            <label className="lbl">保存方式</label>
            <div style={{ display: 'flex', gap: 16, fontSize: 12.5 }}>
              <label className="checkbox-row">
                <input type="radio" checked={mode === 'update'} onChange={() => setMode('update')} /> 更新原脚本
              </label>
              <label className="checkbox-row">
                <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> 另存为新脚本
              </label>
            </div>
          </>
        )}
        <div className="form-hint">将同时记录脚本所属的连接与 Schema，便于下次打开时自动切换。</div>
      </div>
    </Modal>
  )
}
