/* AI 消息 Markdown 渲染：marked + DOMPurify
 *
 * - SQL 代码块包一层带工具条的容器（复制/插入/运行按钮为纯 HTML，
 *   由 ChatMessage 在容器上做事件委托处理，读 data-action）
 * - 所有 HTML 过 DOMPurify 消毒后才进 innerHTML
 */
import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code(token: { text: string; lang?: string }): string {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase()
      const body = `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(token.text)}</code></pre>`
      if (lang === 'sql') {
        return (
          `<div class="ai-code ai-code-sql">` +
          `<div class="ai-code-bar"><span class="ai-code-lang">SQL</span>` +
          `<span class="ai-code-actions">` +
          `<button class="ai-code-btn" data-action="copy" type="button">复制</button>` +
          `<button class="ai-code-btn" data-action="insert" type="button">插入编辑器</button>` +
          `<button class="ai-code-btn" data-action="run" type="button">运行</button>` +
          `</span></div>${body}</div>`
        )
      }
      return (
        `<div class="ai-code">` +
        `<div class="ai-code-bar"><span class="ai-code-lang">${escapeHtml(lang || 'code')}</span></div>${body}</div>`
      )
    },
  },
})

/** markdown → 消毒后的 HTML（供消息体与预览共用） */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string
  return DOMPurify.sanitize(raw)
}

export function Markdown({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
