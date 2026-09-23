/* SQL 工具：语句拆分 / 格式化 / INSERT 生成 / CSV 导出 / 表名解析 */

import type { ColumnMeta } from './types'
import { fmtDateTime } from './utils'

/** 标识符加反引号 */
export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

/** 全限定表名 `schema`.`table` */
export function quoteTable(schema: string | undefined, table: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table)
}

/** SQL 字符串字面量转义 */
export function quoteValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Date) return `'${fmtDateTime(v)}'`
  const s = String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u001a/g, '\\Z')
  return `'${s}'`
}

/**
 * 按分号拆分 SQL 语句，正确跳过字符串、反引号标识符与注释。
 * 返回去掉空语句与行注释后的语句数组。
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length
  let state: 'none' | 'sq' | 'dq' | 'bt' | 'line' | 'block' = 'none'
  while (i < n) {
    const c = sql[i]
    const c2 = sql[i + 1]
    if (state === 'none') {
      if (c === '-' && c2 === '-') { state = 'line'; cur += c + c2; i += 2; continue }
      if (c === '#') { state = 'line'; cur += c; i++; continue }
      if (c === '/' && c2 === '*') { state = 'block'; cur += c + c2; i += 2; continue }
      if (c === "'") { state = 'sq'; cur += c; i++; continue }
      if (c === '"') { state = 'dq'; cur += c; i++; continue }
      if (c === '`') { state = 'bt'; cur += c; i++; continue }
      if (c === ';') {
        const s = cur.trim()
        if (s) out.push(s)
        cur = ''
        i++
        continue
      }
      cur += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') state = 'none'
      cur += c
      i++
      continue
    }
    if (state === 'block') {
      cur += c
      if (c === '*' && c2 === '/') { cur += c2; i += 2; state = 'none'; continue }
      i++
      continue
    }
    // 字符串 / 标识符
    cur += c
    if (c === '\\' && state !== 'bt') { cur += c2 ?? ''; i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bt' && c === '`')) {
      // 双写转义（'' / ``）
      if (c2 === c) { cur += c2; i += 2; continue }
      state = 'none'
    }
    i++
  }
  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}

/** 语句是否为只读查询（粗略判断，供 UI 提示） */
export function isReadOnlySql(sql: string): boolean {
  const s = sql.replace(/^\s*(?:\/\*[\s\S]*?\*\/|--[^\n]*\n?|#)/g, '').trim()
  return /^(SELECT|SHOW|DESC|R?DESCRIBE|EXPLAIN|USE|SET|WITH)\b/i.test(s)
}

const MAJOR_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'DROP', 'ALTER',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'JOIN', 'ON', 'AND', 'OR', 'ASC', 'DESC',
])

const NEWLINE_BEFORE = new Set([
  'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'UNION', 'UNION ALL',
  'INSERT INTO', 'VALUES', 'SET', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'JOIN',
  'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'INNER OUTER JOIN', 'CROSS JOIN', 'ON',
])

/** 轻量 SQL 格式化：关键字大写 + 主要子句换行缩进 */
export function formatSql(sql: string): string {
  // 先去掉换行，把空白压成单空格，再按 token 处理
  const flat = sql.replace(/\s+/g, ' ').trim()
  if (!flat) return flat
  const tokens = tokenize(flat)
  let out = ''
  let depth = 0
  let prev = ''
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]
    const up = tk.toUpperCase()
    const twoWord = up === 'GROUP' || up === 'ORDER' || up === 'UNION' || up === 'LEFT' || up === 'RIGHT' || up === 'INNER' || up === 'CROSS'
    const phrase = twoWord && tokens[i + 1] ? `${up} ${tokens[i + 1].toUpperCase()}` : up

    if (NEWLINE_BEFORE.has(phrase)) {
      out = out.replace(/\s*$/, '')
      if (out) out += '\n'
      out += '  '.repeat(depth) + phrase
      if (twoWord) i++
      prev = phrase
      continue
    }
    if (up === '(') {
      out = out.replace(/\s*$/, '') + (prev ? ' ' : '') + '('
      depth++
      prev = up
      continue
    }
    if (up === ')') {
      depth = Math.max(0, depth - 1)
      out = out.replace(/\s*$/, '') + ')'
      prev = up
      continue
    }
    if (up === ',') {
      // VALUES 行内不换行；其余逗号换行缩进
      if (prev === 'VALUES' || depth === 0) out += ', '
      else out += ',\n' + '  '.repeat(depth)
      prev = up
      continue
    }
    const upper = MAJOR_KEYWORDS.has(up) ? up : tk
    if (prev === '' || prev === '(' || out.endsWith('\n')) out += upper
    else out += ' ' + upper
    prev = up
  }
  return out
}

