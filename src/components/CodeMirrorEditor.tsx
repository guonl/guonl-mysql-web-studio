/* CodeMirror 6 SQL 编辑器封装 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle,
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { sql, MySQL } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'

export interface EditorHandle {
  focus(): void
  /** 当前选中文本（未选中返回 undefined） */
  getSelection(): string | undefined
  /** 光标处插入文本 */
  insertText(text: string): void
  getDoc(): string
}

interface Props {
  value: string
  onChange?: (v: string) => void
  /** 表名 → 列名[]，用于自动补全 */
  schemaHint?: Record<string, string[]>
  /** ⌘/Ctrl+Enter 触发 */
  onRun?: () => void
  readOnly?: boolean
  placeholder?: string
}

/* 与 global.css 中 .tok-* 类对应，主题色由 CSS 管理（支持暗/亮切换） */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'tok-number' },
  { tag: [tags.lineComment, tags.blockComment], class: 'tok-comment' },
  { tag: [tags.function(tags.variableName), tags.macroName], class: 'tok-func' },
  { tag: tags.operator, class: 'tok-op' },
  { tag: [tags.variableName, tags.propertyName], class: 'tok-id' },
  { tag: tags.quote, class: 'tok-backtick' },
])

const schemaCpt = new Compartment()
const readOnlyCpt = new Compartment()

export const CodeMirrorEditor = forwardRef<EditorHandle, Props>(function CodeMirrorEditor(
  { value, onChange, schemaHint, onRun, readOnly = false, placeholder },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const cbs = useRef({ onChange, onRun })
  cbs.current = { onChange, onRun }

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ override: undefined }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
          { key: 'Mod-Enter', preventDefault: true, run: () => { cbs.current.onRun?.(); return true } },
        ]),
        schemaCpt.of(sql({ dialect: MySQL, upperCaseKeywords: true, schema: schemaHint ?? {} })),
        readOnlyCpt.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        syntaxHighlighting(highlight, { fallback: true }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbs.current.onChange?.(u.state.doc.toString())
        }),
        placeholder
          ? EditorView.theme({ '&.cm-editor.cm-empty::before': { color: 'var(--text-3)' } })
          : [],
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    return () => { v.destroy(); view.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部 value 变化（切换标签页等）同步进编辑器
  useEffect(() => {
    const v = view.current
    if (!v) return
    if (v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])

  // schema 补全热更新
  useEffect(() => {
    view.current?.dispatch({
      effects: schemaCpt.reconfigure(sql({ dialect: MySQL, upperCaseKeywords: true, schema: schemaHint ?? {} })),
    })
  }, [schemaHint])

  // 只读热切换
  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCpt.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    getSelection: () => {
      const st = view.current?.state
      if (!st) return undefined
      const text = st.sliceDoc(st.selection.main.from, st.selection.main.to)
      return text.trim() ? text : undefined
    },
    insertText: (text: string) => {
      const v = view.current
      if (!v) return
      const { from, to } = v.state.selection.main
      v.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      })
      v.focus()
    },
    getDoc: () => view.current?.state.doc.toString() ?? '',
  }))

  return <div ref={host} className="editor-cm" style={{ position: 'absolute', inset: 0 }} />
})

