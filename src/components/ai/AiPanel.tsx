/* AI 面板：右侧对话列（挤压式布局）——头部 / 消息流 / 输入区
 * 输入区支持 / 快捷指令菜单与 @表名 补全（表清单来自当前连接元数据） */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAiStore } from '../../ai/store'
import { activeProfileIdOf, applyProfileToSettings, isConfigured, loadAiProfiles, loadAiSettings } from '../../ai/settings'
import { sendUserMessage } from '../../ai/chat'
import { activeCtx, refreshActiveContext } from '../../ai/prompts'
import { useStore } from '../../core/store'
import { loadStore, saveStore } from '../../core/storage'
import { ChatMessage } from './ChatMessage'
import { AiSettingsModal } from './AiSettingsModal'
import { AiSessionHistoryModal } from './AiSessionHistoryModal'
import { IconBot, IconChevronRight, IconGear, IconHistory } from '../icons'
import { FlowerLogo } from './AiFab'

/* 面板宽度（可拖拽调整，持久化） */
const PANEL_W_KEY = 'ai.panelWidth'
const PANEL_W_MIN = 300
const PANEL_W_MAX = 720

/* ---------------- / 快捷指令 ---------------- */

interface SlashCmd {
  cmd: string
  desc: string
  /** 返回实际发送的提示词；null 表示特殊处理（如 /clear） */
  build: (() => string) | null
}

function activeTabSql(): string | null {
  const st = useStore.getState()
  const tab = st.tabs.find((t) => t.id === st.activeTabId)
  return tab?.sql.trim() || null
}

function lastErrorInfo(): { sql: string; error: string } | null {
  const st = useStore.getState()
  const tab = st.tabs.find((t) => t.id === st.activeTabId)
  const rs = [...(tab?.results ?? [])].reverse().find((r) => r.kind === 'error')
  return rs ? { sql: rs.sql, error: rs.notice ?? '未知错误' } : null
}

const SLASH_COMMANDS: SlashCmd[] = [
  {
    cmd: '/explain', desc: '解释当前编辑器中的 SQL',
    build: () => {
      const sql = activeTabSql()
      if (!sql) return '请先在编辑器中写好 SQL（当前编辑器为空）。我可以解释编辑器中的语句。'
      return `请逐段解释编辑器中这段 SQL 的作用，指出每个子句做了什么：\n\n\`\`\`sql\n${sql}\n\`\`\``
    },
  },
  {
    cmd: '/optimize', desc: '优化当前编辑器中的 SQL',
    build: () => {
      const sql = activeTabSql()
      if (!sql) return '编辑器当前为空。请先写好 SQL，我再给出优化建议。'
      return `请分析下面这段 SQL 的性能问题（索引、扫描方式、写法），给出优化后的版本并解释改动点：\n\n\`\`\`sql\n${sql}\n\`\`\``
    },
  },
  { cmd: '/tables', desc: '介绍当前 Schema 的表', build: () => '请介绍当前 Schema 下有哪些表、各自的用途，以及它们之间可能的关联关系。' },
  {
    cmd: '/fix', desc: '修复最近一次执行报错',
    build: () => {
      const info = lastErrorInfo()
      if (!info) return '当前标签页最近没有执行报错。请先运行出错的 SQL，或直接把错误信息发给我。'
      return `下面这条 SQL 执行报错了，请分析原因并给出修复后的 SQL：\n\n\`\`\`sql\n${info.sql}\n\`\`\`\n\n错误信息：\n\n\`\`\`\n${info.error}\n\`\`\``
    },
  },
  { cmd: '/clear', desc: '清空当前会话', build: null },
]

/* ---------------- @表名补全候选 ---------------- */

interface AtItem { label: string; ref: string }

function useAtItems(): AtItem[] {
  const ctx = activeCtx()
  const connMeta = useStore((s) => (ctx ? s.meta[ctx.connId] : undefined))
  return useMemo(() => {
    if (!ctx || !connMeta) return []
    const out: AtItem[] = []
    const push = (schema: string, name: string) => {
      const sameSchema = schema === ctx.schema
      out.push({ label: sameSchema ? name : `${schema}.${name}`, ref: sameSchema ? name : `${schema}.${name}` })
    }
    if (ctx.schema) (connMeta.tables[ctx.schema] ?? []).forEach((t) => push(ctx.schema!, t.name))
    for (const [schema, tables] of Object.entries(connMeta.tables)) {
      if (schema === ctx.schema) continue
      tables?.forEach((t) => push(schema, t.name))
    }
    return out
  }, [ctx?.connId, ctx?.schema, connMeta])
}

/* ---------------- 面板组件 ---------------- */

