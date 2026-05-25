# Concept: Local Markdown Viewer

## Summary

Codex UI can add a Chrome-extension-like markdown viewer with low system
intrusion by extending the existing local file browser route. The recommended
shape is a standalone server-rendered HTML viewer for markdown files opened via
`/codex-local-browse/*`, not a new Vue route in the main SPA.

Source:
- [Local markdown viewer attachment review](../../raw/features/local-markdown-viewer-attachment-review.md)
- [Local markdown viewer implementation](../../raw/features/local-markdown-viewer-implementation.md)

## Recommended Attachment Point

Use the server-owned local browse route:

- `/codex-local-browse/*path` already decodes absolute local paths.
- It already distinguishes directories from files.
- It already renders standalone HTML for directories through
  `createDirectoryListingHtml`.
- It already serves editable text files through `/codex-local-edit/*path`.

The implementation should centralize the browse decision in a shared server
module so production `httpServer.ts` and Vite dev middleware do not drift. The
viewer HTML and markdown parsing should live in a pure server module separate
from directory and editor HTML.

This keeps existing links stable. A link such as
`/codex-local-browse/home/user/project/README.md` can start showing the viewer
without changing chat rendering, skill cards, or directory browse links.

## Why Not Start With A Vue Route

The SPA router is intentionally thin: home, thread, skills, a new-thread
redirect, and fallback. Most display branching lives in `App.vue`, where the
thread conversation, review pane, composer, terminal, Directory Hub, and other
surfaces are assembled.

A dedicated Vue markdown viewer route would require additional App-level
branching and client-side local-file APIs. That may be useful later, but it is
more invasive than extending the route that already owns local file browsing.

## Existing Markdown Capability

`ThreadConversation.vue` already contains a limited markdown parser and HTML
renderer for chat and plan-card content. It supports:

- headings
- paragraphs
- blockquotes
- unordered, ordered, and task lists
- tables
- fenced code blocks
- thematic breaks
- markdown images
- inline bold, italic, strikethrough, code, URL links, and local file links
- bounded caches for parsed blocks, inline segments, rendered HTML, and
  highlighted code
- lazy `highlight.js` loading

This renderer proves the app already has enough markdown semantics for a
viewer. However, the implementation is embedded inside a Vue component and tied
to component state such as `cwd`, highlighter refs, caches, and message-specific
rendering. Extract it only if exact renderer parity is required.

## Viewer UX Shape

The viewer should behave like a document tab:

- open from existing local browse links in a normal browser tab
- sticky top toolbar with Back, Raw, Edit, and Copy path
- path visible but compact
- centered readable article width on desktop
- full-width content and touch-sized controls on mobile
- light and dark theme support
- code fences highlighted consistently with current app code blocks

For local file links and images inside markdown, resolve relative paths against
the markdown file directory. Clicked links can navigate through the existing
authenticated local browse route. Auto-rendered local images are stricter:
only `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp` may render, and only when the
resolved path stays inside the markdown file directory tree. SVG and external
images are not auto-embedded in v1.

## Constraints

- Keep auth middleware ordering unchanged.
- Keep absolute path validation in the server route.
- Escape markdown-rendered HTML by default.
- Do not render raw HTML from markdown unless a sanitizer is deliberately added.
- Use allowlist-based URL handling. Escaping alone does not make
  `javascript:` or `data:` hrefs safe.
- Bound markdown preview reads to 1 MiB plus one byte instead of relying on
  `stat` as the final guard.
- Add CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  and `Cache-Control: private, no-store` on viewer HTML responses.
- Preserve directory browse and non-markdown raw file behavior.
- Keep `.md` editable through `/codex-local-edit/*path`.
- Treat `.mdx` as an explicit product decision, because markdown-only rendering
  may not match MDX semantics.

## Verification Notes

When implemented, verify:

- `/codex-local-browse/.../README.md` returns viewer HTML.
- non-markdown files still return raw file responses.
- directory listing behavior is unchanged.
- toolbar Back, Raw, Edit, and Copy path work.
- headings, lists, task lists, blockquotes, tables, links, images, and code
  fences render.
- file links still route through `/codex-local-browse`.
- absolute images still route through `/codex-local-image`.
- light and dark themes are readable.
- mobile and desktop layouts are usable.
- large markdown files do not cause unbounded parse or highlight work.
- Vite dev middleware and production server route render markdown with the same
  route decision logic.
- hostile markdown links render inert and do not emit executable `href` values.
