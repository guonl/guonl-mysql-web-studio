/* AI 提示词：系统提示词组装 + 当前连接上下文注入 + @表名 DDL 解析
 *
 * 原则：上下文按需最小化 —— 表清单最多 50 条（只给名称/类型/注释），
 * 完整 DDL 只在用户 @表名 时拉取（M2 起也可由工具 describe_table 拉取）。
 */
import { useStore } from '../core/store'
import { getAdapter } from '../core/store'
import { quoteTable } from '../core/sql'
import type { TableMeta } from '../core/types'

const MAX_TABLES_IN_PROMPT = 50

/** 当前连接/Schema 上下文（无可用连接返回 null）：
 *  优先取活动查询标签页绑定的连接；标签页未选连接（或连接已被删）时，
 *  回退到第一个在线连接——左侧树已连接但新标签页尚未绑定连接时，AI 仍能注入正确的库上下文 */
export function activeCtx(): { connId: string; connName: string; schema?: string } | null {
  const st = useStore.getState()
  const tab = st.tabs.find((t) => t.id === st.activeTabId)
  const bound = tab?.connId ? st.connections.find((c) => c.id === tab.connId) : undefined
  const cfg = bound ?? st.connections.find((c) => st.runtime[c.id]?.status === 'connected')
  if (!cfg) return null
  const schema = bound ? (tab?.schema ?? cfg.database) : (st.runtime[cfg.id]?.currentSchema ?? cfg.database)
  return { connId: cfg.id, connName: cfg.name, schema }
}

/** 重查当前连接的元数据并更新上下文缓存：Schema 列表 + 活动 Schema 的表清单。
 *  新会话打开面板时调用（库表结构可能在面板关闭期间变化）；失败静默，保留旧缓存。 */
export async function refreshActiveContext(): Promise<void> {
  const ctx = activeCtx()
  if (!ctx) return
  const cfg = useStore.getState().connections.find((c) => c.id === ctx.connId)
  const ad = cfg ? getAdapter(cfg) : undefined
  if (!ad) return
  const [schemas, tables] = await Promise.allSettled([
    ad.listSchemas(),
    ctx.schema ? ad.listTables(ctx.schema) : Promise.resolve(null),
  ])
  if (schemas.status === 'fulfilled') useStore.getState().setSchemas(ctx.connId, schemas.value)
  if (tables.status === 'fulfilled' && tables.value && ctx.schema) {
    useStore.getState().setTables(ctx.connId, ctx.schema, tables.value)
  }
}

