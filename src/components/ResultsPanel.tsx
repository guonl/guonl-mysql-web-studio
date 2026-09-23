/* 结果面板：结果集标签页 + 消息页 + 虚拟滚动表格（表头含字段注释）+ 结果集编辑 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueryTab, ResultSet } from '../core/types'
import { useStore } from '../core/store'
import { ensureConnected } from '../core/connOps'
import { buildInserts, cellLiteral, extractTableFromSql, parseCellValue, quoteIdent, quoteTable, toCsv } from '../core/sql'
import { copyText, downloadText, fmtDuration, fmtNum, fmtTime, isNumLike, valueToText } from '../core/utils'
import { openContextMenu, type CtxItem } from './ContextMenu'
import { toast } from './Toast'
import { IconCopy, IconDownload, IconEdit, IconInfo, IconSave, IconTable } from './icons'

const ROW_H = 26
const OVERSCAN = 10

/* ---------------- 结果面板入口 ---------------- */
export function ResultsPanel({ tab }: { tab?: QueryTab }) {
  const results = tab?.results ?? []
  const activeResultId = tab?.activeResultId
  const active = results.find((r) => r.id === activeResultId) ?? results[results.length - 1]
  const [showMsg, setShowMsg] = useState(results.length === 0)

  /* 新结果到达时自动切到该结果集 */
  useEffect(() => {
    if (activeResultId) setShowMsg(false)
  }, [activeResultId])

  /* 无任何结果：空态引导 */
  if (!results.length) {
    return (
      <div className="empty-state">
        <IconTable />
        <div className="big">还没有结果</div>
        <div className="hint">
          编写 SQL 后按 <span className="kbd">⌘/Ctrl</span> + <span className="kbd">Enter</span> 执行<br />
          选中部分语句可只执行选中内容
        </div>
      </div>
    )
  }

  return (
    <div className="results">
      <div className="results-tabs">
        {results.map((r) => (
          <button
            key={r.id}
            className={`rtab ${!showMsg && active?.id === r.id ? 'on' : ''}`}
            title={r.sql}
            onClick={() => { setShowMsg(false); useStore.getState().updateTab(tab!.id, { activeResultId: r.id }) }}
          >
            <span className="t-title">{r.title}</span>
            <span className={`rtag ${r.kind === 'error' ? 'err' : 'ok'}`}>
              {r.kind === 'error' ? '失败' : r.kind === 'notice' ? 'OK' : fmtNum(r.rowCount)}
            </span>
            <span
              className="rtab-close"
              title="关闭此结果页"
              onClick={(e) => { e.stopPropagation(); useStore.getState().removeResult(tab!.id, r.id) }}
            >
              ×
            </span>
          </button>
        ))}
        <button className={`rtab ${showMsg ? 'on' : ''}`} onClick={() => setShowMsg(true)}>
          <span className="t-title">消息</span>
          <span className={`rtag ${results.some((r) => r.kind === 'error') ? 'err' : 'ok'}`}>
            {results.filter((r) => r.kind === 'error').length > 0
              ? `${results.filter((r) => r.kind === 'error').length} 错误`
              : `${results.length} 条`}
          </span>
        </button>
        <button className="rtab rtab-clear" title="清空当前标签页的全部结果" onClick={() => { useStore.getState().clearResults(tab!.id); setShowMsg(false) }}>
          <span className="t-title">清空结果</span>
        </button>
      </div>

      {showMsg
        ? <MessagePanel results={results} />
        : active && <ResultView key={active.id} tabId={tab!.id} rs={active} />}
    </div>
  )
}

/* ---------------- 可编辑性判定 ---------------- */
interface Editability {
  ok: boolean
  /** 不可编辑时的原因（tooltip 展示） */
  reason?: string
  /** 主键列下标 */
  pkIdx: number[]
}

/**
 * 结果集可编辑判定：
 * 1. 是查询结果；2. 包含主键列；3. 非 DISTINCT/GROUP BY/UNION/聚合（行必须是物理行）；
 * 4. 全部列来自同一张表（排除 JOIN / 表达式列），且能拿到原始表名定位 UPDATE。
 */
