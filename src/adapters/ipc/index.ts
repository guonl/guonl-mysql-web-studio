/* 桌面客户端适配器：经 preload 注入的 desktopBridge 调用主进程 mysql-service
 * （复用 bridge-core 的 mysql2 实现，直连 MySQL，无需任何桥接器）。
 * 元数据 SQL 与 WsAdapter 完全一致，仅传输层从 WebSocket 换成 Electron IPC。 */

import type { ColumnMeta, ConnectionConfig, DriverAdapter, ExecResult, IndexMeta, TableMeta } from '../../core/types'

interface ErrInfo { code: number | string; message: string; fatal?: boolean }

interface RpcResult<T> { ok: boolean; data?: T; error?: ErrInfo }

/** 原生菜单动作（主进程 → 渲染进程，经 preload onMenuAction 订阅） */
export type MenuAction =
  | { type: 'open-sql-file'; name: string; content: string }
  | { type: 'export-current-sql' }

/** preload.cjs 注入到 window 的桥接 API */
export interface DesktopBridgeApi {
  invoke: (op: string, args: unknown) => Promise<RpcResult<never>>
  /** 应用级 RPC：系统对话框 / 文件导出等（app:op 通道） */
  invokeApp?: (op: string, args: unknown) => Promise<RpcResult<never>>
  /** 订阅原生菜单动作，返回退订函数 */
  onMenuAction?: (cb: (action: MenuAction) => void) => () => void
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridgeApi
  }
}

/** 是否运行在桌面客户端（Electron 渲染进程） */
export function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && !!window.desktopBridge
}

const CONNECT_TIMEOUT = 15_000
const QUERY_TIMEOUT = 60_000

/** 标识符加反引号并转义 */
const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`'

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s），数据库可能无响应`)), ms),
    ),
  ])
}

