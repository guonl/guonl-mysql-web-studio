/* AI 会话消息渲染：用户 / 助手 / 工具卡片 / 系统提示 四类
 * SQL 代码块工具条（复制/插入/运行）通过事件委托处理 */
import { useState } from 'react'
import { Markdown } from './Markdown'
import { toast } from '../Toast'
import { copyText } from '../../core/utils'
import { runTabSql } from '../../core/connOps'
import { useStore } from '../../core/store'
import { loadAiSettings } from '../../ai/settings'
import type { ChatMsg } from '../../ai/types'

/* SQL 块动作（事件委托入口） */
function onMarkdownClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement
  const btn = target.closest('button[data-action]') as HTMLButtonElement | null
  const block = target.closest('.ai-code-sql') as HTMLDivElement | null
  if (!btn || !block) return
  const sql = block.querySelector('pre code')?.textContent ?? ''
  if (!sql.trim()) return
  const action = btn.dataset.action
  if (action === 'copy') {
    void copyText(sql).then((ok) => ok && toast.success('已复制 SQL'))
    return
  }
  if (action === 'insert') {
    useStore.getState().pushEditorIntent('insert', sql)
    toast.success('已插入编辑器')
    return
  }
  if (action === 'run') {
    // 插入编辑器后走与手动运行一致的执行入口（结果进结果区页签）
    const tabId = useStore.getState().activeTabId
    if (!tabId) { toast.warn('请先在结果区上方新建查询标签页'); return }
    useStore.getState().pushEditorIntent('insert', sql)
    void runTabSql(tabId, sql)
  }
}

/* 工具调用折叠卡片 */
function ToolCard({ msg }: { msg: ChatMsg }) {
  const [open, setOpen] = useState(false)
  const label = toolLabel(msg.toolName)
  return (
    <div className={`ai-toolcard ${msg.meta?.error ? 'err' : ''}`}>
      <button className="ai-toolcard-head" onClick={() => setOpen((v) => !v)} type="button">
        <span className={`ai-toolcard-caret ${open ? 'on' : ''}`}>▸</span>
        <span className="ai-toolcard-name">{label}</span>
        <span className="ai-toolcard-state">{msg.meta?.error ? '失败' : '完成'}</span>
      </button>
      {open && <pre className="ai-toolcard-body">{msg.content}</pre>}
    </div>
  )
}

function toolLabel(name?: string): string {
  switch (name) {
    case 'list_schemas': return '查看 Schema 列表'
    case 'list_tables': return '查看表清单'
    case 'describe_table': return '查看表结构'
    case 'sample_data': return '抽样查看数据'
    case 'run_query': return '执行查询'
    default: return name ?? '工具调用'
  }
}

export function ChatMessage({ msg }: { msg: ChatMsg }) {
  /* 工具卡片 */
  if (msg.meta?.kind === 'tool') return <ToolCard msg={msg} />

  /* 系统提示条 */
  if (msg.meta?.kind === 'notice') {
    return <div className={`ai-notice ${msg.meta.error ? 'err' : ''}`}>{msg.content}</div>
  }

  /* 用户消息（纯文本，保留换行；@高亮交给 CSS 不了做 DOM 处理，保持简单） */
  if (msg.role === 'user') {
    return (
      <div className="ai-msg ai-msg-user">
        <div className="ai-bubble">{msg.content}</div>
      </div>
    )
  }

  /* 助手消息（Markdown + 流式光标；reduceMotion 时光标静止常显，FR-25） */
  const streaming = msg.role === 'assistant' && !msg.meta?.done
  const still = streaming && loadAiSettings().reduceMotion
  return (
    <div className="ai-msg ai-msg-assistant">
      <div className={`ai-bubble md-host ${streaming ? 'streaming' : ''}`} onClick={onMarkdownClick}>
        {msg.content ? <Markdown content={msg.content} /> : streaming ? <span className={still ? 'ai-typing static' : 'ai-typing'} /> : null}
        {streaming && msg.content ? <span className={still ? 'ai-caret static' : 'ai-caret'} /> : null}
      </div>
    </div>
  )
}
