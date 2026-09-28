/* Agent 循环（tech.md §6.1）：流式对话 + 工具调度 + 人工确认等待 + 预算控制
 *
 * - 每轮请求携带五工具 Schema；返回 tool_calls 则逐个执行（含确认矩阵）后回填，
 *   直至模型给出最终回答或预算耗尽；
 * - 中止 / 清空会话时：pending 确认一律拒绝、流式请求由 AbortController 打断。
 */
import { chatStream, AiError, type OpenAiMessage } from '../transport'
import { buildSystemPrompt, fetchAtTableDdl } from '../prompts'
import { loadAiSettings } from '../settings'
import { newMsg, useAiStore } from '../store'
import { TOOL_SCHEMAS, runTool } from './tools'
import { uid } from '../../core/utils'
import type { ToolCallItem } from '../types'

/** 组装初始 history：system + 近期会话（过滤卡片/提示条）+ 本条用户消息 */
function buildHistory(system: string, userContent: string): OpenAiMessage[] {
  const msgs = useAiStore.getState().messages
  const convo: OpenAiMessage[] = msgs
    .filter((m) => !m.meta?.kind && (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .slice(-24)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  return [{ role: 'system', content: system }, ...convo, { role: 'user', content: userContent }]
}

/** 工具消息（UI 折叠卡片 + history 回填共用内容） */
function toolMsg(callId: string, name: string, content: string) {
  return { id: uid('msg'), role: 'tool' as const, content, toolCallId: callId, toolName: name, meta: { kind: 'tool' as const, done: true } }
}

/**
 * 处理一条用户消息的完整 Agent 轮次（含多轮工具调用）。
 * 调用方需保证未在 busy/streaming 中。
 */
export async function runAgentTurn(text: string): Promise<void> {
  const settings = loadAiSettings()
  const ai = useAiStore.getState()
  const ctl = new AbortController()
  ai.setStreaming(true, ctl)
  ai.setBusy(true)
  ai.append(newMsg('user', text))

  /* 当前轮展示中的 assistant 占位消息（每轮新建，空内容+纯工具调用时移除） */
  let assistant = newMsg('assistant', '')
  let history: OpenAiMessage[] = []

  /* 流式增量节流：攒分片每 50ms 批量渲染一次，避免每个 SSE 分片都触发全量重渲染（CPU 优化） */
  let pendingDelta = ''
  let flushTimer: number | null = null
  const flushDelta = () => {
    flushTimer = null
    if (!pendingDelta) return
    useAiStore.getState().patch(assistant.id, { contentDelta: pendingDelta })
    pendingDelta = ''
  }
  const onDelta = (d: string) => {
    pendingDelta += d
    if (flushTimer == null) flushTimer = window.setTimeout(flushDelta, 50)
  }

  try {
    /* @表名 → 附注真实 DDL（防编造结构） */
    const ddl = await fetchAtTableDdl(text)
    const userContent = ddl ? `${text}\n\n---\n[附注 · 以下为当前连接中该表的真实结构，务必以此为准，不要编造]\n${ddl}` : text
    const system = await buildSystemPrompt()
    history = buildHistory(system, userContent)

    /* 工具调用总预算（跨轮次累计） */
    let budget = settings.maxToolRounds

    for (let round = 0; round < settings.maxToolRounds; round++) {
      assistant = newMsg('assistant', '')
      ai.append(assistant)

      const resp = await chatStream(settings, {
        messages: history,
        tools: TOOL_SCHEMAS,
        signal: ctl.signal,
        onDelta,
      })
      /* 流结束：冲刷剩余增量，保证最终内容完整 */
      if (flushTimer != null) { window.clearTimeout(flushTimer); flushTimer = null }
      flushDelta()
      useAiStore.getState().patch(assistant.id, { meta: { done: true } })

      /* 无工具调用 → 最终回答，结束 */
      if (!resp.toolCalls?.length) return

      /* 纯工具调用轮：空文本占位消息不保留 */
      if (!resp.content.trim()) useAiStore.getState().remove(assistant.id)

      /* assistant（带 tool_calls）写入 history */
      history.push({
        role: 'assistant',
        content: resp.content || null,
        ...(resp.toolCalls.length
          ? { tool_calls: resp.toolCalls.map((c: ToolCallItem) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } })) }
          : {}),
      })

      /* 逐个执行工具调用（串行，保证确认弹窗与结果顺序一致） */
      for (const call of resp.toolCalls) {
        if (budget-- <= 0) {
          ai.append(newMsg('assistant', `已达到工具调用上限（${settings.maxToolRounds} 次），请基于以上信息继续提问或开新话题。`, { kind: 'notice', done: true }))
          return
        }
        const result = await runTool(call.name, call.args)
        /* 中止期间完成的执行：结果仍回填（信息不丢），但不再继续下一轮 */
        const m = toolMsg(call.id, call.name, result)
        ai.append(m)
        history.push({ role: 'tool', tool_call_id: call.id, content: result })
        if (ctl.signal.aborted) return
      }
    }

    /* 轮次上限：不再继续请求 */
    ai.append(newMsg('assistant', `已连续进行 ${settings.maxToolRounds} 轮工具调用，暂停执行。如需继续请再发一条消息（如「继续」）。`, { kind: 'notice', done: true }))
  } catch (e) {
    if (ctl.signal.aborted) {
      /* 用户主动停止：保留已生成内容并标注 */
      const cur = useAiStore.getState().messages.find((m) => m.id === assistant.id)
      if (cur?.content) {
        useAiStore.getState().patch(assistant.id, {
          content: cur.content + '\n\n*(已手动停止)*',
          meta: { done: true },
        })
      }
      /* 工具卡片期间中止：无占位可标，静默结束 */
    } else {
      const msg = e instanceof AiError ? e.message : String(e)
      const cur = useAiStore.getState().messages.find((m) => m.id === assistant.id)
      if (cur && !cur.content) {
        useAiStore.getState().remove(assistant.id)
        useAiStore.getState().append(
          newMsg('assistant', `**请求失败**：${msg}`, { kind: 'notice', error: true, done: true }),
        )
      } else {
        useAiStore.getState().patch(assistant.id, {
          content: (cur?.content ?? '') + `\n\n**生成中断**：${msg}`,
          meta: { done: true },
        })
      }
    }
  } finally {
    /* 清理挂起的节流定时器，冲刷剩余增量（内容不丢；消息已移除时为无害 no-op） */
    if (flushTimer != null) { window.clearTimeout(flushTimer); flushTimer = null }
    flushDelta()
    const st = useAiStore.getState()
    st.setStreaming(false)
    st.setBusy(false)
    /* 确保 done 标记与持久化 */
    const cur = st.messages.find((m) => m.id === assistant.id)
    if (cur && !cur.meta?.done) st.patch(assistant.id, { meta: { done: true } })
  }
}
