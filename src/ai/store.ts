/* AI 会话状态（独立 aiStore，与主 store 职责分离；只读引用主 store，不反向写）
 *
 * - 面板开合 / 流式中止 / 消息流 / 多会话持久化（FR-12）
 * - pendingConfirm：工具执行的人工确认队列（Promise 化，M2 Agent 使用）
 */
import { create } from 'zustand'
import type { ChatMsg, ExecDecision, RiskLevel } from './types'
import { uid } from '../core/utils'
import { loadStore, saveStore, removeStore } from '../core/storage'
import { activeCtx } from './prompts'

const SESSION_KEY = 'ai.session' // 每个会话的消息存为 ai.session.<id>
const INDEX_KEY = 'ai.sessions' // 会话索引：{ current, sessions }
const MAX_MSGS = 200
const MAX_SESSIONS = 30
const MAX_CONTENT = 8 * 1024 // 单条 content 超 8KB 截断

/* ---------------- 持久化辅助 ---------------- */

/** 会话元信息（索引文件用） */
export interface SessionMeta {
  id: string
  title: string
  updatedAt: number
  /** 会话关联的数据库 Schema（发送首条用户消息时记录） */
  schema?: string
}

interface SessionsFile {
  current: string
  sessions: SessionMeta[]
}

function persistMsg(m: ChatMsg): ChatMsg {
  return m.content.length > MAX_CONTENT ? { ...m, content: m.content.slice(0, MAX_CONTENT) + '…（已截断）' } : m
}

/** 由消息流推导会话标题（首条用户消息第一行，截 24 字符；无用户消息返回空串） */
function deriveTitle(msgs: ChatMsg[]): string {
  const first = msgs.find((m) => m.role === 'user')?.content.trim().split('\n')[0] ?? ''
  return first ? (first.length > 24 ? first.slice(0, 24) + '…' : first) : ''
}

/** 会话是否仍为自动命名的默认标题（chat会话 / 旧数据 chatN / 新会话 / 空），可被首句话覆盖 */
function isAutoTitle(title: string): boolean {
  return !title || title === '新会话' || title === DEFAULT_TITLE || /^chat\d+$/.test(title)
}

/** 新会话默认标题：固定「chat会话」，不递增序号（产生对话后被首句话覆盖） */
const DEFAULT_TITLE = 'chat会话'

function loadSessionMsgs(id: string): ChatMsg[] {
  const msgs = loadStore<ChatMsg[]>(`${SESSION_KEY}.${id}`, [])
  return msgs.map((m) => ({ ...m, meta: { ...m.meta, done: true } })) // 启动时不可能有未完成的流
}

function persistSessionMsgs(id: string, msgs: ChatMsg[]) {
  saveStore(`${SESSION_KEY}.${id}`, msgs.slice(-MAX_MSGS).map(persistMsg))
}

/** 读取会话索引；旧版单会话数据自动迁移为第一个会话 */
function loadSessionsFile(): SessionsFile {
  const f = loadStore<SessionsFile | null>(INDEX_KEY, null)
  if (f && Array.isArray(f.sessions) && f.sessions.length && f.current) {
    // 启动时清理历史遗留的空会话（从未产生过对话的不进索引）
    const sessions = pruneEmptySessions(f.sessions, f.current)
    const file: SessionsFile = { current: f.current, sessions }
    saveStore(INDEX_KEY, file)
    return file
  }

  const legacy = loadStore<ChatMsg[]>(SESSION_KEY, [])
  const meta: SessionMeta = {
    id: uid('sess'),
    title: deriveTitle(legacy) || DEFAULT_TITLE, // 无历史记录时用默认标题
    updatedAt: Date.now(),
  }
  if (legacy.length) persistSessionMsgs(meta.id, legacy)
  const file: SessionsFile = { current: meta.id, sessions: [meta] }
  saveStore(INDEX_KEY, file)
  return file
}

/** 移除索引中的空会话（无任何消息记录；keepId 为必保留的当前会话），并清理其消息文件 */
function pruneEmptySessions(list: SessionMeta[], keepId: string): SessionMeta[] {
  const kept: SessionMeta[] = []
  for (const s of list) {
    if (s.id === keepId || loadSessionMsgs(s.id).length > 0) kept.push(s)
    else removeStore(`${SESSION_KEY}.${s.id}`)
  }
  return kept
}

function touchMeta(sessions: SessionMeta[], id: string, msgs?: ChatMsg[], schema?: string): SessionMeta[] {
  const derived = msgs ? deriveTitle(msgs) : ''
  return sessions.map((s) =>
    s.id === id
      ? {
          ...s,
          updatedAt: Date.now(),
          // 默认命名（chatN 等）且已有用户消息时，用首句话作为标题
          title: msgs && derived && isAutoTitle(s.title) ? derived : s.title,
          schema: schema != null ? schema : s.schema,
        }
      : s,
  )
}

