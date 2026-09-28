/* AI 传输层：OpenAI Chat Completions 兼容端点的 SSE 流式客户端
 *
 * - fetch 直连（主流端点均放行 CORS）；AbortSignal 中断
 * - SSE 按「事件块」解析：data: {...} 行 → choices[0].delta
 *   - delta.content → onDelta 文本增量
 *   - delta.tool_calls → 按 index 聚合 id/name/arguments 分片
 * - 错误归一化：401/403 / 404 / 429 / 网络(CORS) / 中止 / 其他
 */
import type { AiSettings, ToolCallItem } from './types'

/** OpenAI 消息形态（我们只用到本轮需要的字段） */
export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** OpenAI tools 参数（function calling） */
export interface OpenAiTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatRequest {
  messages: OpenAiMessage[]
  tools?: OpenAiTool[]
  signal: AbortSignal
  /** 文本增量回调 */
  onDelta?: (text: string) => void
  /** 工具调用聚合完成回调（一次请求结束时统一给出） */
  onToolCalls?: (calls: ToolCallItem[]) => void
}

export interface ChatResponse {
  content: string
  toolCalls: ToolCallItem[]
}

/** 错误归一化：任何失败都抛 AiError（message 可直接展示给用户） */
export class AiError extends Error {
  /** retryable: 提示用户可重试（限流/超时/网络抖动） */
  retryable: boolean
  constructor(message: string, retryable = false) {
    super(message)
    this.name = 'AiError'
    this.retryable = retryable
  }
}

/** 统一错误归一化（流式请求与测试连接共用） */
export async function normalizeHttpError(res: Response): Promise<AiError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string }
      detail = j.error?.message ?? j.message ?? ''
    } catch {
      detail = text.slice(0, 200)
    }
  } catch { /* ignore */ }
  if (res.status === 401 || res.status === 403) return new AiError(`鉴权失败（HTTP ${res.status}），请检查 API Key 是否正确${detail ? `：${detail}` : ''}`)
  if (res.status === 404) return new AiError(`接口路径不存在（HTTP 404），请检查请求地址是否以 /v1 结尾${detail ? `：${detail}` : ''}`)
  if (res.status === 429) return new AiError(`触发限流（HTTP 429），请稍后重试${detail ? `：${detail}` : ''}`, true)
  if (res.status >= 500) return new AiError(`服务端错误（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, true)
  return new AiError(`请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`)
}

function normalizeNetworkError(e: unknown): AiError {
  if (e instanceof AiError) return e
  if (e instanceof DOMException && e.name === 'AbortError') return new AiError('已中止本次生成')
  if (e instanceof TypeError) {
    return new AiError('无法连接目标地址（可能被 CORS 拦截或地址不可达），建议在设置中用「测试连接」验证')
  }
  const msg = e instanceof Error ? e.message : String(e)
  return new AiError(`请求异常：${msg}`, true)
}

/** chat/completions URL 拼接（容忍末尾 /） */
function endpoint(baseURL: string): string {
  return baseURL.replace(/\/+$/, '') + '/chat/completions'
}

/**
 * 流式对话：SSE 解析 content 与 tool_calls（按 index 聚合）。
 * 结束时返回完整 content + toolCalls。错误一律抛 AiError。
 */
export async function chatStream(s: AiSettings, req: ChatRequest): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: s.model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: false },
  }
  if (req.tools?.length) body.tools = req.tools
  if (s.temperature != null) body.temperature = s.temperature
  if (s.maxTokens != null) body.max_tokens = s.maxTokens

  const timeout = AbortSignal.timeout?.(s.timeoutMs ?? 60_000)
  const signal = timeout ? AbortSignal.any([req.signal, timeout]) : req.signal

  let res: Response
  try {
    res = await fetch(endpoint(s.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    throw normalizeNetworkError(e)
  }
  if (!res.ok) throw await normalizeHttpError(res)
  if (!res.body) throw new AiError('响应无内容流（stream 为空）')

  let content = ''
  // 按 index 聚合 tool_calls 分片
  const tcAgg = new Map<number, { id: string; name: string; args: string }>()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const handleBlock = (block: string) => {
    const line = block.trim()
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let json: {
      choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]
      error?: { message?: string }
    }
    try {
      json = JSON.parse(payload)
    } catch {
      return // 非 JSON 分片（心跳等）忽略
    }
    if (json.error?.message) throw new AiError(`模型返回错误：${json.error.message}`)
    const delta = json.choices?.[0]?.delta
    if (!delta) return
    if (delta.content) {
      content += delta.content
      req.onDelta?.(delta.content)
    }
    delta.tool_calls?.forEach((tc) => {
      const agg = tcAgg.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) agg.id = tc.id
      if (tc.function?.name) agg.name += tc.function.name
      if (tc.function?.arguments) agg.args += tc.function.arguments
      tcAgg.set(tc.index, agg)
    })
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔；逐块处理已完整的部分
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line) handleBlock(line) // 空行是事件分隔，data: 行单独处理即可（OpenAI 均为单行 data）
      }
    }
    if (buf.trim()) handleBlock(buf)
  } catch (e) {
    throw normalizeNetworkError(e)
  }

  const toolCalls: ToolCallItem[] = [...tcAgg.values()]
    .filter((t) => t.id || t.name)
    .map((t) => ({ id: t.id || `call_${Math.random().toString(36).slice(2)}`, name: t.name, args: t.args || '{}' }))
  req.onToolCalls?.(toolCalls)
  return { content, toolCalls }
}

/** 测试连接：同端点 max_tokens=1 的非流式请求，复用错误归一化 */
export async function testConnection(s: Pick<AiSettings, 'baseURL' | 'model' | 'apiKey' | 'timeoutMs'>): Promise<string> {
  let res: Response
  try {
    res = await fetch(endpoint(s.baseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout?.(Math.min(s.timeoutMs ?? 20_000, 20_000)),
    })
  } catch (e) {
    throw normalizeNetworkError(e)
  }
  if (!res.ok) throw await normalizeHttpError(res)
  try {
    const j = (await res.json()) as { model?: string }
    return j.model ?? s.model
  } catch {
    return s.model
  }
}
