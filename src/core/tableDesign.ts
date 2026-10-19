/* 表设计器核心（纯函数，无 UI 依赖）：
 * - ColumnDraft：设计器网格中的列草稿模型
 * - buildColumnDef：生成列定义子串（字符集保留 / DEFAULT 语义 / 自增 / 注释）
 * - designAlterSql：对比原表元数据 → 单条 ALTER TABLE（改动 SQL 预览）
 * - buildCreateTableSql：新建表 CREATE TABLE
 * - validateColumnDrafts / TYPE_GROUPS / ENGINES / CHARSET_COLLATIONS：校验与候选值
 */
import type { ColumnMeta, IndexKind, IndexMeta } from './types'
import { quoteIdent, quoteTable, quoteValue, isNumericType } from './sql'

/* ---------------- 列草稿模型 ---------------- */

export interface ColumnDraft {
  id: string // 前端稳定 key（网格行）
  name: string
  /** 基础类型名（小写），如 varchar、int、enum */
  type: string
  /** 长度 / 精度参数（括号内原文）：255、10,2、'a','b'；无长度类型为空 */
  len: string
  /** 类型尾缀属性（保留原定义），如 unsigned、unsigned zerofill */
  extra: string
  notNull: boolean
  hasDefault: boolean
  /** 默认值原文：NULL / 数字 / 函数 / (表达式) / 字符串（生成 SQL 时按规则加引号） */
  defaultValue: string
  autoInc: boolean
  pk: boolean
  comment: string
  /** 原服务器列（新增列为 null）——diff 与字符集保留依据 */
  orig: ColumnMeta | null
  /** 生成列（VIRTUAL/STORED GENERATED）：锁定编辑，避免生成损坏的 DDL */
  generated: boolean
}

/** 解析完整类型定义（information_schema.COLUMN_TYPE 风格）→ 基础名 + 括号参数 + 尾缀 */
export function parseTypeDef(full: string): { base: string; args: string; suffix: string } {
  const s = full.trim()
  const m = /^([a-zA-Z]+)\s*(?:\(([\s\S]*)\))?\s*(.*)$/.exec(s)
  if (!m) return { base: s.toLowerCase(), args: '', suffix: '' }
  return { base: m[1].toLowerCase(), args: m[2] ?? '', suffix: m[3] ?? '' }
}

/** 由草稿拼装完整类型定义（与 COLUMN_TYPE 风格一致，diff 与 DDL 生成共用） */
export function fullType(d: Pick<ColumnDraft, 'type' | 'len' | 'extra'>): string {
  const base = d.type.trim().toLowerCase() || 'varchar'
  const args = d.len.trim()
  const suffix = d.extra.trim()
  return `${base}${args ? `(${args})` : ''}${suffix ? ` ${suffix}` : ''}`
}

/** 由服务器列元数据构造草稿行 */
export function draftFromColumn(c: ColumnMeta, id: string): ColumnDraft {
  const { base, args, suffix } = parseTypeDef(c.type)
  return {
    id,
    name: c.name,
    type: base,
    len: args,
    extra: suffix,
    notNull: !c.nullable,
    hasDefault: c.defaultValue != null,
    defaultValue: c.defaultValue == null ? '' : c.defaultValue,
    autoInc: /auto_increment/i.test(c.extra ?? ''),
    pk: c.key === 'PRI',
    comment: c.comment ?? '',
    orig: c,
    generated: /(?:virtual|stored)\s+generated/i.test(c.extra ?? ''),
  }
}

/** 新增列的空白草稿 */
export function newDraft(id: string, name = ''): ColumnDraft {
  return {
    id, name, type: 'varchar', len: '255', extra: '', notNull: true,
    hasDefault: false, defaultValue: '', autoInc: false, pk: false,
    comment: '', orig: null, generated: false,
  }
}

/* ---------------- 索引草稿模型（PRIMARY 由列网格 PK 管理，不在此列） ---------------- */

export interface IndexDraft {
  id: string // 前端稳定 key
  name: string
  kind: IndexKind
  /** 索引列原文（逗号分隔），支持前缀长度如 name(10)；表达式索引原样透传 */
  cols: string
  orig: IndexMeta | null
}