/* ---------------- 待确认请求（Promise 化） ---------------- */

export interface PendingConfirm {
  id: string
  sql: string
  schema?: string
  level: RiskLevel
  features: string[]
  /** 会话内已放行的相同 SQL（L0 专属） */
  allowRemember: boolean
  resolve: (d: ExecDecision) => void
}

/* ---------------- Store ---------------- */

interface AiState {
  open: boolean
  settingsOpen: boolean
  /** 当前会话 id（多会话，FR-12） */
  sessionId: string
  /** 会话索引（最新在前由 UI 排序） */
  sessions: SessionMeta[]
  messages: ChatMsg[]
  /** 流式生成中 */
  streaming: boolean
  /** 当前轮 Agent 忙碌（含工具执行） */
  busy: boolean
  /** 流式中止控制器（面板关闭/停止按钮共用） */
  abort: AbortController | null
  /** 工具执行待确认（同一时刻至多一个弹窗） */
  pendingConfirm: PendingConfirm | null
  /** 会话内放行的 SQL（L0 自动执行白名单，语句原文） */
  approvedSqls: string[]

  setOpen: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  /** 新建会话（当前会话保留在历史中，切换到默认命名的新会话） */
  newSession: () => void
  /** 切换会话 */
  switchSession: (id: string) => void
  /** 删除会话（删除当前时自动落到其余会话） */
  deleteSession: (id: string) => void
  /** 重命名会话（历史列表用） */
  renameSession: (id: string, title: string) => void
  append: (m: ChatMsg) => void
  /** 就地更新消息内容（流式增量） */
  patch: (id: string, patch: Partial<ChatMsg> & { contentDelta?: string }) => void
  remove: (id: string) => void
  clear: () => void
  setStreaming: (v: boolean, abort?: AbortController | null) => void
  setBusy: (v: boolean) => void
  /** 提交确认请求，返回 Promise（resolve('deny') 于中止/清空时统一触发） */
  requestConfirm: (p: Omit<PendingConfirm, 'id' | 'resolve'>) => Promise<ExecDecision>
  resolveConfirm: (d: ExecDecision, remember?: boolean) => void
}

