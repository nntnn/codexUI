import { realpathSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize, relative } from 'node:path'
import { escapeForInlineScriptString, escapeHtml, toBrowseHref, toEditHref } from './localBrowseUi.js'

const SAFE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const UNSAFE_PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:/iu
const MAX_RENDERED_LOCAL_IMAGES = 100

export type MarkdownViewerState = 'empty' | 'too-large' | 'missing' | 'render-failed'

type ViewerOptions = {
  localPath: string
  markdown?: string
  nonce: string
  state?: MarkdownViewerState
  errorMessage?: string
  newProjectName?: string
}

type SafeHrefResult = {
  html: string
  external: boolean
}

type RenderContext = {
  localPath: string
  newProjectName: string
  localImageChecks: number
  realBaseDir?: string | null
  imageRealpathCache: Map<string, string | null>
}

function createRenderContext(localPath: string, newProjectName = ''): RenderContext {
  return {
    localPath,
    newProjectName,
    localImageChecks: 0,
    imageRealpathCache: new Map(),
  }
}

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '')
}

function decodeForProtocolCheck(value: string): string {
  let current = value
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const decoded = decodeURIComponent(current)
      if (decoded === current) return decoded
      current = decoded
    } catch {
      return current
    }
  }
  return current
}

function isInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const rel = relative(directoryPath, candidatePath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function resolveLocalReference(rawHref: string, localPath: string): string {
  if (isAbsolute(rawHref)) return normalize(rawHref)
  return normalize(join(dirname(localPath), rawHref))
}

function decodeLocalMarkdownPath(rawPath: string): string | null {
  const decodedSegments: string[] = []
  for (const segment of rawPath.split('/')) {
    try {
      const decoded = decodeURIComponent(segment)
      if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\u0000')) return null
      decodedSegments.push(decoded)
    } catch {
      return null
    }
  }
  return decodedSegments.join('/')
}

function splitLocalHrefFragment(rawHref: string): { pathPart: string, fragment: string } | null {
  const hashIndex = rawHref.indexOf('#')
  if (hashIndex < 0) return { pathPart: rawHref, fragment: '' }
  const fragment = rawHref.slice(hashIndex + 1)
  if (fragment && !/^[a-z0-9_.:-]+$/iu.test(fragment)) return null
  return {
    pathPart: rawHref.slice(0, hashIndex),
    fragment,
  }
}

export function isMarkdownViewerPath(localPath: string): boolean {
  const extension = extname(localPath).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

export function safeMarkdownHref(rawHref: string, localPath: string, newProjectName = ''): SafeHrefResult | null {
  const trimmed = stripControls(rawHref.trim())
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return null
  const protocolProbe = decodeForProtocolCheck(trimmed).trim().toLowerCase()
  if (protocolProbe.startsWith('//')) return null
  if (protocolProbe.startsWith('#')) {
    const anchor = protocolProbe.slice(1)
    if (!anchor || /^[a-z0-9_.:-]+$/iu.test(anchor)) {
      return { html: `#${escapeHtml(trimmed.slice(1))}`, external: false }
    }
    return null
  }
  if (UNSAFE_PROTOCOL_PATTERN.test(protocolProbe)) {
    try {
      const url = new URL(trimmed)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { html: escapeHtml(url.toString()), external: true }
      }
      if (url.protocol === 'mailto:') {
        return { html: escapeHtml(trimmed), external: false }
      }
    } catch {
      return null
    }
    return null
  }

  const splitHref = splitLocalHrefFragment(trimmed)
  if (!splitHref || !splitHref.pathPart) return null
  const decodedPath = decodeLocalMarkdownPath(splitHref.pathPart)
  if (!decodedPath) return null
  const resolved = resolveLocalReference(decodedPath, localPath)
  const fragment = splitHref.fragment ? `#${encodeURIComponent(splitHref.fragment)}` : ''
  return { html: escapeHtml(`${toBrowseHref(resolved, newProjectName)}${fragment}`), external: false }
}

export function safeMarkdownImageSrc(rawSrc: string, localPath: string, context?: RenderContext): string | null {
  const trimmed = stripControls(rawSrc.trim())
  if (!trimmed || trimmed.startsWith('//')) return null
  const protocolProbe = decodeForProtocolCheck(trimmed).trim().toLowerCase()
  if (UNSAFE_PROTOCOL_PATTERN.test(protocolProbe) || protocolProbe.startsWith('//')) return null

  const decodedPath = decodeLocalMarkdownPath(trimmed)
  if (!decodedPath) return null
  const resolved = resolveLocalReference(decodedPath, localPath)
  const baseDir = dirname(localPath)
  if (!isInsideDirectory(resolved, baseDir)) return null
  if (!SAFE_IMAGE_EXTENSIONS.has(extname(resolved).toLowerCase())) return null
  if (context) {
    if (context.localImageChecks >= MAX_RENDERED_LOCAL_IMAGES) return null
    context.localImageChecks += 1
  }
  try {
    let realBaseDir: string
    if (context) {
      if (context.realBaseDir === undefined) context.realBaseDir = realpathSync(baseDir)
      if (context.realBaseDir === null) return null
      realBaseDir = context.realBaseDir
    } else {
      realBaseDir = realpathSync(baseDir)
    }
    let realImagePath: string
    if (context) {
      const cachedImagePath = context.imageRealpathCache.get(resolved)
      if (cachedImagePath === null) return null
      if (cachedImagePath) {
        realImagePath = cachedImagePath
      } else {
        realImagePath = realpathSync(resolved)
        context.imageRealpathCache.set(resolved, realImagePath)
      }
    } else {
      realImagePath = realpathSync(resolved)
    }
    if (!isInsideDirectory(realImagePath, realBaseDir)) return null
  } catch {
    if (context) {
      if (context.realBaseDir === undefined) context.realBaseDir = null
      context.imageRealpathCache.set(resolved, null)
    }
    return null
  }
  return `/codex-local-image?path=${encodeURIComponent(resolved)}`
}

function renderInline(value: string, context: RenderContext): string {
  const codeSegments: string[] = []
  const htmlSegments: string[] = []
  const htmlToken = (html: string) => {
    const token = `\u0000HTML${htmlSegments.length}\u0000`
    htmlSegments.push(html)
    return token
  }
  let rendered = value.replace(/`([^`]+)`/gu, (_match, code: string) => {
    const token = `\u0000CODE${codeSegments.length}\u0000`
    codeSegments.push(`<code>${escapeHtml(code)}</code>`)
    return token
  })

  rendered = rendered.replace(/!\[([^\]]*)\]\(((?:[^()\s]+|\([^()]*\))+)(?:\s+"[^"]*")?\)/gu, (match, alt: string, src: string) => {
    const safeSrc = safeMarkdownImageSrc(src, context.localPath, context)
    if (!safeSrc) return match
    return htmlToken(`<img src="${escapeHtml(safeSrc)}" alt="${escapeHtml(alt)}" loading="lazy" />`)
  })

  rendered = rendered.replace(/\[([^\]]+)\]\(((?:[^()\s]+|\([^()]*\))+)(?:\s+"[^"]*")?\)/gu, (match, label: string, href: string) => {
    const safeHref = safeMarkdownHref(href, context.localPath, context.newProjectName)
    if (!safeHref) return match
    const targetAttrs = safeHref.external ? ' target="_blank" rel="noopener noreferrer"' : ''
    return htmlToken(`<a href="${safeHref.html}"${targetAttrs}>${renderInline(label, context)}</a>`)
  })

  rendered = escapeHtml(rendered)
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/__([^_]+)__/gu, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/gu, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/gu, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/gu, '$1<em>$2</em>')

  codeSegments.forEach((html, index) => {
    rendered = rendered.replace(new RegExp(`\\u0000CODE${index}\\u0000`, 'gu'), html)
  })
  htmlSegments.forEach((html, index) => {
    rendered = rendered.replace(new RegExp(`\\u0000HTML${index}\\u0000`, 'gu'), html)
  })
  return rendered
}

function renderList(lines: string[], startIndex: number, ordered: boolean, context: RenderContext): { html: string, nextIndex: number } {
  const items: string[] = []
  let index = startIndex
  const pattern = ordered ? /^\s*\d+\.\s+(.*)$/u : /^\s*[-*+]\s+(.*)$/u
  while (index < lines.length) {
    const match = lines[index]?.match(pattern)
    if (!match) break
    let item = match[1] ?? ''
    let checkboxHtml = ''
    const task = item.match(/^\[( |x|X)\]\s+(.*)$/u)
    if (task) {
      const isChecked = (task[1] ?? '').toLowerCase() === 'x'
      checkboxHtml = `<input type="checkbox" disabled${isChecked ? ' checked' : ''} aria-label="${isChecked ? 'Completed' : 'Incomplete'} task" /> `
      item = task[2] ?? ''
    }
    items.push(`<li>${checkboxHtml}${renderInline(item, context)}</li>`)
    index += 1
  }
  return {
    html: `<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`,
    nextIndex: index,
  }
}

function renderTable(lines: string[], startIndex: number, context: RenderContext): { html: string, nextIndex: number } | null {
  const header = lines[startIndex]
  const separator = lines[startIndex + 1]
  if (!header || !separator || !header.includes('|')) return null
  if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(separator)) return null

  const splitCells = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
  const headers = splitCells(header)
  const rows: string[][] = []
  let index = startIndex + 2
  while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
    rows.push(splitCells(lines[index] ?? ''))
    index += 1
  }
  const headerHtml = headers.map((cell) => `<th>${renderInline(cell, context)}</th>`).join('')
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, context)}</td>`).join('')}</tr>`)
    .join('')
  return {
    html: `<div class="markdown-table-scroll"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index,
  }
}