export class IpcAdapter implements DriverAdapter {
  kind = 'desktop' as const
  private cfg: ConnectionConfig
  private currentSchema: string | undefined
  /** 单连接串行队列：避免同一连接上「USE + 查询」交错（与 WsAdapter 同一策略） */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(cfg: ConnectionConfig) {
    this.cfg = cfg
    this.currentSchema = cfg.database
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => { /* 队列继续 */ })
    return next
  }

  private call<T>(op: string, args: unknown, label: string, timeoutMs = QUERY_TIMEOUT): Promise<T> {
    const bridge = window.desktopBridge
    if (!bridge) return Promise.reject(new Error('桌面桥未就绪，请通过桌面客户端运行（npm run dev:desktop）'))
    return withTimeout(bridge.invoke(op, args), timeoutMs, label).then((r) => {
      if (!r.ok || r.error) {
        const e = new Error(r.error?.message ?? '未知错误')
        Object.assign(e, { code: r.error?.code ?? 0, fatal: !!r.error?.fatal })
        throw e
      }
      return r.data as T
    })
  }

  async connect(): Promise<{ serverVersion?: string }> {
    try {
      const res = await this.call<{ serverVersion: string }>(
        'connect',
        {
          connId: this.cfg.id,
          host: this.cfg.host ?? '127.0.0.1',
          port: this.cfg.port ?? 3306,
          user: this.cfg.user ?? 'root',
          password: this.cfg.password ?? '',
          database: this.cfg.database,
        },
        '连接',
        CONNECT_TIMEOUT,
      )
      return { serverVersion: res.serverVersion }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/using password: NO/i.test(msg)) {
        throw new Error(`${msg} —— 密码未随连接发送，请编辑该连接填写密码`)
      }
      throw e
    }
  }

  async ping(): Promise<void> {
    await this.enqueue(() => this.call('query', { connId: this.cfg.id, sql: 'SELECT 1' }, '查询'))
  }

  async close(): Promise<void> {
    await this.call('close', { connId: this.cfg.id }, '断开')
  }

  async execute(sql: string, schema?: string): Promise<ExecResult> {
    return this.enqueue(async () => {
      /* 切库由主进程在执行前完成（USE），仅在目标库变化时下发，减少往返 */
      const switchTo = schema && schema !== this.currentSchema ? schema : undefined
      if (switchTo) this.currentSchema = schema
      return this.call<ExecResult>('query', { connId: this.cfg.id, sql, schema: switchTo }, '查询')
    })
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.execute(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
    )
    return r.rows.map((row) => String(row[0]))
  }

  async listTables(schema: string): Promise<TableMeta[]> {
    const r = await this.execute(
      `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
       ORDER BY TABLE_NAME`,
    )
    return r.rows.map((row) => ({
      name: String(row[0]),
      type: row[1] === 'VIEW' ? 'VIEW' : 'TABLE',
      engine: row[2] == null ? undefined : String(row[2]),
      rowsApprox: row[3] == null ? undefined : Number(row[3]) || 0,
      comment: row[4] == null ? '' : String(row[4]),
    }))
  }

  async getColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    const esc = (s: string) => s.replace(/'/g, "''")
    const r = await this.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, CHARACTER_SET_NAME, COLLATION_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = '${esc(schema)}' AND TABLE_NAME = '${esc(table)}'
       ORDER BY ORDINAL_POSITION`,
    )
    return r.rows.map((row) => ({
      name: String(row[0]),
      type: String(row[1]),
      nullable: row[2] === 'YES',
      key: (row[3] as ColumnMeta['key']) || '',
      defaultValue: row[4] == null ? null : String(row[4]),
      extra: row[5] == null ? '' : String(row[5]),
      comment: row[6] == null ? '' : String(row[6]),
      charset: row[7] == null ? undefined : String(row[7]),
      collation: row[8] == null ? undefined : String(row[8]),
    }))
  }

  /** 一次性取回整 schema 全部表的列（单条 SQL），避免逐表查询造成请求风暴 */
  async getSchemaColumns(schema: string): Promise<Record<string, ColumnMeta[]>> {
    const r = await this.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    )
    const out: Record<string, ColumnMeta[]> = {}
    for (const row of r.rows) {
      const table = String(row[0])
      ;(out[table] ??= []).push({
        name: String(row[1]),
        type: String(row[2]),
        nullable: row[3] === 'YES',
        key: (row[4] as ColumnMeta['key']) || '',
        defaultValue: row[5] == null ? null : String(row[5]),
        extra: row[6] == null ? '' : String(row[6]),
        comment: row[7] == null ? '' : String(row[7]),
      })
    }
    return out
  }

  async getPK(schema: string, table: string): Promise<string[]> {
    const esc = (s: string) => s.replace(/'/g, "''")
    const r = await this.execute(
      `SELECT COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE CONSTRAINT_NAME = 'PRIMARY'
         AND TABLE_SCHEMA = '${esc(schema)}' AND TABLE_NAME = '${esc(table)}'
       ORDER BY ORDINAL_POSITION`,
    )
    return r.rows.map((row) => String(row[0]))
  }

  /** 表的二级索引（不含 PRIMARY）；来自 information_schema.STATISTICS，按索引名分组聚合 */
  async getIndexes(schema: string, table: string): Promise<IndexMeta[]> {
    const esc = (s: string) => s.replace(/'/g, "''")
    const r = await this.execute(
      `SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = '${esc(schema)}' AND TABLE_NAME = '${esc(table)}'
         AND INDEX_NAME <> 'PRIMARY'
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    )
    const out: IndexMeta[] = []
    const byName = new Map<string, IndexMeta>()
    for (const row of r.rows) {
      if (row[3] == null) continue /* MySQL 8.0 函数索引行 COLUMN_NAME 为 null，跳过 */
      const name = String(row[0])
      let ix = byName.get(name)
      if (!ix) {
        ix = {
          name,
          kind: String(row[2]) === 'FULLTEXT' ? 'FULLTEXT' : Number(row[1]) === 0 ? 'UNIQUE' : 'INDEX',
          cols: [],
        }
        byName.set(name, ix)
        out.push(ix)
      }
      ix.cols.push(String(row[3]))
    }
    return out
  }

  async showCreateTable(schema: string, table: string): Promise<string> {
    const r = await this.execute(`SHOW CREATE TABLE ${qi(schema)}.${qi(table)}`)
    return r.rows[0] ? String(r.rows[0][1]) : ''
  }
}
