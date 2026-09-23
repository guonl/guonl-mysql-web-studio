/* 演示模式迷你 SQL 引擎
   支持：SELECT（列/聚合/GROUP BY/WHERE/ORDER BY/LIMIT/DISTINCT）、
        SHOW（DATABASES/TABLES/COLUMNS/CREATE TABLE/INDEX/VARIABLES...）、
        DESCRIBE / EXPLAIN / USE / information_schema 虚拟表
   不支持（给出友好提示）：JOIN、写操作、子查询等 */

import { ExecResult, ColumnMeta } from '../../core/types'
import { DEMO_SCHEMAS, DemoTableDef, DemoColumn, mulberry32, SYSTEM_SCHEMAS, DEMO_SERVER_VERSION } from './data'

/* ---------------- 数据物化缓存 ---------------- */
const rowCache = new Map<string, Record<string, unknown>[]>()
function tableRows(schema: string, def: DemoTableDef): Record<string, unknown>[] {
  const key = `${schema}.${def.name}`
  let rows = rowCache.get(key)
  if (!rows) {
    if (def.type === 'VIEW' && def.viewSelect) {
      const from = findDef(schema, def.viewFrom!)
      rows = def.viewSelect(tableRows(schema, from))
    } else {
      rows = def.gen ? def.gen(mulberry32(42), def.count ?? 50) : []
    }
    rowCache.set(key, rows)
  }
  return rows
}
export function clearDemoCache() { rowCache.clear() }

export function findDef(schema: string, table: string): DemoTableDef {
  const s = DEMO_SCHEMAS.find((x) => x.name === schema)
  const t = s?.tables.find((x) => x.name === table)
  if (!s || !t) throw new DemoSqlError(`Table '${schema}.${table}' doesn't exist`, 1146)
  return t
}

export class DemoSqlError extends Error {
  code: number
  constructor(msg: string, code = 1064) {
    super(msg)
    this.code = code
  }
}

/* ---------------- DDL 渲染（由元数据生成，保证一致） ---------------- */
const esc = (s: string) => s.replace(/'/g, "''")

export function renderCreateTable(schema: string, def: DemoTableDef): string {
  const lines: string[] = []
  for (const c of def.columns) {
    let ln = '  `' + c.name + '` ' + c.type
    if (c.def !== undefined && c.def !== null) {
      ln += ` DEFAULT '${esc(c.def)}'`
      if (c.nullable === false) ln += ' NOT NULL'
    } else if (c.nullable === false) {
      ln += ' NOT NULL'
    } else {
      ln += ' DEFAULT NULL'
    }
    if (c.extra) ln += ' ' + c.extra.toUpperCase()
    if (c.comment) ln += ` COMMENT '${esc(c.comment)}'`
    lines.push(ln)
  }
  if (def.pk.length) lines.push(`  PRIMARY KEY (${def.pk.map((p) => '`' + p + '`').join(', ')})`)
  for (const idx of def.indexes ?? []) {
    const u = idx.unique ? 'UNIQUE KEY ' : 'KEY '
    lines.push(`  ${u}\`${idx.name}\` (${idx.cols.map((c) => '`' + c + '`').join(', ')})`)
  }
  let ddl = `CREATE TABLE \`${def.name}\` (\n${lines.join(',\n')}\n)`
  if (def.type === 'VIEW') {
    ddl = `CREATE ALGORITHM=UNDEFINED VIEW \`${def.name}\` AS SELECT * FROM \`${def.viewFrom}\``
  } else {
    ddl += ` ENGINE=${def.engine ?? 'InnoDB'} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='${esc(def.comment ?? '')}'`
  }
  return ddl
}

/* ---------------- 词法分析 ---------------- */
type Tok = { t: 'id' | 'num' | 'str' | 'op'; v: string; up: string }

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '`') {
      const j = sql.indexOf('`', i + 1)
      if (j < 0) throw new DemoSqlError('反引号未闭合')
      toks.push({ t: 'id', v: sql.slice(i + 1, j), up: sql.slice(i + 1, j).toUpperCase() })
      i = j + 1
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      let out = ''
      while (j < n) {
        if (sql[j] === '\\' && j + 1 < n) { out += sql[j + 1] === 'n' ? '\n' : sql[j + 1]; j += 2; continue }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { out += ch; j += 2; continue } // 转义 ''
          break
        }
        out += sql[j]; j++
      }
      if (j >= n) throw new DemoSqlError('字符串未闭合')
      toks.push({ t: 'str', v: out, up: out.toUpperCase() })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i
      while (j < n && /[0-9.]/.test(sql[j])) j++
      // 科学计数法
      if ((sql[j] === 'e' || sql[j] === 'E') && /[0-9+-]/.test(sql[j + 1] ?? '')) { j++; if (/[+-]/.test(sql[j])) j++; while (j < n && /[0-9]/.test(sql[j])) j++ }
      toks.push({ t: 'num', v: sql.slice(i, j), up: '' })
      i = j
      continue
    }
    if (/[A-Za-z_$\u4e00-\u9fa5@]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$\u4e00-\u9fa5.@]/.test(sql[j])) j++
      const v = sql.slice(i, j)
      toks.push({ t: 'id', v, up: v.toUpperCase() })
      i = j
      continue
    }
    const two = sql.slice(i, i + 2)
    if (['<=', '>=', '!=', '<>', '<<', '>>'].includes(two)) {
      toks.push({ t: 'op', v: two === '<>' ? '!=' : two, up: '' })
      i += 2
      continue
    }
    if ('=<>(),.;*+-/'.includes(ch)) {
      if (ch === '.' && toks.length && (toks[toks.length - 1].t === 'id') && /[0-9]/.test(sql[i + 1] ?? '')) {
        // 数字表别名等，忽略场景
      }
      toks.push({ t: 'op', v: ch, up: '' })
      i++
      continue
    }
    throw new DemoSqlError(`无法识别的字符 '${ch}'`)
  }
  return toks
}

