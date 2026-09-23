/* 全局状态（Zustand） */
import { create } from 'zustand'
import type {
  ConnectionConfig, ConnRuntime, QueryTab, SavedScript, HistoryItem,
  UIPrefs, ResultSet, TableMeta, ColumnMeta, DriverAdapter,
} from './types'
import { loadStore, saveStore } from './storage'
import { uid } from './utils'

/* ---------------- 适配器注册表（运行期，不持久化） ---------------- */
const adapters = new Map<string, DriverAdapter>()

export function getAdapter(conn: ConnectionConfig): DriverAdapter | undefined {
  return adapters.get(conn.id)
}
export function registerAdapter(connId: string, ad: DriverAdapter) {
  adapters.set(connId, ad)
}
export async function disposeAdapter(connId: string) {
  const ad = adapters.get(connId)
  if (ad) {
    try { await ad.close() } catch { /* ignore */ }
    adapters.delete(connId)
  }
}

/* ---------------- 默认值 ---------------- */
const DEFAULT_PREFS: UIPrefs = {
  theme: 'dark',
  sidebarWidth: 272,
  resultHeight: Math.round(window.innerHeight * 0.45),
  maxRows: 1000,
  showCellJSON: false,
  sidePanelCollapsed: false,
}

function seedConnections(): ConnectionConfig[] {
  return [{
    id: 'conn_demo',
    name: '演示数据库（内置示例）',
    type: 'demo',
    host: 'demo.internal',
    port: 3306,
    user: 'demo_user',
    database: 'shop',
    rememberPassword: true,
    createdAt: Date.now(),
  }]
}

/* ---------------- 元数据缓存（树用，不持久化） ---------------- */
export interface ConnMetaCache {
  schemas: string[] | null
  tables: Record<string, TableMeta[] | undefined> // key=schema
  columns: Record<string, ColumnMeta[] | undefined> // key=`schema`.`table`
  serverVersion?: string
}

interface AppState {
  connections: ConnectionConfig[]
  runtime: Record<string, ConnRuntime>
  meta: Record<string, ConnMetaCache>
  tabs: QueryTab[]
  activeTabId: string
  scripts: SavedScript[]
  history: HistoryItem[]
  prefs: UIPrefs

  /* 连接管理 */
  upsertConnection: (c: ConnectionConfig) => void
  removeConnection: (id: string) => void

  /* 连接生命周期 */
  setRuntime: (id: string, rt: Partial<ConnRuntime>) => void
  connected: (id: string, serverVersion?: string, defaultSchema?: string) => void
  disconnected: (id: string) => void

  /* 元数据 */
  setSchemas: (connId: string, schemas: string[]) => void
  setTables: (connId: string, schema: string, tables: TableMeta[]) => void
  setColumns: (connId: string, schema: string, table: string, cols: ColumnMeta[]) => void

  /* 标签页 */
  newTab: (init?: Partial<QueryTab>) => string
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTab: (id: string, patch: Partial<QueryTab>) => void
  setTabSql: (id: string, sql: string) => void
  appendResult: (tabId: string, rs: ResultSet) => void
  removeResult: (tabId: string, rsId: string) => void
  clearResults: (tabId: string) => void
  /** 结果集编辑保存成功后，把更新后的行数据写回结果集 */
  updateResultRows: (tabId: string, rsId: string, rows: unknown[][]) => void

  /* 脚本 */
  saveScript: (s: { id?: string; name: string; sql: string; connId?: string; schema?: string }) => SavedScript
  deleteScript: (id: string) => void
  renameScript: (id: string, name: string) => void

  /* 历史 */
  pushHistory: (h: Omit<HistoryItem, 'id' | 'at'>) => void
  clearHistory: () => void

  /* 偏好 */
  setPrefs: (p: Partial<UIPrefs>) => void
}

/* 持久化辅助 */
function persist() {
  const s = useStore.getState()
  /* 未勾选「记住密码」的连接：密码仅本次会话内存有效，不写入 localStorage */
  saveStore('connections', s.connections.map((c) => (c.rememberPassword ? c : { ...c, password: undefined })))
  saveStore('tabs', s.tabs)
  saveStore('scripts', s.scripts)
  saveStore('history', s.history)
  saveStore('prefs', s.prefs)
}