export function draftFromIndex(ix: IndexMeta, id: string): IndexDraft {
  return { id, name: ix.name, kind: ix.kind, cols: ix.cols.join(', '), orig: ix }
}

export function newIndexDraft(id: string): IndexDraft {
  return { id, name: '', kind: 'INDEX', cols: '', orig: null }
}

/** 索引列定义子串：逐段加反引号（前缀长度 name(10) 保留），括号开头的表达式原样透传 */
export function idxColsLiteral(cols: string): string {
  return cols.split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((t) => {
      if (t.startsWith('(')) return t
      const m = /^([^(]+?)\s*(\(\s*\d+\s*\))?$/.exec(t)
      if (!m) return t
      return `${quoteIdent(m[1].trim())}${m[2] ?? ''}`
    })
    .join(', ')
}

/** ALTER 子句中的索引定义前缀：UNIQUE INDEX / FULLTEXT INDEX / INDEX */
export const indexDefPrefix = (kind: IndexKind): string => (kind === 'INDEX' ? 'INDEX' : `${kind} INDEX`)

/** 索引列原文归一化（比较 diff 用） */
export const normIdxCols = (cols: string) => cols.split(',').map((s) => s.trim()).filter(Boolean).join(',')

/** 草稿索引相对原索引是否变化 */
export function indexChanged(d: IndexDraft): boolean {
  if (!d.orig) return true
  return d.orig.name !== d.name.trim() || d.orig.kind !== d.kind || normIdxCols(d.orig.cols.join(',')) !== normIdxCols(d.cols)
}

/* ---------------- DEFAULT 值语义 ---------------- */

const FN_CALL = /^[a-zA-Z_$][\w$]*\s*\(.*\)\s*$/s
const CURRENT_TS = /^current_timestamp(\s*\(\s*\d*\s*\))?$/i
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/
/** 用户已写成 SQL 字面量（''、'abc' 等）——原样输出，不再二次加引号 */
const QUOTED_LIT = /^'[^']*'$/

/**
 * DEFAULT 子句的值：函数/表达式原样、数值列裸数字，其余按字符串字面量转义。
 * 留空 = 空字符串字面量 ''（与 COLUMN_DEFAULT='' 的原表回读一致，diff 两侧走同一函数）；
 * 想要 NULL 可显式输入 NULL 或取消勾选「有默认值」。
 */
export function formatDefaultValue(raw: string, type: string): string {
  const s = raw.trim()
  if (!s) return "''"
  if (s.toUpperCase() === 'NULL') return 'NULL'
  if (CURRENT_TS.test(s) || FN_CALL.test(s) || s.startsWith('(')) return s
  if (QUOTED_LIT.test(s)) return s
  if (isNumericType(type) && PLAIN_NUMBER.test(s)) return s
  return quoteValue(s)
}

/** 归一化类型比较（忽略大小写与多余空白） */
const normType = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * 生成完整列定义子串（列名 + 类型 + … + COMMENT），MODIFY / CHANGE / ADD 共用。
 * 注意：MODIFY 不写 DEFAULT / COMMENT 会清掉原值，因此这两项总是显式输出。
 * 不写列级 CHARACTER SET / COLLATE：跟随表默认字符集即可（与 Navicat 默认行为一致）。
 */
export function buildColumnDef(c: ColumnDraft): string {
  const parts: string[] = [quoteIdent(c.name.trim()), fullType(c) || 'varchar(255)']
  parts.push(c.notNull ? 'NOT NULL' : 'NULL')
  if (c.hasDefault) parts.push(`DEFAULT ${formatDefaultValue(c.defaultValue, fullType(c))}`)
  if (c.autoInc) parts.push('AUTO_INCREMENT')
  parts.push(`COMMENT ${quoteValue(c.comment ?? '')}`)
  return parts.join(' ')
}

/* ---------------- 列变更检测 ---------------- */

