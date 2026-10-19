/* 表设计器（参考 Navicat「表设计」）：
 * - 列网格：新增 / 修改 / 删除 / 排序，支持类型、默认值、非空、自增、主键、注释
 * - 生成列（VIRTUAL/STORED GENERATED）锁定编辑，防止生成损坏的 DDL
 * - 底部实时预览变更摘要与 ALTER / CREATE TABLE 语句，保存时先弹出 SQL 预览再执行
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../core/store'
import { ensureConnected } from '../core/connOps'
import type { ColumnMeta, IndexMeta } from '../core/types'
import {
  type ColumnDraft, draftFromColumn, newDraft, designAlterSql, buildCreateTableSql,
  validateColumnDrafts, parseTypeDef, lenForType,
  UNSIGNED_TYPES, TYPE_GROUPS, TYPE_OPTIONS, NO_LEN_TYPES, TYPE_LEN_HINT,
  type IndexDraft, draftFromIndex, newIndexDraft, validateIndexDrafts,
  ENGINES, CHARSET_COLLATIONS, defaultCollation,
} from '../core/tableDesign'
import { Modal } from './Modal'
import { SqlViewer } from './SqlViewer'
import { openSqlModal } from './ModalHost'
import { toast } from './Toast'
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash } from './icons'

export interface TableDesignerProps {
  connId: string
  schema: string
  /** null = 新建表模式 */
  table: string | null
  onClose: () => void
}

