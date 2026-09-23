/* 左侧资源树：连接 → Schema → 表/视图 → 列 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, getAdapter } from '../core/store'
import { ensureConnected, disconnectConn, runTabSql, openQueryTab } from '../core/connOps'
import type { ConnectionConfig, TableMeta } from '../core/types'
import { copyText } from '../core/utils'
import { buildTopN, quoteTable } from '../core/sql'
import { openContextMenu } from './ContextMenu'
import { openConnModal, openExportModal, openSqlModal, exportTableCsv, confirmDialog } from './ModalHost'
import { toast } from './Toast'
import { SIDE_TAB_DEFS } from './SidePanels'

const ScriptsPanelComp = SIDE_TAB_DEFS[0].Comp
const HistoryPanelComp = SIDE_TAB_DEFS[1].Comp
import {
  IconDb, IconSchema, IconTable, IconView, IconCaret, IconSearch, IconPlus,
  IconCopy, IconDownload, IconKey, IconRefresh, IconWrench, IconDoc, IconHistory, IconPlay, IconTrash, IconEdit, IconPlug,
  IconChevronDown, IconChevronUp,
} from './icons'

/* 展开状态 key 前缀 */
const K_CONN = (id: string) => `c:${id}`
const K_SCHEMA = (connId: string, s: string) => `s:${connId}:${s}`

