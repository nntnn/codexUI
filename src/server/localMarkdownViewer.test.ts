import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMarkdownViewerHtml, renderMarkdownDocument, safeMarkdownHref, safeMarkdownImageSrc } from './localMarkdownViewer'
import { toBrowseHref } from './localBrowseUi'

let tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codexui-md-viewer-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('local markdown viewer renderer', () => {
  it('renders supported markdown blocks and escapes raw HTML', () => {
    const localPath = '/tmp/docs/readme.md'
    const rendered = renderMarkdownDocument([
      '# Title',
      '## Usage Guide',
      '## Usage Guide',
      '',
      'Paragraph with **bold**, *italic*, ~~gone~~, and `code`.',
      '',
      '[Spec](docs/ADR_(final).md)',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '> quote',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| A | B |',
      '',
      '```html',
      '<script>alert(1)</script>',
      '```',
      '',
      '<img src=x onerror=alert(1)>',
    ].join('\n'), { localPath })

    expect(rendered.hasH1).toBe(true)
    expect(rendered.html).toContain('<h1 id="title">Title</h1>')
    expect(rendered.html).toContain('<h2 id="usage-guide">Usage Guide</h2>')
    expect(rendered.html).toContain('<h2 id="usage-guide-2">Usage Guide</h2>')
    expect(rendered.html).toContain('<strong>bold</strong>')
    expect(rendered.html).toContain('href="/codex-local-browse/tmp/docs/docs/ADR_(final).md"')
    expect(rendered.html).toContain('<em>italic</em>')
    expect(rendered.html).toContain('<del>gone</del>')
    expect(rendered.html).toContain('<code>code</code>')
    expect(rendered.html).toContain('type="checkbox" disabled checked')
    expect(rendered.html).toContain('<blockquote>')
    expect(rendered.html).toContain('<table>')
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(rendered.html).not.toContain('<script>alert')
  })

  it('uses an allowlist for links and local browse rewrites', () => {
    const localPath = '/tmp/docs/readme.md'

    expect(safeMarkdownHref('https://example.com/a?x=1&y=2', localPath)).toMatchObject({ external: true })
    expect(safeMarkdownHref('mailto:test@example.com', localPath)).toMatchObject({ external: false })
    expect(safeMarkdownHref('#section-1', localPath)).toMatchObject({ html: '#section-1' })
    expect(safeMarkdownHref('guide/intro.md', localPath)?.html).toBe('/codex-local-browse/tmp/docs/guide/intro.md')
    expect(safeMarkdownHref('guide/intro.md#usage', localPath)?.html).toBe('/codex-local-browse/tmp/docs/guide/intro.md#usage')
    expect(safeMarkdownHref('My%20Guide.md', localPath)?.html).toBe('/codex-local-browse/tmp/docs/My%20Guide.md')
    expect(safeMarkdownHref('docs/ADR_(final).md', localPath)?.html).toBe('/codex-local-browse/tmp/docs/docs/ADR_(final).md')
    expect(safeMarkdownHref('/tmp/other.md', localPath)?.html).toBe('/codex-local-browse/tmp/other.md')

    expect(safeMarkdownHref('javascript:alert(1)', localPath)).toBeNull()
    expect(safeMarkdownHref('%6aavascript:alert(1)', localPath)).toBeNull()
    expect(safeMarkdownHref('data:text/html,hi', localPath)).toBeNull()
    expect(safeMarkdownHref('//example.com/path', localPath)).toBeNull()
    expect(safeMarkdownHref('\u0000javascript:alert(1)', localPath)).toBeNull()
    expect(safeMarkdownHref('guide/intro.md#bad space', localPath)).toBeNull()
    expect(safeMarkdownHref('guide%2Fintro.md', localPath)).toBeNull()
  })

  it('confines auto-rendered local images and excludes svg', async () => {
    const dir = await createTempDir()
    const imageDir = join(dir, 'images')
    await mkdir(imageDir)
    await writeFile(join(imageDir, 'a.png'), 'fake png', 'utf8')
    await writeFile(join(imageDir, 'My Image.png'), 'fake png', 'utf8')
    await writeFile(join(imageDir, 'v1_(dark).png'), 'fake png', 'utf8')
    await writeFile(join(dir, 'a.webp'), 'fake webp', 'utf8')
    await writeFile(join(imageDir, 'a.svg'), '<svg />', 'utf8')
    const localPath = join(dir, 'readme.md')

    expect(safeMarkdownImageSrc('images/a.png', localPath)).toBe(`/codex-local-image?path=${encodeURIComponent(join(imageDir, 'a.png'))}`)
    expect(safeMarkdownImageSrc('images/My%20Image.png', localPath)).toBe(`/codex-local-image?path=${encodeURIComponent(join(imageDir, 'My Image.png'))}`)
    expect(safeMarkdownImageSrc('images/v1_(dark).png', localPath)).toBe(`/codex-local-image?path=${encodeURIComponent(join(imageDir, 'v1_(dark).png'))}`)
    expect(safeMarkdownImageSrc('./a.webp', localPath)).toBe(`/codex-local-image?path=${encodeURIComponent(join(dir, 'a.webp'))}`)
    expect(safeMarkdownImageSrc('../private/a.png', localPath)).toBeNull()
    expect(safeMarkdownImageSrc('images%2Fa.png', localPath)).toBeNull()
    expect(safeMarkdownImageSrc('icons/a.svg', localPath)).toBeNull()
    expect(safeMarkdownImageSrc('https://example.com/a.png', localPath)).toBeNull()
  })

  it('blocks symlinked images that resolve outside the markdown directory tree', async () => {
    const dir = await createTempDir()
    const outside = await createTempDir()
    const imageDir = join(dir, 'images')
    await mkdir(imageDir)
    await writeFile(join(outside, 'secret.png'), 'secret', 'utf8')
    await symlink(join(outside, 'secret.png'), join(imageDir, 'leak.png'))

    expect(safeMarkdownImageSrc('images/leak.png', join(dir, 'readme.md'))).toBeNull()
  })

  it('caps local image filesystem checks during document rendering', async () => {
    const dir = await createTempDir()
    const imageDir = join(dir, 'images')
    await mkdir(imageDir)
    await writeFile(join(imageDir, 'a.png'), 'fake png', 'utf8')
    const localPath = join(dir, 'readme.md')
    const markdown = Array.from({ length: 101 }, (_value, index) => `![shot ${index}](images/a.png)`).join('\n\n')

    const rendered = renderMarkdownDocument(markdown, { localPath })

    expect(rendered.html.match(/<img /gu)).toHaveLength(100)
  })

  it('encodes browse href path segments with special characters', () => {
    const href = toBrowseHref('/tmp/A B/(draft)#1?.md')

    expect(href).toBe('/codex-local-browse/tmp/A%20B/(draft)%231%3F.md')
  })

  it('builds a standalone viewer with toolbar, state shell, and nonce script', () => {
    const html = createMarkdownViewerHtml({
      localPath: '/tmp/docs/readme.md',
      nonce: 'abc123',
      markdown: 'Hello [safe](https://example.com) [bad](javascript:alert(1))',
      newProjectName: 'Draft Project',
    })

    expect(html).toContain('class="markdown-viewer-page"')
    expect(html).toContain('aria-label="Markdown viewer actions"')
    expect(html).toContain('script nonce="abc123"')
    expect(html).toContain('id="reloadButton"')
    expect(html).not.toContain('onclick=')
    expect(html).toContain('Raw</a>')
    expect(html).toContain('/codex-local-browse/tmp/docs?newProjectName=Draft%20Project')
    expect(html).toContain('/codex-local-browse/tmp/docs/readme.md?newProjectName=Draft%20Project&amp;raw=1')
    expect(html).toContain('/codex-local-edit/tmp/docs/readme.md?newProjectName=Draft%20Project')
    expect(html).toContain('target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('[bad](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
  })

  it('escapes local paths embedded in the toolbar script', () => {
    const html = createMarkdownViewerHtml({
      localPath: '/tmp/a</script>/readme.md',
      nonce: 'abc123',
      markdown: '# Title',
    })

    expect(html.match(/<\/script>/gu)).toHaveLength(1)
    expect(html).toContain('/tmp/a&lt;/script&gt;/readme.md')
    expect(html).toContain('/tmp/a<\\/script>/readme.md')
  })

  it('does not need filesystem access while rendering markdown content', async () => {
    const dir = await createTempDir()
    const localPath = join(dir, 'readme.md')
    await writeFile(localPath, '# Title', 'utf8')

    const rendered = renderMarkdownDocument('# Title', { localPath })

    expect(rendered.html).toBe('<h1 id="title">Title</h1>')
  })
})
