import { describe, expect, it } from 'vitest'
import { classifyExternalChange, getOutline, getWordCount, isFileDirty, titleFromPath, type Note } from './model'

describe('getWordCount', () => {
  it('counts Latin words and CJK characters', () => {
    expect(getWordCount('# Hello Markora\n你好，世界')).toBe(6)
  })

  it('does not count markdown punctuation', () => {
    expect(getWordCount('**bold** [link](https://example.com)')).toBe(5)
  })
})

describe('getOutline', () => {
  it('extracts heading hierarchy and ignores fenced code', () => {
    const markdown = '# Title\n## **Section**\n```md\n# not a heading\n```\n### Detail'
    expect(getOutline(markdown)).toEqual([
      { level: 1, text: 'Title', index: 0 },
      { level: 2, text: 'Section', index: 1 },
      { level: 3, text: 'Detail', index: 2 },
    ])
  })
})

describe('isFileDirty', () => {
  const note: Note = { id: '1', title: 'Doc', markdown: 'current', updatedAt: 0, filePath: '/doc.md', diskMarkdown: 'saved' }

  it('tracks changes relative to the file on disk', () => {
    expect(isFileDirty(note)).toBe(true)
    expect(isFileDirty({ ...note, markdown: 'saved' })).toBe(false)
  })

  it('keeps library-only notes out of the disk dirty state', () => {
    expect(isFileDirty({ ...note, filePath: undefined })).toBe(false)
  })
})

describe('classifyExternalChange', () => {
  const note: Note = { id: '1', title: 'Doc', markdown: 'saved', diskMarkdown: 'saved', filePath: '/doc.md', updatedAt: 0 }

  it('reloads clean notes and reports conflicts for locally edited notes', () => {
    expect(classifyExternalChange(note, 'external')).toBe('reload')
    expect(classifyExternalChange({ ...note, markdown: 'local' }, 'external')).toBe('conflict')
    expect(classifyExternalChange(note, 'saved')).toBe('unchanged')
  })
})

describe('titleFromPath', () => {
  it('derives document titles from Unix and Windows paths', () => {
    expect(titleFromPath('/notes/Guide.md')).toBe('Guide')
    expect(titleFromPath('C:\\notes\\Guide.markdown')).toBe('Guide')
  })
})
