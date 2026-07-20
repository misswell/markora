import { Component, type ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import {
  Bold, Braces, Code2, Code, Eye, FilePlus2, Files,
  FileText, Focus, FolderOpen, FolderTree, Heading1, Heading2, Heading3, Import, Info, Italic, Link, List,
  Highlighter, ListOrdered, ListTree, Minus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Palette, Pencil, Printer, Quote, Redo2, RefreshCw, Save, Search, Sigma, Smile, Strikethrough, Subscript, Superscript, Table2, TextCursorInput, Trash2, Undo2, X,
  Settings, Underline,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildFileTree, classifyExternalChange, createNote, displayDate, flattenTree, getOutline, getWordCount, isFileDirty, noteFromFile, titleFromPath, type Note, WELCOME_NOTE } from './model'
import { exportHtmlFile, isDesktop, onMenuAction, onNativeCloseRequested, onNativeDocumentOpened, onToast, openNativeDocument, openNativeWorkspace, openExportInBrowser, quitNativeApp, readExternalDocument, readNativeWorkspaceDocument, refreshNativeWorkspace, revealNativeDocument, saveNativeDocument, startWindowDrag, syncThemeMenu, takeStartupDocuments, type OpenedDocument, type Workspace } from './native'
import { createEditorExtensions, getEditorOutline, isEditorUsable } from './editor'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', color: '#c00', fontSize: 13 }}>
          <h2>页面出错</h2>
          <pre>{String(this.state.error)}</pre>
          <button onClick={() => this.setState({ error: null })}>重试</button>
        </div>
      )
    }
    return this.props.children
  }
}

const STORAGE_KEY = 'typedown.documents.v1'
const ACTIVE_KEY = 'typedown.active.v1'
function loadNotes(): Note[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (!value) return [WELCOME_NOTE]
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length === 0) return [WELCOME_NOTE]
    const notes = parsed.filter((note): note is Note => Boolean(
      note && typeof note === 'object'
      && typeof (note as Note).id === 'string'
      && typeof (note as Note).title === 'string'
      && typeof (note as Note).markdown === 'string'
      && typeof (note as Note).updatedAt === 'number',
    ))
    if (!notes.length) return [WELCOME_NOTE]
    return notes.map((note) => note.id === 'welcome'
      ? { ...note, title: note.title.replaceAll('TypeDown', 'Markora'), markdown: note.markdown.replaceAll('TypeDown', 'Markora') }
      : note)
  } catch {
    return [WELCOME_NOTE]
  }
}

