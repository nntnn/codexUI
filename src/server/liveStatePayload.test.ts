import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearLiveStatePayloadRuntime,
  findCommandOutputInTurns,
  getStoredCommandOutputBlock,
  prepareLiveStateResponse,
  slimLiveStateCommandOutputs,
} from './liveStatePayload'

afterEach(() => {
  clearLiveStatePayloadRuntime()
})

function requestWithDigest(digest = ''): IncomingMessage {
  return {
    headers: digest ? { 'x-codex-live-state-digest': digest } : {},
  } as IncomingMessage
}

describe('live-state command output blocks', () => {
  it('replaces oversized command output with a preview and stores the full block', () => {
    const output = 'abcdefghijklmnopqrstuvwxyz\n'.repeat(2000)
    const response = {
      threadId: 'thread-1',
      conversationState: {
        turns: [{
          id: 'turn-1',
          items: [{
            id: 'cmd-1',
            type: 'commandExecution',
            status: 'completed',
            aggregatedOutput: output,
            exitCode: 0,
          }],
        }],
      },
      isInProgress: false,
    }

    const slimmed = slimLiveStateCommandOutputs('thread-1', response)
    const item = (slimmed.data as typeof response).conversationState.turns[0]?.items[0] as {
      aggregatedOutput: string
      outputBlock?: {
        blockId: string
        itemId: string
        digest: string
        truncated: boolean
        fullBytes: number
        previewBytes: number
      }
    }

    expect(slimmed.stats.blockCount).toBe(1)
    expect(item.aggregatedOutput.length).toBeLessThan(output.length)
    expect(item.outputBlock).toMatchObject({
      itemId: 'cmd-1',
      truncated: true,
      fullBytes: Buffer.byteLength(output, 'utf8'),
    })

    const stored = getStoredCommandOutputBlock('thread-1', item.outputBlock?.blockId ?? '', 'cmd-1', item.outputBlock?.digest ?? '')
    expect(stored?.output).toBe(output)
    expect(findCommandOutputInTurns(response.conversationState.turns, 'cmd-1', item.outputBlock?.digest ?? '')).toBe(output)
  })

  it('leaves command output intact when the full block is too large to cache', () => {
    const output = 'abcdefghijklmnopqrstuvwxyz\n'.repeat(2000)
    const response = {
      threadId: 'thread-1',
      conversationState: {
        turns: [{
          id: 'turn-1',
          items: [{
            id: 'cmd-1',
            type: 'commandExecution',
            status: 'completed',
            aggregatedOutput: output,
            exitCode: 0,
          }],
        }],
      },
      isInProgress: false,
    }

    const slimmed = slimLiveStateCommandOutputs('thread-1', response, {
      commandOutputBlockCacheMaxBytes: 16,
    })
    const item = (slimmed.data as typeof response).conversationState.turns[0]?.items[0] as {
      aggregatedOutput: string
      outputBlock?: unknown
    }

    expect(slimmed.stats.blockCount).toBe(0)
    expect(item.aggregatedOutput).toBe(output)
    expect(item.outputBlock).toBeUndefined()
  })
})

describe('live-state digest preparation', () => {
  it('marks identical live-state responses as no-content when the client sends the digest', () => {
    const response = {
      threadId: 'thread-1',
      conversationState: { turns: [{ id: 'turn-1', items: [] }] },
      isInProgress: false,
    }
    const metadata = {
      generation: 0,
      sessionPath: '',
      sessionSize: 0,
      sessionMtimeMs: 0,
      isInProgress: false,
    }

    const first = prepareLiveStateResponse(requestWithDigest(), 'thread-1', response, metadata)
    const second = prepareLiveStateResponse(requestWithDigest(first.digest), 'thread-1', response, metadata)

    expect(first.statusCode).toBe(200)
    expect(first.digest).toMatch(/^[a-f0-9]{40}$/u)
    expect(second.statusCode).toBe(204)
  })
})
