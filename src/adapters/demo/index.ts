/* 演示适配器：完全离线的内置 MySQL 模拟 */

import { DriverAdapter, ExecResult, ColumnMeta, TableMeta } from '../../core/types'
import { DEMO_SCHEMAS, DEMO_SERVER_VERSION, DemoTableDef, SYSTEM_SCHEMAS } from './data'
import { demoExecute, DemoSqlError, renderCreateTable } from './engine'

export class DemoAdapter implements DriverAdapter {
  kind = 'demo' as const
  private defaultSchema: string

  constructor(defaultSchema = 'shop') {
    this.defaultSchema = defaultSchema
  }

  async connect() {
    return { serverVersion: DEMO_SERVER_VERSION }
  }
  async ping() { /* 始终在线 */ }
  async close() { /* no-op */ }

  async listSchemas() {
    return [...DEMO_SCHEMAS.map((s) => s.name)]
  }

  async listTables(schema: string): Promise<TableMeta[]> {
    const s = DEMO_SCHEMAS.find((x) => x.name === schema)
    if (!s) return []
    return s.tables.map((t): TableMeta => ({
      name: t.name,
      type: t.type === 'VIEW' ? 'VIEW' : 'TABLE',
      engine: t.engine,
      rowsApprox: t.type === 'VIEW' ? undefined : (t.count ?? undefined),
      comment: t.comment,
    }))
  }

  async getColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    return this.colsOf(this.find(schema, table))
  }

  /** 一次性取回整 schema 全部表的列 */
  async getSchemaColumns(schema: string): Promise<Record<string, ColumnMeta[]>> {
    const s = DEMO_SCHEMAS.find((x) => x.name === schema)
    if (!s) return {}
    const out: Record<string, ColumnMeta[]> = {}
    for (const t of s.tables) out[t.name] = this.colsOf(t)
    return out
  }

  private colsOf(def: DemoTableDef): ColumnMeta[] {
    return def.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable !== false,
      key: c.key ?? '',
      defaultValue: c.def ?? null,
      extra: c.extra ?? '',
      comment: c.comment ?? '',
    }))
  }

  async getPK(schema: string, table: string): Promise<string[]> {
    return this.find(schema, table).pk
  }

  async showCreateTable(schema: string, table: string): Promise<string> {
    const def = this.find(schema, table)
    return renderCreateTable(schema, def)
  }

  async execute(sql: string, schema?: string): Promise<ExecResult> {
    try {
      return demoExecute(sql, schema ?? this.defaultSchema)
    } catch (e) {
      if (e instanceof DemoSqlError) throw e
      throw new DemoSqlError((e as Error).message || String(e))
    }
  }

  private find(schema: string, table: string): DemoTableDef {
    const s = DEMO_SCHEMAS.find((x) => x.name === schema)
      ?? (SYSTEM_SCHEMAS.includes(schema) ? null : null)
    const t = s?.tables.find((x) => x.name === table)
    if (!s || !t) throw new DemoSqlError(`Table '${schema}.${table}' doesn't exist`, 1146)
    return t
  }
}
