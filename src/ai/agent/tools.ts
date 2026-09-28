/* AI Agent 工具层：五工具定义（OpenAI tools 格式）+ 执行（确认矩阵 + 摘要回填）
 *
 * - 元数据类工具（list_schemas/list_tables/describe_table/sample_data）直接执行；
 * - run_query 走本地风险分级（guard.classifySql，模型不可绕过）+ 确认矩阵（tech.md §6.2）；
 * - 所有回填以固定前缀包裹，响应 Prompt Injection（PRD FR-26）。
 */
import type { ColumnMeta } from '../../core/types'
import { useStore } from '../../core/store'
import { ensureConnected } from '../../core/connOps'
import { isQueryStatement, hasTopLevelLimit, appendLimit, quoteTable } from '../../core/sql'
import { classifySql } from './guard'
import { useAiStore, isApprovedSql } from '../store'
import { loadAiSettings } from '../settings'

/* ---------------- 工具 Schema（OpenAI tools 格式） ---------------- */

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required?: string[]
    }
  }
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'list_schemas',
      description: '列出当前连接下所有数据库（Schema）名称。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tables',
      description: '列出指定数据库下的表与视图（名称/类型/预估行数/注释），最多返回 50 条。',
      parameters: {
        type: 'object',
        properties: { schema: { type: 'string', description: '数据库名；省略时使用当前活动 Schema' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_table',
      description: '获取表结构：SHOW CREATE TABLE 的完整 DDL + 全部列定义（类型/可空/键/注释）。写 SQL 前应先调用它，禁止编造表列名。',
      parameters: {
        type: 'object',
        properties: {
          schema: { type: 'string', description: '数据库名；省略时使用当前活动 Schema' },
          table: { type: 'string', description: '表名' },
        },
        required: ['table'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sample_data',
      description: '抽样查看表数据：SELECT * ... LIMIT n（最多 20 行），用于了解数据形态。',
      parameters: {
        type: 'object',
        properties: {
          schema: { type: 'string', description: '数据库名；省略时使用当前活动 Schema' },
          table: { type: 'string', description: '表名' },
          n: { type: 'string', description: '抽样行数，默认 10，最大 20' },
        },
        required: ['table'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_query',
      description: '在当前连接上执行一条 SQL 并返回结果摘要。只读语句通常自动执行；写入/结构变更/服务器级语句会弹出人工确认。一次只传一条语句。',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: '要执行的单条 SQL 语句' },
          schema: { type: 'string', description: '执行时使用的数据库；省略时使用当前活动 Schema' },
        },
        required: ['sql'],
      },
    },
  },
]

/* ---------------- 摘要回填辅助 ---------------- */

const PREFIX = '[工具结果 · 来源：本地数据库]'
const CELL_MAX = 40

function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > CELL_MAX ? s.slice(0, CELL_MAX) + '…' : s
}

/** 结果集摘要：列名 + 行数 + 前 5 行（每格截断）+ 截断标记；完整数据只进 UI 不进模型 */
function summarizeQuery(cols: ColumnMeta[], rows: unknown[][], rowCount: number, note?: string): string {
  const lines: string[] = [`列：${cols.map((c) => c.name).join(' | ')}`]
  lines.push(`行数：${rowCount}${note ? `（${note}）` : ''}`)
  rows.slice(0, 5).forEach((r, i) => lines.push(`${i + 1}) ${r.map(cellText).join(' | ')}`))
  if (rows.length > 5) lines.push(`…（其余 ${rows.length - 5} 行省略；如需完整数据请缩小查询范围）`)
  return lines.join('\n')
}

/* ---------------- 连接定位 ---------------- */

/** 解析目标连接与 Schema：工具参数 > 活动标签页 > 连接默认库 */
function resolveTarget(schema?: string) {
  const st = useStore.getState()
  const tab = st.tabs.find((t) => t.id === st.activeTabId)
  const conn = st.connections.find((c) => c.id === tab?.connId) ?? st.connections[0]
  if (!conn) throw new Error('当前没有可用连接，请先在左侧创建并连接一个数据库')
  return { conn, schema: schema?.trim() || tab?.schema || conn.database || '' }
}

/** 统一执行：ensureConnected → adapter.execute → 错误归一为工具结果文本 */
async function execSql(sql: string, schema?: string): Promise<string> {
  try {
    const { conn, schema: sch } = resolveTarget(schema)
    const ad = await ensureConnected(conn)
    const rs = await ad.execute(sql, sch || undefined)
    if (rs.columns.length) return `${PREFIX}\n${summarizeQuery(rs.columns, rs.rows, rs.rowCount)}`
    return `${PREFIX}\n执行成功。${rs.affected != null ? `受影响行数：${rs.affected}。` : ''}${rs.notice ? `\n提示：${rs.notice}` : ''}`
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `${PREFIX}\n执行失败：${msg}\n请据此修正 SQL 后重试，或向用户说明原因。`
  }
}

/* ---------------- 各工具实现 ---------------- */