export function TableDesigner({ connId, schema, table, onClose }: TableDesignerProps) {
  const cfg = useStore((s) => s.connections.find((c) => c.id === connId))
  const serverVersion = useStore((s) => s.runtime[connId]?.serverVersion)
  const tableMeta = useStore((s) => s.meta[connId]?.tables[schema]?.find((t) => t.name === table))

  const [drafts, setDrafts] = useState<ColumnDraft[] | null>(table ? null : [newDraft('col-0')])
  const [origCols, setOrigCols] = useState<ColumnMeta[]>([])
  const [origPK, setOrigPK] = useState<string[]>([])
  const [origIndexes, setOrigIndexes] = useState<IndexMeta[]>([])
  const [idxDrafts, setIdxDrafts] = useState<IndexDraft[]>([])
  const [tab, setTab] = useState<'cols' | 'indexes'>('cols')
  const [loadErr, setLoadErr] = useState('')

  const [name, setName] = useState(table ?? '')
  const [comment, setComment] = useState(tableMeta?.comment ?? '')
  /* 新建表选项 */
  const [engine, setEngine] = useState('InnoDB')
  const [charset, setCharset] = useState('utf8mb4')
  const [collate, setCollate] = useState(() => defaultCollation(serverVersion))
  const [ifNotExists, setIfNotExists] = useState(true)

  const seq = useRef(0) // 新增行稳定 key（col-new-N，不与加载的 col-i 冲突）

  /* 编辑模式：挂载时拉取服务器列、主键与二级索引（索引加载失败不拖垮整表加载） */
  useEffect(() => {
    if (!table) return
    let alive = true
    void (async () => {
      try {
        const st = useStore.getState()
        const c = st.connections.find((x) => x.id === connId)
        if (!c) throw new Error('连接不存在')
        const ad = await ensureConnected(c)
        const [cols, pk] = await Promise.all([ad.getColumns(schema, table), ad.getPK(schema, table)])
        if (!alive) return
        setOrigCols(cols)
        setOrigPK(pk)
        setDrafts(cols.map((col, i) => draftFromColumn(col, `col-${i}`)))
        let idxs: IndexMeta[] = []
        try {
          idxs = ad.getIndexes ? await ad.getIndexes(schema, table) : []
        } catch { idxs = [] }
        if (!alive) return
        setOrigIndexes(idxs)
        setIdxDrafts(idxs.map((ix, i) => draftFromIndex(ix, `ix-${i}`)))
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 草稿行操作 ---------------- */
  const patch = (id: string, p: Partial<ColumnDraft>) =>
    setDrafts((ds) => ds && ds.map((d) => (d.id === id ? { ...d, ...p } : d)))

  const move = (i: number, dir: -1 | 1) =>
    setDrafts((ds) => {
      if (!ds) return ds
      const j = i + dir
      if (j < 0 || j >= ds.length) return ds
      const a = [...ds]
      ;[a[i], a[j]] = [a[j], a[i]]
      return a
    })

  const remove = (i: number) => setDrafts((ds) => ds && ds.filter((_, k) => k !== i))
  const addRow = () => setDrafts((ds) => ds && [...ds, newDraft(`col-new-${seq.current++}`)])

  /* 切换类型：拆出基础名与尾缀（unsigned 等），按新类型决定长度的去留；
   * 原勾选的 unsigned 在新类型仍支持时保留（无符号是独立控件，不随类型切换重置） */
  const setType = (d: ColumnDraft, val: string) => {
    const { base, suffix } = parseTypeDef(val)
    const carry = !suffix && UNSIGNED_TYPES.has(base) && /\bunsigned\b/i.test(d.extra)
    patch(d.id, { type: base, extra: carry ? 'unsigned' : suffix, len: lenForType(base, d.len) })
  }

  /* 切换 UNSIGNED：以独立复选框控制 extra 中的 unsigned 尾缀（保留 zerofill 等其他尾缀） */
  const toggleUnsigned = (d: ColumnDraft) => {
    const has = /\bunsigned\b/i.test(d.extra)
    const rest = d.extra.replace(/\bunsigned\b/i, '').replace(/\s+/g, ' ').trim()
    patch(d.id, { extra: has ? rest : rest ? `unsigned ${rest}` : 'unsigned' })
  }

  /* ---------------- 索引草稿操作 ---------------- */
  const patchIdx = (id: string, p: Partial<IndexDraft>) =>
    setIdxDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)))

  const removeIdx = (i: number) => setIdxDrafts((ds) => ds.filter((_, k) => k !== i))
  const addIdx = () => setIdxDrafts((ds) => [...ds, newIndexDraft(`ix-new-${seq.current++}`)])

  const pickCharset = (cs: string) => {
    setCharset(cs)
    const list = CHARSET_COLLATIONS[cs] ?? []
    const dft = defaultCollation(serverVersion)
    setCollate(list.includes(collate) ? collate : list.includes(dft) ? dft : list[0])
  }

  /* ---------------- SQL 实时预览 ---------------- */
  const result = useMemo(() => {
    if (!drafts) return { sql: '', changes: [] as string[] }
    if (table) {
      return designAlterSql({
        schema, table, newTable: name,
        origColumns: origCols, origPK,
        origIndexes, indexDrafts: idxDrafts,
        origComment: tableMeta?.comment ?? '',
        newComment: comment, drafts,
      })
    }
    return buildCreateTableSql({
      schema, table: name.trim() || 'table_name',
      drafts, indexDrafts: idxDrafts, comment, engine, charset, collate, ifNotExists,
    })
  }, [drafts, table, name, origCols, origPK, origIndexes, idxDrafts, tableMeta, comment, engine, charset, collate, ifNotExists, schema])

  /* ---------------- 保存：校验 → SQL 预览弹窗（可执行） ---------------- */
  const doSave = () => {
    if (!drafts || !result.sql) return
    const n = name.trim()
    if (!n) { toast.error('请填写表名'); return }
    if (!/^[a-zA-Z0-9_$]+$/.test(n)) { toast.error('表名仅支持字母、数字、下划线与 $'); return }
    if (n.length > 64) { toast.error('表名过长：MySQL 标识符上限 64 字符'); return }
    const verr = validateColumnDrafts(drafts)
    if (verr) { toast.error(verr); return }
    const ierr = validateIndexDrafts(idxDrafts, drafts.map((d) => d.name.trim()))
    if (ierr) { toast.error(ierr); setTab('indexes'); return }

    openSqlModal({
      title: table ? `保存表设计：${schema}.${table}` : `创建表：${schema}.${n}`,
      sub: result.changes.join('；'),
      sql: result.sql,
      filename: table ? 'alter-table.sql' : 'create-table.sql',
      onExecute: async () => {
        const st = useStore.getState()
        const c = st.connections.find((x) => x.id === connId)
        if (!c) throw new Error('连接不存在')
        const ad = await ensureConnected(c)
        const t0 = performance.now()
        await ad.execute(result.sql, schema)
        const durationMs = Math.round(performance.now() - t0)
        /* DDL 后刷新表 / 列缓存（刷新失败不阻塞保存） */
        try {
          st.setTables(connId, schema, await ad.listTables(schema))
          st.setColumns(connId, schema, n, await ad.getColumns(schema, n))
        } catch { /* ignore */ }
        st.pushHistory({ sql: result.sql, connId, connName: c.name, schema, ok: true, durationMs })
        toast.success(table ? `表 ${n} 已更新` : `表 ${n} 已创建`)
        onClose()
      },
    })
  }

  if (!cfg) return null

  return (
    <Modal
      title={table ? `设计表：${schema}.${table}` : `新建表（${schema}）`}
      sub={table ? '修改列后保存，将生成 ALTER TABLE；可先预览 SQL 再执行' : '定义各列后保存，将生成 CREATE TABLE 语句'}
      width={1000}
      resizable
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!result.sql} onClick={doSave}>
            {table ? '保存改动…' : '创建表…'}
          </button>
        </>
      }
    >
      <div className="designer">
        {loadErr ? (
          <div className="designer-error">
            <div>加载表结构失败：{loadErr}</div>
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        ) : !drafts ? (
          <div className="designer-loading">正在加载表结构…</div>
        ) : (
          <>
            <div className="designer-top">
              <div className="form-grid">
                <label className="lbl">表名</label>
                <input className="input" value={name} placeholder={table ? undefined : '例如：t_order'}
                  onChange={(e) => setName(e.target.value)} />
                {table ? (
                  <>
                    <label className="lbl">表注释</label>
                    <input className="input" value={comment} placeholder="可选"
                      onChange={(e) => setComment(e.target.value)} />
                  </>
                ) : (
                  <>
                    <label className="lbl">引擎</label>
                    <select className="select" value={engine} onChange={(e) => setEngine(e.target.value)}>
                      {ENGINES.map((en) => <option key={en} value={en}>{en}</option>)}
                    </select>
                    <label className="lbl">字符集</label>
                    <select className="select" value={charset} onChange={(e) => pickCharset(e.target.value)}>
                      {Object.keys(CHARSET_COLLATIONS).map((cs) => <option key={cs} value={cs}>{cs}</option>)}
                    </select>
                    <label className="lbl">排序规则</label>
                    <select className="select" value={collate} onChange={(e) => setCollate(e.target.value)}>
                      {(CHARSET_COLLATIONS[charset] ?? []).map((co) => <option key={co} value={co}>{co}</option>)}
                    </select>
                    <label className="lbl">表注释</label>
                    <input className="input" value={comment} placeholder="可选"
                      onChange={(e) => setComment(e.target.value)} />
                    <div className="full checkbox-row">
                      <input type="checkbox" id="chk-td-ine" checked={ifNotExists}
                        onChange={(e) => setIfNotExists(e.target.checked)} />
                      <label htmlFor="chk-td-ine">IF NOT EXISTS（表已存在时不报错）</label>
                    </div>
                  </>
                )}
              </div>
              {cfg.type === 'demo' && (
                <div className="designer-warn">演示模式为只读数据集，无法执行 DDL；SQL 仅作预览</div>
              )}
            </div>

            {/* 列 / 索引 Tab */}
            <div className="designer-tabs">
              <button className={`designer-tab${tab === 'cols' ? ' on' : ''}`} onClick={() => setTab('cols')}>列</button>
              <button className={`designer-tab${tab === 'indexes' ? ' on' : ''}`} onClick={() => setTab('indexes')}>
                索引{idxDrafts.length > 0 ? `（${idxDrafts.length}）` : ''}
              </button>
            </div>

            {tab === 'cols' ? (
            <div className="designer-grid-wrap">
              <table className="designer-grid">
                <thead>
                  <tr>
                    <th className="col-pk" title="主键">PK</th>
                    <th>列名</th>
                    <th className="col-type">类型</th>
                    <th className="col-len">长度/值</th>
                    <th className="col-uns" title="UNSIGNED（仅数值类型支持）">无符号</th>
                    <th className="col-bool" title="NOT NULL">非空</th>
                    <th className="col-default">默认值</th>
                    <th className="col-bool" title="AUTO_INCREMENT">自增</th>
                    <th>注释</th>
                    <th className="col-ops">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((d, i) => (
                    <tr key={d.id} className={`${d.orig ? '' : 'row-new'}${d.generated ? ' row-generated' : ''}`}>
                      <td className="col-pk">
                        <input type="checkbox" checked={d.pk} title={d.pk ? '主键（点击取消）' : '设为主键'}
                          onChange={() => patch(d.id, { pk: !d.pk })} />
                      </td>
                      <td className="col-name">
                        <input className="input" value={d.name} placeholder="列名" disabled={d.generated}
                          title={d.generated ? '生成列（VIRTUAL/STORED GENERATED）不支持在此修改定义' : undefined}
                          onChange={(e) => patch(d.id, { name: e.target.value })} />
                      </td>
                      <td className="col-type">
                        <select className="select" value={d.extra ? `${d.type} ${d.extra}` : d.type}
                          disabled={d.generated}
                          onChange={(e) => setType(d, e.target.value)}>
                          {/* 当前完整类型不在预设列表中时（如 int unsigned zerofill），动态显示为第一项 */}
                          {(() => {
                            const cur = d.extra ? `${d.type} ${d.extra}` : d.type
                            return TYPE_OPTIONS.includes(cur) ? null : <option value={cur}>{cur}</option>
                          })()}
                          {TYPE_GROUPS.map((g) => (
                            <optgroup key={g.label} label={g.label}>
                              {g.types.map((t) => <option key={t} value={t}>{t}</option>)}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td className="col-len">
                        <input className="input" value={d.len}
                          disabled={d.generated || NO_LEN_TYPES.has(d.type)}
                          placeholder={TYPE_LEN_HINT[d.type] ?? '长度/参数'}
                          title={d.generated ? '生成列不支持在此修改定义' : NO_LEN_TYPES.has(d.type) ? '该类型不支持长度/参数' : undefined}
                          onChange={(e) => patch(d.id, { len: e.target.value })} />
                      </td>
                      <td className="col-uns">
                        <input type="checkbox" checked={/\bunsigned\b/i.test(d.extra)}
                          title={UNSIGNED_TYPES.has(d.type) ? 'UNSIGNED（无符号）' : '仅数值类型支持 UNSIGNED'}
                          disabled={d.generated || !UNSIGNED_TYPES.has(d.type)}
                          onChange={() => toggleUnsigned(d)} />
                      </td>
                      <td className="col-bool">
                        <input type="checkbox" checked={d.notNull} title="NOT NULL" disabled={d.generated}
                          onChange={() => patch(d.id, { notNull: !d.notNull })} />
                      </td>
                      <td className="col-default">
                        <input type="checkbox" checked={d.hasDefault} title="有默认值"
                          disabled={d.generated || d.autoInc}
                          onChange={() => patch(d.id, { hasDefault: !d.hasDefault })} />
                        <input className="input" value={d.defaultValue} disabled={d.generated || !d.hasDefault}
                          placeholder={d.hasDefault ? "'' 或 NULL / 值 / NOW()" : ''}
                          title={d.hasDefault
                            ? "留空 = 空字符串 ''；NULL 显式输入；NOW() 等函数原样使用；字符串值自动加引号"
                            : undefined}
                          onChange={(e) => patch(d.id, { defaultValue: e.target.value })} />
                      </td>
                      <td className="col-bool">
                        <input type="checkbox" checked={d.autoInc} title="AUTO_INCREMENT" disabled={d.generated}
                          onChange={() => patch(d.id, !d.autoInc ? { autoInc: true, pk: true } : { autoInc: false })} />
                      </td>
                      <td className="col-comment">
                        <input className="input" value={d.comment} placeholder="注释" disabled={d.generated}
                          onChange={(e) => patch(d.id, { comment: e.target.value })} />
                      </td>
                      <td className="col-ops">
                        <button className="icon-btn" title={d.generated ? '生成列不支持排序' : '上移'}
                          disabled={d.generated || i === 0} onClick={() => move(i, -1)}>
                          <IconChevronUp />
                        </button>
                        <button className="icon-btn" title={d.generated ? '生成列不支持排序' : '下移'}
                          disabled={d.generated || i === drafts.length - 1} onClick={() => move(i, 1)}>
                          <IconChevronDown />
                        </button>
                        <button className="icon-btn" title="删除列" onClick={() => remove(i)}>
                          <IconTrash />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn designer-add" onClick={addRow}>
                <IconPlus /> 添加列
              </button>
            </div>
            ) : (
            <div className="designer-grid-wrap">
              <table className="designer-grid designer-idx-grid">
                <thead>
                  <tr>
                    <th className="idx-name">索引名</th>
                    <th className="idx-kind">类型</th>
                    <th className="idx-cols">索引列</th>
                    <th className="col-ops">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {idxDrafts.map((ix, i) => (
                    <tr key={ix.id} className={ix.orig ? '' : 'row-new'}>
                      <td className="idx-name">
                        <input className="input" value={ix.name} placeholder="索引名"
                          onChange={(e) => patchIdx(ix.id, { name: e.target.value })} />
                      </td>
                      <td className="idx-kind">
                        <select className="select" value={ix.kind}
                          onChange={(e) => patchIdx(ix.id, { kind: e.target.value as IndexDraft['kind'] })}>
                          <option value="INDEX">INDEX</option>
                          <option value="UNIQUE">UNIQUE</option>
                          <option value="FULLTEXT">FULLTEXT</option>
                        </select>
                      </td>
                      <td className="idx-cols">
                        <input className="input" value={ix.cols} placeholder="col1, col2 或 name(10)"
                          title="多个列用英文逗号分隔；支持前缀长度 name(10) 与表达式索引，如 (json_extract(info,'$.x'))"
                          onChange={(e) => patchIdx(ix.id, { cols: e.target.value })} />
                      </td>
                      <td className="col-ops">
                        <button className="icon-btn" title="删除索引" onClick={() => removeIdx(i)}>
                          <IconTrash />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!idxDrafts.length && (
                    <tr>
                      <td colSpan={4} className="idx-empty">暂无二级索引（主键请在「列」页勾选 PK）</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <button className="btn designer-add" onClick={addIdx}>
                <IconPlus /> 添加索引
              </button>
            </div>
            )}

            <div className="designer-preview">
              <div className="designer-changes">
                {result.changes.length
                  ? result.changes.map((c, i) => <span key={i} className="designer-chip">{c}</span>)
                  : <span className="designer-nochange">无改动</span>}
              </div>
              <div className="designer-sql">
                <SqlViewer sql={result.sql || '-- 无改动'} fill />
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
