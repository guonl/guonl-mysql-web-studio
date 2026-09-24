/* 全局弹窗编排宿主：确认框 / SQL 预览 / 表导出 / 连接编辑 */
import { useState, type ReactNode } from 'react'
import { useStore } from '../core/store'
import { ensureConnected } from '../core/connOps'
import type { ConnectionConfig } from '../core/types'
import { quoteIdent, quoteTable, buildInserts, toCsv } from '../core/sql'
import { downloadText } from '../core/utils'
import { Modal, SqlModal } from './Modal'
import { ConnectionModal } from './ConnectionModal'
import { toast } from './Toast'
import { IconDownload } from './icons'

/* ---------------- SqlModal（DDL / INSERT 预览） ---------------- */
interface SqlModalState { title: string; sub?: string; sql: string; filename?: string }
let openSqlModalFn: ((s: SqlModalState) => void) | null = null
export function openSqlModal(s: SqlModalState) { openSqlModalFn?.(s) }

/* ---------------- 确认框（Promise 风格） ---------------- */
interface ConfirmState { title: string; message: ReactNode; danger?: boolean; resolve: (ok: boolean) => void }
let confirmFn: ((s: ConfirmState) => void) | null = null
export function confirmDialog(opts: { title: string; message: ReactNode; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => confirmFn?.({ ...opts, resolve }))
}

/* ---------------- 连接编辑弹窗 ---------------- */
let connModalFn: ((initial?: ConnectionConfig) => void) | null = null
export function openConnModal(initial?: ConnectionConfig) { connModalFn?.(initial) }

/* ---------------- 表导出弹窗 ---------------- */
let exportFn: ((p: { connId: string; schema: string; table: string }) => void) | null = null
export function openExportModal(connId: string, schema: string, table: string) {
  exportFn?.({ connId, schema, table })
}