/** 草稿列相对原列的定义是否发生变化（不含位置） */
export function columnChanged(d: ColumnDraft): boolean {
  const o = d.orig
  if (!o) return true
  if (d.name.trim() !== o.name) return true
  if (fullType(d) !== normType(o.type)) return true
  if (d.notNull !== !o.nullable) return true
  if (defaultSql(d) !== defaultSqlOf(o)) return true
  if (d.autoInc !== /auto_increment/i.test(o.extra ?? '')) return true
  if ((d.comment ?? '') !== (o.comment ?? '')) return true
  return false
}

const defaultSql = (d: ColumnDraft) => (d.hasDefault ? formatDefaultValue(d.defaultValue, fullType(d)) : null)
const defaultSqlOf = (o: ColumnMeta) => (o.defaultValue == null ? null : formatDefaultValue(o.defaultValue, o.type))

/** 变更点摘要（中文，供预览提示），如「（类型、默认值）」 */
export function diffBrief(d: ColumnDraft): string {
  const o = d.orig
  if (!o) return ''
  const bits: string[] = []
  if (fullType(d) !== normType(o.type)) bits.push('类型')
  if (d.notNull !== !o.nullable) bits.push(d.notNull ? '改为非空' : '改为可空')
  if (defaultSql(d) !== defaultSqlOf(o)) bits.push('默认值')
  if (d.autoInc !== /auto_increment/i.test(o.extra ?? '')) bits.push('自增')
  if ((d.comment ?? '') !== (o.comment ?? '')) bits.push('注释')
  return bits.length ? `（${bits.join('、')}）` : ''
}

/* ---------------- ALTER TABLE（编辑已有表） ---------------- */

export interface AlterDesignInput {
  schema?: string
  table: string // 原表名
  newTable: string // 期望表名（可能重命名）
  origColumns: ColumnMeta[] // 服务器当前列（原始顺序）
  origPK: string[]
  origComment: string
  newComment: string
  drafts: ColumnDraft[]
  /** 二级索引 diff（可选） */
  origIndexes?: IndexMeta[]
  indexDrafts?: IndexDraft[]
}

export interface DesignSqlResult {
  sql: string // 空串表示无改动
  changes: string[] // 中文变更摘要
}

/** 顺序数组相等 */
const seqEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * 对比原表元数据与列草稿，生成单条 ALTER TABLE。
 * 子句顺序：DROP PRIMARY KEY → DROP COLUMN → CHANGE/MODIFY(定义) → 位置重排(ADD/MODIFY) → ADD PRIMARY KEY → COMMENT= → RENAME TO。
 * 重排需要时按草稿顺序对「所有列」输出位置子句（顺序应用 AFTER/FIRST 可保证最终顺序与草稿一致）。
 */