export function AiPanel() {
  const open = useAiStore((s) => s.open)
  const messages = useAiStore((s) => s.messages)
  const busy = useAiStore((s) => s.busy)
  const settingsOpen = useAiStore((s) => s.settingsOpen)
  const sessionId = useAiStore((s) => s.sessionId)
  const sessions = useAiStore((s) => s.sessions)

  const [text, setText] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [configured, setConfigured] = useState(() => isConfigured(loadAiSettings()))
  const [profiles, setProfiles] = useState(() => loadAiProfiles())
  const [activeId, setActiveId] = useState(() => activeProfileIdOf(loadAiSettings()))
  const [width, setWidth] = useState(() => loadStore(PANEL_W_KEY, 400))
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  /* 左缘拖拽调整面板宽度（松手时持久化） */
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent) => {
      setWidth(Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, startW + (startX - ev.clientX))))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setWidth((w) => { saveStore(PANEL_W_KEY, w); return w })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /* 配置可能在设置弹窗里刚改过：同步模型列表 / 生效模型 / 配置状态 */
  useEffect(() => {
    setProfiles(loadAiProfiles())
    setActiveId(activeProfileIdOf(loadAiSettings()))
    setConfigured(isConfigured(loadAiSettings()))
  }, [messages.length, settingsOpen])

  /* 新开的空会话：每次打开面板（或新建/切入空会话）时重查当前连接的 Schema 与表清单，刷新 AI 上下文 */
  useEffect(() => {
    if (!open || messages.length) return
    void refreshActiveContext()
  }, [open, sessionId, messages.length])

  /* 自动滚动到底部（消息数量或流式内容变化时） */
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  /* Esc 收起面板：捕获阶段执行；AI 弹窗或业务弹窗（.modal-mask）开启时让位 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const st = useAiStore.getState()
      if (st.settingsOpen || st.pendingConfirm) return
      if (document.querySelector('.modal-mask')) return
      st.setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /* / 指令菜单（仅当输入以 / 开头且无空白时显示） */
  const slashMatches = useMemo(() => {
    if (!/^\/[\w]*$/.test(text)) return []
    const q = text.slice(1).toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.cmd.slice(1).toLowerCase().startsWith(q))
  }, [text])

  /* @ 表名补全（光标前 @\w*$） */
  const atItems = useAtItems()
  const atMatches = useMemo(() => {
    const m = /@([\w$]*)$/.exec(text)
    if (!m || !atItems.length) return []
    const q = m[1].toLowerCase()
    return atItems.filter((i) => i.ref.toLowerCase().includes(q)).slice(0, 8)
  }, [text, atItems])

  const send = async (raw?: string) => {
    let content = (raw ?? text).trim()
    if (!content || busy) return

    /* / 指令展开 */
    if (content.startsWith('/')) {
      const cmd = SLASH_COMMANDS.find((c) => content.toLowerCase().startsWith(c.cmd + ' ') || content.toLowerCase() === c.cmd)
      if (cmd) {
        if (cmd.cmd === '/clear') {
          useAiStore.getState().clear()
          setText('')
          return
        }
        content = cmd.build?.() ?? content
      } else {
        content = `未知指令「${content.split(/\s+/)[0]}」。可用指令：${SLASH_COMMANDS.map((c) => c.cmd).join(' ')}`
      }
    }

    setText('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    await sendUserMessage(content)
    setConfigured(isConfigured(loadAiSettings()))
  }

  const stop = () => {
    const st = useAiStore.getState()
    if (st.pendingConfirm) st.resolveConfirm('deny') // 未决确认一并拒绝
    st.abort?.abort()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /* 菜单打开时 ↑↓/Enter 先服务菜单 */
    if (slashMatches.length || atMatches.length) {
      if (e.key === 'Escape') { setText(text.replace(/(\/[\w]*)?$/, '').replace(/@[\w$]*$/, '')); e.preventDefault(); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
      e.preventDefault()
      if (slashMatches.length === 1 && text !== slashMatches[0].cmd) { setText(slashMatches[0].cmd); return }
      void send()
    }
  }

  const applyAt = (item: AtItem) => {
    setText(text.replace(/@[\w$]*$/, `@${item.ref} `))
    inputRef.current?.focus()
  }

  const modelKnown = profiles.some((p) => p.id === activeId)
  const ctx = activeCtx()
  const current = sessions.find((s) => s.id === sessionId)

  /* 面板关闭时不渲染（AiFab / 消息发送入口会重新打开） */
  if (!open) return null

  return (
    <aside className="ai-panel" style={{ width }}>
      {/* 左缘拖拽调宽热区 */}
      <div className="ai-panel-resizer" onMouseDown={onResizeStart} />
      {/* 头部 */}
      <div className="ai-panel-head">
        <span className="ai-panel-title"><IconBot /> AI 助手</span>
        {profiles.length > 0 ? (
          <select
            className="ai-panel-model"
            value={modelKnown ? activeId : ''}
            title="切换已配置的模型"
            onChange={(e) => {
              const s = applyProfileToSettings(e.target.value)
              if (!s) return
              setActiveId(activeProfileIdOf(s))
              setConfigured(isConfigured(s))
            }}
          >
            {!modelKnown && <option value="" disabled>{loadAiSettings().model || '未配置模型'}</option>}
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : (
          <button className="ai-panel-model is-empty" title="点击配置模型" onClick={() => useAiStore.getState().setSettingsOpen(true)}>未配置模型</button>
        )}
        <span className="spacer" />
        <button className="btn sm icon" title="模型设置" onClick={() => useAiStore.getState().setSettingsOpen(true)}><IconGear /></button>
        <button className="btn sm icon" title="收起面板 (Esc)" onClick={() => useAiStore.getState().setOpen(false)}><IconChevronRight /></button>
      </div>

      {/* 会话栏：当前会话标题 / 新增 / 会话历史 */}
      <div className="ai-sess-bar">
        <span className="ai-sess-title" title={current?.title ?? ''}>{current?.title ?? '新会话'}</span>
        <button className="btn sm icon" title="新增会话" onClick={() => useAiStore.getState().newSession()}>＋</button>
        <button className="btn sm icon" title="会话历史" onClick={() => setHistoryOpen(true)}><IconHistory /></button>
      </div>

      {/* 消息流 */}
      <div className="ai-msgs" ref={listRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <div className="ai-empty-icon"><FlowerLogo still={loadAiSettings().reduceMotion} /></div>
            <div className="ai-empty-title">嗨！我是您的SQL助手</div>
            {configured ? (
              <>
                <div className="ai-empty-hint">会自动注入当前连接（{ctx ? `「${ctx.connName}」` : '未选择连接'}）的上下文，试试：</div>
                <button className="ai-chip" onClick={() => void send('当前连接的库里有哪些表？各自大概存什么数据？')}>看看当前库有哪些表</button>
                <button className="ai-chip" onClick={() => void send('帮我写一个统计订单金额 Top 10 用户的 SQL')}>写个统计订单 Top10 的 SQL</button>
                <button className="ai-chip" onClick={() => void send('/explain')}>解释编辑器里的 SQL</button>
              </>
            ) : (
              <>
                <div className="ai-empty-hint">首次使用需要配置模型（OpenAI 兼容格式，密钥仅保存在本机）。</div>
                <button className="btn primary" onClick={() => useAiStore.getState().setSettingsOpen(true)}>配置 AI 模型</button>
              </>
            )}
          </div>
        )}
        {messages.map((m) => <ChatMessage key={m.id} msg={m} />)}
      </div>

      {/* 输入区 */}
      <div className="ai-input-wrap">
        {/* @ 补全浮层 */}
        {atMatches.length > 0 && (
          <div className="ai-pop">
            {atMatches.map((i) => (
              <button key={i.ref} type="button" className="ai-pop-item" onClick={() => applyAt(i)}>
                <b>@{i.ref}</b>
              </button>
            ))}
            <div className="ai-pop-hint">回车或点击插入表引用，AI 将自动读取其结构</div>
          </div>
        )}
        {/* / 指令浮层 */}
        {slashMatches.length > 0 && (
          <div className="ai-pop">
            {slashMatches.map((c) => (
              <button key={c.cmd} type="button" className="ai-pop-item" onClick={() => { setText(c.cmd); void send(c.cmd) }}>
                <b>{c.cmd}</b> <span className="ai-pop-desc">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="ai-input-row">
          <textarea
            ref={inputRef}
            className="ai-input"
            placeholder={configured ? '问我任何 SQL / 数据问题，@表名 可带结构，/ 使用快捷指令' : '尚未配置模型，点击发送前往设置…'}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button className="ai-send stop" onClick={stop} title="停止生成">■</button>
          ) : (
            <button className="ai-send" onClick={() => void send()} disabled={!text.trim()} title="发送 (Enter)">➤</button>
          )}
        </div>
        <div className="ai-input-hint">
          Enter 发送 · Shift+Enter 换行 · @表名 注入结构 · / 快捷指令
        </div>
      </div>

      {/* 模型设置弹窗（宿主于面板内） */}
      {settingsOpen && <AiSettingsModal onClose={() => useAiStore.getState().setSettingsOpen(false)} />}
      {/* 会话历史弹窗 */}
      {historyOpen && <AiSessionHistoryModal onClose={() => setHistoryOpen(false)} />}
    </aside>
  )
}