function compact(n?: number): string | undefined {
  if (n === undefined || n === null) return undefined
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

/* 树行 */
function TRow(props: {
  depth: number; icon: ReactNode; label: ReactNode; title?: string
  caret?: boolean; open?: boolean; active?: boolean; className?: string
  right?: ReactNode
  onClick?: () => void
  onCaret?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className={`tree-row ${props.active ? 'active' : ''} ${props.className ?? ''}`}
      style={{ paddingLeft: 4 + props.depth * 13 }}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      title={props.title}
    >
      <span
        className={`caret ${props.open ? 'open' : ''} ${props.caret ? '' : 'leaf'}`}
        onClick={(e) => { e.stopPropagation(); props.onCaret?.() }}
      ><IconCaret /></span>
      <span className="node-icon">{props.icon}</span>
      <span className="label">{props.label}</span>
      {props.right}
    </div>
  )
}

export function Sidebar() {
  const connections = useStore((s) => s.connections)
  const runtime = useStore((s) => s.runtime)
  const meta = useStore((s) => s.meta)
  const activeTabId = useStore((s) => s.activeTabId)
  const activeTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const sidePanelCollapsed = useStore((s) => s.prefs.sidePanelCollapsed)

  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [sideTab, setSideTab] = useState<'scripts' | 'history'>('scripts')
  const filterAttempted = useRef(new Set<string>())

  const kw = filter.trim().toLowerCase()

  /* 首次挂载：自动连接演示库并展开 */
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    connections.filter((c) => c.type === 'demo').forEach((c) => {
      void ensureConnected(c)
        .then(() => {
          setExpanded((p) => new Set(p).add(K_CONN(c.id)))
          if (c.database) {
            setExpanded((p) => new Set(p).add(K_SCHEMA(c.id, c.database!)))
            void loadTables(c, c.database!)
          }
        })
        .catch(() => { /* 状态点会显示 error */ })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 过滤时后台补全各 schema 的表清单 */
  useEffect(() => {
    if (!kw) return
    connections.forEach((cfg) => {
      const rt = runtime[cfg.id]
      const ad = getAdapter(cfg)
      const schemas = meta[cfg.id]?.schemas
      if (rt?.status !== 'connected' || !ad || !schemas) return
      schemas.forEach((sc) => {
        const key = `${cfg.id}:${sc}`
        if (meta[cfg.id]?.tables[sc] !== undefined || filterAttempted.current.has(key)) return
        filterAttempted.current.add(key)
        void ad.listTables(sc)
          .then((ts) => useStore.getState().setTables(cfg.id, sc, ts))
          .catch(() => { filterAttempted.current.delete(key) })
      })
    })
  }, [kw, connections, runtime, meta])

  /* ---------------- 数据加载 ---------------- */
  async function loadTables(cfg: ConnectionConfig, schema: string) {
    const cached = useStore.getState().meta[cfg.id]?.tables[schema]
    if (cached) return
    const ad = getAdapter(cfg)
    if (!ad) return
    setLoading((p) => new Set(p).add(K_SCHEMA(cfg.id, schema)))
    try {
      const ts = await ad.listTables(schema)
      useStore.getState().setTables(cfg.id, schema, ts)
    } catch (e) {
      toast.error(`加载表失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading((p) => { const q = new Set(p); q.delete(K_SCHEMA(cfg.id, schema)); return q })
    }
  }

  async function loadColumns(cfg: ConnectionConfig, schema: string, table: string) {
    const key = `t:${cfg.id}:${schema}:${table}`
    if (useStore.getState().meta[cfg.id]?.columns[`${schema}.${table}`]) return
    const ad = getAdapter(cfg)
    if (!ad) return
    setLoading((p) => new Set(p).add(key))
    try {
      const cols = await ad.getColumns(schema, table)
      useStore.getState().setColumns(cfg.id, schema, table, cols)
    } catch { /* 展开失败静默 */ } finally {
      setLoading((p) => { const q = new Set(p); q.delete(key); return q })
    }
  }

  const toggle = (key: string) => {
    setExpanded((p) => {
      const q = new Set(p)
      if (q.has(key)) q.delete(key)
      else q.add(key)
      return q
    })
  }

  const expandConn = async (cfg: ConnectionConfig) => {
    const key = K_CONN(cfg.id)
    if (expanded.has(key)) { toggle(key); return }
    setExpanded((p) => new Set(p).add(key))
    if (runtime[cfg.id]?.status !== 'connected') {
      setLoading((p) => new Set(p).add(key))
      try { await ensureConnected(cfg) } catch (e) {
        toast.error(`连接失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setLoading((p) => { const q = new Set(p); q.delete(key); return q })
      }
    }
    if (cfg.database) {
      setExpanded((p) => new Set(p).add(K_SCHEMA(cfg.id, cfg.database!)))
      void loadTables(cfg, cfg.database)
    }
  }

  const expandSchema = (cfg: ConnectionConfig, schema: string) => {
    const key = K_SCHEMA(cfg.id, schema)
    toggle(key)
    if (!expanded.has(key)) void loadTables(cfg, schema)
  }

  const refreshConn = async (cfg: ConnectionConfig) => {
    try {
      const ad = await ensureConnected(cfg)
      const schemas = await ad.listSchemas()
      useStore.getState().setSchemas(cfg.id, schemas)
      filterAttempted.current = new Set()
      // 已缓存表的 schema 重新拉取
      const cached = Object.keys(useStore.getState().meta[cfg.id]?.tables ?? {})
      await Promise.all(cached.map(async (sc) => {
        try { useStore.getState().setTables(cfg.id, sc, await ad.listTables(sc)) } catch { /* ignore */ }
      }))
      toast.success('元数据已刷新')
    } catch (e) {
      toast.error(`刷新失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /* ---------------- 表动作 ---------------- */
  const showDdl = async (cfg: ConnectionConfig, schema: string, table: string) => {
    try {
      const ad = await ensureConnected(cfg)
      const ddl = await ad.showCreateTable(schema, table)
      openSqlModal({ title: `DDL：${schema}.${table}`, sub: 'SHOW CREATE TABLE', sql: `${ddl.replace(/;+\s*$/, '')};`, filename: `${schema}.${table}.ddl.sql` })
    } catch (e) {
      toast.error(`获取 DDL 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const openTopN = async (cfg: ConnectionConfig, schema: string, table: string, n: number) => {
    try {
      const ad = await ensureConnected(cfg)
      const pk = await ad.getPK(schema, table)
      const sql = buildTopN(schema, table, pk, n)
      const id = openQueryTab({ title: `${table} · 最近 ${n} 条`, sql, connId: cfg.id, schema })
      void runTabSql(id)
    } catch (e) {
      toast.error(`打开失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const openTopRows = (cfg: ConnectionConfig, schema: string, table: string, limit: number) => {
    const sql = `SELECT * FROM ${quoteTable(schema, table)}\nLIMIT ${limit}`
    const id = openQueryTab({ title: `${table} · 前 ${limit} 行`, sql, connId: cfg.id, schema })
    void runTabSql(id)
  }

  const setTabSchema = (schema: string) => {
    if (activeTabId) useStore.getState().updateTab(activeTabId, { schema })
    toast.info(`当前标签页 Schema → ${schema}`)
  }

  const tableMenu = (cfg: ConnectionConfig, schema: string, t: TableMeta) => [
    { label: '复制表名', icon: <IconCopy />, onClick: () => { void copyText(t.name).then((ok) => ok && toast.success(`已复制 ${t.name}`)) } },
    { label: `复制 \`${schema}\`.\`${t.name}\``, icon: <IconCopy />, onClick: () => { void copyText(`${schema}.${t.name}`).then((ok) => ok && toast.success('已复制全限定表名')) } },
    { sep: true } as const,
    { label: '查看 DDL', icon: <IconDoc />, onClick: () => void showDdl(cfg, schema, t.name) },
    { label: '最近 10 条记录', icon: <IconHistory />, onClick: () => void openTopN(cfg, schema, t.name, 10) },
    { label: '查看前 100 行', icon: <IconTable />, onClick: () => openTopRows(cfg, schema, t.name, 100) },
    { sep: true } as const,
    { label: '导出 SQL（DDL + 数据）…', icon: <IconWrench />, onClick: () => openExportModal(cfg.id, schema, t.name) },
    { label: '导出 CSV', icon: <IconDownload />, onClick: () => void exportTableCsv(cfg.id, schema, t.name) },
    { sep: true } as const,
    { label: '在新标签页查询', icon: <IconPlay />, onClick: () => openTopRows(cfg, schema, t.name, 100) },
  ]

  const connMenu = (cfg: ConnectionConfig) => {
    const rt = runtime[cfg.id]
    const connected = rt?.status === 'connected'
    return [
      connected
        ? { label: '断开连接', icon: <IconPlug />, onClick: () => void disconnectConn(cfg) }
        : { label: '打开连接', icon: <IconPlug />, onClick: () => void expandConn(cfg) },
      { label: '刷新元数据', icon: <IconRefresh />, disabled: !connected, onClick: () => void refreshConn(cfg) },
      { label: '新建查询', icon: <IconDoc />, disabled: !connected, onClick: () => openQueryTab({ connId: cfg.id, schema: rt?.currentSchema ?? cfg.database }) },
      { sep: true } as const,
      { label: '编辑连接', icon: <IconEdit />, onClick: () => openConnModal(cfg) },
      { label: '删除连接', icon: <IconTrash />, danger: true, onClick: () => {
        void confirmDialog({
          title: '删除连接',
          message: <>确定删除连接 <b>{cfg.name}</b> 吗？<br />相关脚本会保留，标签页将解除绑定。</>,
          danger: true,
        }).then((ok) => {
          if (ok) { useStore.getState().removeConnection(cfg.id); toast.success('连接已删除') }
        })
      } },
    ]
  }

  const schemaMenu = (cfg: ConnectionConfig, schema: string) => [
    { label: '设为活动 Schema', icon: <IconSchema />, onClick: () => setTabSchema(schema) },
    { label: '在此新建查询', icon: <IconDoc />, onClick: () => openQueryTab({ connId: cfg.id, schema }) },
    { label: '刷新表', icon: <IconRefresh />, onClick: () => {
      const ad = getAdapter(cfg)
      if (!ad) return
      void ad.listTables(schema).then((ts) => { useStore.getState().setTables(cfg.id, schema, ts); toast.success('已刷新') })
    } },
    { sep: true } as const,
    { label: '复制名称', icon: <IconCopy />, onClick: () => { void copyText(schema).then((ok) => ok && toast.success('已复制')) } },
  ]

  /* ---------------- 渲染 ---------------- */
  const connNodes = useMemo(() => {
    return connections.map((cfg) => {
      const rt = runtime[cfg.id]
      const status = rt?.status ?? 'disconnected'
      const schemas = meta[cfg.id]?.schemas
      const connKey = K_CONN(cfg.id)
      const connNameMatch = !kw || cfg.name.toLowerCase().includes(kw)

      /* schema 节点 */
      const schemaNodes: ReactNode[] = []
      let hasMatch = connNameMatch
      if (schemas) {
        schemas.forEach((sc) => {
          const tables = meta[cfg.id]?.tables[sc]
          const schemaMatch = !kw || sc.toLowerCase().includes(kw)
          const matchTables = kw && tables
            ? tables.filter((t) => t.name.toLowerCase().includes(kw) || (t.comment ?? '').toLowerCase().includes(kw))
            : undefined
          if (kw && !schemaMatch && (!matchTables || !matchTables.length)) return
          hasMatch = true

          const expandedNow = kw ? true : expanded.has(K_SCHEMA(cfg.id, sc))
          const loadingNow = loading.has(K_SCHEMA(cfg.id, sc))

          /* 表节点 */
          const tableNodes: ReactNode[] = []
          const list = matchTables ?? tables
          if (list) {
            list.forEach((t) => {
              const tKey = `t:${cfg.id}:${sc}:${t.name}`
              const cols = meta[cfg.id]?.columns[`${sc}.${t.name}`]
              const tOpen = expanded.has(tKey)
              tableNodes.push(
                <div key={tKey} className="tree-node">
                  <TRow
                    depth={2} caret open={tOpen}
                    icon={t.type === 'VIEW' ? <IconView /> : <IconTable />}
                    label={<>{t.name}{t.comment ? <span style={{ color: 'var(--text-3)', marginLeft: 5, fontSize: 11 }}>{t.comment}</span> : null}</>}
                    title={`${sc}.${t.name}${t.comment ? ` — ${t.comment}` : ''}`}
                    right={
                      <>
                        {t.rowsApprox !== undefined && <span className="rowcount">{compact(t.rowsApprox)}</span>}
                        <span className="cnt" title="表类型">{t.type === 'VIEW' ? 'VIEW' : (t.engine ?? '')}</span>
                      </>
                    }
                    onCaret={() => { toggle(tKey); if (!tOpen) void loadColumns(cfg, sc, t.name) }}
                    onClick={() => { toggle(tKey); if (!tOpen) void loadColumns(cfg, sc, t.name) }}
                    onContextMenu={(e) => openContextMenu(e, tableMenu(cfg, sc, t))}
                  />
                  {tOpen && cols && (
                    <div className="tree-children">
                      {cols.map((c) => (
                        <TRow
                          key={c.name} depth={3}
                          icon={c.key === 'PRI' ? <IconKey /> : <span style={{ width: 16, display: 'inline-block' }} />}
                          label={<>
                            {c.name}
                            {c.key === 'PRI' && <span className="badge pri" style={{ marginLeft: 5 }}>PK</span>}
                            <span style={{ color: 'var(--text-3)', marginLeft: 5, fontSize: 10.5 }}>{c.type}</span>
                          </>}
                          title={`${c.name} ${c.type}${c.comment ? ` — ${c.comment}` : ''}${c.nullable ? '' : ' NOT NULL'}`}
                          onClick={() => { void copyText(c.name).then((ok) => ok && toast.success(`已复制列名 ${c.name}`)) }}
                        />
                      ))}
                    </div>
                  )}
                </div>,
              )
            })
          }

          schemaNodes.push(
            <div key={K_SCHEMA(cfg.id, sc)} className="tree-node">
              <TRow
                depth={1} caret open={expandedNow}
                className={sc.startsWith('information_schema') || sc === 'mysql' || sc === 'performance_schema' || sc === 'sys' ? 'sys' : ''}
                icon={<IconSchema />}
                label={sc}
                right={loadingNow
                  ? <span className="spin"><IconRefresh /></span>
                  : <span className="cnt">{tables ? `${tables.length}` : ''}</span>}
                onCaret={() => expandSchema(cfg, sc)}
                onClick={() => expandSchema(cfg, sc)}
                onContextMenu={(e) => openContextMenu(e, schemaMenu(cfg, sc))}
              />
              {expandedNow && (
                <div className="tree-children">
                  {tableNodes}
                  {tables && !tables.length && <div className="tree-empty">该 Schema 没有表</div>}
                  {!tables && !loadingNow && <div className="tree-empty">点击展开加载表…</div>}
                </div>
              )}
            </div>,
          )
        })
      }

      /* 连接节点（过滤时：无匹配则隐藏） */
      if (kw && !hasMatch) return null

      const connOpen = kw ? true : expanded.has(connKey)
      return (
        <div key={cfg.id} className="tree-node">
          <TRow
            depth={0} caret open={connOpen} className="conn-node"
            icon={cfg.type === 'demo' ? <IconDb /> : <IconPlug />}
            label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className={`status-dot ${status}`} />
                {cfg.name}
                {cfg.type === 'demo' && <span className="badge demo">DEMO</span>}
              </span>
            }
            title={`${cfg.name}${rt?.serverVersion ? ` — MySQL ${rt.serverVersion}` : ''}${rt?.error ? `\n${rt.error}` : ''}`}
            right={
              loading.has(connKey)
                ? <span className="spin"><IconRefresh /></span>
                : schemas ? <span className="cnt">{schemas.length}</span> : null
            }
            onCaret={() => void expandConn(cfg)}
            onClick={() => void expandConn(cfg)}
            onContextMenu={(e) => openContextMenu(e, connMenu(cfg))}
          />
          {connOpen && (
            <div className="tree-children">
              {status === 'error' && (
                <div className="tree-empty" style={{ color: 'var(--err)' }}>
                  连接失败：{rt?.error ?? '未知错误'}
                </div>
              )}
              {schemas?.length ? schemaNodes : (
                <div className="tree-empty">
                  {status === 'connecting' || loading.has(connKey) ? '正在连接…' : '点击展开以连接并列出 Schema'}
                </div>
              )}
            </div>
          )}
        </div>
      )
    })
  }, [connections, runtime, meta, expanded, loading, kw, activeTab?.schema])

  return (
    <aside className="sidebar" style={{ '--sidebar-w': `${useStore.getState().prefs.sidebarWidth}px` } as React.CSSProperties}>
      <div className="sidebar-top">
        <div style={{ display: 'flex', gap: 6 }}>
          <div className="sidebar-search" style={{ flex: 1 }}>
            <IconSearch />
            <input
              className="input" placeholder="按表名 / Schema / 注释过滤"
              value={filter} onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <button className="btn sm icon" title="新建连接" onClick={() => openConnModal()}>
            <IconPlus />
          </button>
        </div>
        {kw && (
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            过滤中：已连接的库会自动加载表清单
          </div>
        )}
      </div>

      <div className="tree">
        {connNodes}
        {!connections.length && (
          <div className="conn-empty">
            还没有数据库连接<br />点击右上角 ＋ 新建连接
          </div>
        )}
      </div>

      <div className={`sidebar-bottom ${sidePanelCollapsed ? 'collapsed' : ''}`}>
        <div className="side-tabs">
          {SIDE_TAB_DEFS.map((d) => (
            <button key={d.key} className={`side-tab ${sideTab === d.key ? 'on' : ''}`} onClick={() => setSideTab(d.key)}>
              {d.label}
            </button>
          ))}
          <button
            className="icon-btn side-collapse"
            title={sidePanelCollapsed ? '展开面板' : '收起面板'}
            onClick={() => useStore.getState().setPrefs({ sidePanelCollapsed: !sidePanelCollapsed })}
          >
            {sidePanelCollapsed ? <IconChevronUp /> : <IconChevronDown />}
          </button>
        </div>
        {!sidePanelCollapsed && (
          <div className="side-panel">
            {sideTab === 'scripts' ? <ScriptsPanelComp /> : <HistoryPanelComp />}
          </div>
        )}
      </div>
    </aside>
  )
}