export function designAlterSql(input: AlterDesignInput): DesignSqlResult {
  const { schema, table, origColumns, origPK, origComment, drafts } = input
  const newTable = input.newTable.trim()
  const clauses: string[] = []
  const changes: string[] = []
  const q = quoteIdent

  /* 主键变更 */
  const newPK = drafts.filter((d) => d.pk && d.name.trim()).map((d) => d.name.trim())
  const pkChanged = !seqEq(origPK, newPK)
  if (pkChanged && origPK.length) {
    clauses.push('DROP PRIMARY KEY')
    changes.push('删除主键')
  }

  /* 索引：先删除（原索引不在草稿中），DROP INDEX 需在 DROP COLUMN 之前 */
  const idxDrafts = input.indexDrafts
  const origIdx = input.origIndexes
  if (idxDrafts && origIdx) {
    const keptIdx = new Set(idxDrafts.filter((d) => d.orig).map((d) => d.orig!.name))
    for (const ix of origIdx) {
      if (!keptIdx.has(ix.name)) {
        clauses.push(`DROP INDEX ${q(ix.name)}`)
        changes.push(`删除索引 ${ix.name}`)
      }
    }
  }

  /* 删除列（原列不在草稿中） */
  const keptOrig = new Set(drafts.filter((d) => d.orig).map((d) => d.orig!.name))
  for (const c of origColumns) {
    if (!keptOrig.has(c.name)) {
      clauses.push(`DROP COLUMN ${q(c.name)}`)
      changes.push(`删除列 ${c.name}`)
    }
  }

  /* 改动既有列的定义（改名用 CHANGE；位置统一在重排步骤处理） */
  for (const d of drafts) {
    if (!d.orig || !columnChanged(d)) continue
    const newName = d.name.trim()
    const renamed = d.orig.name !== newName
    const def = buildColumnDef(d)
    clauses.push(renamed ? `CHANGE COLUMN ${q(d.orig.name)} ${def}` : `MODIFY COLUMN ${def}`)
    changes.push(`修改列 ${renamed ? `${d.orig.name} → ${newName}` : newName}${diffBrief(d)}`)
  }

  /* 位置重排判定：存活原列的相对顺序变化，或新列不是全部追加在末尾 */
  const survivors = drafts.filter((d) => d.orig)
  const origOrder = origColumns.map((c) => c.name).filter((n) => keptOrig.has(n))
  const relativeSame = seqEq(survivors.map((d) => d.orig!.name), origOrder)
  const firstNewIdx = drafts.findIndex((d) => !d.orig)
  const appendedOnly = firstNewIdx < 0 || survivors.every((d) => drafts.indexOf(d) < firstNewIdx)
  const needReorder = !relativeSame || !appendedOnly

  if (needReorder) {
    /* 按草稿顺序逐列落位：FIRST / AFTER 前一列；新增列直接带位置 ADD，原有列用 MODIFY 移动。
     * 生成列保持原位——其定义含 AS 表达式（元数据未采集），MODIFY 重定位会生成损坏的 DDL；
     * 其余列 AFTER 引用它仍然有效 */
    drafts.forEach((d, i) => {
      if (d.generated) return
      const pos = i === 0 ? 'FIRST' : `AFTER ${q(drafts[i - 1].name.trim())}`
      if (!d.orig) {
        clauses.push(`ADD COLUMN ${buildColumnDef(d)} ${pos}`)
        changes.push(`新增列 ${d.name.trim() || '(未命名)'}`)
      } else {
        clauses.push(`MODIFY COLUMN ${buildColumnDef(d)} ${pos}`)
        if (!columnChanged(d)) changes.push(`移动列 ${d.name.trim()}`)
      }
    })
  } else {
    for (const d of drafts) {
      if (!d.orig) {
        clauses.push(`ADD COLUMN ${buildColumnDef(d)}`)
        changes.push(`新增列 ${d.name.trim() || '(未命名)'}`)
      }
    }
  }

  /* 主键 */
  if (pkChanged && newPK.length) {
    clauses.push(`ADD PRIMARY KEY (${newPK.map(q).join(', ')})`)
    changes.push('设置主键')
  }

  /* 索引：新增 / 修改（改名或改定义统一 DROP + ADD） */
  if (idxDrafts && origIdx) {
    for (const d of idxDrafts) {
      const n = d.name.trim()
      if (!n || !d.cols.trim()) continue // 未填完的行由校验拦截
      if (!d.orig) {
        clauses.push(`ADD ${indexDefPrefix(d.kind)} ${q(n)} (${idxColsLiteral(d.cols)})`)
        changes.push(`新增索引 ${n}`)
      } else if (indexChanged(d)) {
        clauses.push(`DROP INDEX ${q(d.orig.name)}`)
        clauses.push(`ADD ${indexDefPrefix(d.kind)} ${q(n)} (${idxColsLiteral(d.cols)})`)
        changes.push(`修改索引 ${d.orig.name}${d.orig.name !== n ? ` → ${n}` : ''}`)
      }
    }
  }

  /* 表注释 */
  if (input.newComment !== origComment) {
    clauses.push(`COMMENT=${quoteValue(input.newComment)}`)
    changes.push(origComment ? '修改表注释' : '添加表注释')
  }

  /* 重命名表 */
  if (newTable && newTable !== table) {
    clauses.push(`RENAME TO ${q(newTable)}`)
    changes.push(`重命名表 ${table} → ${newTable}`)
  }

  if (!clauses.length) return { sql: '', changes: [] }
  return {
    sql: `ALTER TABLE ${quoteTable(schema, table)}\n${clauses.map((c) => `  ${c}`).join(',\n')};`,
    changes,
  }
}

