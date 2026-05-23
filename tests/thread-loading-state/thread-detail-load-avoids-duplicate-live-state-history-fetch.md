### Thread detail load avoids duplicate live-state history fetch

#### Feature/Change Name
Normal thread detail loading uses `/codex-api/thread-live-state` first and reuses the cached digest response instead of repeatedly fetching the same full live-state payload.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. An existing thread with a large history

#### Steps
1. Open the existing thread
2. Inspect network/RPC calls during the message load
3. Re-open or refresh the same thread while the live-state response cache is still fresh

#### Expected Results
- The initial message load performs `GET /codex-api/thread-live-state?threadId=...`
- A repeat request for unchanged completed live state returns `204 No Content` with the same digest and reuses the cached client payload
- `thread/read` RPC is used only as a fallback when the live-state endpoint fails or cannot provide thread data
- Messages and active/in-progress state still render correctly

#### Rollback/Cleanup
- None

---
