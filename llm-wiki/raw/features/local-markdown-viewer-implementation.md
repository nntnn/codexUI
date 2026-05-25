# Local Markdown Viewer Implementation

Captured: 2026-05-25

## Source Facts

- The approved implementation attaches the viewer to `/codex-local-browse/*.md` and `/codex-local-browse/*.markdown`.
- `ThreadConversation.vue` remains unchanged for v1. Existing chat file links benefit because they already point to `/codex-local-browse`.
- Browse route decisions are centralized in `src/server/localBrowseRoute.ts` so production `src/server/httpServer.ts` and the Vite dev middleware can share the same behavior.
- Markdown rendering lives in `src/server/localMarkdownViewer.ts`, separate from directory and editor HTML in `src/server/localBrowseUi.ts`.
- The renderer supports a deliberately narrow subset: headings, paragraphs, blockquotes, lists, task lists, fenced code, inline code, bold, italic, strikethrough, simple pipe tables, links, and images.
- Raw HTML is escaped. Unsupported markdown renders as escaped text rather than unsafe partial HTML.
- The route preserves raw markdown behavior when `raw=1` is present.
- `.mdx` is not auto-rendered by the markdown viewer.
- Preview reads are bounded to 1 MiB plus one byte, preventing unbounded `readFile` behavior.
- Viewer HTML adds CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: private, no-store`.
- Link rewriting is allowlist-based. Dangerous protocols such as `javascript:`, `data:`, `vbscript:`, protocol-relative URLs, malformed URLs, and control-character-prefixed URLs are rendered inert.
- Relative local images auto-render only for `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp` when the resolved path stays inside the markdown file directory tree.
- SVG and external images are not auto-embedded in v1.

## Verification Obligations

- Unit tests must cover renderer output, hostile links, image confinement, path encoding, raw bypass, oversized files, missing files, directories, and non-markdown files.
- Browser verification must cover TestChat file-link flow, desktop light/dark, mobile light/dark at 375x812, and tablet at 768x1024.
- Performance verification must inspect browser runtime profile output for duplicate requests, warnings, request payload size, and slow API rows.