/** 压平后的简单 tokenizer：字符串/标识符/括号/逗号/其他词 */
function tokenize(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "'") {
      let j = i + 1
      while (j < s.length) {
        if (s[j] === '\\') j += 2
        else if (s[j] === "'") { j += (s[j + 1] === "'" ? 2 : 1); break }
        else j++
      }
      out.push(s.slice(i, j))
      i = j
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < s.length && s[j] !== '`') j++
      out.push(s.slice(i, Math.min(j + 1, s.length)))
      i = j + 1
      continue
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push(c)
      i++
      continue
    }
    if (c === ' ') { i++; continue }
    let j = i
    while (j < s.length && s[j] !== ' ' && s[j] !== '(' && s[j] !== ')' && s[j] !== ',' && s[j] !== "'") j++
    out.push(s.slice(i, j))
    i = j
  }
  return out
}

/** 由结果集生成 INSERT 语句（分批，默认 200 行/条） */
export function buildInserts(
  table: string,
  columns: ColumnMeta[],
  rows: unknown[][],
  opts: { batch?: number; includeIfNotExists?: boolean } = {},
): string {
  const { batch = 200, includeIfNotExists = false } = opts
  const colNames = columns.map((c) => quoteIdent(c.name)).join(', ')
  const lines: string[] = []
  for (let start = 0; start < rows.length; start += batch) {
    const chunk = rows.slice(start, start + batch)
    const tuples = chunk
      .map((row) => '(' + row.map((v) => quoteValue(v)).join(', ') + ')')
      .join(',\n  ')
    const head = includeIfNotExists
      ? `INSERT IGNORE INTO ${table} (${colNames}) VALUES`
      : `INSERT INTO ${table} (${colNames}) VALUES`
    lines.push(head + '\n  ' + tuples + ';')
  }
  return lines.join('\n\n')
}

/** 行/列转 CSV（带 BOM 便于 Excel 识别 UTF-8） */
export function toCsv(columns: ColumnMeta[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'string' ? v : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = columns.map((c) => esc(c.name)).join(',')
  const body = rows.map((r) => r.map(esc).join(',')).join('\n')
  return '\uFEFF' + head + '\n' + body
}

/** 粗略解析 SQL 主查询表（用于结果列注释匹配） */
export function extractTableFromSql(sql: string): { schema?: string; table: string } | null {
  const m = /\bfrom\s+(?:`?([\w$]+)`?)\s*(?:\.\s*`?([\w$]+)`?)?/i.exec(sql.replace(/--.*$/gm, ''))
  if (!m) return null
  if (m[2]) return { schema: m[1], table: m[2] }
  return { table: m[1] }
}

/** 最近 N 条记录查询语句（按主键倒序；无主键则直接 LIMIT） */
export function buildTopN(
  schema: string | undefined,
  table: string,
  pk: string[],
  n = 10,
): string {
  const t = quoteTable(schema, table)
  if (pk.length) {
    const order = pk.map((c) => `${quoteIdent(c)} DESC`).join(', ')
    return `SELECT * FROM ${t}\nORDER BY ${order}\nLIMIT ${n}`
  }
  return `SELECT * FROM ${t}\nLIMIT ${n}`
}

/* ---------------- 结果集单元格编辑（值文本 ↔ SQL 字面量） ---------------- */

const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year|bit)/i

/** 列类型是否为数值型（决定单元格编辑输入按数字处理） */
export function isNumericType(type?: string): boolean {
  return !!type && NUMERIC_TYPE.test(type.trim())
}

/**
 * 把单元格编辑输入文本转成 SQL 字面量：
 * - 输入 NULL（不区分大小写）→ NULL
 * - 数值列：空 → NULL，非法数字抛错
 * - 其他列：空且可空 → NULL，否则按字符串转义
 */
export function cellLiteral(col: ColumnMeta, text: string): string {
  if (text.trim().toUpperCase() === 'NULL') return 'NULL'
  if (isNumericType(col.type)) {
    if (text.trim() === '') return 'NULL'
    const n = Number(text)
    if (!Number.isFinite(n)) throw new Error(`「${col.name}」需要数字，当前输入："${text}"`)
    return String(n)
  }
  if (text === '' && col.nullable) return 'NULL'
  return quoteValue(text)
}

/** 保存成功后把编辑文本解析回本地行数据（供结果集回显） */
export function parseCellValue(col: ColumnMeta, text: string): unknown {
  if (text.trim().toUpperCase() === 'NULL') return null
  if (isNumericType(col.type)) return text.trim() === '' ? null : Number(text)
  if (text === '' && col.nullable) return null
  return text
}
