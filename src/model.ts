export interface Note {
  id: string
  title: string
  markdown: string
  updatedAt: number
  filePath?: string
  diskMarkdown?: string
}

export function noteFromFile(path: string, title: string, markdown: string): Note {
  return {
    id: crypto.randomUUID(),
    title,
    markdown,
    updatedAt: Date.now(),
    filePath: path,
    diskMarkdown: markdown,
  }
}

export function isFileDirty(note: Note) {
  return Boolean(note.filePath && note.markdown !== note.diskMarkdown)
}

export type ExternalChange = 'unchanged' | 'reload' | 'conflict'

export function classifyExternalChange(note: Note, diskMarkdown: string): ExternalChange {
  if (!note.filePath || note.diskMarkdown === undefined || diskMarkdown === note.diskMarkdown) return 'unchanged'
  return note.markdown === note.diskMarkdown ? 'reload' : 'conflict'
}

export function titleFromPath(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? path
  return fileName.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') || '未命名文稿'
}

export interface OutlineItem {
  level: number
  text: string
  index: number
}

export interface TreeNode {
  name: string
  file?: { path: string; title: string; relativePath: string }
  children: TreeNode[]
}

export function buildFileTree(files: { path: string; title: string; relativePath: string }[]): TreeNode[] {
  if (!files || !Array.isArray(files)) return []
  const root: TreeNode = { name: '', children: [] }
  for (const file of files) {
    if (!file || !file.relativePath) continue
    const parts = file.relativePath.split(/[\\/]/)
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!part) continue
      const isFile = i === parts.length - 1
      let child = current.children.find((c) => c.name === part && (isFile ? !!c.file : !c.file))
      if (!child) {
        child = { name: part, children: [], ...(isFile ? { file } : {}) }
        current.children.push(child)
      }
      if (!isFile) current = child
    }
  }
  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.file && !b.file) return 1
      if (!a.file && b.file) return -1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((n) => sortTree(n.children))
  }
  sortTree(root.children)
  return root.children
}

export function flattenTree(nodes: TreeNode[], depth = 0): { node: TreeNode; depth: number }[] {
  const result: { node: TreeNode; depth: number }[] = []
  for (const node of nodes) {
    result.push({ node, depth })
    if (node.children.length) result.push(...flattenTree(node.children, depth + 1))
  }
  return result
}

export function getOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    items.push({
      level: match[1].length,
      text: match[2].replace(/[*_`~\[\]]/g, ''),
      index: items.length,
    })
  }
  return items
}

export const WELCOME_NOTE: Note = {
  id: 'welcome',
  title: '欢迎使用 Markora',
  updatedAt: Date.now(),
  markdown: `# 欢迎使用 Markora

像写字一样写 Markdown。格式标记会让位给内容，让你的注意力留在文字上。

## 从这里开始

- 点击任意文字即可编辑
- 用顶部工具栏添加标题、加粗、链接与代码
- 文稿会自动保存在本机
- 可以导入或导出标准 **Markdown** 文件

> 简洁不是少，而是恰到好处。

### 常用快捷键

使用 **⌘ B** 加粗、*⌘ I* 斜体，或按 **⌘ S** 导出当前文稿。

\`Markora\` 正在持续变得更好。
`,
}

export function createNote(index: number): Note {
  return {
    id: crypto.randomUUID(),
    title: `未命名文稿 ${index}`,
    markdown: '# 未命名文稿\n\n开始写作…',
    updatedAt: Date.now(),
  }
}

export function getWordCount(markdown: string) {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\-[\]()!]/g, ' ')
    .trim()
  const latinWords = plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  const cjkCharacters = plain.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  return latinWords + cjkCharacters
}

export function displayDate(timestamp: number) {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
