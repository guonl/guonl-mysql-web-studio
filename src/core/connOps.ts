/* 连接编排与 SQL 执行调度 */
import { getAdapter, registerAdapter, useStore } from './store'
import type { ConnectionConfig, DriverAdapter, QueryTab, ResultSet } from './types'
import { DemoAdapter } from '../adapters/demo'
import { WsAdapter } from '../adapters/ws'
import { splitStatements, isReadOnlySql, isQueryStatement, hasTopLevelLimit, appendLimit } from './sql'
import { uid, fmtDuration } from './utils'
import { toast } from '../components/Toast'

/** 创建（或复用）连接的适配器并完成握手 */
export async function ensureConnected(cfg: ConnectionConfig): Promise<DriverAdapter> {
  const st = useStore.getState()
  const existed = getAdapter(cfg)
  const rt = st.runtime[cfg.id]
  if (existed && rt?.status === 'connected') return existed

  st.setRuntime(cfg.id, { status: 'connecting', error: undefined })
  try {
    // 已有适配器则复用重连（connect 幂等）；否则新建
    const adapter: DriverAdapter = existed ?? (() => {
      const a = cfg.type === 'demo' ? new DemoAdapter(cfg.database || 'shop') : new WsAdapter(cfg)
      registerAdapter(cfg.id, a)
      return a
    })()
    const { serverVersion } = await adapter.connect()
    const schemas = await adapter.listSchemas()
    useStore.getState().connected(cfg.id, serverVersion, cfg.database)
    useStore.getState().setSchemas(cfg.id, schemas)
    return adapter
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    useStore.getState().setRuntime(cfg.id, { status: 'error', error: msg })
    throw e
  }
}

/** 断开连接 */
export async function disconnectConn(cfg: ConnectionConfig) {
  const ad = getAdapter(cfg)
  if (ad) { try { await ad.close() } catch { /* ignore */ } }
  useStore.getState().setRuntime(cfg.id, { status: 'disconnected' })
}

function shorten(s: string, n = 42): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

/**
 * 执行标签页 SQL（或传入的指定 SQL 片段）。
 * 多条语句按顺序执行并追加多个结果集。
 */
export async function runTabSql(tabId: string, sqlOverride?: string): Promise<void> {
  const st = useStore.getState()
  const tab = st.tabs.find((t) => t.id === tabId)
  if (!tab || tab.running) return
  const sqlText = (sqlOverride ?? tab.sql).trim()
  if (!sqlText) { toast.warn('没有可执行的 SQL 语句'); return }

  const cfg = st.connections.find((c) => c.id === tab.connId)
  if (!cfg) {
    toast.warn('请先在左上角选择一个数据库连接')
    return
  }

  let adapter: DriverAdapter
  try {
    adapter = await ensureConnected(cfg)
  } catch (e) {
    toast.error(`连接失败：${e instanceof Error ? e.message : String(e)}`)
    return
  }

  const statements = splitStatements(sqlText)
  if (!statements.length) { toast.warn('没有可执行的 SQL 语句'); return }

  st.updateTab(tabId, { running: true })

  for (const stmt of statements) {
    const t0 = performance.now()
    const at = Date.now()
    const max = useStore.getState().prefs.maxRows
    /* 查询语句未写 LIMIT 时按右上角行数上限自动附加，避免大表全量拉取拖慢请求 */
    let exec = stmt
    if (max > 0 && isQueryStatement(stmt) && !hasTopLevelLimit(stmt)) {
      exec = appendLimit(stmt, max)
    }
    const rs: ResultSet = {
      id: uid('rs'),
      title: shorten(stmt),
      columns: [], rows: [], rowCount: 0,
      durationMs: 0, at, sql: exec,
      connId: cfg.id, connName: cfg.name, schema: tab.schema,
      kind: 'query',
      autoLimit: exec !== stmt ? max : undefined,
    }
    try {
      const res = await adapter.execute(exec, tab.schema)
      if (res.rows.length > max) {
        rs.rows = res.rows.slice(0, max)
        rs.truncated = true
      } else {
        rs.rows = res.rows
      }
      rs.columns = res.columns
      rs.rowCount = rs.rows.length
      rs.durationMs = performance.now() - t0
      if (res.notice) rs.notice = res.notice
      if (res.info) rs.info = res.info
      if (res.affected !== undefined && res.columns.length === 0) {
        rs.kind = 'notice'
        rs.notice = `执行成功：影响 ${res.affected} 行${res.info ? `（${res.info}）` : ''}`
      }
      useStore.getState().appendResult(tabId, rs)
      useStore.getState().pushHistory({
        sql: stmt, connId: cfg.id, connName: cfg.name, schema: tab.schema,
        ok: true, durationMs: rs.durationMs,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      rs.kind = 'error'
      rs.notice = msg
      rs.durationMs = performance.now() - t0
      useStore.getState().appendResult(tabId, rs)
      useStore.getState().pushHistory({
        sql: stmt, connId: cfg.id, connName: cfg.name, schema: tab.schema,
        ok: false, durationMs: rs.durationMs, error: msg,
      })
    }
  }

  const done = useStore.getState().tabs.find((t) => t.id === tabId)
  useStore.getState().updateTab(tabId, { running: false })
  const last = done?.results[done.results.length - 1]
  if (last?.kind === 'error') toast.error(shorten(last.notice || '执行出错', 60))
  else if (last) toast.success(`执行完成（${fmtDuration(last.durationMs)}）`)
}

/** 打开查询标签页 */
export function openQueryTab(init: Partial<QueryTab> = {}) {
  return useStore.getState().newTab(init)
}
