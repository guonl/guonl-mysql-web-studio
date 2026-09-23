/* 只读 SQL 查看器（DDL / INSERT 预览） */
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { sql as sqlLang } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'

const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'tok-number' },
  { tag: [tags.lineComment, tags.blockComment], class: 'tok-comment' },
  { tag: [tags.function(tags.variableName), tags.macroName], class: 'tok-func' },
  { tag: tags.operator, class: 'tok-op' },
  { tag: [tags.variableName, tags.propertyName], class: 'tok-id' },
])

export function SqlViewer({ sql, maxHeight = 480 }: { sql: string; maxHeight?: number }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: sql,
      extensions: [
        sqlLang(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        syntaxHighlighting(highlight, { fallback: true }),
        EditorView.theme({
          '&': { height: 'auto', background: 'var(--bg-1)' },
          '.cm-scroller': { overflow: 'auto', maxHeight: `${maxHeight}px`, padding: '4px 0', fontSize: 12.5 },
          '.cm-content': { padding: '6px 0', caretColor: 'transparent' },
          '.cm-line': { padding: '0 12px' },
          '.cm-gutters': { display: 'none' },
          '.cm-activeLine': { background: 'transparent' },
        }),
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    return () => { v.destroy() }
  }, [sql, maxHeight])
  return (
    <div className="sql-viewer">
      <div ref={host} />
    </div>
  )
}
