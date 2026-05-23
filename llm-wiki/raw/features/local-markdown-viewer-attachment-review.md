# Local Markdown Viewer Attachment Review

Captured on 2026-05-23 from a read-only repository review requested in Korean:
evaluate whether a Chrome-extension-like markdown viewer can be attached to
Codex UI with low system intrusion, while working on mobile and desktop.

## Question

Can Codex UI add a markdown viewer, similar in feel to Chrome markdown viewer
extensions, without invasive architecture changes?

## Conclusion

Yes. The least intrusive attachment point is the existing server-owned
`/codex-local-browse/*` route. It already resolves and serves absolute local
paths, renders directory listings, and falls back to raw file delivery. A
markdown viewer can special-case markdown-like files before raw `sendFile`,
returning standalone HTML for `.md`, `.markdown`, and possibly `.mdx`.

This avoids adding a new Vue route or pushing more state into the main chat
screen.

## Evidence

- `src/server/httpServer.ts` imports local browse helpers from
  `src/server/localBrowseUi.ts`.
- `src/server/httpServer.ts` installs auth middleware before local file routes.
- `src/server/httpServer.ts` defines:
  - `/codex-local-image`
  - `/codex-local-file`
  - `/codex-local-directories`
  - `/codex-local-browse/*path`
  - `/codex-local-edit/*path`
- `/codex-local-browse/*path` decodes the wildcard path, requires an absolute
  local path, stats it, renders a directory listing for directories, and serves
  files with `res.sendFile`.
- `src/server/localBrowseUi.ts` already treats `.md` as a text-editable
  extension.
- `src/server/localBrowseUi.ts` already generates standalone HTML for directory
  browsing and text editing, including mobile viewport metadata and local CSS.
- `src/components/content/ThreadConversation.vue` already contains a limited
  markdown parser and renderer for chat and plan cards:
  - block types: paragraphs, headings, blockquotes, lists, task lists, ordered
    lists, tables, code blocks, thematic breaks, images
  - inline segments: text, bold, italic, strikethrough, code, URLs, local file
    links
  - caches for message blocks, inline segments, rendered markdown HTML, and
    highlighted code
  - lazy `highlight.js/lib/common` loading for code highlighting
- `src/router/index.ts` uses a very thin hash-router surface: home, thread,
  skills, new-thread redirect, and fallback.
- `src/App.vue` owns most screen selection, including the thread conversation,
  review pane, composer, and terminal panel.
- `src/components/layout/DesktopLayout.vue` already switches between desktop
  sidebar layout and mobile drawer at the shared mobile breakpoint.
- `src/style.css` contains global dark-theme overrides for message markdown
  primitives, plan-card markdown, file links, tables, code blocks, and app
  surfaces.
- `tests.md` already has manual coverage for markdown file links, file-link
  context menus, light/dark contrast, and plan-card markdown styling.

## Ranked Implementation Options

### 1. Server-side standalone viewer for markdown files

Recommended.

Add `createMarkdownViewerHtml(localPath)` to `src/server/localBrowseUi.ts` and
call it from `/codex-local-browse/*path` when the file extension is markdown.
The viewer should provide:

- sticky toolbar with Back, Raw, Edit, and Copy path actions
- responsive reading column
- light and dark theme support
- code highlighting
- local image/file link handling where feasible

Why this is low intrusion:

- keeps existing `/codex-local-browse/.../README.md` links stable
- does not require a new SPA route
- does not alter chat thread state or routing
- keeps local-file security posture in the existing server path
- matches the current standalone HTML pattern used by directory browse and
  text edit pages

### 2. Extract chat markdown parser/renderer into a shared module

Feasible, but a larger refactor.

The current chat renderer has useful support for file links, relative path
resolution, images, tables, task lists, and code highlighting. However, it is
embedded inside `ThreadConversation.vue` and depends on component props such as
`cwd`, Vue refs, caches, and message-specific behavior.

Extraction would reduce duplication if the viewer needs exact chat markdown
parity, but it should be a second step unless parity is mandatory.

### 3. Add a Vue SPA markdown viewer route

Not preferred for the first implementation.

The current router is intentionally thin and App owns most display decisions.
A new `#/markdown-viewer` or similar route would add App branching and client
fetch APIs for local markdown content. It may be useful later for integrated
navigation, but it is more invasive than extending the existing browse route.

## Design Notes

The requested "Chrome extension markdown viewer" feel maps well to a document
viewer rather than an app panel:

- open markdown links in a new tab from file links, skill cards, or directory
  browse
- keep the path visible in a compact toolbar
- use a centered, readable article column on desktop
- use full-width, touch-friendly controls on mobile
- preserve raw/edit affordances for developer workflows

Avoid coupling the viewer to chat-specific scrolling, message virtualization,
or thread state.

## Security And Correctness Constraints

- Escape HTML by default; do not inject raw markdown HTML unless a sanitizer is
  introduced and audited.
- Keep local path validation in the server route.
- Keep auth middleware ordering unchanged.
- Prefer existing helpers for `decodeBrowsePath`, `normalizeLocalPath`,
  `toBrowseHref`, and `toEditHref`.
- If supporting local images, route absolute image paths through
  `/codex-local-image`.
- If supporting file links, route absolute or cwd-resolved file paths through
  `/codex-local-browse`.

## Verification Shape

For implementation, add or run checks covering:

- `.md` served via `/codex-local-browse/...` returns viewer HTML, not raw text
- non-markdown files still use raw `sendFile`
- directory browse behavior is unchanged
- toolbar Back/Raw/Edit links point to the expected routes
- markdown headings, lists, tables, task lists, code fences, blockquotes, and
  file links render
- light and dark theme contrast
- desktop and mobile viewport behavior
- large markdown files do not trigger unbounded repeated parsing

Manual docs should be added to `tests.md` if this becomes an implementation
task.

## Open Questions

- Should `.mdx` render as markdown-only text, or remain raw because MDX can
  include JSX semantics?
- Should the viewer reuse chat markdown styling exactly, or intentionally use a
  separate document-reader style?
- Should relative image/file links resolve against the markdown file directory
  or the current Codex project cwd? For a file viewer, the markdown file
  directory is likely the correct base.
