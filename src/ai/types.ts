/* AI 助手 · 核心类型定义 */

/* ---------------- 模型配置 ---------------- */

/** 服务商预设（OpenAI Chat Completions 兼容端点） */
export interface AiPreset {
  id: string
  name: string
  baseURL: string
  model: string
  /** 备选模型（下拉可改） */
  models?: string[]
}

export interface AiSettings {
  /** 当前生效的模型方案 id（对应模型列表中的条目） */
  activeProfileId?: string
  /** 请求地址，如 https://api.deepseek.com/v1（通常以 /v1 结尾） */
  baseURL: string
  /** 模型 ID，如 deepseek-chat */
  model: string
  /** API 密钥，仅保存在本机 */
  apiKey: string
  temperature?: number
  maxTokens?: number
  /** 请求超时毫秒，默认 60_000 */
  timeoutMs?: number
  /** L0 只读语句自动执行（关闭则一律弹窗确认） */
  autoRunReadOnly: boolean
  /** Agent 单轮最大工具循环次数 */
  maxToolRounds: number
  /** 减少动效（呼吸灯/打字机） */
  reduceMotion: boolean
}

/* ---------------- 会话消息 ---------------- */

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'

/** assistant 发起的工具调用（对齐 OpenAI tool_calls 形态） */
export interface ToolCallItem {
  id: string
  name: string
  /** JSON 字符串形式的参数 */
  args: string
}

export type RiskLevel = 0 | 1 | 2 | 3 // 只读 / 数据变更 / 结构变更 / 服务器级（含兜底）

export interface ChatMsg {
  id: string
  role: ChatRole
  content: string
  toolCalls?: ToolCallItem[]
  /** tool 消息归属的调用 id */
  toolCallId?: string
  toolName?: string
  meta?: {
    /** tool=工具折叠卡片 notice=系统提示条 */
    kind?: 'tool' | 'notice'
    level?: RiskLevel
    error?: boolean
    /** 流式是否已结束 */
    done?: boolean
  }
}

/* ---------------- 风险分级与执行决策（M2） ---------------- */

export interface RiskReport {
  level: RiskLevel
  /** 命中的风险特征，如 ['UPDATE 无 WHERE', '多语句'] */
  features: string[]
}

export type ExecDecision = 'run' | 'deny'
