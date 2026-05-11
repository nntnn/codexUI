import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJsonResponse } from './httpResponse.js'

type JsonRecord = Record<string, unknown>

export type CommandOutputBlockEntry = {
  threadId: string
  itemId: string
  digest: string
  output: string
  bytes: number
  expiresAt: number
}

export type CommandOutputBlockStats = {
  blockCount: number
  fullBytes: number
  previewBytes: number
}

export type LiveStateDigestMetadata = {
  threadId: string
  digest: string
  generation: number
  sessionPath: string
  sessionSize: number
  sessionMtimeMs: number
  isInProgress: boolean
  expiresAt: number
}

export type LiveStateSessionStat = {
  size: number
  mtimeMs: number
}

export type PreparedLiveStateResponse = {
  data: unknown
  digest: string
  statusCode: 200 | 204
  stats: CommandOutputBlockStats
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

function readEnvValueFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = content.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+)\\s*$`, 'm'))
    if (!match) return null
    const rawValue = match[1]?.trim() ?? ''
    if (!rawValue) return null
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
      return rawValue.slice(1, -1).trim()
    }
    return rawValue
  } catch {
    return null
  }
}

function readEnvConfigValue(envKey: string): string | null {
  const fromProcess = process.env[envKey]
  if (typeof fromProcess === 'string' && fromProcess.trim().length > 0) return fromProcess
  return readEnvValueFromFile('.env.local', envKey) ?? readEnvValueFromFile('.env', envKey)
}

function parseBooleanEnvFlag(value: string | null | undefined): boolean | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return null
}

function resolveBooleanEnvConfig(envKey: string, fallback: boolean): boolean {
  return parseBooleanEnvFlag(readEnvConfigValue(envKey)) ?? fallback
}

function parseNumberEnvFlag(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function resolveNumericEnvConfig(envKey: string, fallback: number): number {
  return parseNumberEnvFlag(readEnvConfigValue(envKey)) ?? fallback
}

const COMMAND_OUTPUT_BLOCKS_ENABLED = resolveBooleanEnvConfig('CODEXUI_COMMAND_OUTPUT_BLOCKS_ENABLED', true)
const COMMAND_OUTPUT_BLOCK_MIN_BYTES = Math.max(1024, Math.floor(resolveNumericEnvConfig('CODEXUI_COMMAND_OUTPUT_BLOCK_MIN_BYTES', 32768)))
const COMMAND_OUTPUT_BLOCK_PREVIEW_BYTES = Math.max(1024, Math.floor(resolveNumericEnvConfig('CODEXUI_COMMAND_OUTPUT_BLOCK_PREVIEW_BYTES', 8192)))
const COMMAND_OUTPUT_BLOCK_RESPONSE_BUDGET_BYTES = Math.max(4096, Math.floor(resolveNumericEnvConfig('CODEXUI_COMMAND_OUTPUT_BLOCK_RESPONSE_BUDGET_BYTES', 98304)))
const COMMAND_OUTPUT_BLOCK_CACHE_MAX_BYTES = Math.max(1024 * 1024, Math.floor(resolveNumericEnvConfig('CODEXUI_COMMAND_OUTPUT_BLOCK_CACHE_MAX_BYTES', 64 * 1024 * 1024)))
const THREAD_READ_SNAPSHOT_CACHE_MAX_BYTES = Math.max(1024 * 1024, Math.floor(resolveNumericEnvConfig('CODEXUI_THREAD_READ_SNAPSHOT_CACHE_MAX_BYTES', 16 * 1024 * 1024)))
const THREAD_READ_SNAPSHOT_CACHE_TTL_MS = Math.max(10_000, Math.floor(resolveNumericEnvConfig('CODEXUI_THREAD_READ_SNAPSHOT_CACHE_TTL_MS', 300_000)))
const LIVE_STATE_COMPLETED_CACHE_MAX_BYTES = Math.max(1024 * 1024, Math.floor(resolveNumericEnvConfig('CODEXUI_LIVE_STATE_COMPLETED_CACHE_MAX_BYTES', 32 * 1024 * 1024)))
const LIVE_STATE_COMPLETED_CACHE_TTL_MS = Math.max(10_000, Math.floor(resolveNumericEnvConfig('CODEXUI_LIVE_STATE_COMPLETED_CACHE_TTL_MS', 300_000)))
const LIVE_STATE_DIGEST_ENABLED = resolveBooleanEnvConfig('CODEXUI_LIVE_STATE_DIGEST_ENABLED', true)
const COMMAND_OUTPUT_BLOCK_MAX_ENTRIES = 1024
const THREAD_READ_SNAPSHOT_CACHE_MAX_ENTRIES = 8
const LIVE_STATE_COMPLETED_CACHE_MAX_ENTRIES = 16
const LIVE_STATE_DIGEST_CACHE_MAX_ENTRIES = 512
const COMMAND_OUTPUT_BLOCK_TTL_MS = 30 * 60 * 1000
const LIVE_STATE_DIGEST_CACHE_TTL_MS = 30 * 1000

const commandOutputBlockCache = new Map<string, CommandOutputBlockEntry>()
const liveStateDigestCache = new Map<string, LiveStateDigestMetadata>()

export function getThreadReadSnapshotCacheLimits(): { maxEntries: number; maxBytes: number; ttlMs: number } {
  return {
    maxEntries: THREAD_READ_SNAPSHOT_CACHE_MAX_ENTRIES,
    maxBytes: THREAD_READ_SNAPSHOT_CACHE_MAX_BYTES,
    ttlMs: THREAD_READ_SNAPSHOT_CACHE_TTL_MS,
  }
}

export function getCompletedLiveStateCacheLimits(): { maxEntries: number; maxBytes: number; ttlMs: number } {
  return {
    maxEntries: LIVE_STATE_COMPLETED_CACHE_MAX_ENTRIES,
    maxBytes: LIVE_STATE_COMPLETED_CACHE_MAX_BYTES,
    ttlMs: LIVE_STATE_COMPLETED_CACHE_TTL_MS,
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

export function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return -1
  }
}

function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

export function hashCommandOutput(value: string): string {
  return sha1(value)
}

function decodeUtf8Window(buffer: Buffer, start: number, end: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const currentStart = Math.max(0, Math.min(buffer.length, start))
  const currentEnd = Math.max(currentStart, Math.min(buffer.length, end))
  for (let startOffset = 0; startOffset < 4 && currentStart + startOffset < currentEnd; startOffset += 1) {
    for (let endOffset = 0; endOffset < 4 && currentEnd - endOffset > currentStart + startOffset; endOffset += 1) {
      try {
        return decoder.decode(buffer.subarray(currentStart + startOffset, currentEnd - endOffset))
      } catch {
        // Try a smaller UTF-8 window.
      }
    }
  }
  return ''
}

function createCommandOutputPreview(output: string, fullBytes: number, budgetBytes: number): string {
  const outputBuffer = Buffer.from(output, 'utf8')
  const markerPrefix = '\n\n--- CodexApp output preview: showing '
  const markerSuffix = ` of ${fullBytes} bytes. Expand to load full output. ---\n\n`
  const markerReserve = byteLengthUtf8(`${markerPrefix}${String(Math.min(fullBytes, budgetBytes))}${markerSuffix}`)
  const contentBudget = Math.max(256, Math.min(fullBytes, budgetBytes) - markerReserve)
  const headBytes = Math.ceil(contentBudget / 2)
  const tailBytes = Math.floor(contentBudget / 2)
  const head = decodeUtf8Window(outputBuffer, 0, Math.min(outputBuffer.length, headBytes))
  const tail = decodeUtf8Window(outputBuffer, Math.max(0, outputBuffer.length - tailBytes), outputBuffer.length)
  const shownBytes = byteLengthUtf8(head) + byteLengthUtf8(tail)
  return `${head}${markerPrefix}${shownBytes}${markerSuffix}${tail}`
}

function makeCommandOutputBlockId(threadId: string, itemId: string, digest: string): string {
  return sha1(`${threadId}:${itemId}:${digest}`)
}

function getCommandOutputBlockCacheBytes(): number {
  let total = 0
  for (const entry of commandOutputBlockCache.values()) {
    total += entry.bytes
  }
  return total
}

export function pruneCommandOutputBlockCache(now = Date.now()): void {
  for (const [key, entry] of commandOutputBlockCache.entries()) {
    if (entry.expiresAt <= now) commandOutputBlockCache.delete(key)
  }
  while (commandOutputBlockCache.size > COMMAND_OUTPUT_BLOCK_MAX_ENTRIES || getCommandOutputBlockCacheBytes() > COMMAND_OUTPUT_BLOCK_CACHE_MAX_BYTES) {
    const firstKey = commandOutputBlockCache.keys().next().value
    if (typeof firstKey !== 'string') break
    commandOutputBlockCache.delete(firstKey)
  }
}

export function clearLiveStatePayloadRuntime(): void {
  commandOutputBlockCache.clear()
  liveStateDigestCache.clear()
}

export function invalidateLiveStateDigest(threadId: string): void {
  liveStateDigestCache.delete(threadId)
}

export function storeCommandOutputBlock(threadId: string, itemId: string, output: string, digest = hashCommandOutput(output)): string {
  const blockId = makeCommandOutputBlockId(threadId, itemId, digest)
  const bytes = byteLengthUtf8(output)
  if (bytes > COMMAND_OUTPUT_BLOCK_CACHE_MAX_BYTES) return blockId
  commandOutputBlockCache.delete(blockId)
  commandOutputBlockCache.set(blockId, {
    threadId,
    itemId,
    digest,
    output,
    bytes,
    expiresAt: Date.now() + COMMAND_OUTPUT_BLOCK_TTL_MS,
  })
  pruneCommandOutputBlockCache()
  return blockId
}

export function getStoredCommandOutputBlock(
  threadId: string,
  blockId: string,
  itemId: string,
  digest: string,
): CommandOutputBlockEntry | null {
  pruneCommandOutputBlockCache()
  const entry = commandOutputBlockCache.get(blockId)
  if (!entry) return null
  if (entry.threadId !== threadId || entry.itemId !== itemId || entry.digest !== digest) return null
  const refreshed = {
    ...entry,
    expiresAt: Date.now() + COMMAND_OUTPUT_BLOCK_TTL_MS,
  }
  commandOutputBlockCache.delete(blockId)
  commandOutputBlockCache.set(blockId, refreshed)
  return refreshed
}

export function findCommandOutputInTurns(turns: unknown[], itemId: string, digest: string): string | null {
  let matched: string | null = null
  let matchedCount = 0
  for (const turn of turns) {
    const turnRecord = asRecord(turn)
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : []
    for (const item of items) {
      const itemRecord = asRecord(item)
      if (itemRecord?.type !== 'commandExecution') continue
      if (typeof itemRecord.id !== 'string' || itemRecord.id !== itemId) continue
      const output = typeof itemRecord.aggregatedOutput === 'string' ? itemRecord.aggregatedOutput : ''
      if (hashCommandOutput(output) !== digest) continue
      matched = output
      matchedCount += 1
    }
  }
  return matchedCount === 1 ? matched : null
}

export function slimLiveStateCommandOutputs(threadId: string, responseData: unknown): { data: unknown; stats: CommandOutputBlockStats } {
  const emptyStats = { blockCount: 0, fullBytes: 0, previewBytes: 0 }
  if (!COMMAND_OUTPUT_BLOCKS_ENABLED) return { data: responseData, stats: emptyStats }

  const record = asRecord(responseData)
  const conversationState = asRecord(record?.conversationState)
  const turns = Array.isArray(conversationState?.turns) ? conversationState.turns : null
  if (!record || !conversationState || !turns) return { data: responseData, stats: emptyStats }

  let responseBudget = COMMAND_OUTPUT_BLOCK_RESPONSE_BUDGET_BYTES
  let changed = false
  let blockCount = 0
  let fullBytesTotal = 0
  let previewBytesTotal = 0
  const nextTurns = turns.map((turn) => {
    const turnRecord = asRecord(turn)
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !items) return turn

    let itemsChanged = false
    const nextItems = items.map((item) => {
      const itemRecord = asRecord(item)
      if (!itemRecord || itemRecord.type !== 'commandExecution') return item
      if (asRecord(itemRecord.outputBlock)?.truncated === true) return item

      const itemId = typeof itemRecord.id === 'string' && itemRecord.id.length > 0 ? itemRecord.id : ''
      const output = typeof itemRecord.aggregatedOutput === 'string' ? itemRecord.aggregatedOutput : ''
      if (!itemId || !output) return item

      const fullBytes = byteLengthUtf8(output)
      if (fullBytes < COMMAND_OUTPUT_BLOCK_MIN_BYTES && responseBudget >= fullBytes) {
        responseBudget -= fullBytes
        return item
      }

      const digest = hashCommandOutput(output)
      const blockId = storeCommandOutputBlock(threadId, itemId, output, digest)
      const previewBudget = responseBudget > 0 ? Math.min(COMMAND_OUTPUT_BLOCK_PREVIEW_BYTES, responseBudget) : 1024
      const preview = createCommandOutputPreview(output, fullBytes, Math.max(1024, previewBudget))
      const previewBytes = byteLengthUtf8(preview)
      responseBudget -= previewBytes
      blockCount += 1
      fullBytesTotal += fullBytes
      previewBytesTotal += previewBytes
      itemsChanged = true
      changed = true

      return {
        ...itemRecord,
        aggregatedOutput: preview,
        outputBlock: {
          blockId,
          itemId,
          digest,
          truncated: true,
          fullBytes,
          previewBytes,
        },
      }
    })
    return itemsChanged ? { ...turnRecord, items: nextItems } : turn
  })

  if (!changed) return { data: responseData, stats: emptyStats }
  return {
    data: {
      ...record,
      conversationState: {
        ...conversationState,
        turns: nextTurns,
      },
    },
    stats: {
      blockCount,
      fullBytes: fullBytesTotal,
      previewBytes: previewBytesTotal,
    },
  }
}

function readLiveStateDigestHeader(req: IncomingMessage): string {
  const value = req.headers['x-codex-live-state-digest']
  const digest = Array.isArray(value) ? value[0] : value
  return typeof digest === 'string' && /^[a-f0-9]{40}$/u.test(digest) ? digest : ''
}

function hashLiveStateResponseData(responseData: unknown): string {
  return sha1(JSON.stringify(responseData) ?? 'null')
}

function pruneLiveStateDigestCache(now = Date.now()): void {
  for (const [key, entry] of liveStateDigestCache.entries()) {
    if (entry.expiresAt <= now) liveStateDigestCache.delete(key)
  }
  while (liveStateDigestCache.size > LIVE_STATE_DIGEST_CACHE_MAX_ENTRIES) {
    const firstKey = liveStateDigestCache.keys().next().value
    if (typeof firstKey !== 'string') break
    liveStateDigestCache.delete(firstKey)
  }
}

function storeLiveStateDigestMetadata(metadata: Omit<LiveStateDigestMetadata, 'expiresAt'>): void {
  if (!LIVE_STATE_DIGEST_ENABLED || !metadata.digest || metadata.isInProgress) return
  pruneLiveStateDigestCache()
  liveStateDigestCache.delete(metadata.threadId)
  liveStateDigestCache.set(metadata.threadId, {
    ...metadata,
    expiresAt: Date.now() + LIVE_STATE_DIGEST_CACHE_TTL_MS,
  })
  pruneLiveStateDigestCache()
}

function setLiveStateDigestHeaders(res: ServerResponse, digest: string): void {
  if (!digest || res.headersSent) return
  res.setHeader('X-Codex-Live-State-Digest', digest)
  res.setHeader('Cache-Control', 'no-store, private')
}

function sendLiveStateNoContent(res: ServerResponse, digest: string): void {
  setLiveStateDigestHeaders(res, digest)
  res.statusCode = 204
  res.setHeader('Content-Length', '0')
  res.end()
}

export function prepareLiveStateResponse(
  req: IncomingMessage,
  threadId: string,
  responseData: unknown,
  metadata: {
    generation: number
    sessionPath: string
    sessionSize: number
    sessionMtimeMs: number
    isInProgress: boolean
  },
): PreparedLiveStateResponse {
  const slimmed = slimLiveStateCommandOutputs(threadId, responseData)
  const digest = LIVE_STATE_DIGEST_ENABLED ? hashLiveStateResponseData(slimmed.data) : ''
  const requestedDigest = readLiveStateDigestHeader(req)

  if (digest) {
    storeLiveStateDigestMetadata({
      threadId,
      digest,
      generation: metadata.generation,
      sessionPath: metadata.sessionPath,
      sessionSize: metadata.sessionSize,
      sessionMtimeMs: metadata.sessionMtimeMs,
      isInProgress: metadata.isInProgress,
    })
  }

  return {
    data: slimmed.data,
    digest,
    statusCode: digest && requestedDigest === digest ? 204 : 200,
    stats: slimmed.stats,
  }
}

export function sendPreparedLiveStateResponse(res: ServerResponse, prepared: PreparedLiveStateResponse): void {
  if (prepared.statusCode === 204) {
    sendLiveStateNoContent(res, prepared.digest)
    return
  }
  setLiveStateDigestHeaders(res, prepared.digest)
  sendJsonResponse(res, 200, prepared.data)
}

export async function maybeSendFastLiveStateUnchanged(
  req: IncomingMessage,
  res: ServerResponse,
  threadId: string,
  generation: number,
  readSessionStat: (sessionPath: string) => Promise<LiveStateSessionStat | null>,
): Promise<boolean> {
  if (!LIVE_STATE_DIGEST_ENABLED) return false
  const requestedDigest = readLiveStateDigestHeader(req)
  if (!requestedDigest) return false
  pruneLiveStateDigestCache()
  const cached = liveStateDigestCache.get(threadId)
  if (!cached || cached.digest !== requestedDigest || cached.generation !== generation || cached.isInProgress) return false

  if (cached.sessionPath) {
    const currentStat = await readSessionStat(cached.sessionPath)
    if (!currentStat) return false
    if (cached.sessionSize !== currentStat.size || cached.sessionMtimeMs !== currentStat.mtimeMs) return false
  }

  sendLiveStateNoContent(res, cached.digest)
  return true
}
