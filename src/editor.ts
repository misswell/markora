import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Highlight } from '@tiptap/extension-highlight'
import { Subscript } from '@tiptap/extension-subscript'
import { Superscript } from '@tiptap/extension-superscript'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import Image from '@tiptap/extension-image'
import Mathematics, { migrateMathStrings } from '@tiptap/extension-mathematics'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import type { OutlineItem } from './model'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { authorizeNativeImage } from './native'

export function resolveLocalImagePath(documentPath: string | undefined, source: string) {
  if (!documentPath || !source) return null
  if (/^file:/i.test(source)) {
    try {
      return decodeURIComponent(new URL(source).pathname).replace(/^\/(?:([a-zA-Z]:))/, '$1')
    } catch {
      return null
    }
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) return null
  let decoded: string
  try {
    decoded = decodeURI(source.split(/[?#]/, 1)[0])
  } catch {
    return null
  }
  if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith('/')) return decoded

  const separator = documentPath.includes('\\') ? '\\' : '/'
  const base = documentPath.slice(0, Math.max(documentPath.lastIndexOf('/'), documentPath.lastIndexOf('\\')))
  const prefix = base.startsWith('/') ? '/' : /^[a-zA-Z]:/.exec(base)?.[0] ?? ''
  const parts = `${base}${separator}${decoded}`.split(/[\\/]/)
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.' || part === prefix) continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return prefix === '/' ? `/${normalized.join('/')}` : `${prefix}${prefix ? separator : ''}${normalized.join(separator)}`
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '`': '`', '*': '*', '~': '~', '"': '"', "'": "'", '$': '$' }

const AutoPair = Extension.create({
  name: 'autoPair',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput(view, from, to, text) {
            const { state, dispatch } = view
            const closing = PAIRS[text]
            if (!closing) return false
            if (from !== to) {
              const selectedText = state.doc.textBetween(from, to, '\n')
              if (selectedText) {
                const tr = state.tr.replaceWith(from, to, state.schema.text(text + selectedText + closing))
                tr.setSelection(TextSelection.create(tr.doc, from + 1, from + 1 + selectedText.length))
                dispatch(tr)
                return true
              }
            }
            const tr = state.tr.insertText(text + closing, from)
            tr.setSelection(TextSelection.create(tr.doc, from + 1, from + 1))
            dispatch(tr)
            return true
          },
          handleKeyDown(view, event) {
            const { state, dispatch } = view
            const closing = event.key
            const openFor: Record<string, string> = { ')': '(', ']': '[', '}': '{', '`': '`', '*': '*', '~': '~', '$': '$' }
            const open = openFor[closing]
            if (open && !event.metaKey && !event.ctrlKey) {
              const { from } = state.selection
              if (from === state.selection.to) {
                const before = state.doc.textBetween(from - 1, from, '\n')
                if (before === open) {
                  const tr = state.tr.delete(from, from + 1)
                  tr.setSelection(TextSelection.create(tr.doc, from, from))
                  dispatch(tr)
                  return true
                }
              }
            }
            if (event.key === 'Backspace') {
              const { from } = state.selection
              if (from === state.selection.to && from > 0) {
                const before = state.doc.textBetween(from - 1, from, '\n')
                const after = state.doc.textBetween(from, from + 1, '\n')
                if (PAIRS[before] === after && before) {
                  const tr = state.tr.delete(from - 1, from + 1)
                  dispatch(tr)
                  return true
                }
              }
            }
            return false
          },
        },
      }),
    ]
  },
})

function localImage(documentPath?: string) {
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const image = document.createElement('img')
        let requestedSource = ''
        const render = (attrs: Record<string, unknown>) => {
          const source = String(attrs.src ?? '')
          requestedSource = source
          const localPath = resolveLocalImagePath(documentPath, source)
          image.alt = String(attrs.alt ?? '')
          image.title = String(attrs.title ?? '')
          if (localPath && isTauri()) {
            image.removeAttribute('src')
            void authorizeNativeImage(documentPath!, source).then((authorizedPath) => {
              if (requestedSource === source) image.src = convertFileSrc(authorizedPath)
            }).catch(() => image.removeAttribute('src'))
          } else {
            image.src = source
          }
        }
        render(node.attrs)
        return {
          dom: image,
          update: (updated) => {
            if (updated.type.name !== 'image') return false
            render(updated.attrs)
            return true
          },
        }
      }
    },
  })
}

export function createEditorExtensions(documentPath?: string) {
  const lowlight = createLowlight(common)
  return [
    StarterKit.configure({
      codeBlock: false,
    }),
    CodeBlockLowlight.configure({ lowlight }),
    localImage(documentPath),
    Mathematics.configure({
      katexOptions: { throwOnError: false },
    }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    Highlight,
    Subscript,
    Superscript,
    AutoPair,
  ]
}

export function isEditorUsable(editor: Editor | null | undefined): editor is Editor {
  return Boolean(editor && !editor.isDestroyed)
}

export function getEditorOutline(editor: Editor): OutlineItem[] {
  const items: OutlineItem[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'heading') return
    items.push({
      level: Number(node.attrs.level) || 1,
      text: node.textContent,
      index: items.length,
    })
  })
  return items
}