/* ---------------- CREATE TABLE（新建表） ---------------- */

export interface CreateTableInput {
  schema?: string
  table: string
  drafts: ColumnDraft[]
  comment?: string
  engine?: string // 默认 InnoDB
  charset?: string // 默认 utf8mb4
  collate?: string
  ifNotExists?: boolean
  /** 二级索引（INDEX/UNIQUE/FULLTEXT；主键由 drafts 的 pk 生成） */
  indexDrafts?: IndexDraft[]
}

export function buildCreateTableSql(input: CreateTableInput): DesignSqlResult {
  const { schema, table, drafts, engine = 'InnoDB', charset = 'utf8mb4', collate, ifNotExists = true, indexDrafts } = input
  const lines = drafts.map((d) => `  ${buildColumnDef(d)}`)
  const pk = drafts.filter((d) => d.pk && d.name.trim()).map((d) => d.name.trim())
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map(quoteIdent).join(', ')})`)
  let idxCount = 0
  for (const d of indexDrafts ?? []) {
    const n = d.name.trim()
    if (!n || !d.cols.trim()) continue
    lines.push(`  ${indexDefPrefix(d.kind)} ${quoteIdent(n)} (${idxColsLiteral(d.cols)})`)
    idxCount++
  }
  const tail = [
    `ENGINE=${engine}`,
    charset ? `DEFAULT CHARSET=${charset}` : '',
    collate ? `COLLATE=${collate}` : '',
    input.comment ? `COMMENT=${quoteValue(input.comment)}` : '',
  ].filter(Boolean).join(' ')
  return {
    sql: `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quoteTable(schema, table)} (\n${lines.join(',\n')}\n) ${tail};`,
    changes: [`创建表 ${table}（${drafts.length} 列${pk.length ? '，含主键' : ''}${idxCount ? `，${idxCount} 个索引` : ''}）`],
  }
}

/* ---------------- 校验 ---------------- */

/** 校验列草稿：返回错误消息，'' 表示通过 */
export function validateColumnDrafts(drafts: ColumnDraft[]): string {
  const seen = new Set<string>()
  for (const [i, d] of drafts.entries()) {
    const n = d.name.trim()
    const row = `第 ${i + 1} 行`
    if (!n) return `${row}：列名不能为空`
    if (n.length > 64) return `${row}（${n}）：列名超过 64 字符上限`
    if (!d.type.trim()) return `${row}（${n}）：请填写列类型`
    const low = n.toLowerCase()
    if (seen.has(low)) return `列名重复：${n}`
    seen.add(low)
    if ((d.type === 'enum' || d.type === 'set') && !d.len.trim()) {
      return `${row}（${n}）：${d.type.toUpperCase()} 需要值列表，如 'a','b'`
    }
    if (d.autoInc && !d.pk) return `自增列「${n}」必须同时设为主键（MySQL 要求自增列必须是键）`
    if (d.hasDefault && d.autoInc) return `自增列「${n}」不能设置默认值`
    if (d.hasDefault && isNumericType(d.type) && !d.defaultValue.trim()) {
      // 数值列默认值留空会生成 DEFAULT ''（非法），须显式填数字或 NULL
      return `${row}（${n}）：数值列默认值请填写数字或 NULL（留空 = 空字符串，对数值列非法）`
    }
  }
  return ''
}

/** 校验索引草稿；colNames 为列草稿中有效列名（用于校验索引列存在性）。返回错误消息，'' 表示通过 */
export function validateIndexDrafts(drafts: IndexDraft[], colNames: string[]): string {
  const colSet = new Set(colNames.map((c) => c.toLowerCase()))
  const seen = new Set<string>()
  for (const [i, d] of drafts.entries()) {
    const n = d.name.trim()
    const cols = d.cols.trim()
    const row = `索引第 ${i + 1} 行`
    if (!n && !cols) continue // 空行跳过（生成 SQL 时忽略）
    if (!n) return `${row}：索引名不能为空`
    if (n.length > 64) return `${row}（${n}）：索引名超过 64 字符上限`
    if (!/^[a-zA-Z0-9_$]+$/.test(n)) return `${row}（${n}）：索引名仅支持字母、数字、下划线与 $`
    if (n.toUpperCase() === 'PRIMARY') return `${row}：索引名不能为 PRIMARY（主键请在列网格勾选 PK）`
    const low = n.toLowerCase()
    if (seen.has(low)) return `索引名重复：${n}`
    seen.add(low)
    if (!cols) return `${row}（${n}）：请填写索引列，多个列用英文逗号分隔`
    for (const part of cols.split(',')) {
      const t = part.trim()
      if (!t) return `${row}（${n}）：索引列存在空段，请检查逗号`
      if (t.startsWith('(')) continue // 表达式索引（MySQL 8.0 函数索引）原样透传，不做列名校验
      const m = /^([^(]+?)\s*(\(\s*\d+\s*\))?$/.exec(t)
      const cn = (m?.[1] ?? t).trim().replace(/^`|`$/g, '')
      if (!colSet.has(cn.toLowerCase())) return `${row}（${n}）：索引列「${cn}」不存在于列网格`
    }
  }
  return ''
}

/* ---------------- 候选值（类型 / 引擎 / 字符集） ---------------- */

/** 类型下拉（分组）：值为基础类型名，长度与无符号由独立控件编辑 */
export const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: '整数', types: ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'] },
  { label: '小数', types: ['decimal', 'float', 'double'] },
  { label: '字符串', types: ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'] },
  { label: '日期时间', types: ['date', 'time', 'datetime', 'timestamp', 'year'] },
  { label: '二进制 / JSON', types: ['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'json'] },
]

export const TYPE_OPTIONS = TYPE_GROUPS.flatMap((g) => g.types)

/** 支持 UNSIGNED 属性的数值类型（「无符号」复选框仅对这些类型可用） */
export const UNSIGNED_TYPES = new Set([
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint',
  'decimal', 'numeric', 'float', 'double', 'real',
])

/** 不支持长度 / 精度参数的类型（长度输入框禁用，DDL 拼装时忽略 len） */
export const NO_LEN_TYPES = new Set([
  'tinytext', 'text', 'mediumtext', 'longtext',
  'tinyblob', 'blob', 'mediumblob', 'longblob',
  'json', 'date', 'year',
  'point', 'linestring', 'polygon', 'geometry', 'geomcollection',
  'multipoint', 'multilinestring', 'multipolygon',
])

/** 长度 / 值输入框的 placeholder 提示（按类型） */
export const TYPE_LEN_HINT: Record<string, string> = {
  varchar: '最大字符数', char: '字符数',
  decimal: 'M,D（精度,小数位）',
  enum: "'a','b'", set: "'a','b'",
  binary: '字节数', varbinary: '字节数',
  datetime: '小数秒 0-6（可选）', timestamp: '小数秒 0-6（可选）', time: '小数秒 0-6（可选）',
}

/** 切换类型后长度参数的去留：无长度类型清空；enum/set 缺省给值列表；其余保留 */
export function lenForType(base: string, curLen: string): string {
  const t = base.trim().toLowerCase()
  if (NO_LEN_TYPES.has(t)) return ''
  if ((t === 'enum' || t === 'set') && !curLen.trim()) return "'a','b'"
  return curLen
}

export const ENGINES = ['InnoDB', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE', 'BLACKHOLE']

/** 常用字符集 → 候选排序规则（MySQL 8.0 默认排序规则置顶） */
export const CHARSET_COLLATIONS: Record<string, string[]> = {
  utf8mb4: ['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin'],
  utf8: ['utf8_general_ci', 'utf8_unicode_ci', 'utf8_bin'],
  latin1: ['latin1_swedish_ci', 'latin1_bin'],
  ascii: ['ascii_general_ci', 'ascii_bin'],
  gbk: ['gbk_chinese_ci', 'gbk_bin'],
}

/** 依服务器大版本取 utf8mb4 的默认排序规则（8.0+ 为 utf8mb4_0900_ai_ci，5.x 为 utf8mb4_general_ci） */
export function defaultCollation(serverVersion?: string): string {
  const major = Number(serverVersion?.split('.')?.[0] ?? 0)
  return major >= 8 ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_general_ci'
}
