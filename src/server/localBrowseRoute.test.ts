import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalBrowseResponse, MARKDOWN_PREVIEW_MAX_BYTES } from './localBrowseRoute'

let tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codexui-local-browse-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('createLocalBrowseResponse', () => {
  it('renders markdown files through the viewer by default', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'readme.md')
    await writeFile(filePath, '# Hello\n\nWorld', 'utf8')

    const response = await createLocalBrowseResponse({ localPath: filePath, searchParams: new URLSearchParams() })

    expect(response.kind).toBe('html')
    expect(response.status).toBe(200)
    if (response.kind !== 'html') return
    expect(response.body).toContain('class="markdown-viewer-page"')
    expect(response.body).toContain('<h1 id="hello">Hello</h1>')
    expect(response.headers['Content-Security-Policy']).toContain("default-src 'none'")
    expect(response.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(response.headers['Referrer-Policy']).toBe('no-referrer')
  })

  it('uses raw file behavior only for exact raw=1', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'readme.markdown')
    await writeFile(filePath, '# Hello', 'utf8')

    const raw = await createLocalBrowseResponse({ localPath: filePath, searchParams: new URLSearchParams('raw=1') })
    const rawTrue = await createLocalBrowseResponse({ localPath: filePath, searchParams: new URLSearchParams('raw=true') })
    const rawZero = await createLocalBrowseResponse({ localPath: filePath, searchParams: new URLSearchParams('raw=0') })

    expect(raw.kind).toBe('file')
    expect(rawTrue.kind).toBe('html')
    expect(rawZero.kind).toBe('html')
  })

  it('propagates sanitized newProjectName into directory browse links', async () => {
    const dir = await createTempDir()
    await writeFile(join(dir, 'readme.md'), '# Hello', 'utf8')

    const response = await createLocalBrowseResponse({
      localPath: dir,
      searchParams: new URLSearchParams('newProjectName=../Bad Name'),
      newProjectName: '../Bad Name',
    })

    expect(response.kind).toBe('html')
    if (response.kind !== 'html') return
    expect(response.body).toContain('newProjectName=..Bad%20Name')
    expect(response.body).not.toContain('newProjectName=../Bad')
  })

  it('propagates sanitized newProjectName into markdown viewer toolbar links', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'readme.md')
    await writeFile(filePath, '# Hello', 'utf8')

    const response = await createLocalBrowseResponse({
      localPath: filePath,
      searchParams: new URLSearchParams('newProjectName=../Bad Name'),
      newProjectName: '../Bad Name',
    })

    expect(response.kind).toBe('html')
    if (response.kind !== 'html') return
    expect(response.body).toContain(`${dir}?newProjectName=..Bad%20Name`)
    expect(response.body).toContain(`${filePath}?newProjectName=..Bad%20Name&amp;raw=1`)
    expect(response.body).toContain(`/codex-local-edit${filePath}?newProjectName=..Bad%20Name`)
    expect(response.body).not.toContain('newProjectName=../Bad')
  })

  it('treats malformed and encoded-separator absolute paths as ordinary local paths', async () => {
    const malformed = await createLocalBrowseResponse({
      localPath: '/tmp/%E0%A4%A.md',
      searchParams: new URLSearchParams(),
    })
    const encodedSeparator = await createLocalBrowseResponse({
      localPath: '/tmp/encoded%2fseparator.md',
      searchParams: new URLSearchParams(),
    })

    expect(malformed.status).toBe(404)
    expect(encodedSeparator.status).toBe(404)
    expect(malformed.kind).toBe('html')
    expect(encodedSeparator.kind).toBe('html')
  })

  it('preserves directory and non-markdown file behavior', async () => {
    const dir = await createTempDir()
    const childDir = join(dir, 'child')
    const txtPath = join(dir, 'notes.txt')
    await mkdir(childDir)
    await writeFile(txtPath, 'plain text', 'utf8')

    const directory = await createLocalBrowseResponse({ localPath: dir, searchParams: new URLSearchParams() })
    const textFile = await createLocalBrowseResponse({ localPath: txtPath, searchParams: new URLSearchParams() })

    expect(directory.kind).toBe('html')
    if (directory.kind === 'html') {
      expect(directory.body).toContain('Index of')
      expect(directory.body).toContain('child/')
    }
    expect(textFile).toMatchObject({ kind: 'file', status: 200, filePath: txtPath })
  })

  it('returns recovery shells for oversized, missing, and renderable empty markdown states', async () => {
    const dir = await createTempDir()
    const oversizedPath = join(dir, 'big.md')
    const emptyPath = join(dir, 'empty.md')
    await writeFile(oversizedPath, `${'x'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 2)}SECRET_SHOULD_NOT_RENDER`, 'utf8')
    await writeFile(emptyPath, '', 'utf8')

    const oversized = await createLocalBrowseResponse({ localPath: oversizedPath, searchParams: new URLSearchParams() })
    const missing = await createLocalBrowseResponse({ localPath: join(dir, 'missing.md'), searchParams: new URLSearchParams() })
    const empty = await createLocalBrowseResponse({ localPath: emptyPath, searchParams: new URLSearchParams() })

    expect(oversized.kind).toBe('html')
    if (oversized.kind === 'html') {
      expect(oversized.body).toContain('larger than the 1 MiB preview limit')
      expect(oversized.body).not.toContain('SECRET_SHOULD_NOT_RENDER')
    }
    expect(missing.kind).toBe('html')
    expect(missing.status).toBe(404)
    if (missing.kind === 'html') expect(missing.body).toContain('File not found.')
    expect(empty.kind).toBe('html')
    if (empty.kind === 'html') expect(empty.body).toContain('This markdown file is empty.')
  })

  it('returns an explicit render-failed response when viewer html generation throws', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'broken.md')
    await writeFile(filePath, '# Hello', 'utf8')
    const response = await createLocalBrowseResponse({
      localPath: filePath,
      searchParams: new URLSearchParams(),
      createViewerHtml(options) {
        if (options.markdown) throw new Error('forced render failure')
        return '<!doctype html><html><body>Preview failed. Raw markdown is still available.</body></html>'
      },
    })

    expect(response.kind).toBe('html')
    expect(response.status).toBe(500)
    if (response.kind === 'html') {
      expect(response.body).toContain('Preview failed')
      expect(response.body).not.toContain('forced render failure')
    }
  })

  it('rejects non-absolute local paths before route handling', async () => {
    const response = await createLocalBrowseResponse({ localPath: 'relative/readme.md', searchParams: new URLSearchParams() })

    expect(response.kind).toBe('json')
    expect(response.status).toBe(400)
    if (response.kind === 'json') expect(response.body.error).toBe('Expected absolute local file path.')
  })
})
