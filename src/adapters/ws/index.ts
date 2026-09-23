/* 真实 MySQL 适配器：经内嵌 Vite 桥接器连接（SQL 由桥接端 mysql2 执行，WS 传 JSON） */

import type { ColumnMeta, ConnectionConfig, DriverAdapter, ExecResult, TableMeta } from '../../core/types'
import { defaultBridgeUrl } from '../../core/storage'
import { MysqlClient } from './client'

/** 标识符加反引号并转义 */
const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`'

export class WsAdapter implements DriverAdapter {
  kind = 'ws' as const
  private cfg: ConnectionConfig
  private client = new MysqlClient()
  private currentSchema: string | undefined
  /** 单会话串行队列：避免同一连接上命令交错 */
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

  async connect(): Promise<{ serverVersion?: string }> {
    const { host = '127.0.0.1', port = 3306 } = this.cfg
    /* 桥接地址留空时：Web 模式连同源内置桥接器，插件模式连本机独立桥接器 */
    const wsUrl = this.cfg.wsUrl || defaultBridgeUrl()

    try {
      const { serverVersion } = await this.client.connect(wsUrl, {
        host, port,
        user: this.cfg.user ?? 'root',
        password: this.cfg.password ?? '',
        database: this.cfg.database,
      })
      return { serverVersion }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/using password: NO/i.test(msg)) {
        throw new Error(`${msg} —— 密码未随连接发送，请编辑该连接填写密码（未勾选「记住密码」时，刷新页面后需重新填写）`)
      }
      throw e
    }
  }

  async ping(): Promise<void> {
    await this.enqueue(() => this.client.query('SELECT 1'))
  }

  close(): Promise<void> {
    this.client.close()
    return Promise.resolve()
  }

  async execute(sql: string, schema?: string): Promise<ExecResult> {
    return this.enqueue(async () => {
      if (schema && schema !== this.currentSchema) {
        await this.client.query(`USE ${qi(schema)}`)
        this.currentSchema = schema
      }
      return this.client.query(sql)
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
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
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
    }))
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

  async showCreateTable(schema: string, table: string): Promise<string> {
    const r = await this.execute(`SHOW CREATE TABLE ${qi(schema)}.${qi(table)}`)
    return r.rows[0] ? String(r.rows[0][1]) : ''
  }
}