function checkEditable(rs: ResultSet): Editability {
  const no = (reason: string): Editability => ({ ok: false, reason, pkIdx: [] })
  if (rs.kind !== 'query') return no('仅查询结果支持编辑')
  if (!rs.columns.length) return no('无列信息')
  const pkIdx = rs.columns.map((c, i) => (c.key === 'PRI' ? i : -1)).filter((i) => i >= 0)
  if (!pkIdx.length) return no('查询结果中未包含主键列，无法定位记录')
  if (/\b(distinct|group\s+by|union(\s+all)?|having)\b/i.test(rs.sql) || /\b(count|sum|avg|min|max)\s*\(/i.test(rs.sql)) {
    return no('聚合 / 分组 / DISTINCT 结果不是物理行，不支持编辑')
  }
  const tables = new Set(rs.columns.map((c) => `${c.schema ?? ''}.${c.table ?? ''}`))
  if (tables.size > 1) return no('列来自多张表（JOIN），不支持按主键更新')
  if ([...tables][0] === '.') return no('缺少字段来源表信息，无法定位记录')
  return { ok: true, pkIdx }
}

/* ---------------- 单个结果集（工具条 + 表格 + footer） ---------------- */
function ResultView({ tabId, rs }: { tabId: string; rs: ResultSet }) {
  /* 编辑态：editing=修改模式；edits="行:列" -> 新值文本；saving=保存进行中 */
  const [editing, setEditing] = useState(false)
  const [edits, setEdits] = useState<Map<string, string>>(() => new Map())
  const [saving, setSaving] = useState(false)

  const editable = useMemo(() => checkEditable(rs), [rs])
  const pkSet = useMemo(() => new Set(editable.pkIdx), [editable])

  /* 早退分支（错误 / 提示结果不提供编辑） */
  if (rs.kind === 'error') {
    return (
      <div className="msg-panel">
        <div className="msg-item err">
          <span className="m-time">{fmtTime(rs.at)}</span>
          <span className="m-body">{rs.notice}</span>
        </div>
        <div className="msg-item">
          <span className="m-time" />
          <span className="m-body" style={{ color: 'var(--text-3)' }}>SQL：{rs.sql}</span>
        </div>
      </div>
    )
  }
  if (rs.kind === 'notice' || !rs.columns.length) {
    return (
      <div className="msg-panel">
        <div className="msg-item ok">
          <span className="m-time">{fmtTime(rs.at)}</span>
          <span className="m-body">{rs.notice ?? '执行成功'}</span>
        </div>
        {rs.info && (
          <div className="msg-item info">
            <span className="m-time" />
            <span className="m-body">{rs.info}</span>
          </div>
        )}
      </div>
    )
  }

  /* 进入 / 退出修改模式；退出时若有未保存修改需确认 */
  const toggleEdit = () => {
    if (editing && edits.size > 0) {
      if (!window.confirm(`有 ${edits.size} 处未保存的修改，退出修改模式将丢弃这些修改，确定？`)) return
      setEdits(new Map())
    }
    setEditing((v) => !v)
  }

  /* 单元格提交：与原值相同则视为未修改 */
  const onCellEdit = (r: number, c: number, text: string) => {
    const orig = valueToText(rs.rows[r]?.[c])
    setEdits((prev) => {
      const next = new Map(prev)
      if (text === orig) next.delete(`${r}:${c}`)
      else next.set(`${r}:${c}`, text)
      return next
    })
  }

  /** 把已保存的行写回本地结果集（parseCellValue 按列类型还原值） */
  const writeBack = (doneRows: Set<number>, byRow: Map<number, { c: number; text: string }[]>) => {
    const next = rs.rows.map((row, r) => {
      const chs = byRow.get(r)
      if (!chs || !doneRows.has(r)) return row
      const copy = row.slice()
      for (const { c, text } of chs) copy[c] = parseCellValue(rs.columns[c], text)
      return copy
    })
    useStore.getState().updateResultRows(tabId, rs.id, next)
  }

  /** 保存：按主键为每个修改行生成一条 UPDATE 并执行 */
  const saveEdits = async () => {
    if (!editable.ok || saving || edits.size === 0) return
    const cfg = useStore.getState().connections.find((c) => c.id === rs.connId)
    if (!cfg) { toast.error('找不到该结果集对应的数据库连接'); return }

    /* 按行聚合单元格修改 */
    const byRow = new Map<number, { c: number; text: string }[]>()
    for (const [k, text] of edits) {
      const [r, c] = k.split(':').map(Number)
      const arr = byRow.get(r) ?? []
      arr.push({ c, text })
      byRow.set(r, arr)
    }

    /* 生成 UPDATE：SET 非主键字段，WHERE 主键定位 */
    const col0 = rs.columns[0]
    /* checkEditable 已保证 table/schema 非空且同表 */
    const tbl = quoteTable(col0.schema || rs.schema, col0.table ?? '')
    const upd: { r: number; sql: string }[] = []
    try {
      for (const [r, changes] of byRow) {
        const row = rs.rows[r]
        if (!row) continue
        const where = editable.pkIdx.map((pi) => {
          const pk = rs.columns[pi]
          const v = row[pi]
          if (v === null || v === undefined) throw new Error(`第 ${r + 1} 行主键「${pk.name}」为 NULL，无法定位记录`)
          return `${quoteIdent(pk.orgName ?? pk.name)} = ${cellLiteral(pk, valueToText(v))}`
        })
        const sets = changes
          .sort((a, b) => a.c - b.c)
          .map(({ c, text }) => `${quoteIdent(rs.columns[c].orgName ?? rs.columns[c].name)} = ${cellLiteral(rs.columns[c], text)}`)
        upd.push({ r, sql: `UPDATE ${tbl} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}` })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return
    }

    setSaving(true)
    let done: typeof upd = []
    let failMsg: string | null = null
    let connErr: string | null = null
    try {
      const adapter = await ensureConnected(cfg)
      for (const u of upd) {
        try {
          await adapter.execute(u.sql, rs.schema)
          done.push(u)
        } catch (e) {
          failMsg = e instanceof Error ? e.message : String(e)
          break
        }
      }
    } catch (e) {
      connErr = e instanceof Error ? e.message : String(e)
    } finally {
      setSaving(false)
    }
    if (connErr) {
      toast.error(`连接失败：${connErr}`)
      return
    }

    /* 已成功的行写回本地结果集，并从待保存清单中移除 */
    if (done.length) {
      writeBack(new Set(done.map((u) => u.r)), byRow)
      setEdits((prev) => {
        const next = new Map(prev)
        for (const u of done) for (const ch of byRow.get(u.r) ?? []) next.delete(`${u.r}:${ch.c}`)
        return next
      })
    }
    if (failMsg) {
      toast.error(`保存失败：${failMsg}（已成功 ${done.length}/${upd.length} 行）`)
      return
    }
    toast.success(`已保存 ${done.length} 行修改`)
    setEditing(false)
  }

  return (
    <>
      <ResultToolbar
        rs={rs}
        editable={editable}
        editing={editing}
        dirty={edits.size > 0}
        saving={saving}
        onToggleEdit={toggleEdit}
        onSave={() => void saveEdits()}
      />
      <div className="results-body">
        <ResultGrid rs={rs} editing={editing} edits={edits} pkSet={pkSet} locked={saving} onCellEdit={onCellEdit} />
      </div>
      <div className="grid-footer">
        <span><b>{fmtNum(rs.rowCount)}</b> 行</span>
        <span className="sep" />
        <span>耗时 <b>{fmtDuration(rs.durationMs)}</b></span>
        {rs.truncated && <><span className="sep" /><span style={{ color: 'var(--warn)' }}>结果已截断（可在偏好中调大行数上限）</span></>}
        {editing && <><span className="sep" /><span style={{ color: 'var(--accent-text)' }}>修改模式：双击单元格编辑值（主键列除外）</span></>}
        {edits.size > 0 && <><span className="sep" /><span style={{ color: 'var(--warn)' }}>未保存 {edits.size} 处修改</span></>}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-3)' }}>{rs.connName}{rs.schema ? ` / ${rs.schema}` : ''} · {fmtTime(rs.at)}</span>
      </div>
    </>
  )
}

/* ---------------- 工具条：复制 / 导出 / 修改保存 ---------------- */
function ResultToolbar({ rs, editable, editing, dirty, saving, onToggleEdit, onSave }: {
  rs: ResultSet
  editable: Editability
  editing: boolean
  dirty: boolean
  saving: boolean
  onToggleEdit: () => void
  onSave: () => void
}) {
  const targetTable = useMemo(() => {
    const m = extractTableFromSql(rs.sql)
    return m ? quoteTable(rs.schema ?? m.schema, m.table) : undefined
  }, [rs.sql, rs.schema])

  const copyAsCsv = () => {
    void copyText(toCsv(rs.columns, rs.rows))
      .then((ok) => ok ? toast.success(`已复制 ${rs.rows.length} 行 CSV`) : toast.error('复制失败'))
  }
  const copyAsInsert = () => {
    const t = targetTable ?? '`result`'
    const sql = buildInserts(t, rs.columns, rs.rows)
    void copyText(sql).then((ok) => ok ? toast.success('已复制 INSERT 语句') : toast.error('复制失败'))
  }
  const downloadCsv = () => {
    downloadText(`result_${new Date(rs.at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(rs.columns, rs.rows), 'text/csv;charset=utf-8')
    toast.success('已下载 CSV')
  }
  const downloadInsert = () => {
    const t = targetTable ?? '`result`'
    downloadText(`insert_${Date.now()}.sql`, buildInserts(t, rs.columns, rs.rows), 'application/sql')
    toast.success('已下载 INSERT 脚本')
  }

  return (
    <div className="results-toolbar">
      <button className="btn sm ghost" onClick={copyAsCsv} title="以 CSV 格式复制全部结果"><IconCopy /> 复制 CSV</button>
      <button className="btn sm ghost" onClick={copyAsInsert} disabled={!targetTable} title={targetTable ? `生成到 ${targetTable} 的 INSERT` : '无法从 SQL 识别表名'}><IconCopy /> 复制 INSERT</button>
      <button className="btn sm ghost" onClick={downloadCsv}><IconDownload /> CSV</button>
      <button className="btn sm ghost" onClick={downloadInsert} disabled={!targetTable}><IconDownload /> INSERT</button>
      {rs.truncated && <span style={{ color: 'var(--warn)', fontSize: 11, marginLeft: 6 }}>仅导出已加载的 {fmtNum(rs.rowCount)} 行</span>}
      <span className="tb-sep" />
      {editable.ok ? (
        <>
          <button
            className={`btn sm ${editing ? 'primary' : 'ghost'}`}
            onClick={onToggleEdit}
            title={editing ? '退出修改模式（未保存的修改将丢弃）' : '进入修改模式：双击非主键单元格编辑值'}
          >
            <IconEdit /> {editing ? '退出修改' : '修改'}
          </button>
          <button
            className="btn sm ghost"
            onClick={onSave}
            disabled={!editing || !dirty || saving}
            title="按主键生成 UPDATE 语句，保存已修改的单元格"
          >
            <IconSave /> {saving ? '保存中…' : '保存'}
          </button>
        </>
      ) : (
        <button className="btn sm ghost" disabled title={editable.reason}>
          <IconEdit /> 修改
        </button>
      )}
    </div>
  )
}

/* ---------------- 虚拟滚动网格（支持结果集编辑） ---------------- */
function ResultGrid({ rs, editing, edits, pkSet, locked, onCellEdit }: {
  rs: ResultSet
  /** 是否处于修改模式 */
  editing: boolean
  /** 已修改单元格："行:列" -> 新值文本 */
  edits: Map<string, string>
  /** 主键列下标集合（锁定不可编辑） */
  pkSet: Set<number>
  /** 保存进行中，禁止再编辑 */
  locked: boolean
  onCellEdit: (r: number, c: number, text: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(360)
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  const [cellEdit, setCellEdit] = useState<{ r: number; c: number } | null>(null)

  /* 容器尺寸监听 */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const total = rs.rows.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const visible = rs.rows.slice(start, end)

  const cellMenu = (r: number, c: number): CtxItem[] => {
    const v = rs.rows[r]?.[c]
    const col = rs.columns[c]
    const rowText = rs.columns.map((cc, idx) => `${cc.name}: ${valueToText(rs.rows[r]?.[idx])}`).join('\n')
    return [
      { label: `复制值${col ? `（${col.name}）` : ''}`, icon: <IconCopy />, disabled: v === null, onClick: () => { void copyText(valueToText(v)).then((ok) => ok && toast.success('已复制单元格值')) } },
      { label: '复制整行（key: value）', icon: <IconCopy />, onClick: () => { void copyText(rowText).then((ok) => ok && toast.success('已复制整行')) } },
      { label: '复制整行（CSV）', icon: <IconCopy />, onClick: () => { void copyText(rs.rows[r].map((x) => valueToText(x)).join(',')).then((ok) => ok && toast.success('已复制整行')) } },
      { sep: true },
      { label: '复制列名', icon: <IconCopy />, onClick: () => { if (col) void copyText(col.name).then((ok) => ok && toast.success('已复制')) } },
    ]
  }

  return (
    <div className="grid-wrap" ref={wrapRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
      <table className="grid vgrid">
        <thead>
          <tr>
            <th className="rownum-h" style={{ width: 52, minWidth: 52 }}>#</th>
            {rs.columns.map((c, i) => (
              <th key={i} onContextMenu={(e) => openContextMenu(e, [
                { label: `复制列名 ${c.name}`, icon: <IconCopy />, onClick: () => { void copyText(c.name).then((ok) => ok && toast.success('已复制')) } },
                { label: '复制列注释', icon: <IconCopy />, disabled: !c.comment, onClick: () => { void copyText(c.comment ?? '').then((ok) => ok && toast.success('已复制')) } },
              ])}
                title={c.comment ? `${c.name} — ${c.comment}` : c.name}
              >
                <div className="th-inner">
                  <div className="col-name">
                    {c.name}
                    <span className="type-tag">{shortType(c.type)}</span>
                    {c.key === 'PRI' && <span className="badge pri">PK</span>}
                  </div>
                  <div className={`col-comment ${c.comment ? 'has' : ''}`}>{c.comment || '\u00a0'}</div>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr className="spacer-top" style={{ height: start * ROW_H }}>
              <td colSpan={rs.columns.length + 1} style={{ height: start * ROW_H, padding: 0, border: 'none' }} />
            </tr>
          )}
          {visible.map((row, vi) => {
            const ri = start + vi
            const rowSel = sel?.r === ri
            return (
              <tr key={ri} className={rowSel ? 'selected' : ''}>
                <td
                  className="rownum"
                  onClick={() => setSel({ r: ri, c: -1 })}
                >{ri + 1}</td>
                {row.map((v, ci) => {
                  const isSel = rowSel || (sel?.r === ri && sel?.c === ci)
                  const isPk = pkSet.has(ci)
                  const modified = edits.has(`${ri}:${ci}`)
                  const text = v === null || v === undefined ? 'NULL' : valueToText(v)
                  const display = modified ? edits.get(`${ri}:${ci}`)! : text
                  const canEdit = editing && !isPk && !locked
                  const cls = [
                    v === null || v === undefined ? 'null' : isNumLike(v) ? 'num' : '',
                    isSel && !rowSel ? 'selected' : '',
                    canEdit ? 'editable' : '',
                    isPk && editing ? 'pk-locked' : '',
                    modified ? 'modified' : '',
                  ].filter(Boolean).join(' ')
                  return (
                    <td
                      key={ci}
                      className={cls}
                      onClick={() => setSel({ r: ri, c: ci })}
                      onDoubleClick={() => {
                        if (canEdit) { setSel({ r: ri, c: ci }); setCellEdit({ r: ri, c: ci }) }
                        else if (!editing && v !== null) { void copyText(valueToText(v)); toast.success('已复制单元格值') }
                      }}
                      onContextMenu={(e) => { setSel({ r: ri, c: ci }); openContextMenu(e, cellMenu(ri, ci)) }}
                      title={editing && isPk ? `${text}（主键列，不可修改）` : text}
                    >
                      {cellEdit && cellEdit.r === ri && cellEdit.c === ci ? (
                        <CellEditor
                          initial={display}
                          onCommit={(t) => { setCellEdit(null); onCellEdit(ri, ci, t) }}
                          onCancel={() => setCellEdit(null)}
                        />
                      ) : display}
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {end < total && (
            <tr className="spacer-bottom" style={{ height: (total - end) * ROW_H }}>
              <td colSpan={rs.columns.length + 1} style={{ height: (total - end) * ROW_H, padding: 0, border: 'none' }} />
            </tr>
          )}
          {!total && (
            <tr><td colSpan={rs.columns.length + 1} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 18 }}>查询成功，0 行</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- 单元格编辑输入框 ---------------- */
function CellEditor({ initial, onCommit, onCancel }: {
  initial: string
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [val, setVal] = useState(initial)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      className="cell-input"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); onCommit(val) }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
      onBlur={() => onCommit(val)}
    />
  )
}

function shortType(t: string): string {
  // varchar(255) -> varchar · int unsigned -> int
  return (t.split('(')[0] ?? t).trim()
}

/* ---------------- 消息页 ---------------- */
function MessagePanel({ results }: { results: ResultSet[] }) {
  return (
    <div className="results-body">
      <div className="msg-panel">
        {results.map((r) => (
          <div key={r.id} className={`msg-item ${r.kind === 'error' ? 'err' : r.kind === 'notice' ? 'ok' : 'ok'}`}>
            <span className="m-time">{fmtTime(r.at)}</span>
            <span className="m-body">
              {r.kind === 'error' && <>执行失败：{r.notice}<br /></>}
              {r.kind === 'notice' && <>{r.notice}<br /></>}
              {r.kind === 'query' && <>成功 · {fmtNum(r.rowCount)} 行 · {fmtDuration(r.durationMs)}<br /></>}
              <span style={{ color: 'var(--text-3)' }}>{r.sql}</span>
            </span>
          </div>
        ))}
        <div className="msg-item">
          <IconInfo /> <span style={{ color: 'var(--text-3)', fontSize: 11 }}>共 {results.length} 条执行记录（保留最近 12 条）</span>
        </div>
      </div>
    </div>
  )
}
