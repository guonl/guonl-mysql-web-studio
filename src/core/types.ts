/* 核心领域类型 */

export type ConnectionType = 'demo' | 'ws'

export interface ConnectionConfig {
  id: string
  name: string // 自定义命名
  type: ConnectionType // demo=内置演示库, ws=经 WebSocket 桥接的真实 MySQL
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string // 默认 schema
  wsUrl?: string // ws(s):// 桥接地址
  rememberPassword?: boolean
  createdAt: number
}

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnRuntime {
  status: ConnStatus
  error?: string
  serverVersion?: string
  currentSchema?: string
}

export interface ColumnMeta {
  name: string
  /** 原始列名（SELECT id AS uid 时 orgName=id）；结果集编辑生成 UPDATE 必须用它 */
  orgName?: string
  type: string
  nullable: boolean
  key?: 'PRI' | 'UNI' | 'MUL' | ''
  defaultValue?: string | null
  extra?: string
  comment?: string
  /** 来源表 / 库（由桥接器从 mysql2 字段元数据补齐，供结果集编辑定位表） */
  table?: string
  schema?: string
}

export interface TableMeta {
  name: string
  type: 'TABLE' | 'VIEW'
  engine?: string
  rowsApprox?: number
  comment?: string
  pk?: string[]
}

export interface ExecResult {
  columns: ColumnMeta[]
  rows: unknown[][]
  rowCount: number
  affected?: number
  notice?: string
  info?: string
  serverVersion?: string
}

/** 适配器：Demo 与真实 MySQL(WS桥) 共同实现的驱动接口 */
export interface DriverAdapter {
  kind: ConnectionType
  connect(): Promise<{ serverVersion?: string }>
  ping(): Promise<void>
  close(): Promise<void>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<TableMeta[]>
  getColumns(schema: string, table: string): Promise<ColumnMeta[]>
  /** 一次性取回整 schema 全部表的列（键为表名），比逐表 getColumns 高效；供自动补全预取 */
  getSchemaColumns?(schema: string): Promise<Record<string, ColumnMeta[]>>
  getPK(schema: string, table: string): Promise<string[]>
  showCreateTable(schema: string, table: string): Promise<string>
  execute(sql: string, schema?: string): Promise<ExecResult>
}

export interface ResultSet {
  id: string
  title: string
  columns: ColumnMeta[]
  rows: unknown[][]
  rowCount: number
  truncated?: boolean
  durationMs: number
  at: number
  sql: string
  connId: string
  connName?: string
  schema?: string
  kind: 'query' | 'notice' | 'error'
  notice?: string
  info?: string
  autoLimit?: number // 原语句未写 LIMIT 时执行器自动附加的行数上限
}

export interface SavedScript {
  id: string
  name: string
  sql: string
  connId?: string
  connName?: string
  schema?: string
  createdAt: number
  updatedAt: number
}

export interface HistoryItem {
  id: string
  sql: string
  connId?: string
  connName?: string
  schema?: string
  ok: boolean
  durationMs: number
  at: number
  error?: string
}

export interface QueryTab {
  id: string
  title: string
  sql: string
  connId?: string
  schema?: string
  dirty: boolean
  results: ResultSet[]
  activeResultId?: string
  running: boolean
  savedScriptId?: string
  savedScriptName?: string
}

/* UI 主题：id 持久化在 prefs.theme（旧值 'dark'/'light' 天然兼容）；mode 为明暗归属；swatch 为菜单色卡预览（背景/强调/关键字） */
export type ThemeId =
  | 'dark' | 'one-dark' | 'dracula' | 'tokyo-night' | 'monokai' | 'nord'
  | 'light' | 'github-light' | 'solarized-light'

export interface ThemeMeta {
  id: ThemeId
  name: string
  mode: 'dark' | 'light'
  swatch: [string, string, string]
}

export const THEMES: ThemeMeta[] = [
  { id: 'dark', name: '默认暗色', mode: 'dark', swatch: ['#0d1117', '#4f8cff', '#ff7ab8'] },
  { id: 'one-dark', name: 'One Dark Pro', mode: 'dark', swatch: ['#282c34', '#61afef', '#c678dd'] },
  { id: 'dracula', name: 'Dracula', mode: 'dark', swatch: ['#282a36', '#bd93f9', '#ff79c6'] },
  { id: 'tokyo-night', name: 'Tokyo Night', mode: 'dark', swatch: ['#1a1b26', '#7aa2f7', '#bb9af7'] },
  { id: 'monokai', name: 'Monokai', mode: 'dark', swatch: ['#272822', '#fd971f', '#f92672'] },
  { id: 'nord', name: 'Nord', mode: 'dark', swatch: ['#2e3440', '#88c0d0', '#81a1c1'] },
  { id: 'light', name: '默认亮色', mode: 'light', swatch: ['#ffffff', '#3b6edc', '#b0248a'] },
  { id: 'github-light', name: 'GitHub Light', mode: 'light', swatch: ['#ffffff', '#0969da', '#cf222e'] },
  { id: 'solarized-light', name: 'Solarized Light', mode: 'light', swatch: ['#fdf6e3', '#268bd2', '#859900'] },
]

export interface UIPrefs {
  theme: ThemeId
  sidebarWidth: number
  sidebarCollapsed: boolean // 左侧表视图栏整体收起到侧边（窄条）
  resultHeight: number
  maxRows: number // 单次查询最大返回行数
  showCellJSON: boolean
  sidePanelCollapsed: boolean // 左下角「脚本/历史」面板是否收起
}