async function toolListSchemas(args: Record<string, unknown>): Promise<string> {
  try {
    const { conn } = resolveTarget()
    const ad = await ensureConnected(conn)
    const schemas = await ad.listSchemas()
    return `${PREFIX}\n共 ${schemas.length} 个数据库：\n${schemas.join('\n')}`
  } catch (e) {
    return `${PREFIX}\n获取失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function toolListTables(args: Record<string, unknown>): Promise<string> {
  try {
    const { conn, schema } = resolveTarget(args.schema as string | undefined)
    if (!schema) return `${PREFIX}\n失败：无法确定目标数据库（没有活动 Schema，也未传入 schema 参数）`
    const ad = await ensureConnected(conn)
    const tables = await ad.listTables(schema)
    const lines = tables.slice(0, 50).map((t) => {
      const rows = t.rowsApprox != null ? ` · 约 ${t.rowsApprox.toLocaleString()} 行` : ''
      const cmt = t.comment ? ` · ${t.comment}` : ''
      return `${t.name} · ${t.type === 'VIEW' ? '视图' : '表'}${rows}${cmt}`
    })
    const more = tables.length > 50 ? `\n…（其余 ${tables.length - 50} 张省略，可按名称进一步查询）` : ''
    return `${PREFIX}\n数据库 ${schema} 共 ${tables.length} 个对象：\n${lines.join('\n')}${more}`
  } catch (e) {
    return `${PREFIX}\n获取失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function toolDescribeTable(args: Record<string, unknown>): Promise<string> {
  const table = String(args.table ?? '')
  if (!table) return `${PREFIX}\n失败：缺少 table 参数`
  try {
    const { conn, schema } = resolveTarget(args.schema as string | undefined)
    const ad = await ensureConnected(conn)
    const ddl = await ad.showCreateTable(schema, table).catch(() => '')
    const cols = await ad.getColumns(schema, table)
    const colLines = cols.map(
      (c) => `- ${c.name} · ${c.type}${c.nullable ? '' : ' · NOT NULL'}${c.key === 'PRI' ? ' · 主键' : c.key === 'UNI' ? ' · 唯一键' : ''}${c.comment ? ` · ${c.comment}` : ''}`,
    )
    return `${PREFIX}\n表 ${quoteTable(schema, table)} 结构：\n\nDDL：\n${ddl || '（获取 DDL 失败，以下为列信息）'}\n\n列（${cols.length}）：\n${colLines.join('\n')}`
  } catch (e) {
    return `${PREFIX}\n获取失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function toolSampleData(args: Record<string, unknown>): Promise<string> {
  const table = String(args.table ?? '')
  if (!table) return `${PREFIX}\n失败：缺少 table 参数`
  const n = Math.min(Math.max(Number(args.n) || 10, 1), 20)
  try {
    const { conn, schema } = resolveTarget(args.schema as string | undefined)
    const sql = `SELECT * FROM ${quoteTable(schema, table)} LIMIT ${n}`
    const ad = await ensureConnected(conn)
    const rs = await ad.execute(sql, schema || undefined)
    return `${PREFIX}\n表 ${quoteTable(schema, table)} 抽样（LIMIT ${n}）：\n${summarizeQuery(rs.columns, rs.rows, rs.rowCount)}`
  } catch (e) {
    return `${PREFIX}\n获取失败：${e instanceof Error ? e.message : String(e)}`
  }
}

/* ---------------- run_query：风险分级 + 确认矩阵 ---------------- */

async function toolRunQuery(args: Record<string, unknown>): Promise<string> {
  const sql = String(args.sql ?? '').trim().replace(/;\s*$/, '')
  if (!sql) return `${PREFIX}\n失败：缺少 sql 参数`
  const schema = args.schema as string | undefined

  /* 本地分级（模型不可绕过） */
  const report = classifySql(sql)
  const { autoRunReadOnly } = loadAiSettings()

  /* 确认矩阵：L0 且 autoRunReadOnly 或 会话已放行 → 自动执行；其余弹窗 */
  const autoAllowed = report.level === 0 && (autoRunReadOnly || isApprovedSql(sql))
  if (!autoAllowed) {
    const d = await useAiStore.getState().requestConfirm({
      sql,
      schema,
      level: report.level,
      features: report.features,
      allowRemember: report.level === 0, // 仅 L0 提供「记住」放行
    })
    if (d === 'deny') {
      return `${PREFIX}\n用户拒绝执行该 SQL。请勿再次发起这条语句，改为向用户说明风险或给出建议。`
    }
  }

  /* 只读查询无 LIMIT 时自动附加行数上限（复用手动执行的 maxRows 语义） */
  const { prefs } = useStore.getState()
  let exec = sql
  let note: string | undefined
  if (report.level === 0 && isQueryStatement(exec) && !hasTopLevelLimit(exec)) {
    exec = appendLimit(exec, prefs.maxRows)
    note = `已自动附加 LIMIT ${prefs.maxRows}`
  }
  return execSql(exec, schema) + (note ? `\n${note}` : '')
}

/* ---------------- 分发 ---------------- */

/** 执行一次工具调用，返回回填给模型的结果文本 */
export async function runTool(name: string, argsJson: string): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = argsJson ? JSON.parse(argsJson) as Record<string, unknown> : {}
  } catch {
    return `${PREFIX}\n失败：工具参数不是合法 JSON`
  }
  switch (name) {
    case 'list_schemas': return toolListSchemas(args)
    case 'list_tables': return toolListTables(args)
    case 'describe_table': return toolDescribeTable(args)
    case 'sample_data': return toolSampleData(args)
    case 'run_query': return toolRunQuery(args)
    default: return `${PREFIX}\n失败：未知工具「${name}」`
  }
}

/** 工具中文名（折叠卡片展示用） */
export function toolLabel(name: string): string {
  switch (name) {
    case 'list_schemas': return '查询数据库列表'
    case 'list_tables': return '查询表清单'
    case 'describe_table': return '读取表结构'
    case 'sample_data': return '抽样查看数据'
    case 'run_query': return '执行 SQL'
    default: return name
  }
}
