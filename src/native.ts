import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

export interface OpenedDocument {
  path: string
  title: string
  contents: string
}

export interface WorkspaceFile {
  path: string
  relativePath: string
  title: string
}

export interface Workspace {
  root: string
  name: string
  files: WorkspaceFile[]
}

export function isDesktop() {
  return isTauri()
}

export async function startWindowDrag() {
  if (!isTauri()) return
  try {
    await getCurrentWindow().startDragging()
  } catch (error) {
    console.error('Markora could not start window dragging', error)
  }
}

export async function quitNativeApp() {
  if (!isTauri()) return
  await getCurrentWindow().destroy()
}

export async function openNativeDocument() {
  return invoke<OpenedDocument | null>('open_markdown')
}

export async function saveNativeDocument(
  path: string | undefined,
  suggestedName: string,
  contents: string,
  expectedContents?: string,
  force = false,
) {
  return invoke<string | null>('save_markdown', {
    path: path ?? null,
    suggestedName,
    contents,
    expectedContents: expectedContents ?? null,
    force,
  })
}

export async function revealNativeDocument(path: string) {
  return invoke<void>('reveal_in_folder', { path })
}

export async function exportHtmlFile(suggestedName: string, contents: string) {
  return invoke<string | null>('export_html_file', { suggestedName, contents })
}

export async function openExportInBrowser(title: string, contents: string) {
  return invoke<void>('open_export_in_browser', { title, contents })
}

export async function takeStartupDocuments() {
  return invoke<OpenedDocument[]>('take_pending_documents')
}

export async function onNativeDocumentOpened(handler: (document: OpenedDocument) => void): Promise<UnlistenFn> {
  return listen<OpenedDocument>('open-document', (event) => handler(event.payload))
}

export async function onNativeCloseRequested(shouldAllowClose: () => boolean): Promise<UnlistenFn> {
  return getCurrentWindow().onCloseRequested(async (event) => {
    // Always take ownership of the native close request. Tauri's implicit
    // window.destroy() fallback is unreliable with the macOS overlay titlebar.
    event.preventDefault()
    if (shouldAllowClose()) await quitNativeApp()
  })
}

export async function authorizeNativeImage(documentPath: string, source: string) {
  return invoke<string>('authorize_local_image', { documentPath, source })
}

export async function openNativeWorkspace() {
  return invoke<Workspace | null>('open_workspace')
}

export async function refreshNativeWorkspace(root: string) {
  return invoke<Workspace>('refresh_workspace', { root })
}

export async function readNativeWorkspaceDocument(path: string) {
  return invoke<OpenedDocument>('read_workspace_document', { path })
}

export async function readExternalDocument(path: string) {
  return invoke<string>('read_external_document', { path })
}

export async function onMenuAction(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>('menu', (event) => handler(event.payload))
}

export async function onToast(handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>('toast', (event) => handler(event.payload))
}

export async function syncThemeMenu(theme: string) {
  return invoke<void>('sync_theme_menu', { theme })
}