function App() {
  const [notes, setNotes] = useState<Note[]>(loadNotes)
  const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_KEY) ?? 'welcome')
  const [sidebar, setSidebar] = useState(true)
  const [focusMode, setFocusMode] = useState(false)
  const [typewriterMode, setTypewriterMode] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'workspace' | 'outline'>('files')
  const [sourceMode, setSourceMode] = useState(false)
  const [search, setSearch] = useState('')
  const [findReplace, setFindReplace] = useState<{ visible: boolean; query: string; replacement: string; caseSensitive: boolean }>({ visible: false, query: '', replacement: '', caseSensitive: false })
  const [theme, setTheme] = useState(() => localStorage.getItem('typedown.theme') ?? 'auto')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [emojiPicker, setEmojiPicker] = useState(false)
  const [saved, setSaved] = useState(true)
  const [message, setMessage] = useState('')
  const [richOutline, setRichOutline] = useState<ReturnType<typeof getOutline>>([])
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [externalConflicts, setExternalConflicts] = useState<Set<string>>(() => new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null)
  const active = notes.find((note) => note.id === activeId) ?? notes[0]
  const notesRef = useRef(notes)
  const menuHandlerRef = useRef<(id: string) => void>(() => {})

  useEffect(() => { notesRef.current = notes }, [notes])

  const [quickOpen, setQuickOpen] = useState(false)
  const [quickOpenQuery, setQuickOpenQuery] = useState('')
  const [quickOpenIndex, setQuickOpenIndex] = useState(0)
 const [zoom, setZoom] = useState(() => parseFloat(localStorage.getItem('typedown.zoom') ?? '1') || 1)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false)
  const [moreMenu, setMoreMenu] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
 const [fontFamily, setFontFamily] = useState(() => localStorage.getItem('typedown.fontFamily') ?? 'serif')
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('typedown.fontSize') ?? '16', 10) || 16)
 const [lineHeight, setLineHeight] = useState(() => parseFloat(localStorage.getItem('typedown.lineHeight') ?? '1.85') || 1.85)
  const [letterSpacing, setLetterSpacing] = useState(() => parseFloat(localStorage.getItem('typedown.letterSpacing') ?? '0') || 0)

  const FONT_FAMILIES: Record<string, string> = {
    serif: "'Noto Serif SC', Georgia, serif",
    sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, 'PingFang SC', sans-serif",
    mono: "'DM Mono', 'SFMono-Regular', Menlo, monospace",
  }

  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-family', FONT_FAMILIES[fontFamily] ?? FONT_FAMILIES.serif)
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`)
    document.documentElement.style.setProperty('--editor-line-height', String(lineHeight))
    document.documentElement.style.setProperty('--editor-letter-spacing', letterSpacing ? `${letterSpacing}px` : 'normal')
    localStorage.setItem('typedown.fontFamily', fontFamily)
    localStorage.setItem('typedown.fontSize', String(fontSize))
    localStorage.setItem('typedown.lineHeight', String(lineHeight))
    localStorage.setItem('typedown.letterSpacing', String(letterSpacing))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontFamily, fontSize, lineHeight, letterSpacing])

  useEffect(() => { setQuickOpenIndex(0) }, [quickOpenQuery])
  useEffect(() => { setEditingTitle(false) }, [activeId])

  useEffect(() => {
    document.documentElement.style.setProperty('--zoom', String(zoom))
    localStorage.setItem('typedown.zoom', String(zoom))
  }, [zoom])

  const quickOpenItems = useMemo(() => {
    const q = quickOpenQuery.toLowerCase()
    const fromNotes = notes.map((n) => ({ id: n.id, title: n.title, type: 'note' as const }))
    const fromWorkspace = workspace?.files.map((f) => ({ id: f.path, title: f.title, type: 'file' as const, path: f.path })) ?? []
    return [...fromNotes, ...fromWorkspace]
      .filter((item) => item.title.toLowerCase().includes(q))
      .slice(0, 12)
  }, [notes, workspace, quickOpenQuery])

  const updateActive = useCallback((patch: Partial<Note>) => {
    setSaved(false)
    setNotes((current) => current.map((note) => note.id === active?.id
      ? { ...note, ...patch, updatedAt: Date.now() }
      : note))
  }, [active?.id])

  const extensions = useMemo(() => createEditorExtensions(active?.filePath), [active?.filePath])
  const editor = useEditor({
    extensions,
    content: active?.markdown ?? '',
    contentType: 'markdown',
    editorProps: {
      attributes: { class: 'rich-editor', spellcheck: 'true' },
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Tab') return false
        const editor = editorRef.current
        if (!isEditorUsable(editor)) return false
        event.preventDefault()
        const listType = editor.isActive('taskItem') ? 'taskItem' : 'listItem'
        if (event.shiftKey) {
          return editor.chain().focus().liftListItem(listType).run()
        }
        return editor.chain().focus().sinkListItem(listType).run()
      },
    },
    onCreate: ({ editor }) => setRichOutline(getEditorOutline(editor)),
    onUpdate: ({ editor }) => {
      if (!editor.isEditable) return
      setRichOutline(getEditorOutline(editor))
      updateActive({ markdown: editor.getMarkdown() })
    },
    immediatelyRender: false,
  }, [active?.filePath])

  useEffect(() => { editorRef.current = editor }, [editor])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
      localStorage.setItem(ACTIVE_KEY, activeId)
      setSaved(true)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [notes, activeId])

  useEffect(() => {
    if (!isEditorUsable(editor) || !active || sourceMode) return
    if (editor.getMarkdown() !== active.markdown) {
      editor.commands.setContent(active.markdown, { contentType: 'markdown', emitUpdate: false })
      setRichOutline(getEditorOutline(editor))
    }
  }, [active?.markdown, editor, sourceMode])

  const filteredNotes = useMemo(() => notes
    .filter((note) => note.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt), [notes, search])
  const filteredWorkspaceFiles = useMemo(() => workspace?.files.filter((file) =>
    (file.relativePath ?? '').toLowerCase().includes(search.toLowerCase())) ?? [], [search, workspace])
  const workspaceTree = useMemo(() => buildFileTree(filteredWorkspaceFiles), [filteredWorkspaceFiles])
  const flattenedTree = useMemo(() => flattenTree(workspaceTree), [workspaceTree])
  const outline = useMemo(() => (sourceMode ? getOutline(active?.markdown ?? '') : richOutline)
    .filter((item) => item.text.toLowerCase().includes(search.toLowerCase())), [active?.markdown, richOutline, search, sourceMode])

  useEffect(() => {
    if (!isEditorUsable(editor)) return
    function syncActiveBlock() {
      if (!isEditorUsable(editor)) return
      editor.view.dom.querySelectorAll('.active-block').forEach((node) => node.classList.remove('active-block'))
      const dom = editor.view.domAtPos(editor.state.selection.anchor).node
      const element = (dom.nodeType === Node.TEXT_NODE ? dom.parentElement : dom) as HTMLElement | null
      const block = element?.closest('p,h1,h2,h3,h4,h5,h6,blockquote,pre,li')
      block?.classList.add('active-block')
      if (typewriterMode) block?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    editor.on('selectionUpdate', syncActiveBlock)
    editor.on('update', syncActiveBlock)
    syncActiveBlock()
    return () => {
      editor.off('selectionUpdate', syncActiveBlock)
      editor.off('update', syncActiveBlock)
    }
  }, [editor, typewriterMode])

  function jumpToHeading(index: number) {
    if (!isEditorUsable(editor)) return
    const heading = editor.view.dom.querySelectorAll('h1,h2,h3,h4,h5,h6').item(index)
    heading?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function addNote() {
    const note = createNote(notes.length + 1)
    setNotes((current) => [...current, note])
    setActiveId(note.id)
    setSourceMode(false)
  }

  function acceptOpenedDocument(opened: OpenedDocument) {
    const current = notesRef.current
    const existing = current.find((note) => note.filePath === opened.path)
    if (existing) {
      if (isFileDirty(existing) && !window.confirm(`“${existing.title}”有未保存修改。要放弃修改并从磁盘重新载入吗？`)) {
        setActiveId(existing.id)
        return false
      }
      const next = current.map((note) => note.id === existing.id
        ? { ...note, title: opened.title, markdown: opened.contents, diskMarkdown: opened.contents, updatedAt: Date.now() }
        : note)
      notesRef.current = next
      setNotes(next)
      setActiveId(existing.id)
    } else {
      const note = noteFromFile(opened.path, opened.title, opened.contents)
      const next = [...current, note]
      notesRef.current = next
      setNotes(next)
      setActiveId(note.id)
    }
    setSourceMode(false)
    setExternalConflicts((current) => {
      if (!current.has(opened.path)) return current
      const next = new Set(current)
      next.delete(opened.path)
      return next
    })
    setMessage('已打开文件')
    return true
  }

  function removeNote(id: string) {
    if (notes.length === 1) return
    const target = notes.find((note) => note.id === id)
    if (!target) return
    const warning = isFileDirty(target)
      ? `“${target.title}”有尚未写入磁盘的修改，仍要从文稿库移除吗？`
      : `要从文稿库移除“${target.title}”吗？磁盘文件不会被删除。`
    if (!window.confirm(warning)) return
    const next = notes.filter((note) => note.id !== id)
    setNotes(next)
    if (activeId === id) setActiveId(next[0].id)
  }

  function format(command: string, value?: string) {
    if (!isEditorUsable(editor)) return
    const chain = editor.chain().focus()
    if (command === 'undo') chain.undo().run()
    else if (command === 'redo') chain.redo().run()
    else if (command === 'formatBlock' && value === 'h1') chain.toggleHeading({ level: 1 }).run()
    else if (command === 'formatBlock' && value === 'h2') chain.toggleHeading({ level: 2 }).run()
    else if (command === 'formatBlock' && value === 'h3') chain.toggleHeading({ level: 3 }).run()
    else if (command === 'formatBlock' && value === 'blockquote') chain.toggleBlockquote().run()
    else if (command === 'formatBlock' && value === 'pre') chain.toggleCodeBlock().run()
    else if (command === 'bold') chain.toggleBold().run()
    else if (command === 'italic') chain.toggleItalic().run()
    else if (command === 'strikeThrough') chain.toggleStrike().run()
    else if (command === 'insertUnorderedList') chain.toggleBulletList().run()
    else if (command === 'insertOrderedList') chain.toggleOrderedList().run()
  }

  function addLink() {
    if (!isEditorUsable(editor)) return
    const previous = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('链接地址', previous ?? 'https://')
    if (url === null) return
    if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  function downloadNote() {
    if (!active) return
    const blob = new Blob([active.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${active.title.replace(/[\\/:*?"<>|]/g, '-')}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function openDocument() {
    if (!isDesktop()) {
      fileInputRef.current?.click()
      return
    }
    try {
      const opened = await openNativeDocument()
      if (!opened) return
      acceptOpenedDocument(opened)
    } catch (error) {
      setMessage(`打开失败：${String(error)}`)
    }
  }

  async function chooseWorkspace() {
    if (!isDesktop()) {
      setMessage('文件夹工作区仅在桌面应用中可用')
      return
    }
    try {
      const selected = await openNativeWorkspace()
      if (!selected) return
      setWorkspace(selected)
      setSidebarTab('workspace')
      setSearch('')
      setMessage(`已打开工作区“${selected.name}”`)
    } catch (error) {
      setMessage(`打开文件夹失败：${String(error)}`)
    }
  }

  async function refreshWorkspace() {
    if (!workspace) return
    try {
      setWorkspace(await refreshNativeWorkspace(workspace.root))
      setMessage('工作区已刷新')
    } catch (error) {
      setMessage(`刷新失败：${String(error)}`)
    }
  }

  async function openWorkspaceFile(path: string) {
    try {
      acceptOpenedDocument(await readNativeWorkspaceDocument(path))
    } catch (error) {
      setMessage(`读取文稿失败：${String(error)}`)
    }
  }

  async function saveDocument(saveAs = false) {
    if (!active) return
    if (!isDesktop()) {
      downloadNote()
      return
    }
    let force = false
    if (!saveAs && active.filePath && externalConflicts.has(active.filePath)) {
      if (!window.confirm('磁盘版本在你编辑期间发生了变化，或文件已被移动/删除。继续保存会覆盖或重建它，确定吗？')) return
      force = true
    }
    try {
      const previousPath = active.filePath
      let path: string | null
      try {
        path = await saveNativeDocument(
          saveAs ? undefined : active.filePath,
          active.title,
          active.markdown,
          saveAs ? undefined : active.diskMarkdown,
          force,
        )
      } catch (error) {
        if (saveAs || !active.filePath || !String(error).includes('EXTERNAL_DOCUMENT_CHANGED')) throw error
        setExternalConflicts((current) => new Set(current).add(active.filePath!))
        if (!window.confirm('文件刚刚被其他程序修改、移动或删除。仍要用当前内容覆盖或重建它吗？')) return
        path = await saveNativeDocument(active.filePath, active.title, active.markdown, active.diskMarkdown, true)
      }
      if (!path) return
      updateActive({ filePath: path, title: titleFromPath(path), diskMarkdown: active.markdown })
      setExternalConflicts((current) => {
        const next = new Set(current)
        if (previousPath) next.delete(previousPath)
        next.delete(path!)
        return next
      })
      setMessage(saveAs ? '副本已保存' : '文件已保存')
    } catch (error) {
      setMessage(`保存失败：${String(error)}`)
    }
  }

  function importNote(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const note: Note = {
        id: crypto.randomUUID(),
        title: file.name.replace(/\.md$/i, ''),
        markdown: String(reader.result),
        updatedAt: Date.now(),
      }
      setNotes((current) => [...current, note])
      setActiveId(note.id)
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  function exportPdf() {
    if (!active) return
    const html = renderMarkdownToHtml(active.markdown)
    const document_ = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${active.title}</title><style>body{max-width:780px;margin:40px auto;padding:0 24px;font-family:"Noto Serif SC",Georgia,serif;font-size:16px;line-height:1.85;color:#333}h1{font-size:2em;border-bottom:1px solid #eee;padding-bottom:.3em}h2{font-size:1.4em;border-bottom:1px solid #eee;padding-bottom:.25em}a{color:#b65b3e}blockquote{border-left:4px solid #b65b3e;padding-left:1.2em;color:#666;font-style:italic}code{background:#f6f6f6;padding:.2em .4em;border-radius:3px;color:#c7254e;font-family:"DM Mono",monospace;font-size:.85em}pre{background:#0d1117;color:#e6edf3;border-radius:6px;padding:16px;overflow:auto}img{max-width:100%}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:.5em .7em}th{background:#f7f7f7}mark{background:#fffd72;padding:.1em .2em;border-radius:2px}sub,sup{font-size:.75em}</style></head><body>${html}</body></html>`
    void openExportInBrowser(active.title || '未命名文稿', document_).then(
      () => setMessage('已在浏览器中打开，可在浏览器中选择“打印 → 另存为 PDF”'),
      (error) => setMessage(`导出失败：${String(error)}`),
    )
  }

  function exportHtml() {
    if (!active) return
    const html = renderMarkdownToHtml(active.markdown)
    const full = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${active.title}</title>
<style>
body { max-width: 780px; margin: 40px auto; padding: 0 24px; font-family: "Noto Serif SC", Georgia, serif; font-size: 17px; line-height: 1.9; color: #333; }
h1 { font-size: 2.1em; } h2 { font-size: 1.45em; } h3 { font-size: 1.15em; }
a { color: #b65b3e; } blockquote { border-left: 3px solid #d7a28f; margin-left: 0; padding-left: 1.2em; color: #777; }
code { background: #f0ede8; padding: .15em .35em; border-radius: 3px; font-family: "DM Mono", monospace; font-size: .85em; }
pre { background: #2e2c2a; color: #eee; border-radius: 8px; padding: 16px; overflow: auto; }
pre code { background: none; } img { max-width: 100%; } table { border-collapse: collapse; } th, td { border: 1px solid #ddd; padding: .5em .7em; }
</style>
</head>
<body>
${html}
</body>
</html>`
    void exportHtmlFile(active.title || '未命名文稿', full).then(
      (path) => path && setMessage(`已导出：${path.split('/').pop()}`),
      (error) => setMessage(`导出失败：${String(error)}`),
    )
  }

  function renderMarkdownToHtml(markdown: string): string {
    let html = markdown
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')
    html = html.replace(/==(.+?)==/g, '<mark>$1</mark>')
    html = html.replace(/~(.+?)~/g, '<sub>$1</sub>')
    html = html.replace(/\^(.+?)\^/g, '<sup>$1</sup>')
    html = html.replace(/&lt;u&gt;(.+?)&lt;\/u&gt;/g, '<u>$1</u>')
    html = html.replace(/^(- \[x\] .+)$/gm, '<li><input type="checkbox" checked disabled> $1</li>')
    html = html.replace(/^(- \[ \] .+)$/gm, '<li><input type="checkbox" disabled> $1</li>')
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    html = html.replace(/^---$/gm, '<hr>')
    const lines = html.split('\n')
    let inList = false
    let result: string[] = []
    for (const line of lines) {
      const isLi = line.startsWith('<li>')
      if (isLi && !inList) { result.push('<ul>'); inList = true }
      if (!isLi && inList) { result.push('</ul>'); inList = false }
      result.push(line)
    }
    if (inList) result.push('</ul>')
    return result.join('\n').replace(/<li>(- \[x\] |- \[ \] )/g, '<li>')
  }

  function insertTable() {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  }

  function insertHorizontalRule() {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().setHorizontalRule().run()
  }

  function insertInlineCode() {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().toggleCode().run()
  }

  function toggleHighlight() {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().toggleHighlight().run()
  }

  function toggleSubscript() {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().toggleSubscript().run()
  }

  function toggleSuperscript() {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().toggleSuperscript().run()
  }

  function clearFormat() {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().unsetAllMarks().clearNodes().setParagraph().run()
  }

  function insertMath() {
    if (!isEditorUsable(editor)) return
    const latex = window.prompt('LaTeX 公式', 'E = mc^2')
    if (latex === null || !latex) return
    editor.chain().focus().insertBlockMath({ latex }).run()
  }

  function insertImageDialog() {
    imageInputRef.current?.click()
  }

  function insertImageFromFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !editor) return
    const reader = new FileReader()
    reader.onload = () => {
      const currentEditor = editorRef.current
      if (isEditorUsable(currentEditor)) currentEditor.chain().focus().setImage({ src: String(reader.result), alt: file.name }).run()
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  function insertEmoji(emoji: string) {
    if (!isEditorUsable(editor)) return
    editor.chain().focus().insertContent(emoji).run()
    setEmojiPicker(false)
  }

  const EMOJIS = ['😀','😎','🤔','👍','👏','🙏','💪','🎉','🔥','✨','📚','✏️','📝','💡','⚠️','✅','❌','❤️','🧠','🚀','⭐','📝','📌','🏷️','🎯','🔧','⚙️','📊','📈','💡','🔍','📋','💻','🖥️','⌨️','🖱️','🗑️','📁','📂','🔗','📎','✂️','📋','📌','📍','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤']

  function applyTheme(next: string) {
    setTheme(next)
    localStorage.setItem('typedown.theme', next)
  }

  function closeContextMenu() { setContextMenu(null) }

  function handleTitlebarDrag(event: React.MouseEvent) {
    if (event.button !== 0) return
    const target = event.target as Element
    if (target?.closest?.('button, input, textarea, select, a, [contenteditable="true"], .more-menu, .settings-panel')) return
    void startWindowDrag()
  }

  function handleContextMenu(event: React.MouseEvent) {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY })
  }

  function pasteImage(event: React.ClipboardEvent) {
    const items = event.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        event.preventDefault()
        const file = item.getAsFile()
        if (!file || !editor) return
        const reader = new FileReader()
        reader.onload = () => {
          const currentEditor = editorRef.current
          if (isEditorUsable(currentEditor)) currentEditor.chain().focus().setImage({ src: String(reader.result) }).run()
        }
        reader.readAsDataURL(file)
        return
      }
    }
  }

  function handleDrop(event: React.DragEvent) {
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        event.preventDefault()
        if (!isEditorUsable(editor)) return
        const reader = new FileReader()
        reader.onload = () => {
          const currentEditor = editorRef.current
          if (isEditorUsable(currentEditor)) currentEditor.chain().focus().setImage({ src: String(reader.result) }).run()
        }
        reader.readAsDataURL(file)
        return
      }
    }
  }

  function findInDocument() {
    if (!editor || !findReplace.query) return
    const doc = editor.state.doc
    let found = false
    doc.descendants((node, pos) => {
      if (found) return false
      if (node.isText) {
        const text = node.text || ''
        const searchStr = findReplace.caseSensitive ? text : text.toLowerCase()
        const queryStr = findReplace.caseSensitive ? findReplace.query : findReplace.query.toLowerCase()
        const idx = searchStr.indexOf(queryStr)
        if (idx >= 0) {
          editor.chain().focus().setTextSelection({ from: pos + idx, to: pos + idx + findReplace.query.length }).run()
          found = true
          return false
        }
      }
      return true
    })
    if (found) {
      const dom = editor.view.domAtPos(editor.state.selection.from).node
      const el = (dom.nodeType === Node.TEXT_NODE ? dom.parentElement : dom) as HTMLElement | null
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else {
      setMessage('未找到匹配内容')
    }
  }

  function replaceInDocument() {
    if (!editor || !findReplace.query) return
    const { selection } = editor.state
    if (selection && !selection.empty) {
      const selected = editor.state.doc.textBetween(selection.from, selection.to, '\n')
      const searchStr = findReplace.caseSensitive ? selected : selected.toLowerCase()
      const queryStr = findReplace.caseSensitive ? findReplace.query : findReplace.query.toLowerCase()
      if (searchStr === queryStr) {
        editor.chain().focus().insertContent(findReplace.replacement).run()
      }
    }
    findInDocument()
  }

  function replaceAllInDocument() {
    if (!editor || !findReplace.query) return
    const markdown = editor.getMarkdown()
    const flags = findReplace.caseSensitive ? 'g' : 'gi'
    const escaped = findReplace.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const replaced = markdown.replace(new RegExp(escaped, flags), findReplace.replacement)
    if (replaced !== markdown) {
      editor.commands.setContent(replaced, { contentType: 'markdown' })
      setMessage('已替换全部匹配')
    }
  }

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveDocument(event.shiftKey)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        addNote()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openDocument()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault()
        setFindReplace((prev) => ({ ...prev, visible: true }))
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'h') {
        event.preventDefault()
        setFindReplace((prev) => ({ ...prev, visible: true }))
      }
      if (event.key === 'Escape' && findReplace.visible) {
        setFindReplace((prev) => ({ ...prev, visible: false }))
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '1') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 1 }).run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '2') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 2 }).run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '3') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 3 }).run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '4') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 4 }).run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '5') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 5 }).run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '6') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 6 }).run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '0') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().setParagraph().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'b' && !event.shiftKey) {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleBold().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'i' && !event.shiftKey) {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleItalic().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u' && !event.shiftKey) {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleUnderline().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'S') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleStrike().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === '8' || event.key === '*')) {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleBulletList().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === '9' || event.key === '(')) {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleOrderedList().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleTaskList().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'c') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleCodeBlock().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '`') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleCode().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault()
        setSourceMode((value) => !value)
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'j') {
        event.preventDefault()
        void exportHtml()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault()
        addLink()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setQuickOpen(true)
        setQuickOpenQuery('')
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't' && !event.shiftKey) {
        event.preventDefault()
        insertTable()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        insertMath()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'i') {
        event.preventDefault()
        insertImageDialog()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault()
        toggleHighlight()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().toggleCodeBlock().run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ']') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().sinkListItem('listItem').run()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '[') {
        event.preventDefault()
        if (isEditorUsable(editor)) editor.chain().focus().liftListItem('listItem').run()
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSidebar((v) => !v)
      }
      if (event.key === 'F8') {
        event.preventDefault()
        setFocusMode((v) => !v)
      }
      if (event.key === 'F9') {
        event.preventDefault()
        setTypewriterMode((v) => !v)
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '=') {
        event.preventDefault()
        setZoom((z) => Math.min(z + 0.1, 2))
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '-') {
        event.preventDefault()
        setZoom((z) => Math.max(z - 0.1, 0.5))
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault()
        setZoom(1)
      }
      if (event.key === 'Escape' && quickOpen) {
        setQuickOpen(false)
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  })

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!contextMenu) return
    function close() { setContextMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
 }, [contextMenu])

  useEffect(() => {
    if (!moreMenu) return
    function close(event: MouseEvent) {
      const target = event.target as Element | null
      if (target && !target.closest?.('.more-wrap')) setMoreMenu(false)
    }
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') setMoreMenu(false) }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [moreMenu])

 const fileDirty = active ? isFileDirty(active) : false
  const hasDirtyFiles = notes.some(isFileDirty)
  const desktop = isDesktop()

  useEffect(() => {
    function preventAccidentalClose(event: BeforeUnloadEvent) {
      if (!hasDirtyFiles) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', preventAccidentalClose)
    return () => window.removeEventListener('beforeunload', preventAccidentalClose)
  }, [hasDirtyFiles])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 2800)
    return () => window.clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (!isDesktop()) return
    let disposed = false
    let stopListening: (() => void) | undefined
    let stopCloseListener: (() => void) | undefined
    void onNativeDocumentOpened((document) => acceptOpenedDocument(document)).then((unlisten) => {
      if (disposed) unlisten()
      else stopListening = unlisten
    })
    void takeStartupDocuments().then((documents) => {
      if (!disposed) documents.forEach(acceptOpenedDocument)
    })
    void onNativeCloseRequested(() => {
      if (!notesRef.current.some(isFileDirty)) return true
      setCloseConfirmationOpen(true)
      return false
    }).then((unlisten) => {
      if (disposed) unlisten()
      else stopCloseListener = unlisten
    })
    return () => {
      disposed = true
      stopListening?.()
      stopCloseListener?.()
    }
  }, [])

  menuHandlerRef.current = (id: string) => {
    switch (id) {
      case 'settings': setSettingsOpen(true); break
      case 'quit':
        if (notesRef.current.some(isFileDirty)) setCloseConfirmationOpen(true)
        else void quitNativeApp()
        break
      case 'new': addNote(); break
      case 'open': void openDocument(); break
      case 'save': void saveDocument(false); break
      case 'save_as': void saveDocument(true); break
      case 'import': fileInputRef.current?.click(); break
      case 'export_html': exportHtml(); break
      case 'export_pdf': exportPdf(); break
      case 'open_workspace': void chooseWorkspace(); break
      case 'reveal':
        if (active?.filePath) void revealNativeDocument(active.filePath)
        else setMessage('当前文稿未保存到磁盘')
        break
      case 'undo': if (isEditorUsable(editor)) editor.chain().focus().undo().run(); break
      case 'redo': if (isEditorUsable(editor)) editor.chain().focus().redo().run(); break
      case 'find': setFindReplace((p) => ({ ...p, visible: true })); break
      case 'replace': setFindReplace((p) => ({ ...p, visible: true })); break
      case 'clear_format': clearFormat(); break
      case 'h1': if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 1 }).run(); break
      case 'h2': if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 2 }).run(); break
      case 'h3': if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 3 }).run(); break
      case 'h4': if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 4 }).run(); break
      case 'h5': if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 5 }).run(); break
      case 'h6': if (isEditorUsable(editor)) editor.chain().focus().toggleHeading({ level: 6 }).run(); break
      case 'paragraph': if (isEditorUsable(editor)) editor.chain().focus().setParagraph().run(); break
      case 'blockquote': if (isEditorUsable(editor)) editor.chain().focus().toggleBlockquote().run(); break
      case 'codeblock': if (isEditorUsable(editor)) editor.chain().focus().toggleCodeBlock().run(); break
      case 'bullet_list': if (isEditorUsable(editor)) editor.chain().focus().toggleBulletList().run(); break
      case 'ordered_list': if (isEditorUsable(editor)) editor.chain().focus().toggleOrderedList().run(); break
      case 'task_list': if (isEditorUsable(editor)) editor.chain().focus().toggleTaskList().run(); break
      case 'hr': insertHorizontalRule(); break
      case 'table': insertTable(); break
      case 'math': insertMath(); break
      case 'bold': if (isEditorUsable(editor)) editor.chain().focus().toggleBold().run(); break
      case 'italic': if (isEditorUsable(editor)) editor.chain().focus().toggleItalic().run(); break
      case 'underline': if (isEditorUsable(editor)) editor.chain().focus().toggleUnderline().run(); break
      case 'strike': if (isEditorUsable(editor)) editor.chain().focus().toggleStrike().run(); break
      case 'code': insertInlineCode(); break
      case 'highlight': toggleHighlight(); break
      case 'superscript': toggleSuperscript(); break
      case 'subscript': toggleSubscript(); break
      case 'link': addLink(); break
      case 'image': insertImageDialog(); break
      case 'emoji': setEmojiPicker((v) => !v); break
      case 'focus': setFocusMode((v) => !v); break
      case 'typewriter': setTypewriterMode((v) => !v); break
      case 'source': setSourceMode((v) => !v); break
      case 'sidebar': setSidebar((v) => !v); break
      case 'outline': setSidebarTab('outline'); setSidebar(true); break
      case 'files': setSidebarTab('files'); setSidebar(true); break
      case 'workspace': setSidebarTab('workspace'); setSidebar(true); break
      case 'zoom_in': setZoom((z) => Math.min(+(z + 0.1).toFixed(1), 2)); break
      case 'zoom_out': setZoom((z) => Math.max(+(z - 0.1).toFixed(1), 0.5)); break
      case 'zoom_reset': setZoom(1); break
      case 'help': setMessage('Markora - 宁静的本地优先 Markdown 编辑器'); break
      case 'about': setMessage('Markora - 宁静的本地优先 Markdown 编辑器'); break
      default:
        if (id.startsWith('theme:')) applyTheme(id.slice(6))
    }
  }

  useEffect(() => {
    if (!isDesktop()) return
    let disposed = false
    let stopMenu: (() => void) | undefined
    let stopToast: (() => void) | undefined
    void onMenuAction((id) => menuHandlerRef.current(id)).then((unlisten) => {
      if (disposed) unlisten()
      else stopMenu = unlisten
    })
    void onToast((message) => setMessage(message)).then((unlisten) => {
      if (disposed) unlisten()
      else stopToast = unlisten
    })
    return () => {
      disposed = true
      stopMenu?.()
      stopToast?.()
    }
  }, [])

  useEffect(() => {
    if (!isDesktop()) return
    void syncThemeMenu(theme)
  }, [theme])

  useEffect(() => {
    if (!isDesktop() || !active?.filePath) return
    const path = active.filePath
    let disposed = false
    let checking = false
    let reportedReadFailure = false
    async function checkDisk() {
      if (checking) return
      checking = true
      try {
        const diskMarkdown = await readExternalDocument(path)
        if (disposed) return
        reportedReadFailure = false
        const note = notesRef.current.find((candidate) => candidate.filePath === path)
        if (!note) return
        const change = classifyExternalChange(note, diskMarkdown)
        if (change === 'reload') {
          // 本地未编辑但磁盘已被外部程序改动：询问是重新加载还是用当前内容覆盖磁盘
          const confirmed = window.confirm(
            '检测到该文件已被其他程序修改。\n\n' +
            '• 点击「确定」：重新加载磁盘上的最新内容（替换当前查看内容）\n' +
            '• 点击「取消」：保留当前内容并覆盖磁盘文件（撤销外部修改）',
          )
          if (disposed) return
          if (confirmed) {
            const next = notesRef.current.map((candidate) => candidate.filePath === path
              ? { ...candidate, markdown: diskMarkdown, diskMarkdown, updatedAt: Date.now() }
              : candidate)
            notesRef.current = next
            setNotes(next)
            setExternalConflicts((current) => {
              const updated = new Set(current)
              updated.delete(path)
              return updated
            })
            setMessage('已载入磁盘上的最新修改')
          } else {
            try {
              const savedPath = await saveNativeDocument(
                path,
                note.title,
                note.markdown,
                note.diskMarkdown,
                true,
              )
              if (disposed) return
              if (savedPath) {
                const next = notesRef.current.map((candidate) => candidate.filePath === path
                  ? { ...candidate, diskMarkdown: note.markdown, updatedAt: Date.now() }
                  : candidate)
                notesRef.current = next
                setNotes(next)
                setExternalConflicts((current) => {
                  const updated = new Set(current)
                  updated.delete(path)
                  return updated
                })
                setMessage('已用当前内容覆盖磁盘文件')
              }
            } catch (error) {
              if (!disposed) setMessage(`覆盖失败：${String(error)}`)
            }
          }
        } else if (change === 'conflict') {
          setExternalConflicts((current) => current.has(path) ? current : new Set(current).add(path))
        } else {
          setExternalConflicts((current) => {
            if (!current.has(path)) return current
            const updated = new Set(current)
            updated.delete(path)
            return updated
          })
        }
      } catch {
        if (disposed) return
        setExternalConflicts((current) => current.has(path) ? current : new Set(current).add(path))
        if (!reportedReadFailure) {
          reportedReadFailure = true
          setMessage('文件已被移动、删除或暂时无法读取；保存前将再次确认')
        }
      } finally {
        checking = false
      }
    }
    const timer = window.setInterval(() => void checkDisk(), 2500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [active?.filePath])

  if (!active) return null

  const words = getWordCount(active.markdown)
  const externalConflict = Boolean(active.filePath && externalConflicts.has(active.filePath))
  const saveLabel = externalConflict ? '磁盘与本地均有修改' : fileDirty ? '有未保存修改' : active.filePath ? '文件已保存' : saved ? '已存入文稿库' : '正在保存…'

  return (
    <div className={`app ${focusMode ? 'is-focus' : ''} ${desktop ? 'is-desktop' : ''}`}>
      <header className="titlebar" data-tauri-drag-region onMouseDown={handleTitlebarDrag}>
        <div className="traffic-lights" aria-hidden="true" data-tauri-drag-region><i /><i /><i /></div>
        <div className="document-title" data-tauri-drag-region>
          {editingTitle && !active.filePath ? (
            <input
              value={active.title}
              onChange={(event) => updateActive({ title: event.target.value })}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
              }}
              title="文稿标题"
              aria-label="文稿标题"
              autoFocus
            />
          ) : (
            <div className="document-title-line" data-tauri-drag-region>
              <strong data-tauri-drag-region title={active.filePath ?? active.title}>{active.title || '未命名文稿'}</strong>
              {!active.filePath && <button className="rename-document" title="重命名文稿" onClick={() => setEditingTitle(true)}><Pencil /></button>}
            </div>
          )}
          <span data-tauri-drag-region>{saveLabel}</span>
        </div>
        <div className="window-actions" data-tauri-drag-region>
          <button title="专注模式" onClick={() => setFocusMode((value) => !value)} className={focusMode ? 'active' : ''}><Focus /></button>
          <button title="主题" onClick={() => {
            const themes = ['auto', 'github', 'newsprint', 'night', 'pixyll']
            const idx = themes.indexOf(theme)
            applyTheme(themes[(idx + 1) % themes.length])
            setMessage(`主题：${themes[(idx + 1) % themes.length]}`)
         }}><Palette /></button>
          <div className="more-wrap">
            <button title="更多" onClick={() => setMoreMenu((v) => !v)} className={moreMenu ? 'active' : ''}><MoreHorizontal /></button>
            {moreMenu && (
              <div className="more-menu" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { setSettingsOpen(true); setMoreMenu(false) }}><Settings />偏好设置…</button>
                <button onClick={() => {
                  const themes = ['auto', 'github', 'newsprint', 'night', 'pixyll']
                  const idx = themes.indexOf(theme)
                  applyTheme(themes[(idx + 1) % themes.length])
                  setMessage(`主题：${themes[(idx + 1) % themes.length]}`)
                  setMoreMenu(false)
                }}><Palette />切换主题</button>
                <button onClick={() => { setFocusMode((v) => !v); setMoreMenu(false) }}><Focus />{focusMode ? '退出专注' : '专注模式'}</button>
                <button onClick={() => { setTypewriterMode((v) => !v); setMoreMenu(false) }}><TextCursorInput />打字机模式</button>
                <button onClick={() => { setSourceMode((v) => !v); setMoreMenu(false) }}>{sourceMode ? <Eye /> : <Braces />}{sourceMode ? '退出源码' : '源码模式'}</button>
                <div className="more-separator" />
                <button onClick={() => void openDocument()}><FolderOpen />打开文件</button>
                <button onClick={() => void saveDocument()}><Save />保存</button>
                <button onClick={exportHtml}><Braces />导出 HTML</button>
                <button onClick={exportPdf}><Printer />导出 PDF</button>
                <div className="more-separator" />
                <button onClick={() => { setMessage('Markora — 宁静的本地优先 Markdown 编辑器'); setMoreMenu(false) }}><Info />关于 Markora</button>
              </div>
            )}
          </div>
         </div>
        </header>

      <aside className={`sidebar ${sidebar ? '' : 'closed'}`}>
        <div className="sidebar-top">
          <div className="sidebar-tabs">
            <button className={sidebarTab === 'files' ? 'active' : ''} onClick={() => setSidebarTab('files')}><Files />文稿</button>
            <button className={sidebarTab === 'workspace' ? 'active' : ''} onClick={() => workspace ? setSidebarTab('workspace') : void chooseWorkspace()}><FolderTree />文件夹</button>
            <button className={sidebarTab === 'outline' ? 'active' : ''} onClick={() => setSidebarTab('outline')}><ListTree />大纲</button>
          </div>
          <button title="新建文稿" onClick={addNote}><FilePlus2 /></button>
        </div>
        <label className="search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={sidebarTab === 'files' ? '搜索文稿' : sidebarTab === 'workspace' ? '搜索工作区' : '筛选标题'} />{search && <button onClick={() => setSearch('')}><X /></button>}</label>
        {sidebarTab === 'files' ? <div className="note-list">
          {filteredNotes.map((note) => (
            <article key={note.id} className={note.id === active.id ? 'selected' : ''} onClick={() => setActiveId(note.id)}>
              <div className="note-heading"><strong>{note.title || '未命名文稿'}</strong><span>{displayDate(note.updatedAt)}</span></div>
              <p>{note.markdown.replace(/[#>*_`~\-[\]()!]/g, '').replace(/\s+/g, ' ').slice(0, 72) || '空文稿'}</p>
              <button title="删除" onClick={(event) => { event.stopPropagation(); removeNote(note.id) }}><Trash2 /></button>
            </article>
          ))}
        </div> : sidebarTab === 'workspace' ? <div className="workspace-files">
          <div className="workspace-heading"><strong>{workspace?.name ?? '未打开文件夹'}</strong><button title="刷新工作区" onClick={() => void refreshWorkspace()}><RefreshCw /></button></div>
          {flattenedTree.length ? flattenedTree.map(({ node, depth }) => {
            if (node.file) {
              return <button key={node.file.path} className={active.filePath === node.file.path ? 'selected' : ''} style={{ paddingLeft: `${12 + depth * 16}px` }} onClick={() => void openWorkspaceFile(node.file!.path)}>
                <FileText /><span><strong>{node.file.title}</strong></span>
              </button>
            } else {
              return <div key={`dir-${node.name}-${depth}`} className="workspace-folder" style={{ paddingLeft: `${12 + depth * 16}px` }}>
                <FolderTree /><strong>{node.name}</strong>
              </div>
            }
          }) : <p>{workspace ? '没有匹配的 Markdown 文稿' : '选择一个文件夹作为工作区'}</p>}
        </div> : <div className="outline-list">
          {outline.length ? outline.map((item) => (
            <button key={`${item.index}-${item.text}`} style={{ paddingLeft: `${12 + (item.level - 1) * 14}px` }} onClick={() => jumpToHeading(item.index)}>
              <span>{item.text}</span><small>H{item.level}</small>
            </button>
          )) : <p>当前文稿没有标题</p>}
        </div>}
        <div className="sidebar-footer">
          <button onClick={() => void chooseWorkspace()}><FolderTree />文件夹</button>
          <button onClick={() => void openDocument()}><Import />打开</button>
          <button onClick={() => void saveDocument()}><Save />保存</button>
          <input ref={fileInputRef} type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={importNote} hidden />
          <input ref={imageInputRef} type="file" accept="image/*" onChange={insertImageFromFile} hidden />
        </div>
      </aside>

      <main className="workspace">
        <nav className="toolbar">
          <button title={sidebar ? '收起侧栏' : '展开侧栏'} onClick={() => setSidebar((value) => !value)}>{sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
          <div className="separator" />
          <button title="撤销" onClick={() => format('undo')}><Undo2 /></button>
          <button title="重做" onClick={() => format('redo')}><Redo2 /></button>
          <div className="separator" />
          <button title="一级标题" onClick={() => format('formatBlock', 'h1')}><Heading1 /></button>
          <button title="二级标题" onClick={() => format('formatBlock', 'h2')}><Heading2 /></button>
          <button title="三级标题" onClick={() => format('formatBlock', 'h3')}><Heading3 /></button>
          <button title="加粗" onClick={() => format('bold')}><Bold /></button>
          <button title="斜体" onClick={() => format('italic')}><Italic /></button>
          <button title="下划线 ⌘U" onClick={() => { if (isEditorUsable(editor)) editor.chain().focus().toggleUnderline().run() }}><Underline /></button>
          <button title="删除线" onClick={() => format('strikeThrough')}><Strikethrough /></button>
          <button title="高亮" onClick={toggleHighlight}><Highlighter /></button>
          <button title="下标" onClick={toggleSubscript}><Subscript /></button>
          <button title="上标" onClick={toggleSuperscript}><Superscript /></button>
          <button title="行内代码" onClick={insertInlineCode}><Code /></button>
          <button title="链接" onClick={addLink}><Link /></button>
          <div className="separator optional" />
          <button className="optional" title="无序列表" onClick={() => format('insertUnorderedList')}><List /></button>
          <button className="optional" title="有序列表" onClick={() => format('insertOrderedList')}><ListOrdered /></button>
          <button className="optional" title="引用" onClick={() => format('formatBlock', 'blockquote')}><Quote /></button>
          <button className="optional" title="代码块" onClick={() => format('formatBlock', 'pre')}><Code2 /></button>
          <button className="optional" title="表格" onClick={insertTable}><Table2 /></button>
          <button className="optional" title="分隔线" onClick={insertHorizontalRule}><Minus /></button>
          <button className="optional" title="数学公式" onClick={insertMath}><Sigma /></button>
          <button className={`optional ${emojiPicker ? 'active' : ''}`} title="表情" onClick={() => setEmojiPicker((v) => !v)}><Smile /></button>
          <span className="toolbar-spacer" />
          <button title="切换 Markdown 源码" onClick={() => setSourceMode((value) => !value)} className={sourceMode ? 'active' : ''}>{sourceMode ? <Eye /> : <Braces />}</button>
          <button title="打开 Markdown 文件" onClick={() => void openDocument()}><FolderOpen /></button>
          <button title="保存 Markdown 文件" onClick={() => void saveDocument()} className={fileDirty || externalConflict ? 'save-dirty' : ''}><Save /></button>
          <button title="导出 HTML" onClick={exportHtml}><Braces /></button>
          <button title="导出 PDF" onClick={exportPdf}><Printer /></button>
        </nav>

        <section className="paper-wrap">
          <div className="paper">
            {sourceMode ? (
              <textarea className="source-editor" value={active.markdown} onChange={(event) => updateActive({ markdown: event.target.value })} spellCheck={false} />
            ) : (
              <div onContextMenu={handleContextMenu} onPaste={pasteImage} onDrop={handleDrop}>
                <EditorContent editor={editor} />
              </div>
            )}
          </div>
        </section>

        <footer className="statusbar">
          <div className="status-modes">
            <button onClick={() => setFocusMode((value) => !value)} className={focusMode ? 'active' : ''}><Focus />{focusMode ? '退出专注' : '专注模式'}</button>
            <button onClick={() => setTypewriterMode((value) => !value)} className={typewriterMode ? 'active' : ''}><TextCursorInput />打字机</button>
          </div>
          {active.filePath && <button className="file-path" title={active.filePath} onClick={() => void revealNativeDocument(active.filePath!)}>{active.filePath}</button>}
          <span>{words} 字</span><i />
          <span>{active.markdown.length} 字符</span><i />
          <span>Markdown</span>
          {zoom !== 1 && <><i /><span>{Math.round(zoom * 100)}%</span></>}
        </footer>
      </main>
      {findReplace.visible && (
        <div className="find-replace">
          <div className="find-row">
            <input
              type="text"
              placeholder="查找"
              value={findReplace.query}
              onChange={(e) => setFindReplace((p) => ({ ...p, query: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findInDocument() } }}
              autoFocus
            />
            <button title="查找下一个" onClick={findInDocument}>下一个</button>
            <button title="关闭" onClick={() => setFindReplace((p) => ({ ...p, visible: false }))}><X /></button>
          </div>
          <div className="replace-row">
            <input
              type="text"
              placeholder="替换"
              value={findReplace.replacement}
              onChange={(e) => setFindReplace((p) => ({ ...p, replacement: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceInDocument() } }}
            />
            <button title="替换" onClick={replaceInDocument}>替换</button>
            <button title="全部替换" onClick={replaceAllInDocument}>全部</button>
            <label><input type="checkbox" checked={findReplace.caseSensitive} onChange={(e) => setFindReplace((p) => ({ ...p, caseSensitive: e.target.checked }))} />区分大小写</label>
          </div>
        </div>
      )}
      {contextMenu && isEditorUsable(editor) && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={closeContextMenu}>
          <button onClick={() => { editor?.chain().focus().undo().run() }} disabled={!editor?.can().undo()}>撤销</button>
          <button onClick={() => { editor?.chain().focus().redo().run() }} disabled={!editor?.can().redo()}>重做</button>
          <div className="context-separator" />
          <button onClick={() => { document.execCommand('cut') }} disabled={editor?.state.selection.empty}>剪切</button>
          <button onClick={() => { document.execCommand('copy') }} disabled={editor?.state.selection.empty}>复制</button>
          <button onClick={() => { document.execCommand('paste') }}>粘贴</button>
          <div className="context-separator" />
          <button onClick={() => { editor?.chain().focus().toggleBold().run() }} className={editor?.isActive('bold') ? 'active' : ''}>加粗</button>
          <button onClick={() => { editor?.chain().focus().toggleItalic().run() }} className={editor?.isActive('italic') ? 'active' : ''}>斜体</button>
          <button onClick={() => { editor?.chain().focus().toggleUnderline().run() }} className={editor?.isActive('underline') ? 'active' : ''}>下划线</button>
          <button onClick={() => { editor?.chain().focus().toggleStrike().run() }} className={editor?.isActive('strike') ? 'active' : ''}>删除线</button>
          <button onClick={() => { editor?.chain().focus().toggleHighlight().run() }} className={editor?.isActive('highlight') ? 'active' : ''}>高亮</button>
          <button onClick={() => { editor?.chain().focus().toggleCode().run() }} className={editor?.isActive('code') ? 'active' : ''}>行内代码</button>
          <div className="context-separator" />
          <button onClick={addLink}>插入链接</button>
          <button onClick={insertTable}>插入表格</button>
          <button onClick={insertHorizontalRule}>插入分隔线</button>
        </div>
      )}
      {emojiPicker && (
        <div className="emoji-picker" onClick={(e) => e.stopPropagation()}>
          {EMOJIS.map((emoji) => (
            <button key={emoji} onClick={() => insertEmoji(emoji)}>{emoji}</button>
          ))}
        </div>
      )}
      {message && <button className="toast" onClick={() => setMessage('')}>{message}</button>}
      {quickOpen && (
        <div className="quick-open-overlay" onClick={() => setQuickOpen(false)}>
          <div className="quick-open" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              placeholder="快速打开…"
              value={quickOpenQuery}
              onChange={(e) => setQuickOpenQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuickOpen(false); return }
                if (e.key === 'ArrowDown') { e.preventDefault(); setQuickOpenIndex((i) => Math.min(i + 1, quickOpenItems.length - 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setQuickOpenIndex((i) => Math.max(i - 1, 0)); return }
                if (e.key === 'Enter' && quickOpenItems.length > 0) {
                  const item = quickOpenItems[quickOpenIndex] ?? quickOpenItems[0]
                  if (item.type === 'note') setActiveId(item.id)
                  else if (item.path) void openWorkspaceFile(item.path)
                  setQuickOpen(false)
                }
              }}
              autoFocus
            />
            {quickOpenItems.length > 0 ? (
              <ul>
                {quickOpenItems.map((item, idx) => (
                  <li key={item.id} className={idx === quickOpenIndex ? 'selected' : ''} onMouseEnter={() => setQuickOpenIndex(idx)} onClick={() => {
                    if (item.type === 'note') setActiveId(item.id)
                    else if (item.path) void openWorkspaceFile(item.path)
                    setQuickOpen(false)
                  }}>
                    {item.type === 'note' ? <FileText /> : <FolderTree />}
                    <span>{item.title || '未命名文稿'}</span>
                    <small>{item.type === 'note' ? '文稿库' : '工作区'}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quick-open-empty">没有匹配的文稿</p>
            )}
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>偏好设置</h2>
              <button title="关闭" onClick={() => setSettingsOpen(false)}><X /></button>
            </div>
            <div className="settings-body">
              <section className="settings-group">
                <label className="settings-label">字体</label>
                <div className="settings-fonts">
                  <button className={fontFamily === 'serif' ? 'selected' : ''} onClick={() => setFontFamily('serif')} style={{ fontFamily: FONT_FAMILIES.serif }}>衬线</button>
                  <button className={fontFamily === 'sans' ? 'selected' : ''} onClick={() => setFontFamily('sans')} style={{ fontFamily: FONT_FAMILIES.sans }}>无衬线</button>
                  <button className={fontFamily === 'mono' ? 'selected' : ''} onClick={() => setFontFamily('mono')} style={{ fontFamily: FONT_FAMILIES.mono }}>等宽</button>
                </div>
              </section>
              <section className="settings-group">
                <label className="settings-label">字号 <span>{fontSize}px</span></label>
                <div className="settings-stepper">
                  <button onClick={() => setFontSize((s) => Math.max(12, s - 1))}>－</button>
                  <input type="range" min={12} max={26} value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value, 10))} />
                  <button onClick={() => setFontSize((s) => Math.min(26, s + 1))}>＋</button>
                </div>
              </section>
              <section className="settings-group">
                <label className="settings-label">行距 <span>{lineHeight.toFixed(2)}</span></label>
                <div className="settings-stepper">
                  <button onClick={() => setLineHeight((l) => Math.round(Math.max(1.2, l - 0.05) * 100) / 100)}>－</button>
                  <input type="range" min={1.2} max={2.4} step={0.05} value={lineHeight} onChange={(e) => setLineHeight(parseFloat(e.target.value))} />
                  <button onClick={() => setLineHeight((l) => Math.round(Math.min(2.4, l + 0.05) * 100) / 100)}>＋</button>
                </div>
              </section>
              <section className="settings-group">
                <label className="settings-label">字间距 <span>{letterSpacing ? `${letterSpacing.toFixed(1)}px` : '默认'}</span></label>
                <div className="settings-stepper">
                  <button onClick={() => setLetterSpacing((s) => Math.round(Math.max(0, s - 0.1) * 10) / 10)}>－</button>
                  <input type="range" min={0} max={3} step={0.1} value={letterSpacing} onChange={(e) => setLetterSpacing(parseFloat(e.target.value))} />
                  <button onClick={() => setLetterSpacing((s) => Math.round(Math.min(3, s + 0.1) * 10) / 10)}>＋</button>
                </div>
              </section>
              <section className="settings-group">
                <label className="settings-label">整体缩放 <span>{Math.round(zoom * 100)}%</span></label>
                <div className="settings-stepper">
                  <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))}>－</button>
                  <input type="range" min={0.5} max={2} step={0.1} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
                  <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(1)))}>＋</button>
                  <button className="reset" onClick={() => setZoom(1)}>重置</button>
                </div>
              </section>
              <section className="settings-group">
                <label className="settings-label">主题</label>
                <div className="settings-themes">
                  {[
                    { id: 'auto', name: '自动' },
                    { id: 'github', name: 'GitHub' },
                    { id: 'newsprint', name: '新闻纸' },
                    { id: 'night', name: '夜间' },
                    { id: 'pixyll', name: 'Pixyll' },
                  ].map((t) => (
                    <button key={t.id} className={theme === t.id ? 'selected' : ''} onClick={() => applyTheme(t.id)}>{t.name}</button>
                  ))}
                </div>
              </section>
            </div>
            <div className="settings-footer">
              <button className="reset" onClick={() => { setFontFamily('serif'); setFontSize(16); setLineHeight(1.85); setLetterSpacing(0); setZoom(1) }}>恢复默认</button>
              <button className="primary" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      )}
      {closeConfirmationOpen && (
        <div className="settings-overlay close-confirmation-overlay" onClick={() => setCloseConfirmationOpen(false)}>
          <div className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-confirmation-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="close-confirmation-title">有未保存的修改</h2>
            <p>仍有文件尚未写入磁盘。直接退出会丢失这些修改。</p>
            <div className="close-confirmation-actions">
              <button onClick={() => setCloseConfirmationOpen(false)}>取消</button>
              <button className="danger" onClick={() => void quitNativeApp()}>退出 Markora</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function AppWithBoundary() {
  return <ErrorBoundary><App /></ErrorBoundary>
}
