/* AI 配置存取：默认值 / 服务商预设 / 持久化（mws.v1.ai.settings） */
import type { AiPreset, AiSettings } from './types'
import { loadStore, saveStore, IS_EXTENSION } from '../core/storage'

/** 服务商预设：均为 OpenAI Chat Completions 兼容端点 */
export const AI_PRESETS: AiPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] },
  { id: 'moonshot', name: 'Moonshot（月之暗面）', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'] },
  { id: 'qwen', name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'doubao', name: '豆包（火山方舟）', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115', models: [] },
  { id: 'zhipu', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-air', models: ['glm-4-air', 'glm-4-plus', 'glm-4-flash'] },
  { id: 'ollama', name: 'Ollama（本机）', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', models: [] },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseURL: '', model: '', models: [] },
]

export const DEFAULT_AI_SETTINGS: AiSettings = {
  baseURL: '',
  model: '',
  apiKey: '',
  temperature: undefined,
  maxTokens: undefined,
  timeoutMs: 60_000,
  autoRunReadOnly: true,
  maxToolRounds: 8,
  reduceMotion: false,
}

const KEY = 'ai.settings'

/** 读取配置（无配置时返回默认值） */
export function loadAiSettings(): AiSettings {
  return { ...DEFAULT_AI_SETTINGS, ...loadStore<Partial<AiSettings>>(KEY, {}) }
}

/** 保存配置 */
export function saveAiSettings(s: AiSettings) {
  saveStore(KEY, s)
}

/** 是否已完成最小配置（baseURL + model + apiKey） */
export function isConfigured(s: AiSettings): boolean {
  return Boolean(s.baseURL.trim() && s.model.trim() && s.apiKey.trim())
}

/** 配置持久化位置说明（弹窗底部隐私声明用） */
export function settingsStorageHint(): string {
  return IS_EXTENSION ? 'chrome.storage（仅本机）' : 'localStorage（仅本机）'
}

/* ---------------- 多配置管理（FR-03） ---------------- */

/** 已保存的配置方案（端点三要素的命名快照） */
export interface AiProfile {
  id: string
  name: string
  baseURL: string
  model: string
  apiKey: string
}

const PROFILE_KEY = 'ai.profiles'

/** 读取全部配置方案 */
export function loadAiProfiles(): AiProfile[] {
  return loadStore<AiProfile[]>(PROFILE_KEY, [])
}

/** 保存全部配置方案 */
export function saveAiProfiles(list: AiProfile[]) {
  saveStore(PROFILE_KEY, list)
}

/** 当前设置命中的方案（端点三要素完全一致视为生效中） */
export function matchProfile(s: AiSettings): AiProfile | null {
  const baseURL = s.baseURL.trim()
  const model = s.model.trim()
  return loadAiProfiles().find((p) => p.baseURL === baseURL && p.model === model && p.apiKey === s.apiKey) ?? null
}

/** 当前生效模型的 id：优先读记录值，老数据无记录时按端点三要素反推 */
export function activeProfileIdOf(s: AiSettings): string {
  if (s.activeProfileId) return s.activeProfileId
  return matchProfile(s)?.id ?? ''
}

/** 按请求地址反推预设 id（非空未命中归为自定义；用于编辑页回显） */
export function presetIdOf(baseURL: string): string {
  const url = baseURL.trim().replace(/\/+$/, '').toLowerCase()
  if (!url) return ''
  return AI_PRESETS.find((p) => p.id !== 'custom' && p.baseURL.replace(/\/+$/, '').toLowerCase() === url)?.id ?? 'custom'
}

/** 按请求地址推断供应商展示名（未命中预设归为自定义） */
export function providerNameOf(baseURL: string): string {
  const url = baseURL.trim().replace(/\/+$/, '').toLowerCase()
  if (!url) return '—'
  const hit = AI_PRESETS.find((p) => p.id !== 'custom' && p.baseURL.replace(/\/+$/, '').toLowerCase() === url)
  return hit ? hit.name : '自定义（OpenAI 兼容）'
}

/** 切换生效模型：把方案端点写入设置并持久化；返回新的设置（未找到方案返回 null） */
export function applyProfileToSettings(id: string): AiSettings | null {
  const p = loadAiProfiles().find((x) => x.id === id)
  if (!p) return null
  const s: AiSettings = { ...loadAiSettings(), activeProfileId: id, baseURL: p.baseURL, model: p.model, apiKey: p.apiKey }
  saveAiSettings(s)
  return s
}
