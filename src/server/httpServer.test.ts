import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, resolveGzippedStaticAssetPath } from './httpServer'

let tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codexui-http-server-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function listenOnRandomPort(app: ReturnType<typeof createServer>['app']): Promise<{ baseUrl: string, close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected tcp address')
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve())
        }),
      })
    })
  })
}

describe('resolveGzippedStaticAssetPath', () => {
  it('resolves gzip-eligible frontend assets inside dist/assets', () => {
    const assetPath = resolveGzippedStaticAssetPath('/assets/index.js')

    expect(assetPath).toMatch(/\/dist\/assets\/index\.js$/u)
  })

  it('rejects encoded paths that escape dist/assets', () => {
    expect(resolveGzippedStaticAssetPath('/assets/%2f..%2f..%2fdist-cli%2findex.js')).toBeNull()
    expect(resolveGzippedStaticAssetPath('/assets/%2e%2e/index.js')).toBeNull()
  })

  it('rejects non-gzipped asset extensions', () => {
    expect(resolveGzippedStaticAssetPath('/assets/logo.png')).toBeNull()
  })
})

describe('/codex-local-browse markdown viewer', () => {
  it('renders markdown through the viewer by default and preserves raw bypass', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'viewer.md')
    await writeFile(filePath, '# Viewer\n\n[bad](javascript:alert(1))', 'utf8')
    const instance = createServer()
    const server = await listenOnRandomPort(instance.app)
    try {
      const encodedPath = filePath.split('/').map((part, index) => index === 0 ? '' : encodeURIComponent(part)).join('/')
      const viewer = await fetch(`${server.baseUrl}/codex-local-browse${encodedPath}`)
      const viewerText = await viewer.text()
      const raw = await fetch(`${server.baseUrl}/codex-local-browse${encodedPath}?raw=1`)
      const rawText = await raw.text()

      expect(viewer.status).toBe(200)
      expect(viewer.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect(viewer.headers.get('x-content-type-options')).toBe('nosniff')
      expect(viewerText).toContain('class="markdown-viewer-page"')
      expect(viewerText).toContain('<h1 id="viewer">Viewer</h1>')
      expect(viewerText).not.toContain('href="javascript:')
      expect(raw.status).toBe(200)
      expect(rawText).toBe('# Viewer\n\n[bad](javascript:alert(1))')
    } finally {
      await server.close()
      instance.dispose()
    }
  })

  it('preserves directory and non-markdown browse behavior', async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, 'child'))
    const txtPath = join(dir, 'plain.txt')
    await writeFile(txtPath, 'plain text', 'utf8')
    const instance = createServer()
    const server = await listenOnRandomPort(instance.app)
    try {
      const encodedDir = dir.split('/').map((part, index) => index === 0 ? '' : encodeURIComponent(part)).join('/')
      const encodedTxt = txtPath.split('/').map((part, index) => index === 0 ? '' : encodeURIComponent(part)).join('/')
      const directory = await fetch(`${server.baseUrl}/codex-local-browse${encodedDir}`)
      const directoryText = await directory.text()
      const txt = await fetch(`${server.baseUrl}/codex-local-browse${encodedTxt}`)
      const txtText = await txt.text()

      expect(directory.status).toBe(200)
      expect(directoryText).toContain('Index of')
      expect(directoryText).toContain('child/')
      expect(txt.status).toBe(200)
      expect(txtText).toBe('plain text')
    } finally {
      await server.close()
      instance.dispose()
    }
  })
})