function createHeadingId(rawHeading: string, counts: Map<string, number>): string {
  const plainText = rawHeading
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[`*_~]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_.-]+/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  const base = plainText || 'section'
  const count = counts.get(base) ?? 0
  counts.set(base, count + 1)
  return count === 0 ? base : `${base}-${count + 1}`
}

export function renderMarkdownDocument(markdown: string, options: { localPath: string, newProjectName?: string }, context = createRenderContext(options.localPath, options.newProjectName ?? '')): { html: string, hasH1: boolean } {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: string[] = []
  const headingCounts = new Map<string, number>()
  let index = 0
  let hasH1 = false

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/u)
    if (fence) {
      const language = fence[1] ?? ''
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : ''
      blocks.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/u)
    if (heading) {
      const level = heading[1]?.length ?? 1
      if (level === 1) hasH1 = true
      const rawHeading = heading[2] ?? ''
      const headingId = createHeadingId(rawHeading, headingCounts)
      blocks.push(`<h${level} id="${escapeHtml(headingId)}">${renderInline(rawHeading, context)}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*[-*_]{3,}\s*$/u.test(line)) {
      blocks.push('<hr />')
      index += 1
      continue
    }

    const table = renderTable(lines, index, context)
    if (table) {
      blocks.push(table.html)
      index = table.nextIndex
      continue
    }

    if (/^\s*>\s?/u.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^\s*>\s?/u.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^\s*>\s?/u, ''))
        index += 1
      }
      const rendered = renderMarkdownDocument(quoteLines.join('\n'), options, context).html
      blocks.push(`<blockquote>${rendered}</blockquote>`)
      continue
    }

    if (/^\s*[-*+]\s+/u.test(line)) {
      const list = renderList(lines, index, false, context)
      blocks.push(list.html)
      index = list.nextIndex
      continue
    }

    if (/^\s*\d+\.\s+/u.test(line)) {
      const list = renderList(lines, index, true, context)
      blocks.push(list.html)
      index = list.nextIndex
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length && (lines[index] ?? '').trim() && !/^(#{1,6})\s+/u.test(lines[index] ?? '') && !/^```/u.test(lines[index] ?? '') && !/^\s*([-*+]|\d+\.)\s+/u.test(lines[index] ?? '') && !/^\s*>\s?/u.test(lines[index] ?? '')) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    blocks.push(`<p>${renderInline(paragraph.join(' '), context)}</p>`)
  }

  return { html: blocks.join('\n'), hasH1 }
}

