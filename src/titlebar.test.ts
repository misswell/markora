import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('desktop titlebar drag regions', () => {
  it('marks the visible passive title surfaces themselves as draggable', () => {
    expect(appSource).toMatch(/className="document-title"[^>]*data-tauri-drag-region/)
    expect(appSource).toMatch(/<span[^>]*data-tauri-drag-region[^>]*>\{saveLabel\}<\/span>/)
  })
})
