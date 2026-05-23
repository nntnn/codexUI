# Feature: Live-state digest and command output hardening

## Prerequisites / Setup

- Start the app with `pnpm run dev --host 127.0.0.1 --port 4173`.
- Open one short completed thread and one thread containing a large completed command output.
- Keep DevTools Network open with response sizes visible.

## Steps

1. Open the short completed thread.
2. Refresh or reselect the same thread after the first live-state response.
3. Confirm subsequent unchanged `/codex-api/thread-live-state` requests return `204` with no response body.
4. Open a thread while a command or assistant turn is still running.
5. Confirm in-progress `/codex-api/thread-live-state` requests return `200`, not `204`, and visible streaming state continues updating.
6. Open the long-output thread.
7. Expand the command output row.
8. Refresh the route and expand the command output again.
9. Switch to dark theme and repeat steps 6-8.
10. Set a mobile-width viewport around 375px and repeat steps 6-8.

## Expected Results

- Completed unchanged live-state polling uses `204` after the first full response.
- In-progress turns never use fast `204`.
- Provider/model labels, older-message controls, feedback links, and file undo/redo controls still render normally.
- Large command output first shows a preview with size metadata, then loads the full output inline.
- If full output cannot be recovered, the preview remains visible and the row shows retryable inline failure state.
- Light and dark themes keep preview, expanded output, loading, and failure text readable.
- Mobile width does not create page-level horizontal overflow.

## Rollback / Cleanup

- Clear DevTools Network filters.
- Close the test thread or stop the dev server if it was started only for this test.
- If the digest or output splitting kill switches were toggled, restore default enabled behavior and reload the app.