function createStateMessage(state: MarkdownViewerState, errorMessage = ''): string {
  switch (state) {
    case 'empty':
      return 'This markdown file is empty.'
    case 'too-large':
      return 'Preview skipped because this file is larger than the 1 MiB preview limit.'
    case 'missing':
      return 'File not found.'
    case 'render-failed':
      return errorMessage || 'Preview failed. Raw markdown is still available.'
  }
}

function rawHref(localPath: string, newProjectName = ''): string {
  const href = toBrowseHref(localPath, newProjectName)
  return `${href}${href.includes('?') ? '&' : '?'}raw=1`
}

export function createMarkdownViewerHtml(options: ViewerOptions): string {
  const parentPath = dirname(options.localPath)
  const filename = options.localPath.split(/[\\/]/u).pop() || options.localPath
  const title = options.state ? filename : filename
  const newProjectName = options.newProjectName ?? ''
  const localPathScriptLiteral = escapeForInlineScriptString(options.localPath)
  let articleHtml = ''
  if (options.state) {
    articleHtml = `<section class="markdown-viewer-state"><h1>${escapeHtml(createStateMessage(options.state, options.errorMessage))}</h1><p>${escapeHtml(options.localPath)}</p></section>`
  } else {
    const markdown = options.markdown ?? ''
    if (!markdown.trim()) {
      articleHtml = `<section class="markdown-viewer-state"><h1>${escapeHtml(createStateMessage('empty'))}</h1><p>${escapeHtml(options.localPath)}</p></section>`
    } else {
      const rendered = renderMarkdownDocument(markdown, { localPath: options.localPath, newProjectName })
      articleHtml = `${rendered.hasH1 ? '' : `<h1>${escapeHtml(filename)}</h1>`}${rendered.html}`
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f8fb;
      --surface: #ffffff;
      --border: #d8dee8;
      --text: #18202c;
      --muted: #5e6b7e;
      --link: #245fb8;
      --code-bg: #eef2f7;
      --toolbar-bg: rgba(255,255,255,0.94);
      --focus: #2f7df6;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1020;
        --surface: #101827;
        --border: #26354d;
        --text: #e8eef8;
        --muted: #a8b4c6;
        --link: #8cc2ff;
        --code-bg: #172236;
        --toolbar-bg: rgba(11,16,32,0.94);
        --focus: #8cc2ff;
      }
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: var(--bg); }
    body.markdown-viewer-page { margin: 0; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 16px; line-height: 1.6; overflow-x: hidden; }
    a { color: var(--link); }
    a:focus-visible, button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
    .markdown-viewer-toolbar { position: sticky; top: 0; z-index: 20; padding: calc(env(safe-area-inset-top) + 8px) 16px 8px; background: var(--toolbar-bg); border-bottom: 1px solid var(--border); backdrop-filter: blur(10px); }
    .markdown-viewer-toolbar-inner { max-width: 820px; margin: 0 auto; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 8px 12px; align-items: center; }
    .markdown-viewer-title { min-width: 0; }
    .markdown-viewer-filename { font-weight: 700; overflow-wrap: anywhere; }
    .markdown-viewer-path { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .markdown-viewer-actions { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; min-height: 44px; align-items: center; }
    .markdown-viewer-actions a, .markdown-viewer-actions button, .markdown-viewer-back { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 8px; padding: 0 12px; background: var(--surface); color: var(--text); text-decoration: none; font: inherit; cursor: pointer; }
    .markdown-viewer-actions a:hover, .markdown-viewer-actions button:hover, .markdown-viewer-back:hover { filter: brightness(0.97); text-decoration: none; }
    .markdown-viewer-copy-status { min-width: 92px; color: var(--muted); font-size: 12px; min-height: 1.4em; }
    .markdown-viewer-main { width: 100%; }
    .markdown-viewer-article { max-width: 820px; margin: 0 auto; padding: 16px; }
    .markdown-viewer-article h1 { font-size: clamp(24px, 5vw, 28px); line-height: 1.18; margin: 20px 0 12px; }
    .markdown-viewer-article h2 { font-size: clamp(21px, 4vw, 23px); line-height: 1.25; margin: 22px 0 10px; }
    .markdown-viewer-article h3, .markdown-viewer-article h4, .markdown-viewer-article h5, .markdown-viewer-article h6 { margin: 18px 0 8px; line-height: 1.3; }
    .markdown-viewer-article p, .markdown-viewer-article ul, .markdown-viewer-article ol, .markdown-viewer-article blockquote { margin: 12px 0; }
    .markdown-viewer-article blockquote { border-left: 4px solid var(--border); padding-left: 14px; color: var(--muted); }
    .markdown-viewer-article code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; background: var(--code-bg); border-radius: 5px; padding: 2px 4px; }
    .markdown-viewer-article pre { overflow-x: auto; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
    .markdown-viewer-article pre code { display: block; padding: 0; background: transparent; white-space: pre; }
    .markdown-viewer-article img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--border); }
    .markdown-table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
    table { border-collapse: collapse; min-width: 100%; }
    th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: var(--code-bg); font-weight: 700; }
    .markdown-viewer-state { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 16px; margin-top: 16px; }
    .markdown-viewer-state h1 { margin-top: 0; }
    @media (min-width: 641px) {
      .markdown-viewer-toolbar-inner { grid-template-columns: auto minmax(0,1fr) auto; }
      .markdown-viewer-actions { grid-column: auto; justify-content: flex-end; }
      .markdown-viewer-article { padding: 24px; line-height: 1.65; }
    }
  </style>
