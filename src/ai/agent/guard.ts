/* SQL 风险分级器：纯函数、在本地执行、模型不可绕过。
   先剥离注释与字符串字面量再判定，避免值内容里的关键字（如 WHERE id='drop'）误报。
   判定规则见 docs/ai/tech.md §5。 */

import type { RiskLevel, RiskReport } from '../types'

/** 剥离字符串/反引号标识符/注释，替换为等长空白（保留词边界与换行） */
function stripSqlText(sql: string): string {
  const out: string[] = []
  let i = 0
  const n = sql.length
  let state: 'none' | 'sq' | 'dq' | 'bt' | 'line' | 'block' = 'none'
  while (i < n) {
    const c = sql[i]
    const c2 = sql[i + 1]
    if (state === 'none') {
      if (c === '-' && c2 === '-') { state = 'line'; out.push('  '); i += 2; continue }
      if (c === '#') { state = 'line'; out.push(' '); i++; continue }
      if (c === '/' && c2 === '*') { state = 'block'; out.push('  '); i += 2; continue }
      if (c === "'") { state = 'sq'; out.push(' '); i++; continue }
      if (c === '"') { state = 'dq'; out.push(' '); i++; continue }
      if (c === '`') { state = 'bt'; out.push(' '); i++; continue }
      out.push(c); i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'none'; out.push('\n') } else out.push(' ')
      i++; continue
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'none'; out.push('  '); i += 2; continue }
      out.push(c === '\n' ? '\n' : ' '); i++; continue
    }
    /* 字符串 / 反引号标识符内部 */
    if (c === '\\' && state !== 'bt') { out.push('  '); i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bt' && c === '`')) {
      if (c2 === c) { out.push('  '); i += 2; continue } // 双写转义（'' / ``）
      state = 'none'; out.push(' '); i++; continue
    }
    out.push(c === '\n' ? '\n' : ' '); i++
  }
  return out.join('')
}

const L0_WORDS = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'USE', 'SET', 'TABLE', 'VALUES', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK'])
const L1_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE'])
const L2_WORDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'])

/* L3 特征：任意语句命中即升级为服务器级（如 SELECT ... INTO OUTFILE） */
const L3_PATTERNS: [RegExp, string][] = [
  [/\bGRANT\b/i, 'GRANT 授权变更'],
  [/\bREVOKE\b/i, 'REVOKE 收回授权'],
  [/\bKILL\b/i, 'KILL 终止会话/查询'],
  [/\bSHUTDOWN\b/i, 'SHUTDOWN 关闭服务器'],
  [/\bLOAD\s+DATA\b/i, 'LOAD DATA 服务器文件导入'],
  [/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i, 'INTO OUTFILE/DUMPFILE 写服务器文件'],
  [/\bLOAD_FILE\s*\(/i, 'LOAD_FILE() 读服务器文件'],
  [/\bSET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY)\b/i, 'SET 全局/持久化变量'],
  [/@@GLOBAL\./i, 'SET 全局变量（@@GLOBAL）'],
]

/** 风险等级中文标签（确认弹窗/徽章共用） */
export function riskLabel(level: RiskLevel): string {
  return level === 0 ? '只读' : level === 1 ? '数据变更' : level === 2 ? '结构变更' : '服务器级'
}

/**
 * 对一段 SQL 做风险分级（多语句直接兜底 L3）：
 * L0 只读 / L1 数据变更 / L2 结构变更 / L3 服务器级。
 */
export function classifySql(sql: string): RiskReport {
  const stripped = stripSqlText(sql)

  /* 多语句兜底：分号切分（字符串已剥离，分号都是真实语句边界） */
  const stmts = stripped.split(';').map((s) => s.trim()).filter(Boolean)
  if (stmts.length > 1) return { level: 3, features: ['多语句（一次执行多条语句）'] }
  const stmt = stmts[0] ?? ''

  /* 首关键字（跳过前导括号，支持 (SELECT ...) 形态） */
  let head = stmt
  while (head.startsWith('(')) head = head.slice(1).trim()
  const firstWord = (/^[A-Za-z_][A-Za-z0-9_$]*/.exec(head))?.[0]?.toUpperCase() ?? ''

  /* L3 特征扫描（作用于整条语句） */
  const features: string[] = []
  let level: RiskLevel = 0
  for (const [re, label] of L3_PATTERNS) {
    if (re.test(stmt)) { level = 3; features.push(label) }
  }
  if (level === 3) return { level, features }

  /* 首关键字分级 */
  let base: RiskLevel | null = null
  if (L1_WORDS.has(firstWord)) base = 1
  else if (L2_WORDS.has(firstWord)) base = 2
  else if (L0_WORDS.has(firstWord)) base = 0
  else if (firstWord === 'WITH') {
    /* CTE 可能前缀 SELECT / INSERT / UPDATE / DELETE，取最先出现的写操作 */
    const m = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(head)
    const w = m?.[1]?.toUpperCase() ?? 'SELECT'
    base = w === 'SELECT' ? 0 : L1_WORDS.has(w) ? 1 : 0
  } else {
    /* 无法识别 → 兜底 L3 */
    return { level: 3, features: [`无法识别的语句类型：${firstWord || '（空）'}`] }
  }
  level = base

  /* L1 特征 */
  if (base === 1) {
    if ((firstWord === 'UPDATE' || firstWord === 'DELETE') && !/\bWHERE\b/i.test(stmt)) {
      features.push(`${firstWord} 无 WHERE（全表变更）`)
    }
    if (firstWord === 'INSERT' && /\bON\s+DUPLICATE\s+KEY\b/i.test(stmt)) {
      features.push('INSERT ON DUPLICATE KEY（可能覆盖已有行）')
    }
  }

  /* L0 特征升级：SELECT ... FOR UPDATE 带行锁 → L1 */
  if (base === 0 && firstWord === 'SELECT' && /\bFOR\s+(?:UPDATE|SHARE)\b/i.test(stmt)) {
    level = 1
    features.push('SELECT FOR UPDATE（行锁）')
  }

  /* L2 特征 */
  if (base === 2 && /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(stmt)) {
    features.push('DROP 不可逆（无回收站）')
  }

  return { level, features }
}