/** 解析用户消息中的 @表名 引用（@后跟字母数字下划线/$，可含库名 @db.tbl） */
export function resolveAtTables(text: string): { schema?: string; table: string }[] {
  const out: { schema?: string; table: string }[] = []
  const seen = new Set<string>()
  const re = /@([a-zA-Z_$][\w$]*)(?:\.([a-zA-Z_$][\w$]*))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const ref = m[2] ? { schema: m[1], table: m[2] } : { table: m[1] }
    const key = `${ref.schema ?? ''}.${ref.table}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** 在当前连接的表清单中解析表引用 → 全限定名（未命中返回 null） */
function resolveRef(ref: { schema?: string; table: string }): { schema: string; table: string } | null {
  const ctx = activeCtx()
  if (!ctx) return null
  const meta = useStore.getState().meta[ctx.connId]
  if (!meta) return null
  if (ref.schema) {
    const tables = meta.tables[ref.schema]
    if (tables?.some((t) => t.name.toLowerCase() === ref.table.toLowerCase())) {
      return { schema: ref.schema, table: tables.find((t) => t.name.toLowerCase() === ref.table.toLowerCase())!.name }
    }
    return null
  }
  // 无 schema 前缀：先查活动 schema，再查所有 schema
  const schemas = meta.schemas ?? []
  const order = [ctx.schema, ...schemas.filter((s) => s !== ctx.schema)].filter(Boolean) as string[]
  for (const s of order) {
    const tables = meta.tables[s]
    const hit = tables?.find((t) => t.name.toLowerCase() === ref.table.toLowerCase())
    if (hit) return { schema: s, table: hit.name }
  }
  return null
}

/** 拉取 @表 的 DDL（含列注释），返回可注入提示词的文本；失败逐表忽略 */
export async function fetchAtTableDdl(text: string): Promise<string> {
  const refs = resolveAtTables(text)
  if (!refs.length) return ''
  const ctx = activeCtx()
  if (!ctx) return ''
  const cfg = useStore.getState().connections.find((c) => c.id === ctx.connId)
  const ad = cfg ? getAdapter(cfg) : undefined
  if (!ad) return ''
  const parts: string[] = []
  for (const ref of refs) {
    const hit = resolveRef(ref)
    if (!hit) {
      parts.push(`-- @${ref.table}：在当前连接中未找到该表`)
      continue
    }
    try {
      const ddl = await ad.showCreateTable(hit.schema, hit.table)
      parts.push(`-- 表 ${quoteTable(hit.schema, hit.table)} 的建表语句：\n${ddl}`)
    } catch {
      // showCreateTable 失败时退化为列信息
      try {
        const cols = await ad.getColumns(hit.schema, hit.table)
        const lines = cols.map((c) => `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.comment ? ` -- ${c.comment}` : ''}`)
        parts.push(`-- 表 ${quoteTable(hit.schema, hit.table)} 的列信息：\nCREATE TABLE … (\n${lines.join(',\n')}\n)`)
      } catch { /* 双失败忽略 */ }
    }
  }
  return parts.join('\n\n')
}

/** 组装系统提示词（每轮对话实时构建，注入当前连接上下文） */
export async function buildSystemPrompt(): Promise<string> {
  const ctx = activeCtx()
  const st = useStore.getState()

  const lines: string[] = [
    '你是运行在 MySQL Web Studio（纯前端 MySQL 客户端）中的数据库专家助手。',
    '用户界面是一个 SQL 查询工作台：左侧是连接/Schema/表树，中间是 SQL 编辑器，下方是结果区。',
    '',
    '## 行为规范',
    '- 始终使用中文回复；解释文字放在 SQL 代码块之外。',
    '- SQL 一律使用 ```sql 代码块，且一条语句一个代码块（便于用户逐块复制/插入/运行）。',
    '- 修改类操作（INSERT/UPDATE/DELETE/DDL）必须附上影响范围说明与回滚思路。',
    '- 不要编造表名或列名：不确定时先向用户确认，或使用工具查看真实结构。',
    '- 数据类问题优先使用工具查询真实数据，不要凭空猜测数值。',
    '- 除非用户明确要求执行修改类操作，默认只生成 SQL 并解释，由用户决定是否运行。',
  ]

  if (!ctx) {
    lines.push(
      '',
      '## 当前状态',
      '用户尚未在查询标签页中选择数据库连接。涉及具体库表的问题，请引导用户先在工作台顶部选择连接与 Schema。',
    )
    return lines.join('\n')
  }

  const meta = st.meta[ctx.connId]
  lines.push(
    '',
    '## 当前上下文（来自用户界面，非用户输入）',
    `- 连接：${ctx.connName}`,
    `- 活动 Schema：${ctx.schema ?? '（未选择）'}`,
  )

  const schemas = meta?.schemas ?? []
  if (schemas.length) {
    lines.push(`- 可见 Schema（最多列出 20 个）：${schemas.slice(0, 20).join(', ')}`)
  }

  const tables: TableMeta[] | undefined = ctx.schema ? meta?.tables[ctx.schema] : undefined
  if (tables?.length) {
    const rows = tables.slice(0, MAX_TABLES_IN_PROMPT).map((t) => {
      const cmt = t.comment ? ` -- ${t.comment}` : ''
      return `  ${t.name}（${t.type === 'VIEW' ? '视图' : '表'}）${cmt}`
    })
    lines.push(
      `- 活动 Schema 的表清单${tables.length > MAX_TABLES_IN_PROMPT ? `（共 ${tables.length} 张，仅列前 ${MAX_TABLES_IN_PROMPT}）` : ''}：`,
      ...rows,
    )
  }

  lines.push(
    '',
    '用户消息中以 @表名 引用的表，其结构已在消息附注中给出；未引用的表如需结构，请让用户 @该表或使用工具查看。',
  )
  return lines.join('\n')
}