</head>
<body class="markdown-viewer-page">
  <nav class="markdown-viewer-toolbar" aria-label="Markdown viewer actions">
    <div class="markdown-viewer-toolbar-inner">
      <a class="markdown-viewer-back" href="${escapeHtml(toBrowseHref(parentPath, newProjectName))}">Back</a>
      <div class="markdown-viewer-title">
        <div class="markdown-viewer-filename">${escapeHtml(filename)}</div>
        <div class="markdown-viewer-path">${escapeHtml(options.localPath)}</div>
      </div>
      <div class="markdown-viewer-actions">
        <a href="${escapeHtml(rawHref(options.localPath, newProjectName))}">Raw</a>
        <a href="${escapeHtml(toEditHref(options.localPath, newProjectName))}">Edit</a>
        <button type="button" id="copyPathButton">Copy path</button>
        <button type="button" id="reloadButton">Reload</button>
        <span id="copyStatus" class="markdown-viewer-copy-status" aria-live="polite"></span>
      </div>
    </div>
  </nav>
  <main class="markdown-viewer-main">
    <article class="markdown-viewer-article">${articleHtml}</article>
  </main>
  <script nonce="${escapeHtml(options.nonce)}">
    const copyButton = document.getElementById('copyPathButton');
    const copyStatus = document.getElementById('copyStatus');
    copyButton?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(${localPathScriptLiteral});
        copyStatus.textContent = 'Path copied';
      } catch {
        copyStatus.textContent = 'Copy failed';
      }
    });
    document.getElementById('reloadButton')?.addEventListener('click', () => {
      location.reload();
    });
  </script>
</body>
</html>`
}
