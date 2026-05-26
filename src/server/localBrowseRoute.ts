import { randomBytes } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createDirectoryListingHtml } from './localBrowseUi.js'
import { createMarkdownViewerHtml, isMarkdownViewerPath } from './localMarkdownViewer.js'

export const MARKDOWN_PREVIEW_MAX_BYTES = 1024 * 1024

export type LocalBrowseResponse =
  | {
      kind: 'html'
      status: number
      headers: Record<string, string>
      body: string
    }
  | {
      kind: 'file'
      status: number
      headers: Record<string, string>
      filePath: string
    }
  | {
      kind: 'json'
      status: number
      headers: Record<string, string>
      body: { error: string }
    }

type LocalBrowseRequestOptions = {
  localPath: string
  searchParams: URLSearchParams
  newProjectName?: string
  readLimitBytes?: number
  createViewerHtml?: typeof createMarkdownViewerHtml
}

type BoundedMarkdownRead =
  | { ok: true, content: string }
  | { ok: false, tooLarge: true }

const VIEWER_SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

function createNonce(): string {
  return randomBytes(16).toString('base64')
}

function markdownViewerHeaders(nonce: string): Record<string, string> {
  return {
    ...VIEWER_SECURITY_HEADERS,
    'Content-Security-Policy': `default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  }
}

async function readMarkdownUnderCap(localPath: string, capBytes: number): Promise<BoundedMarkdownRead> {
  const handle = await open(localPath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(capBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > capBytes) return { ok: false, tooLarge: true }
    return { ok: true, content: buffer.subarray(0, total).toString('utf8') }
  } finally {
    await handle.close()
  }
}

function jsonResponse(statusCode: number, error: string): LocalBrowseResponse {
  return {
    kind: 'json',
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: { error },
  }
}

function htmlResponse(statusCode: number, body: string, nonce?: string): LocalBrowseResponse {
  return {
    kind: 'html',
    status: statusCode,
    headers: nonce ? markdownViewerHeaders(nonce) : VIEWER_SECURITY_HEADERS,
    body,
  }
}

export async function createLocalBrowseResponse(options: LocalBrowseRequestOptions): Promise<LocalBrowseResponse> {
  const { localPath, searchParams } = options
  const previewLimit = options.readLimitBytes ?? MARKDOWN_PREVIEW_MAX_BYTES
  const renderViewerHtml = options.createViewerHtml ?? createMarkdownViewerHtml
  if (!localPath || !isAbsolute(localPath)) {
    return jsonResponse(400, 'Expected absolute local file path.')
  }

  try {
    const fileStat = await stat(localPath)
    if (fileStat.isDirectory()) {
      const html = await createDirectoryListingHtml(localPath, { newProjectName: options.newProjectName ?? '' })
      return htmlResponse(200, html)
    }
    if (!fileStat.isFile()) {
      return jsonResponse(400, 'Expected file path.')
    }

    if (!isMarkdownViewerPath(localPath) || searchParams.get('raw') === '1') {
      return {
        kind: 'file',
        status: 200,
        headers: { 'Cache-Control': 'private, no-store' },
        filePath: localPath,
      }
    }

    const nonce = createNonce()
    if (fileStat.size > previewLimit) {
      return htmlResponse(200, renderViewerHtml({ localPath, nonce, state: 'too-large', newProjectName: options.newProjectName }), nonce)
    }

    const readResult = await readMarkdownUnderCap(localPath, previewLimit)
    if (!readResult.ok) {
      return htmlResponse(200, renderViewerHtml({ localPath, nonce, state: 'too-large', newProjectName: options.newProjectName }), nonce)
    }

    try {
      return htmlResponse(200, renderViewerHtml({ localPath, nonce, markdown: readResult.content, newProjectName: options.newProjectName }), nonce)
    } catch (error) {
      console.error('Failed to render markdown viewer', error)
      return htmlResponse(200, createMarkdownViewerHtml({ localPath, nonce, state: 'render-failed', newProjectName: options.newProjectName }), nonce)
    }
  } catch {
    if (isMarkdownViewerPath(localPath)) {
      const nonce = createNonce()
      return htmlResponse(404, renderViewerHtml({ localPath, nonce, state: 'missing', newProjectName: options.newProjectName }), nonce)
    }
    return jsonResponse(404, 'File not found.')
  }
}