/* ---------------- WHERE 表达式 ---------------- */
type CmpFn = (row: Record<string, unknown>) => boolean

class Parser {
  pos = 0
  constructor(public toks: Tok[], public cols: string[]) {}
  peek(): Tok | undefined { return this.toks[this.pos] }
  next(): Tok | undefined { return this.toks[this.pos++] }
  expectOp(v: string) {
    const t = this.next()
    if (!t || t.t !== 'op' || t.v !== v) throw new DemoSqlError(`期望 '${v}'`)
  }
  isKw(kw: string): boolean {
    const t = this.peek()
    return !!t && t.t === 'id' && t.up === kw
  }
  eatKw(kw: string): boolean {
    if (this.isKw(kw)) { this.pos++; return true }
    return false
  }
  expectKw(kw: string) {
    if (!this.eatKw(kw)) throw new DemoSqlError(`期望关键字 ${kw}`)
  }

  /* orExpr := andExpr (OR andExpr)* */
  parseOr(): CmpFn {
    let left = this.parseAnd()
    while (this.isKw('OR') || this.isKw('||')) {
      this.pos++
      const right = this.parseAnd()
      left = (r) => left(r) || right(r)
    }
    return left
  }
  parseAnd(): CmpFn {
    let left = this.parseAtom()
    while (this.isKw('AND') || this.isKw('&&')) {
      this.pos++
      const right = this.parseAtom()
      left = (r) => left(r) && right(r)
    }
    return left
  }
  parseAtom(): CmpFn {
    if (this.isKw('NOT')) {
      this.pos++
      const inner = this.parseAtom()
      return (r) => !inner(r)
    }
    if (this.peek()?.t === 'op' && this.peek()!.v === '(') {
      this.pos++
      const inner = this.parseOr()
      this.expectOp(')')
      return inner
    }
    // column op value / LIKE / IN / IS NULL / BETWEEN
    const colTok = this.next()
    if (!colTok || colTok.t !== 'id') throw new DemoSqlError('WHERE 条件语法错误')
    let col = colTok.v
    // 忽略表别名前缀 t.col
    if (this.peek()?.t === 'op' && this.peek()!.v === '.' && col.length <= 3 && !this.cols.includes(col)) {
      this.pos++
      const c2 = this.next()
      if (!c2) throw new DemoSqlError('WHERE 条件语法错误')
      col = c2.v
    }
    if (!this.cols.some((c) => c.toLowerCase() === col.toLowerCase())) {
      throw new DemoSqlError(`Unknown column '${col}' in 'where clause'`, 1054)
    }
    const getter = (r: Record<string, unknown>) => r[col] ?? r[col.toLowerCase()] ?? r[col.toUpperCase()]

    if (this.eatKw('IS')) {
      const not = this.eatKw('NOT')
      this.expectKw('NULL')
      return (r) => not ? getter(r) != null : getter(r) == null
    }
    if (this.eatKw('NOT')) {
      if (this.eatKw('LIKE')) {
        const pat = this.readString()
        const re = likeToRe(pat)
        return (r) => !re.test(valueStr(getter(r)))
      }
      if (this.eatKw('IN')) {
        const vals = this.parseValueList()
        return (r) => !vals.some((v) => cmp(getter(r), v) === 0)
      }
      if (this.eatKw('BETWEEN')) {
        const a = this.readValue()
        this.expectKw('AND')
        const b = this.readValue()
        return (r) => !(cmp(getter(r), a) >= 0 && cmp(getter(r), b) <= 0)
      }
      throw new DemoSqlError('NOT 后仅支持 LIKE / IN / BETWEEN')
    }
    if (this.eatKw('LIKE')) {
      const pat = this.readString()
      const re = likeToRe(pat)
      return (r) => re.test(valueStr(getter(r)))
    }
    if (this.eatKw('IN')) {
      const vals = this.parseValueList()
      return (r) => vals.some((v) => cmp(getter(r), v) === 0)
    }
    if (this.eatKw('BETWEEN')) {
      const a = this.readValue()
      this.expectKw('AND')
      const b = this.readValue()
      return (r) => cmp(getter(r), a) >= 0 && cmp(getter(r), b) <= 0
    }
    const opTok = this.next()
    if (!opTok || opTok.t !== 'op' || !['=', '!=', '>', '<', '>=', '<='].includes(opTok.v)) {
      throw new DemoSqlError('WHERE 条件缺少比较运算符')
    }
    const val = this.readValue()
    return (r) => {
      const c = cmp(getter(r), val)
      switch (opTok.v) {
        case '=': return c === 0
        case '!=': return c !== 0
        case '>': return c > 0
        case '<': return c < 0
        case '>=': return c >= 0
        case '<=': return c <= 0
        default: return false
      }
    }
  }
  readString(): string {
    const t = this.next()
    if (!t || t.t !== 'str') throw new DemoSqlError('期望字符串字面量')
    return t.v
  }
  readValue(): string | number | null {
    const t = this.next()
    if (!t) throw new DemoSqlError('缺少比较值')
    if (t.t === 'num') return Number(t.v)
    if (t.t === 'str') return t.v
    if (t.t === 'id' && t.up === 'NULL') return null
    throw new DemoSqlError(`不支持的值 '${t.v}'（演示模式仅支持字面量）`)
  }
  parseValueList(): (string | number | null)[] {
    this.expectOp('(')
    const vals: (string | number | null)[] = []
    while (true) {
      vals.push(this.readValue())
      if (this.peek()?.t === 'op' && this.peek()!.v === ',') { this.pos++; continue }
      break
    }
    this.expectOp(')')
    return vals
  }
}

function valueStr(v: unknown): string {
  if (v == null) return ''
  return String(v)
}