export const useAiStore = create<AiState>((set, get) => {
  const boot = loadSessionsFile()
  /** 中止生成并拒绝未决确认（切换/删除/清空会话前调用） */
  const settleBusy = () => {
    get().abort?.abort()
    if (get().pendingConfirm) get().resolveConfirm('deny')
  }

  return {
  open: false,
  settingsOpen: false,
  sessionId: boot.current,
  sessions: boot.sessions,
  messages: loadSessionMsgs(boot.current),
  streaming: false,
  busy: false,
  abort: null,
  pendingConfirm: null,
  approvedSqls: [],

  setOpen: (v) => {
    set({ open: v })
    if (!v) {
      get().abort?.abort() // 关闭面板即中止生成
      if (get().pendingConfirm) get().resolveConfirm('deny') // 未决确认一律拒绝
    }
  },
  setSettingsOpen: (v) => set({ settingsOpen: v }),

  newSession: () => {
    const { sessionId, messages } = get()
    if (!messages.length) return // 当前已是空会话：直接复用，避免空转消耗会话序号
    settleBusy()
    const { sessions } = get()
    persistSessionMsgs(sessionId, messages)
    const meta: SessionMeta = { id: uid('sess'), title: DEFAULT_TITLE, updatedAt: Date.now() }
    // 顺手清掉索引里的空会话（含刚离开的空会话），避免累积占名额
    const list = pruneEmptySessions([meta, ...touchMeta(sessions, sessionId, messages)], meta.id).slice(0, MAX_SESSIONS)
    saveStore(INDEX_KEY, { current: meta.id, sessions: list })
    set({ sessionId: meta.id, sessions: list, messages: [], streaming: false, busy: false, abort: null, approvedSqls: [] })
  },

  switchSession: (id) => {
    if (id === get().sessionId) return
    settleBusy()
    const { sessionId, messages, sessions } = get()
    persistSessionMsgs(sessionId, messages)
    const list = pruneEmptySessions(touchMeta(sessions, sessionId, messages), id)
    saveStore(INDEX_KEY, { current: id, sessions: list })
    set({ sessionId: id, sessions: list, messages: loadSessionMsgs(id), streaming: false, busy: false, abort: null, approvedSqls: [] })
  },

  deleteSession: (id) => {
    settleBusy()
    const { sessionId, sessions } = get()
    const rest0 = sessions.filter((s) => s.id !== id)
    if (!rest0.length) {
      // 删光：重建一个空会话
      const meta: SessionMeta = { id: uid('sess'), title: DEFAULT_TITLE, updatedAt: Date.now() }
      const list = [meta]
      saveStore(INDEX_KEY, { current: meta.id, sessions: list })
      set({ sessionId: meta.id, sessions: list, messages: [], streaming: false, busy: false, abort: null, approvedSqls: [] })
      return
    }
    const keep = id === sessionId ? rest0[0].id : sessionId
    const rest = pruneEmptySessions(rest0, keep)
    saveStore(INDEX_KEY, { current: keep, sessions: rest })
    if (id === sessionId) {
      set({ sessionId: rest[0].id, sessions: rest, messages: loadSessionMsgs(rest[0].id), streaming: false, busy: false, abort: null, approvedSqls: [] })
    } else {
      set({ sessions: rest })
    }
  },

  renameSession: (id, title) => {
    const name = title.trim()
    if (!name) return
    const sessions = get().sessions.map((s) => (s.id === id ? { ...s, title: name } : s))
    saveStore(INDEX_KEY, { current: get().sessionId, sessions })
    set({ sessions })
  },

  append: (m) => {
    set((st) => ({ messages: [...st.messages, m] }))
    const { sessionId, messages, sessions } = get()
    persistSessionMsgs(sessionId, messages)
    // 用户消息到达时记录当前 Schema，供会话历史展示
    const schema = m.role === 'user' ? activeCtx()?.schema : undefined
    const nextSessions = touchMeta(sessions, sessionId, messages, schema)
    saveStore(INDEX_KEY, { current: sessionId, sessions: nextSessions })
    set({ sessions: nextSessions }) // 同步内存索引（会话栏标题 / 历史列表实时刷新）
  },

  patch: (id, p) => {
    set((st) => ({
      messages: st.messages.map((m) => {
        if (m.id !== id) return m
        const next = { ...m, ...p }
        if (p.contentDelta != null) next.content = m.content + p.contentDelta
        return next
      }),
    }))
    // 流式期间不落盘（避免高频写），结束时的 done patch 会触发持久化
    if (p.meta?.done) {
      const { sessionId, messages, sessions } = get()
      persistSessionMsgs(sessionId, messages)
      const nextSessions = touchMeta(sessions, sessionId, messages)
      saveStore(INDEX_KEY, { current: sessionId, sessions: nextSessions })
      set({ sessions: nextSessions })
    }
  },

  remove: (id) => {
    set((st) => ({ messages: st.messages.filter((m) => m.id !== id) }))
    persistSessionMsgs(get().sessionId, get().messages)
  },

  clear: () => {
    // 会话清空：中止生成 + 全部待确认一律拒绝
    get().abort?.abort()
    get().pendingConfirm?.resolve('deny')
    set({ messages: [], streaming: false, busy: false, abort: null, pendingConfirm: null, approvedSqls: [] })
    persistSessionMsgs(get().sessionId, [])
  },

  setStreaming: (v, abort) => set({ streaming: v, abort: v ? (abort ?? null) : null }),
  setBusy: (v) => set({ busy: v }),

  requestConfirm: (p) =>
    new Promise<ExecDecision>((resolve) => {
      // 若已有待确认（理论上不会发生：Agent 循环串行），先拒绝旧的
      const prev = get().pendingConfirm
      if (prev) prev.resolve('deny')
      set({ pendingConfirm: { ...p, id: uid('confirm'), resolve } })
    }),

  resolveConfirm: (d, remember) => {
    const p = get().pendingConfirm
    if (!p) return
    if (d === 'run' && remember) {
      const norm = p.sql.replace(/\s+/g, ' ').trim()
      set({ approvedSqls: [...get().approvedSqls, norm] })
    }
    set({ pendingConfirm: null })
    p.resolve(d)
  },
  }
})

/** 新建消息（统一 id 生成） */
export function newMsg(role: ChatMsg['role'], content = '', meta?: ChatMsg['meta']): ChatMsg {
  return { id: uid('msg'), role, content, meta }
}

/** 读取指定会话的消息（会话历史搜索用） */
export function sessionMessagesOf(id: string): ChatMsg[] {
  return loadSessionMsgs(id)
}

/** 语句是否在会话放行名单内（空白归一后精确匹配） */
export function isApprovedSql(sql: string): boolean {
  const norm = sql.replace(/\s+/g, ' ').trim()
  return useAiStore.getState().approvedSqls.includes(norm)
}
