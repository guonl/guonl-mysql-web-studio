/* 全局弹窗编排宿主：确认框 / SQL 预览 / 表导出 / 连接编辑 / 新建 Schema */
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

/* ---------------- 新建 Schema（数据库）弹窗 ---------------- */
let schemaModalFn: ((connId: string) => void) | null = null
export function openSchemaModal(connId: string) { schemaModalFn?.(connId) }

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
  const [schemaConnId, setSchemaConnId] = useState<string | null>(null)

  openSqlModalFn = setSqlState
  confirmFn = (s) => setConfirmState(s)
  connModalFn = (initial) => { setConnInitial(initial); setConnOpen(true) }
  exportFn = setExportTarget
  schemaModalFn = setSchemaConnId

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
      {schemaConnId && (
        <CreateSchemaModal connId={schemaConnId} onClose={() => setSchemaConnId(null)} />
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

/* ---------------- 新建 Schema（数据库）弹窗 ---------------- */

/** 常用字符集 → 候选排序规则（MySQL 8.0 默认排序规则置顶） */
const CHARSET_COLLATIONS: Record<string, string[]> = {
  utf8mb4: ['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin'],
  utf8: ['utf8_general_ci', 'utf8_unicode_ci', 'utf8_bin'],
  latin1: ['latin1_swedish_ci', 'latin1_bin'],
  ascii: ['ascii_general_ci', 'ascii_bin'],
  gbk: ['gbk_chinese_ci', 'gbk_bin'],
}

/** 依服务器大版本取 utf8mb4 的默认排序规则（8.0+ 为 utf8mb4_0900_ai_ci，5.x 为 utf8mb4_general_ci） */
function defaultCollation(serverVersion?: string): string {
  const major = Number(serverVersion?.split('.')?.[0] ?? 0)
  return major >= 8 ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_general_ci'
}

function CreateSchemaModal({ connId, onClose }: { connId: string; onClose: () => void }) {
  const cfg = useStore((s) => s.connections.find((c) => c.id === connId))
  const serverVersion = useStore((s) => s.runtime[connId]?.serverVersion)
  const [name, setName] = useState('')
  const [charset, setCharset] = useState('utf8mb4')
  const [collate, setCollate] = useState(() => defaultCollation(serverVersion))
  const [ifNotExists, setIfNotExists] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  if (!cfg) return null

  const n = name.trim()
  /** 将要执行的语句（名称为空时以 db_name 占位仅作预览） */
  const sql = `CREATE DATABASE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quoteIdent(n || 'db_name')}${charset ? ` CHARACTER SET ${charset}` : ''}${collate ? ` COLLATE ${collate}` : ''};`

  /** 切换字符集：尽量保留仍属新字符集的排序规则，否则落回该版本默认值 */
  const pickCharset = (cs: string) => {
    setCharset(cs)
    const list = CHARSET_COLLATIONS[cs] ?? []
    const dft = defaultCollation(serverVersion)
    setCollate(list.includes(collate) ? collate : list.includes(dft) ? dft : list[0])
  }

  const submit = async () => {
    if (!n) { setErr('请填写 Schema 名称'); return }
    if (!/^[a-zA-Z0-9_$]+$/.test(n)) { setErr('名称仅支持字母、数字、下划线与 $；特殊字符请改用 SQL 执行'); return }
    if (n.length > 64) { setErr('名称过长：MySQL 标识符上限 64 字符'); return }
    setBusy(true)
    try {
      const adapter = await ensureConnected(cfg)
      await adapter.execute(sql)
      useStore.getState().setSchemas(connId, await adapter.listSchemas())
      toast.success(`已创建 Schema ${n}`)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="新建 Schema"
      sub={`将在「${cfg.name}」上创建数据库（Schema）`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || !n} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="lbl">名称</label>
        <input
          className="input" value={name} autoFocus
          onChange={(e) => { setName(e.target.value); setErr('') }}
          placeholder="例如：analytics"
        />

        <label className="lbl">字符集</label>
        <select className="select" value={charset} onChange={(e) => pickCharset(e.target.value)}>
          {Object.keys(CHARSET_COLLATIONS).map((cs) => <option key={cs} value={cs}>{cs}</option>)}
        </select>

        <label className="lbl">排序规则</label>
        <select className="select" value={collate} onChange={(e) => setCollate(e.target.value)}>
          {(CHARSET_COLLATIONS[charset] ?? []).map((co) => <option key={co} value={co}>{co}</option>)}
        </select>

        <div className="full checkbox-row" style={{ marginTop: -2 }}>
          <input type="checkbox" checked={ifNotExists} onChange={(e) => setIfNotExists(e.target.checked)} id="chk-schema-ine" />
          <label htmlFor="chk-schema-ine">IF NOT EXISTS（Schema 已存在时不报错）</label>
        </div>

        <div className="full sql-preview">{sql}</div>

        {cfg.type === 'demo' && (
          <div className="full" style={{ fontSize: 11.5, color: 'var(--warn)', lineHeight: 1.6 }}>
            演示模式为只读数据集，无法执行 DDL；请使用「真实 MySQL」连接创建
          </div>
        )}
        {err && <div className="form-error full">{err}</div>}
      </div>
    </Modal>
  )
}