/** 直接导出表数据为 CSV（右键菜单快捷动作） */
export async function exportTableCsv(connId: string, schema: string, table: string) {
  const st = useStore.getState()
  const cfg = st.connections.find((c) => c.id === connId)
  if (!cfg) { toast.error('连接不存在'); return }
  try {
    const adapter = await ensureConnected(cfg)
    toast.info('正在查询数据…')
    const res = await adapter.execute(`SELECT * FROM ${quoteTable(schema, table)} LIMIT 50000`)
    if (!res.rows.length) { toast.warn('表没有数据，已生成仅含表头的 CSV'); }
    downloadText(`${schema}.${table}.csv`, toCsv(res.columns, res.rows), 'text/csv;charset=utf-8')
    toast.success(`已导出 ${res.rows.length} 行到 CSV`)
  } catch (e) {
    toast.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/* ---------------- 宿主组件 ---------------- */
export function ModalHost() {
  const [sqlState, setSqlState] = useState<SqlModalState | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [connInitial, setConnInitial] = useState<ConnectionConfig | undefined>(undefined)
  const [connOpen, setConnOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState<{ connId: string; schema: string; table: string } | null>(null)

  openSqlModalFn = setSqlState
  confirmFn = (s) => setConfirmState(s)
  connModalFn = (initial) => { setConnInitial(initial); setConnOpen(true) }
  exportFn = setExportTarget

  return (
    <>
      {sqlState && <SqlModal {...sqlState} onClose={() => setSqlState(null)} />}
      {confirmState && (
        <Modal
          title={confirmState.title}
          width={420}
          onClose={() => { confirmState.resolve(false); setConfirmState(null) }}
          foot={
            <>
              <button className="btn" onClick={() => { confirmState.resolve(false); setConfirmState(null) }}>取消</button>
              <button
                className={`btn ${confirmState.danger ? 'danger' : 'primary'}`}
                onClick={() => { confirmState.resolve(true); setConfirmState(null) }}
              >
                确定
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>{confirmState.message}</div>
        </Modal>
      )}
      {connOpen && (
        <ConnectionModal
          initial={connInitial}
          onClose={() => { setConnOpen(false); setConnInitial(undefined) }}
        />
      )}
      {exportTarget && (
        <ExportTableModal
          {...exportTarget}
          onClose={() => setExportTarget(null)}
        />
      )}
    </>
  )
}

/* ---------------- 导出选项弹窗 ---------------- */
const EXPORT_MAX_ROWS = 50000

function ExportTableModal({ connId, schema, table, onClose }: { connId: string; schema: string; table: string; onClose: () => void }) {
  const [wantDdl, setWantDdl] = useState(true)
  const [wantData, setWantData] = useState(true)
  const [dropIf, setDropIf] = useState(false)
  const [ifNotExists, setIfNotExists] = useState(true)
  const [ignoreDup, setIgnoreDup] = useState(false)
  const [busy, setBusy] = useState(false)

  const toggle = (v: boolean, set: (b: boolean) => void, other: boolean, setOther: (b: boolean) => void) => {
    const next = !v
    if (!next && !other) return // 至少保留一项
    set(next)
    if (!next) setOther(true)
  }

  /** 按当前选项生成导出 SQL（DDL + INSERT） */
  const buildSql = async (): Promise<{ sql: string; sub: string }> => {
    const st = useStore.getState()
    const cfg = st.connections.find((c) => c.id === connId)
    if (!cfg) throw new Error('连接不存在')
    const adapter = await ensureConnected(cfg)
    const parts: string[] = []
    let dataNote = ''
    if (wantDdl) {
      const ddl = await adapter.showCreateTable(schema, table)
      if (dropIf) parts.push(`DROP TABLE IF EXISTS ${quoteIdent(table)};`)
      parts.push(`${ddl.replace(/;+\s*$/, '')};`)
    }
    if (wantData) {
      const res = await adapter.execute(
        `SELECT * FROM ${quoteTable(schema, table)} LIMIT ${EXPORT_MAX_ROWS}`,
      )
      if (res.rows.length) {
        parts.push(buildInserts(quoteTable(schema, table), res.columns, res.rows, {
          batch: 200,
          includeIfNotExists: ifNotExists,
        }).replace(/^INSERT INTO/m, ignoreDup ? 'INSERT IGNORE INTO' : 'INSERT INTO'))
        if (res.rows.length >= EXPORT_MAX_ROWS) dataNote = `（已达导出上限 ${EXPORT_MAX_ROWS} 行）`
      } else {
        parts.push(`-- ${quoteTable(schema, table)} 无数据`)
      }
    }
    const sub = `包含 ${[wantDdl && 'DDL', wantData && '数据 INSERT'].filter(Boolean).join(' + ')}${dataNote}`
    return { sql: parts.join('\n\n'), sub }
  }

  /** 生成并打开 SQL 预览弹窗（弹窗内可复制 / 下载）。预览叠加在导出弹窗上层，关闭后导出弹窗保留可继续操作 */
  const doPreview = async () => {
    setBusy(true)
    try {
      const { sql, sub } = await buildSql()
      setBusy(false)
      openSqlModal({
        title: `导出：${schema}.${table}`,
        sub,
        sql,
        filename: `${schema}.${table}.sql`,
      })
    } catch (e) {
      setBusy(false)
      toast.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 生成并直接下载 .sql 文件 */
  const doDownload = async () => {
    setBusy(true)
    try {
      const { sql } = await buildSql()
      setBusy(false)
      downloadText(`${schema}.${table}.sql`, sql, 'application/sql')
      toast.success(`已下载 ${schema}.${table}.sql`)
    } catch (e) {
      setBusy(false)
      toast.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <Modal
      title={`导出表：${schema}.${table}`}
      sub="生成可在其他 MySQL 中执行的脚本，或直接下载"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={() => { void exportTableCsv(connId, schema, table) }}>
            <IconDownload /> 下载 CSV
          </button>
          <button className="btn" disabled={busy} onClick={() => { void doDownload() }}>
            <IconDownload /> 下载 SQL
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy} onClick={() => { void doPreview() }}>
            {busy ? '生成中…' : 'SQL预览'}
          </button>
        </>
      }
    >
      <div className="export-options">
        <div className="opt-group">
          <div className="opt-title">导出内容</div>
          <div className="opt-checks">
            <span className={`opt-chip ${wantDdl ? 'on' : ''}`} onClick={() => toggle(wantDdl, setWantDdl, wantData, setWantData)}>
              <span className="chip-dot" /> 表结构（DDL）
            </span>
            <span className={`opt-chip ${wantData ? 'on' : ''}`} onClick={() => toggle(wantData, setWantData, wantDdl, setWantDdl)}>
              <span className="chip-dot" /> 表数据（INSERT）
            </span>
          </div>
        </div>
        {wantDdl && (
          <div className="opt-group">
            <div className="opt-title">DDL 选项</div>
            <div className="opt-checks">
              <span className={`opt-chip ${dropIf ? 'on' : ''}`} onClick={() => setDropIf(!dropIf)}>
                <span className="chip-dot" /> 附带 DROP TABLE IF EXISTS
              </span>
              {wantData && (
                <span className={`opt-chip ${ifNotExists ? 'on' : ''}`} onClick={() => setIfNotExists(!ifNotExists)}>
                  <span className="chip-dot" /> INSERT（含列名）
                </span>
              )}
            </div>
          </div>
        )}
        {wantData && (
          <div className="opt-group">
            <div className="opt-title">数据选项</div>
            <div className="opt-checks">
              <span className={`opt-chip ${ignoreDup ? 'on' : ''}`} onClick={() => setIgnoreDup(!ignoreDup)}>
                <span className="chip-dot" /> 使用 INSERT IGNORE（忽略重复键）
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
              最多导出 {EXPORT_MAX_ROWS.toLocaleString()} 行，按每 200 行一条 INSERT 分批
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
