/* AI 对话发送流程：统一委托给 agent/loop 的 runAgentTurn（M2 起 Agent 循环处理工具调用） */
import { loadAiSettings, isConfigured } from './settings'
import { useAiStore } from './store'
import { runAgentTurn } from './agent/loop'

/**
 * 发送一条用户消息。
 * 未配置模型时打开设置弹窗并返回 false；忙碌中返回 false。
 */
export async function sendUserMessage(text: string): Promise<boolean> {
  const settings = loadAiSettings()
  if (!isConfigured(settings)) {
    const st = useAiStore.getState()
    st.setOpen(true) // 设置弹窗宿主于面板内，需先确保面板可见
    st.setSettingsOpen(true)
    return false
  }
  const ai = useAiStore.getState()
  if (ai.busy || ai.streaming) return false

  await runAgentTurn(text)
  return true
}

/**
 * 结果页签错误态「让 AI 修复」入口：打开面板并携带报错 SQL 与错误信息发送。
 */
export async function requestAiFix(sql: string, error: string): Promise<void> {
  useAiStore.getState().setOpen(true)
  const text = `下面这条 SQL 执行报错了，请分析原因并给出修复后的 SQL：\n\n\`\`\`sql\n${sql}\n\`\`\`\n\n错误信息：\n\n\`\`\`\n${error}\n\`\`\``
  await sendUserMessage(text)
}

/**
 * 结果页签「让 AI 解读」入口（FR-24）：打开面板并发送列名 + 样本数据请求分析。
 * rows 为截断后的样本（每格已限长）。
 */
export async function requestAiReadout(args: {
  sql: string
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated?: boolean
}): Promise<void> {
  useAiStore.getState().setOpen(true)
  const { sql, columns, rows, rowCount, truncated } = args
  const sample = rows
    .map((r) => `| ${r.map((c) => (c == null ? 'NULL' : String(c))).join(' | ')} |`)
    .join('\n')
  const text = [
    '请解读下面这次查询的结果：说明数据整体情况、值得注意的值或异常，并用一两句业务视角总结。',
    '',
    '```sql',
    sql,
    '```',
    '',
    `列名：${columns.join('、')}`,
    `总行数：${rowCount}${truncated ? '（样本仅展示前几行）' : '（以下为全部行）'}`,
    '',
    sample || '（无数据行）',
  ].join('\n')
  await sendUserMessage(text)
}