const loadTabs = (): { tabs: QueryTab[]; activeTabId: string } => {
  const tabs = loadStore<QueryTab[]>('tabs', [])
  if (tabs.length) {
    return {
      tabs: tabs.map((t) => ({ ...t, running: false, results: t.results?.slice(-12) ?? [] })),
      activeTabId: tabs[0].id,
    }
  }
  const id = uid('tab')
  return {
    tabs: [{
      id,
      title: '查询 1',
      sql: '-- 欢迎使用 MySQL Web Studio（纯前端版）\n-- 快捷键：⌘/Ctrl + Enter 执行当前语句或选中语句\n-- 左侧打开「演示数据库」即可浏览示例 schema 与表\n\nSELECT * FROM users ORDER BY id DESC LIMIT 20;\n',
      dirty: false,
      results: [],
      running: false,
    }],
    activeTabId: id,
  }
}

const bootTabs = loadTabs()

/* 旧版本结果区固定 330px 且拖拽失效：已保存的旧默认值升级为按视口计算的默认高度 */
const bootPrefs = loadStore<Partial<UIPrefs>>('prefs', {})
if (bootPrefs.resultHeight === 330) bootPrefs.resultHeight = DEFAULT_PREFS.resultHeight

export const useStore = create<AppState>((set, get) => ({
  connections: loadStore('connections', seedConnections()),
  runtime: {},
  meta: {},
  tabs: bootTabs.tabs,
  activeTabId: bootTabs.activeTabId,
  scripts: loadStore('scripts', []),
  history: loadStore('history', []),
  prefs: { ...DEFAULT_PREFS, ...bootPrefs },

  /* 连接管理 */
  upsertConnection: (c) => {
    set((st) => {
      const exists = st.connections.some((x) => x.id === c.id)
      return {
        connections: exists
          ? st.connections.map((x) => (x.id === c.id ? c : x))
          : [...st.connections, c],
      }
    })
    persist()
  },
  removeConnection: (id) => {
    void disposeAdapter(id)
    set((st) => {
      const { [id]: _rm, ...runtime } = st.runtime
      const { [id]: _rm2, ...meta } = st.meta
      return {
        connections: st.connections.filter((c) => c.id !== id),
        runtime, meta,
        tabs: st.tabs.map((t) => (t.connId === id ? { ...t, connId: undefined } : t)),
      }
    })
    persist()
  },

  /* 连接生命周期 */
  setRuntime: (id, rt) =>
    set((st) => {
      const base: ConnRuntime = st.runtime[id] ?? { status: 'disconnected' }
      return { runtime: { ...st.runtime, [id]: { ...base, ...rt } } }
    }),
  connected: (id, serverVersion, defaultSchema) => {
    get().setRuntime(id, { status: 'connected', error: undefined, serverVersion, currentSchema: defaultSchema })
    if (!get().meta[id]) set((st) => ({ meta: { ...st.meta, [id]: { schemas: null, tables: {}, columns: {} } } }))
    const m = get().meta[id]
    set((st) => ({ meta: { ...st.meta, [id]: { ...m, serverVersion } } }))
  },
  disconnected: (id) => {
    get().setRuntime(id, { status: 'disconnected' })
  },

  /* 元数据 */
  setSchemas: (connId, schemas) =>
    set((st) => {
      const m: ConnMetaCache = st.meta[connId] ?? { schemas: null, tables: {}, columns: {} }
      return { meta: { ...st.meta, [connId]: { ...m, schemas } } }
    }),
  setTables: (connId, schema, tables) =>
    set((st) => {
      const m: ConnMetaCache = st.meta[connId] ?? { schemas: null, tables: {}, columns: {} }
      return { meta: { ...st.meta, [connId]: { ...m, tables: { ...m.tables, [schema]: tables } } } }
    }),
  setColumns: (connId, schema, table, cols) =>
    set((st) => {
      const m: ConnMetaCache = st.meta[connId] ?? { schemas: null, tables: {}, columns: {} }
      return { meta: { ...st.meta, [connId]: { ...m, columns: { ...m.columns, [`${schema}.${table}`]: cols } } } }
    }),

  /* 标签页 */
  newTab: (init) => {
    const id = uid('tab')
    const count = get().tabs.length + 1
    set((st) => ({
      tabs: [...st.tabs, {
        id, title: init?.title ?? `查询 ${count}`,
        sql: init?.sql ?? '',
        connId: init?.connId,
        schema: init?.schema,
        dirty: false,
        results: [], running: false,
        savedScriptId: init?.savedScriptId,
        savedScriptName: init?.savedScriptName,
      }],
      activeTabId: id,
    }))
    persist()
    return id
  },
  closeTab: (id) => {
    set((st) => {
      const idx = st.tabs.findIndex((t) => t.id === id)
      const tabs = st.tabs.filter((t) => t.id !== id)
      let activeTabId = st.activeTabId
      if (activeTabId === id) {
        const next = tabs[Math.min(idx, tabs.length - 1)]
        activeTabId = next ? next.id : ''
      }
      if (!tabs.length) {
        const nid = uid('tab')
        tabs.push({ id: nid, title: '查询 1', sql: '', dirty: false, results: [], running: false })
        activeTabId = nid
      }
      return { tabs, activeTabId }
    })
    persist()
  },
  setActiveTab: (id) => {
    set({ activeTabId: id })
    persist()
  },
  updateTab: (id, patch) => {
    set((st) => ({ tabs: st.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    persist()
  },
  setTabSql: (id, sql) => {
    set((st) => ({ tabs: st.tabs.map((t) => (t.id === id ? { ...t, sql, dirty: t.savedScriptId ? true : false } : t)) }))
    persist()
  },
  appendResult: (tabId, rs) => {
    set((st) => ({
      tabs: st.tabs.map((t) => {
        if (t.id !== tabId) return t
        const results = [...t.results, rs]
        return { ...t, results: results.slice(-12), activeResultId: rs.id }
      }),
    }))
    persist()
  },
  clearResults: (tabId) => {
    set((st) => ({
      tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, results: [], activeResultId: undefined } : t)),
    }))
    persist()
  },
  removeResult: (tabId, rsId) => {
    set((st) => ({
      tabs: st.tabs.map((t) => {
        if (t.id !== tabId) return t
        const results = t.results.filter((r) => r.id !== rsId)
        /* 关闭的是激活页签时，切到剩余最后一个结果 */
        const activeResultId = t.activeResultId === rsId ? results[results.length - 1]?.id : t.activeResultId
        return { ...t, results, activeResultId }
      }),
    }))
    persist()
  },
  updateResultRows: (tabId, rsId, rows) => {
    set((st) => ({
      tabs: st.tabs.map((t) => {
        if (t.id !== tabId) return t
        return { ...t, results: t.results.map((r) => (r.id === rsId ? { ...r, rows, rowCount: rows.length } : r)) }
      }),
    }))
    persist()
  },

  /* 脚本 */
  saveScript: ({ id, name, sql, connId, schema }) => {
    const existing = id ? get().scripts.find((s) => s.id === id) : undefined
    const script: SavedScript = existing
      ? { ...existing, name, sql, connId, schema, updatedAt: Date.now() }
      : { id: uid('sc'), name, sql, connId, schema, createdAt: Date.now(), updatedAt: Date.now() }
    set((st) => ({
      scripts: existing
        ? st.scripts.map((s) => (s.id === script.id ? script : s))
        : [script, ...st.scripts],
      tabs: st.tabs.map((t) =>
        t.id === get().activeTabId
          ? { ...t, savedScriptId: script.id, savedScriptName: script.name, dirty: false }
          : t),
    }))
    persist()
    return script
  },
  deleteScript: (id) => {
    set((st) => ({
      scripts: st.scripts.filter((s) => s.id !== id),
      tabs: st.tabs.map((t) => (t.savedScriptId === id ? { ...t, savedScriptId: undefined, savedScriptName: undefined } : t)),
    }))
    persist()
  },
  renameScript: (id, name) => {
    set((st) => ({
      scripts: st.scripts.map((s) => (s.id === id ? { ...s, name, updatedAt: Date.now() } : s)),
      tabs: st.tabs.map((t) => (t.savedScriptId === id ? { ...t, savedScriptName: name } : t)),
    }))
    persist()
  },

  /* 历史 */
  pushHistory: (h) => {
    set((st) => {
      const item: HistoryItem = { ...h, id: uid('h'), at: Date.now() }
      const history = [item, ...st.history].slice(0, 500)
      saveStore('history', history)
      return { history }
    })
  },
  clearHistory: () => {
    set({ history: [] })
    persist()
  },

  /* 偏好 */
  setPrefs: (p) => {
    set((st) => ({ prefs: { ...st.prefs, ...p } }))
    persist()
  },
}))

/** 当前活动标签页 */
export function useActiveTab(): QueryTab | undefined {
  return useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
}
