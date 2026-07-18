import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions, getEditorOutline, isEditorUsable, resolveLocalImagePath } from './editor'

let editor: Editor | undefined

afterEach(() => editor?.destroy())

describe('Markdown editor model', () => {
  it('rejects an editor instance after Tiptap has destroyed it during document switching', () => {
    expect(isEditorUsable({ isDestroyed: false } as Editor)).toBe(true)
    editor = new Editor({ extensions: createEditorExtensions(), content: 'old document', contentType: 'markdown' })

    editor.destroy()

    expect(isEditorUsable(editor)).toBe(false)
  })

  it('round-trips the core structures used by a Typora-style document', () => {
    const markdown = `# Heading

Text with **bold**, *italic*, ~~strike~~ and [a link](https://example.com).

> A quote

- first
- second

\`inline code\`

\`\`\`ts
const ready = true
\`\`\``

    editor = new Editor({
      extensions: createEditorExtensions(),
      content: markdown,
      contentType: 'markdown',
    })

    const output = editor.getMarkdown()
    expect(output).toContain('# Heading')
    expect(output).toContain('**bold**')
    expect(output).toContain('~~strike~~')
    expect(output).toContain('[a link](https://example.com)')
    expect(output).toContain('> A quote')
    expect(output).toContain('- first')
    expect(output).toContain('```ts')
    expect(getEditorOutline(editor)).toEqual([{ level: 1, text: 'Heading', index: 0 }])
  })

  it('preserves GFM tables, tasks, and images', () => {
    const markdown = `| Name | Ready |
| --- | --- |
| Markora | yes |

- [x] native files
- [ ] export

![logo](./logo.png)`

    editor = new Editor({
      extensions: createEditorExtensions(),
      content: markdown,
      contentType: 'markdown',
    })

    const output = editor.getMarkdown()
    expect(output).toContain('| Name')
    expect(output).toContain('- [x] native files')
    expect(output).toContain('![logo](./logo.png)')
  })
})

describe('relative image paths', () => {
  it('resolves beside a Unix or Windows Markdown document', () => {
    expect(resolveLocalImagePath('/notes/guide/doc.md', '../images/logo.png')).toBe('/notes/images/logo.png')
    expect(resolveLocalImagePath('C:\\notes\\guide\\doc.md', '..\\images\\logo.png')).toBe('C:\\notes\\images\\logo.png')
    expect(resolveLocalImagePath('/notes/doc.md', 'file:///tmp/logo.png')).toBe('/tmp/logo.png')
  })

  it('leaves web and data sources to the webview', () => {
    expect(resolveLocalImagePath('/notes/doc.md', 'https://example.com/logo.png')).toBeNull()
    expect(resolveLocalImagePath('/notes/doc.md', 'data:image/png;base64,abc')).toBeNull()
  })
})