function cmp(a: unknown, b: unknown): number {
  if (a == null || b == null) return NaN
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (!Number.isNaN(na) && nb !== undefined && !Number.isNaN(nb) && String(b).trim() !== '' && typeof a !== 'boolean') {
    // 避免把 '0100' 之类当数字？演示场景从简
    if (!(typeof a === 'string' && a !== '' && !/^-?\d+(\.\d+)?$/.test(a.trim()))) {
      if (!(typeof b === 'string' && b !== '' && !/^-?\d+(\.\d+)?$/.test(b.trim()))) {
        return na < nb ? -1 : na > nb ? 1 : 0
      }
    }
  }
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function likeToRe(pattern: string): RegExp {
  let re = '^'
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*'
    else if (ch === '_') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$', 'i')
}

/* ---------------- 元数据虚拟表（information_schema） ---------------- */
function infoSchemaTable(name: string): { cols: string[]; rows: Record<string, unknown>[] } | null {
  const mk = (schema: string, def: DemoTableDef) => ({ schema, def })
  const all = DEMO_SCHEMAS.flatMap((s) => s.tables.map((t) => mk(s.name, t)))
  switch (name) {
    case 'TABLES':
      return {
        cols: ['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'ENGINE', 'TABLE_ROWS', 'TABLE_COMMENT', 'TABLE_COLLATION'],
        rows: all.map(({ schema, def }) => ({
          TABLE_CATALOG: 'def', TABLE_SCHEMA: schema, TABLE_NAME: def.name,
          TABLE_TYPE: def.type === 'VIEW' ? 'VIEW' : 'BASE TABLE',
          ENGINE: def.type === 'VIEW' ? null : (def.engine ?? 'InnoDB'),
          TABLE_ROWS: def.type === 'VIEW' ? null : (def.count ?? 0),
          TABLE_COMMENT: def.comment ?? '', TABLE_COLLATION: def.type === 'VIEW' ? null : 'utf8mb4_general_ci',
        })),
      }
    case 'COLUMNS':
      return {
        cols: ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_KEY', 'COLUMN_DEFAULT', 'EXTRA', 'COLUMN_COMMENT'],
        rows: all.flatMap(({ schema, def }) => def.columns.map((c, i) => ({
          TABLE_SCHEMA: schema, TABLE_NAME: def.name, COLUMN_NAME: c.name,
          ORDINAL_POSITION: i + 1, COLUMN_TYPE: c.type,
          IS_NULLABLE: c.nullable === false ? 'NO' : 'YES', COLUMN_KEY: c.key ?? '',
          COLUMN_DEFAULT: c.def ?? (c.nullable === false ? null : 'NULL'),
          EXTRA: c.extra ?? '', COLUMN_COMMENT: c.comment ?? '',
        }))),
      }
    case 'STATISTICS':
      return {
        cols: ['TABLE_SCHEMA', 'TABLE_NAME', 'INDEX_NAME', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'NON_UNIQUE', 'INDEX_TYPE'],
        rows: all.flatMap(({ schema, def }) => {
          const out: Record<string, unknown>[] = []
          let seq = 1
          if (def.pk.length) {
            def.pk.forEach((c, i) => out.push({ TABLE_SCHEMA: schema, TABLE_NAME: def.name, INDEX_NAME: 'PRIMARY', SEQ_IN_INDEX: i + 1, COLUMN_NAME: c, NON_UNIQUE: 0, INDEX_TYPE: 'BTREE' }))
            seq = def.pk.length + 1
          }
          for (const idx of def.indexes ?? []) {
            idx.cols.forEach((c, i) => out.push({ TABLE_SCHEMA: schema, TABLE_NAME: def.name, INDEX_NAME: idx.name, SEQ_IN_INDEX: i + 1, COLUMN_NAME: c, NON_UNIQUE: idx.unique ? 0 : 1, INDEX_TYPE: 'BTREE' }))
            seq += idx.cols.length
          }
          void seq
          return out
        }),
      }
    case 'SCHEMATA':
      return {
        cols: ['SCHEMA_NAME', 'DEFAULT_CHARACTER_SET_NAME', 'DEFAULT_COLLATION_NAME'],
        rows: [...DEMO_SCHEMAS.map((s) => ({ SCHEMA_NAME: s.name, DEFAULT_CHARACTER_SET_NAME: 'utf8mb4', DEFAULT_COLLATION_NAME: 'utf8mb4_general_ci' })),
          ...SYSTEM_SCHEMAS.map((s) => ({ SCHEMA_NAME: s, DEFAULT_CHARACTER_SET_NAME: 'utf8mb4', DEFAULT_COLLATION_NAME: 'utf8mb4_general_ci' }))],
      }
    case 'KEY_COLUMN_USAGE':
      return {
        cols: ['CONSTRAINT_NAME', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION'],
        rows: all.flatMap(({ schema, def }) => def.pk.map((c, i) => ({
          CONSTRAINT_NAME: 'PRIMARY', TABLE_SCHEMA: schema, TABLE_NAME: def.name, COLUMN_NAME: c, ORDINAL_POSITION: i + 1,
        }))),
      }
    default:
      return null
  }
}

/* ---------------- SELECT 执行 ---------------- */
interface SelectItem { raw: string; col?: string; agg?: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'; aggArg?: string; alias?: string; star?: boolean; starPrefix?: string }

function parseSelect(toks: Tok[]): ParsedSelect {
  const p = new Parser(toks, [])
  p.expectKw('SELECT')
  const distinct = p.eatKw('DISTINCT')
  const items: SelectItem[] = []
  // select list
  while (true) {
    const t = p.peek()
    if (!t) throw new DemoSqlError('SELECT 列表不完整')
    if (t.t === 'op' && t.v === '*') {
      p.pos++
      items.push({ raw: '*', star: true })
    } else if (t.t === 'id') {
      // func? / col / alias.col
      const name = t.v
      p.pos++
      if (p.peek()?.t === 'op' && p.peek()!.v === '(') {
        p.pos++ // (
        const fn = name.toUpperCase()
        if (!['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(fn)) {
          throw new DemoSqlError(`演示模式仅支持聚合函数 COUNT/SUM/AVG/MIN/MAX，不支持 ${fn}()`)
        }
        const argTok = p.next()
        let arg = '*'
        if (argTok && !(argTok.t === 'op' && argTok.v === '*')) arg = argTok.v
        p.expectOp(')')
        items.push({ raw: `${fn}(${arg})`, agg: fn as SelectItem['agg'], aggArg: arg })
      } else if (p.peek()?.t === 'op' && p.peek()!.v === '.') {
        p.pos++
        const t2 = p.next()
        if (!t2) throw new DemoSqlError('SELECT 语法错误')
        if (t2.t === 'op' && t2.v === '*') items.push({ raw: `${name}.*`, star: true, starPrefix: name })
        else items.push({ raw: t2.v, col: t2.v })
      } else {
        items.push({ raw: name, col: name })
      }
      if (p.eatKw('AS')) {
        const al = p.next()
        if (!al) throw new DemoSqlError('AS 后缺少别名')
        items[items.length - 1].alias = al.v
      }
    } else {
      throw new DemoSqlError(`SELECT 列表中不支持 '${t.v}'`)
    }
    if (p.peek()?.t === 'op' && p.peek()!.v === ',') { p.pos++; continue }
    break
  }
  p.expectKw('FROM')
  // table ref
  const tabTok = p.next()
  if (!tabTok || tabTok.t !== 'id') throw new DemoSqlError('FROM 后缺少表名')
  let table = tabTok.v
  let db: string | undefined
  if (p.peek()?.t === 'op' && p.peek()!.v === '.') {
    p.pos++
    const t2 = p.next()
    if (!t2 || t2.t !== 'id') throw new DemoSqlError('FROM 语法错误')
    db = table
    table = t2.v
  }
  // alias
  if (p.peek()?.t === 'id' && !['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'JOIN', 'LEFT', 'INNER', 'UNION', 'HAVING'].includes(p.peek()!.up)) {
    p.pos++ // consume alias, ignore
  }
  // JOIN 不支持
  if (p.isKw('JOIN') || p.isKw('LEFT') || p.isKw('INNER') || p.isKw('RIGHT') || p.isKw('CROSS')) {
    throw new DemoSqlError('演示模式暂不支持 JOIN：请使用视图（如 shop.v_order_detail），或连接真实 MySQL 体验完整能力')
  }
  if (p.isKw('UNION')) {
    throw new DemoSqlError('演示模式暂不支持 UNION')
  }
  let where: CmpFn | null = null
  let whereRaw = ''
  if (p.eatKw('WHERE')) {
    whereRaw = restText(p)
    const sub = tokenize(whereRaw)
    const wp = new Parser(sub, [])
    where = wp.parseOr()
    if (wp.pos < wp.toks.length) throw new DemoSqlError('WHERE 条件解析不完整')
  }
  const groupBy: string[] = []
  if (p.eatKw('GROUP')) {
    p.expectKw('BY')
    while (true) {
      const c = p.next()
      if (!c || c.t !== 'id') throw new DemoSqlError('GROUP BY 语法错误')
      groupBy.push(c.v)
      if (p.peek()?.t === 'op' && p.peek()!.v === ',') { p.pos++; continue }
      break
    }
  }
  if (p.isKw('HAVING')) throw new DemoSqlError('演示模式暂不支持 HAVING')
  const orderBy: { col: string; desc: boolean }[] = []
  if (p.eatKw('ORDER')) {
    p.expectKw('BY')
    while (true) {
      const c = p.next()
      if (!c) throw new DemoSqlError('ORDER BY 语法错误')
      let colName = c.v
      if (c.t === 'num') colName = '#' + c.v // 序号引用
      const desc = (() => {
        if (p.isKw('DESC')) { p.pos++; return true }
        if (p.isKw('ASC')) { p.pos++; return false }
        return false
      })()
      orderBy.push({ col: colName, desc })
      if (p.peek()?.t === 'op' && p.peek()!.v === ',') { p.pos++; continue }
      break
    }
  }
  let limit: number | undefined
  let offset: number | undefined
  if (p.eatKw('LIMIT')) {
    const a = p.next()
    if (!a || a.t !== 'num') throw new DemoSqlError('LIMIT 语法错误')
    if (p.peek()?.t === 'op' && p.peek()!.v === ',') {
      p.pos++
      const b = p.next()
      if (!b || b.t !== 'num') throw new DemoSqlError('LIMIT 语法错误')
      offset = Number(a.v); limit = Number(b.v)
    } else if (p.eatKw('OFFSET')) {
      const b = p.next()
      if (!b || b.t !== 'num') throw new DemoSqlError('OFFSET 语法错误')
      limit = Number(a.v); offset = Number(b.v)
    } else {
      limit = Number(a.v)
    }
  }
  if (p.pos < p.toks.length) {
    throw new DemoSqlError(`演示模式无法解析 SQL 片段：'${p.toks.slice(p.pos).map((t) => t.v).join(' ')}'`)
  }
  return { distinct, items, table, db, where, whereRaw, groupBy, orderBy, limit, offset }
}

function restText(p: Parser): string {
  // 从当前位置回溯原文：利用 tokenizer 不改变 token 内容，简单重建（字符串重新加引号）
  return p.toks.slice(p.pos).map((t) => (t.t === 'str' ? `'${t.v}'` : t.v)).join(' ')
}

interface ParsedSelect {
  distinct: boolean
  items: SelectItem[]
  table: string
  db?: string
  where: CmpFn | null
  whereRaw: string
  groupBy: string[]
  orderBy: { col: string; desc: boolean }[]
  limit?: number
  offset?: number
}

function execSelect(sql: string, currentSchema: string): ExecResult {
  const toks = tokenize(sql)
  const sel = parseSelect(toks)
  const schema = (sel.db ?? currentSchema).replace(/@@/, '')
  if (SYSTEM_SCHEMAS.includes(schema.toLowerCase())) {
    // information_schema 虚拟表
    if (schema.toLowerCase() === 'information_schema') {
      const virt = infoSchemaTable(sel.table.toUpperCase())
      if (virt) {
        const filtered = sel.where ? virt.rows.filter(sel.where) : virt.rows
        const projected = projectRows(filtered, virt.cols, sel)
        return wrapResult(projected, sel, sql)
      }
      throw new DemoSqlError(`演示模式 information_schema 暂不支持 ${sel.table}`)
    }
    throw new DemoSqlError(`演示模式不包含系统库 ${schema}`)
  }
  const def = findDef(schema, sel.table)
  const cols = def.columns.map((c) => c.name)
  let rows = tableRows(schema, def)
  if (sel.where) rows = rows.filter(sel.where)
  const projected = projectRows(rows, cols, sel, def, schema)
  return wrapResult(projected, sel, sql)
}

interface Projected { columns: ColumnMeta[]; rows: unknown[][] }

function projectRows(
  rows: Record<string, unknown>[],
  srcCols: string[],
  sel: ParsedSelect,
  def?: DemoTableDef,
  schemaName?: string,
): Projected {
  const hasAgg = sel.items.some((i) => i.agg)
  const hasGroup = sel.groupBy.length > 0

  // 展开输出列
  const outCols: { key: string; label: string }[] = []
  for (const it of sel.items) {
    if (it.star) {
      const list = it.starPrefix
        ? srcCols // 简化：t.* 与 * 等价（单表）
        : srcCols
      for (const c of list) outCols.push({ key: c, label: c })
    } else if (it.col) {
      const found = srcCols.find((c) => c.toLowerCase() === it.col!.toLowerCase())
      if (!found) throw new DemoSqlError(`Unknown column '${it.col}' in 'field list'`, 1054)
      outCols.push({ key: found, label: it.alias ?? it.col })
    } else if (it.agg) {
      outCols.push({ key: it.raw, label: it.alias ?? it.raw })
    }
  }

  // GROUP BY
  let workRows: Record<string, unknown>[]
  if (hasGroup) {
    const gCols = sel.groupBy.map((g) => {
      const f = srcCols.find((c) => c.toLowerCase() === g.toLowerCase())
      if (!f) throw new DemoSqlError(`Unknown column '${g}' in 'group statement'`, 1054)
      return f
    })
    const groups = new Map<string, Record<string, unknown>[]>()
    for (const r of rows) {
      const k = gCols.map((c) => String(r[c])).join('\u0001')
      const arr = groups.get(k) ?? []
      arr.push(r)
      groups.set(k, arr)
    }
    workRows = []
    for (const g of groups.values()) {
      const rep = g[0]
      const merged: Record<string, unknown> = { ...rep }
      merged.__group__ = g
      workRows.push(merged)
    }
  } else {
    workRows = rows.map((r) => ({ ...r }))
  }

  // 计算输出行
  const out: unknown[][] = []
  const pushRow = (r: Record<string, unknown>) => {
    const line = outCols.map((c) => {
      const aggItem = sel.items.find((i) => i.raw === c.key || (i.alias ?? i.raw) === c.label) as SelectItem | undefined
      if (aggItem?.agg) {
        const list = (r.__group__ ?? [r]) as Record<string, unknown>[]
        return aggregate(aggItem, list, srcCols)
      }
      const v = r[c.key]
      return v === undefined ? null : v
    })
    out.push(line)
  }

  if (hasAgg && !hasGroup) {
    // 全表聚合，无 GROUP BY：一行
    if (rows.length || sel.items.some((i) => i.agg === 'COUNT')) {
      pushRow({ __group__: rows })
    } else {
      pushRow({ __group__: [] })
    }
  } else {
    for (const r of workRows) pushRow(r)
  }

  // DISTINCT
  let finalRows = out
  if (sel.distinct) {
    const seen = new Set<string>()
    finalRows = out.filter((r) => {
      const k = JSON.stringify(r)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  // ORDER BY
  if (sel.orderBy.length) {
    const idxOf = (col: string): number => {
      if (col.startsWith('#')) {
        const i = Number(col.slice(1)) - 1
        return i >= 0 && i < outCols.length ? i : -1
      }
      const byLabel = outCols.findIndex((c) => c.label.toLowerCase() === col.toLowerCase())
      if (byLabel >= 0) return byLabel
      return outCols.findIndex((c) => c.key.toLowerCase() === col.toLowerCase())
    }
    const sorters = sel.orderBy.map((o) => ({ idx: idxOf(o.col), desc: o.desc })).filter((x) => x.idx >= 0)
    if (sorters.length) {
      finalRows = [...finalRows].sort((a, b) => {
        for (const s of sorters) {
          const c = cmpNullAware(a[s.idx], b[s.idx])
          if (c !== 0) return s.desc ? -c : c
        }
        return 0
      })
    }
  }

  // LIMIT
  if (sel.limit !== undefined) {
    const off = sel.offset ?? 0
    finalRows = finalRows.slice(off, off + sel.limit)
  }

  /* 普通单表查询（非聚合/分组/去重）的行才是物理行，才允许结果集编辑定位来源表 */
  const physical = !hasAgg && !hasGroup && !sel.distinct
  const columns: ColumnMeta[] = outCols.map((c) => {
    const src = physical ? def?.columns.find((dc) => dc.name.toLowerCase() === c.key.toLowerCase()) : undefined
    return {
      name: c.label,
      orgName: src?.name ?? c.label,
      type: src && !aggLabel(c.key) ? src.type : aggLabel(c.key) || 'text',
      nullable: src ? src.nullable !== false : true,
      key: src?.key ?? '',
      comment: src?.comment ?? '',
      table: src ? def?.name ?? '' : '',
      schema: src ? schemaName ?? '' : '',
    }
  })
  return { columns, rows: finalRows }
}

function aggLabel(key: string): string {
  if (/^count\(/i.test(key)) return 'bigint'
  if (/^sum\(/i.test(key)) return 'decimal'
  if (/^avg\(/i.test(key)) return 'decimal'
  return ''
}

function aggregate(item: SelectItem, list: Record<string, unknown>[], srcCols: string[]): unknown {
  const arg = item.aggArg ?? '*'
  if (item.agg === 'COUNT') {
    if (arg === '*' || arg === '1') return list.length
    const f = srcCols.find((c) => c.toLowerCase() === arg.toLowerCase())
    return list.filter((r) => f && r[f] != null).length
  }
  const f = srcCols.find((c) => c.toLowerCase() === arg.toLowerCase())
  if (!f) throw new DemoSqlError(`Unknown column '${arg}'`, 1054)
  const nums = list.map((r) => r[f]).filter((v) => v != null && v !== '').map(Number).filter((n) => !Number.isNaN(n))
  if (item.agg === 'SUM') return nums.length ? Number(nums.reduce((s, x) => s + x, 0).toFixed(2)) : null
  if (item.agg === 'AVG') return nums.length ? Number((nums.reduce((s, x) => s + x, 0) / nums.length).toFixed(2)) : null
  if (item.agg === 'MIN') return nums.length ? Math.min(...nums) : null
  if (item.agg === 'MAX') return nums.length ? Math.max(...nums) : null
  return null
}

function cmpNullAware(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1 // NULL 排最后
  if (b == null) return -1
  return cmp(a, b)
}

function wrapResult(projected: Projected, _sel: ParsedSelect, _sql: string): ExecResult {
  return { columns: projected.columns, rows: projected.rows, rowCount: projected.rows.length }
}

/* ---------------- SHOW / DESC / 工具语句 ---------------- */
function showColumns(def: DemoTableDef, full: boolean): ExecResult {
  const cols: ColumnMeta[] = full
    ? [
        { name: 'Field', type: '', nullable: true, comment: '字段名' },
        { name: 'Type', type: '', nullable: true, comment: '数据类型' },
        { name: 'Collation', type: '', nullable: true, comment: '排序规则' },
        { name: 'Null', type: '', nullable: true, comment: '是否允许 NULL' },
        { name: 'Key', type: '', nullable: true, comment: '键：PRI 主键 / UNI 唯一 / MUL 普通索引' },
        { name: 'Default', type: '', nullable: true, comment: '默认值' },
        { name: 'Extra', type: '', nullable: true, comment: '附加属性（如 auto_increment）' },
        { name: 'Privileges', type: '', nullable: true, comment: '权限' },
        { name: 'Comment', type: '', nullable: true, comment: '字段注释' },
      ]
    : [
        { name: 'Field', type: '', nullable: true, comment: '字段名' },
        { name: 'Type', type: '', nullable: true, comment: '数据类型' },
        { name: 'Null', type: '', nullable: true, comment: '是否允许 NULL' },
        { name: 'Key', type: '', nullable: true, comment: '键类型' },
        { name: 'Default', type: '', nullable: true, comment: '默认值' },
        { name: 'Extra', type: '', nullable: true, comment: '附加属性' },
      ]
  const rows = def.columns.map((c: DemoColumn) => {
    const base = [c.name, c.type]
    if (full) {
      return [...base, 'utf8mb4_general_ci', c.nullable === false ? 'NO' : 'YES', c.key ?? '', c.def ?? null, c.extra ?? '', 'select,insert,update,references', c.comment ?? '']
    }
    return [...base, c.nullable === false ? 'NO' : 'YES', c.key ?? '', c.def ?? null, c.extra ?? '']
  })
  return { columns: cols, rows, rowCount: rows.length }
}

function showIndex(schema: string, def: DemoTableDef): ExecResult {
  const columns: ColumnMeta[] = [
    { name: 'Table', type: '', nullable: true, comment: '表名' },
    { name: 'Non_unique', type: '', nullable: true, comment: '1=非唯一索引' },
    { name: 'Key_name', type: '', nullable: true, comment: '索引名' },
    { name: 'Seq_in_index', type: '', nullable: true, comment: '列在索引中的序号' },
    { name: 'Column_name', type: '', nullable: true, comment: '索引列' },
    { name: 'Index_type', type: '', nullable: true, comment: '索引类型' },
  ]
  const rows: unknown[][] = []
  if (def.pk.length) {
    def.pk.forEach((c, i) => rows.push([def.name, 0, 'PRIMARY', i + 1, c, 'BTREE']))
  }
  for (const idx of def.indexes ?? []) {
    idx.cols.forEach((c, i) => rows.push([def.name, idx.unique ? 0 : 1, idx.name, i + 1, c, 'BTREE']))
  }
  void schema
  return { columns, rows, rowCount: rows.length }
}

const DEMO_VARIABLES: [string, string][] = [
  ['version', DEMO_SERVER_VERSION],
  ['version_comment', 'MySQL Web Studio Demo Engine'],
  ['character_set_server', 'utf8mb4'],
  ['collation_server', 'utf8mb4_general_ci'],
  ['max_connections', '151'],
  ['sql_mode', 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO'],
  ['lower_case_table_names', '0'],
  ['wait_timeout', '28800'],
]

/* ---------------- 主入口 ---------------- */
/** 剥离 SQL 中的 `--` 行注释、`#` 行注释与块注释（保留字符串/反引号内内容） */
function stripComments(sql: string): string {
  let out = ''
  let i = 0
  let state: 'none' | 'sq' | 'dq' | 'bt' = 'none'
  while (i < sql.length) {
    const c = sql[i]
    const c2 = sql[i + 1]
    if (state === 'none') {
      if (c === '-' && c2 === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue }
      if (c === '#') { while (i < sql.length && sql[i] !== '\n') i++; continue }
      if (c === '/' && c2 === '*') {
        i += 2
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
        i += 2
        out += ' '
        continue
      }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'bt'
      out += c
      i++
      continue
    }
    out += c
    if (c === '\\' && state !== 'bt') { out += c2 ?? ''; i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bt' && c === '`')) {
      if (c2 === c) { out += c2; i += 2; continue }
      state = 'none'
    }
    i++
  }
  return out
}

export function demoExecute(sql: string, currentSchema: string): ExecResult {
  const s = stripComments(sql).trim()
  if (!s) return { columns: [], rows: [], rowCount: 0, info: '空语句或纯注释，已忽略' }
  const noSemi = s.replace(/;\s*$/, '')
  const head = noSemi.replace(/^\s*(\/\*[\s\S]*?\*\/|\s)+/, '')
  const kw = head.split(/[\s(]/)[0]?.toUpperCase() ?? ''

  switch (kw) {
    case 'SELECT': return tryBareSelect(noSemi, currentSchema) ?? execSelect(noSemi, currentSchema)
    case 'SHOW': return execShow(noSemi, currentSchema)
    case 'DESC':
    case 'DESCRIBE': {
      const m = noSemi.match(/^(?:DESC|DESCRIBE)\s+(?:`?(\w+)`?\.)?`?(\w+)`?/i)
      if (!m) throw new DemoSqlError('DESC 语法：DESC tbl_name')
      const schema = m[1] ?? currentSchema
      const def = findDef(schema, m[2])
      return showColumns(def, false)
    }
    case 'EXPLAIN': {
      const rest = noSemi.slice(7).trim()
      if (/^select/i.test(rest)) {
        const target = rest.match(/from\s+`?(\w+)`?/i)?.[1]
        const def = target ? findDef(currentSchema, target) : null
        const pkCol = def?.pk[0] ?? def?.columns[0]?.name ?? 'id'
        return {
          columns: [
            { name: 'id', type: '', nullable: true, comment: '执行序号' },
            { name: 'select_type', type: '', nullable: true, comment: '查询类型' },
            { name: 'table', type: '', nullable: true, comment: '访问的表' },
            { name: 'type', type: '', nullable: true, comment: '访问类型：ALL 全表 / ref 索引' },
            { name: 'key', type: '', nullable: true, comment: '实际使用的索引' },
            { name: 'rows', type: '', nullable: true, comment: '预估扫描行数' },
            { name: 'filtered', type: '', nullable: true, comment: '过滤比例 %' },
            { name: 'Extra', type: '', nullable: true, comment: '附加信息' },
          ],
          rows: [[1, 'SIMPLE', target ?? 'dual', 'ALL', null, def?.count ?? 1, 100.0, '演示模式为模拟执行计划']],
          rowCount: 1,
          notice: '演示模式的模拟执行计划，仅供参考',
        }
      }
      throw new DemoSqlError('演示模式 EXPLAIN 仅支持 SELECT')
    }
    case 'USE': {
      const m = noSemi.match(/^use\s+`?(\w+)`?/i)
      if (!m) throw new DemoSqlError('USE 语法：USE db_name')
      const db = m[1]
      if (!DEMO_SCHEMAS.some((x) => x.name === db) && !SYSTEM_SCHEMAS.includes(db)) {
        throw new DemoSqlError(`Unknown database '${db}'`, 1049)
      }
      return { columns: [], rows: [], rowCount: 0, info: `Schema switched to ${db}` }
    }
    case 'SET':
    case 'START':
    case 'BEGIN':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'KILL':
    case 'FLUSH':
    case 'ANALYZE':
    case 'OPTIMIZE':
      return { columns: [], rows: [], rowCount: 0, info: '演示模式：语句已接受（无实际效果）' }
    case 'INSERT': case 'UPDATE': case 'DELETE': case 'REPLACE':
    case 'CREATE': case 'DROP': case 'ALTER': case 'TRUNCATE': case 'RENAME':
    case 'GRANT': case 'REVOKE': case 'LOAD': case 'CALL':
      throw new DemoSqlError('演示模式为只读数据集，不支持写操作（DDL/DML）。可添加真实连接体验完整功能', 1290)
    default:
      throw new DemoSqlError(`演示模式无法识别该语句（${kw || '空语句'}）`)
  }
}

function execShow(sql: string, currentSchema: string): ExecResult {
  const s = sql.replace(/^show\s+/i, '')
  const kw = s.split(/[\s(]/)[0]?.toUpperCase() ?? ''

  if (kw === 'DATABASES' || kw === 'SCHEMAS') {
    const like = s.match(/like\s+'([^']*)'/i)?.[1]
    const names = [...DEMO_SCHEMAS.map((x) => x.name), ...SYSTEM_SCHEMAS]
    const rows = names
      .filter((n) => (like ? likeToRe(like).test(n) : true))
      .map((n) => [n])
    return {
      columns: [{ name: 'Database', type: '', nullable: true, comment: 'schema 名称' }],
      rows, rowCount: rows.length,
    }
  }

  if (kw === 'TABLES' || kw === 'FULL') {
    const full = kw === 'FULL'
    const rest = full ? s.replace(/^full\s+/i, '') : s
    if (!/^tables/i.test(rest)) throw new DemoSqlError('不支持的 SHOW 语句')
    const db = rest.match(/from\s+`?(\w+)`?/i)?.[1] ?? currentSchema
    const like = rest.match(/like\s+'([^']*)'/i)?.[1]
    const sch = DEMO_SCHEMAS.find((x) => x.name === db)
    if (!sch) throw new DemoSqlError(`Unknown database '${db}'`, 1049)
    const defs = sch.tables.filter((t) => (like ? likeToRe(like).test(t.name) : true))
    if (full) {
      return {
        columns: [
          { name: 'Tables_in_' + db, type: '', nullable: true, comment: '表名' },
          { name: 'Table_type', type: '', nullable: true, comment: '类型：BASE TABLE / VIEW' },
        ],
        rows: defs.map((t) => [t.name, t.type === 'VIEW' ? 'VIEW' : 'BASE TABLE']),
        rowCount: defs.length,
      }
    }
    return {
      columns: [{ name: `Tables_in_${db}`, type: '', nullable: true, comment: '表名' }],
      rows: defs.map((t) => [t.name]),
      rowCount: defs.length,
    }
  }

  const colsMatch = s.match(/^(full\s+)?columns\s+from\s+`?(\w+)`?(?:\s+from\s+`?(\w+)`?)?/i)
    ?? s.match(/^(full\s+)?fields\s+from\s+`?(\w+)`?(?:\s+from\s+`?(\w+)`?)?/i)
  if (colsMatch) {
    const full = !!colsMatch[1]
    const table = colsMatch[2]
    const schema = colsMatch[3] ?? currentSchema
    const def = findDef(schema, table)
    return showColumns(def, full)
  }

  const ctMatch = s.match(/^create\s+table\s+`?(\w+)`?(?:\s+from\s+`?(\w+)`?)?/i)
  if (ctMatch) {
    const table = ctMatch[1]
    const schema = ctMatch[2] ?? currentSchema
    const def = findDef(schema, table)
    return {
      columns: [
        { name: 'Table', type: '', nullable: true, comment: '表名' },
        { name: 'Create Table', type: '', nullable: true, comment: '建表语句（含注释/索引）' },
      ],
      rows: [[def.name, renderCreateTable(schema, def)]],
      rowCount: 1,
    }
  }

  const idxMatch = s.match(/^(index|keys)\s+from\s+`?(\w+)`?(?:\s+from\s+`?(\w+)`?)?/i)
  if (idxMatch) {
    const schema = idxMatch[3] ?? currentSchema
    const def = findDef(schema, idxMatch[2])
    return showIndex(schema, def)
  }

  if (kw === 'VARIABLES') {
    const like = s.match(/like\s+'([^']*)'/i)?.[1]
    const rows = DEMO_VARIABLES.filter(([k]) => (like ? likeToRe(like).test(k) : true)).map(([k, v]) => [k, v])
    return {
      columns: [
        { name: 'Variable_name', type: '', nullable: true, comment: '变量名' },
        { name: 'Value', type: '', nullable: true, comment: '变量值' },
      ],
      rows, rowCount: rows.length,
    }
  }

  if (kw === 'ENGINES') {
    return {
      columns: [
        { name: 'Engine', type: '', nullable: true, comment: '存储引擎' },
        { name: 'Support', type: '', nullable: true, comment: '支持程度' },
        { name: 'Comment', type: '', nullable: true, comment: '说明' },
      ],
      rows: [['InnoDB', 'DEFAULT', 'Supports transactions, row-level locking, and foreign keys']],
      rowCount: 1,
    }
  }

  if (kw === 'PROCESSLIST') {
    return {
      columns: [
        { name: 'Id', type: '', nullable: true, comment: '连接ID' },
        { name: 'User', type: '', nullable: true, comment: '用户' },
        { name: 'Host', type: '', nullable: true, comment: '来源主机' },
        { name: 'db', type: '', nullable: true, comment: '当前数据库' },
        { name: 'Command', type: '', nullable: true, comment: '命令' },
        { name: 'Time', type: '', nullable: true, comment: '持续秒数' },
        { name: 'State', type: '', nullable: true, comment: '状态' },
        { name: 'Info', type: '', nullable: true, comment: '正在执行的语句' },
      ],
      rows: [[1, 'demo_user', 'browser:local', currentSchema, 'Query', 0, 'executing', 'SHOW PROCESSLIST']],
      rowCount: 1,
    }
  }

  throw new DemoSqlError(`演示模式不支持的 SHOW 语句：SHOW ${kw}`)
}

/* ---------------- 无 FROM 的表达式（SELECT 1 / @@version 等） ---------------- */
export function tryBareSelect(sql: string, currentSchema: string): ExecResult | null {
  const s = sql.trim().replace(/;\s*$/, '')
  if (!/^select\s/i.test(s) || /\sfrom\s/i.test(s)) return null
  const body = s.replace(/^select\s+/i, '')
  const map: Record<string, unknown> = {
    '@@version': DEMO_SERVER_VERSION,
    '@@version_comment': 'MySQL Web Studio Demo',
    '@@sql_mode': 'STRICT_TRANS_TABLES',
    '@@character_set_server': 'utf8mb4',
    'version()': DEMO_SERVER_VERSION,
    'now()': new Date().toISOString().slice(0, 19).replace('T', ' '),
    'current_user()': 'demo_user@%',
    'user()': 'demo_user@%',
    'connection_id()': 1,
    '1': 1,
  }
  const cols: string[] = []
  const vals: unknown[] = []
  for (const part of body.split(',')) {
    const key = part.trim().toLowerCase().replace(/\s+as\s+\w+$/i, '')
    let v = map[key]
    if (key === 'database()') v = currentSchema
    if (v === undefined) return null
    cols.push((part.match(/\bas\s+(\w+)$/i)?.[1]) ?? key.replace(/@@/, '@@'))
    vals.push(v)
  }
  return {
    columns: cols.map((c) => ({ name: c, type: '', nullable: true, key: '' })),
    rows: [vals],
    rowCount: 1,
  }
}
