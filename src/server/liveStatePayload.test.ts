import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLiveStatePayloadRuntime,
  findCommandOutputInTurns,
  getStoredCommandOutputBlock,
  maybeSendFastLiveStateUnchanged,
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

function metadata(isInProgress = false) {
  return {
    generation: 0,
    sessionPath: '',
    sessionSize: 0,
    sessionMtimeMs: 0,
    isInProgress,
  }
}

describe('live-state command output blocks', () => {
  it('replaces oversized command output in ThreadReadResponse shape and stores the full block', () => {
    const output = 'abcdefghijklmnopqrstuvwxyz\n'.repeat(2000)
    const response = {
      model: 'gpt-5.5',
      thread: {
        id: 'thread-1',
        modelProvider: 'opencode_zen',
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
    const item = (slimmed.data as typeof response).thread.turns[0]?.items[0] as {
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

    expect((slimmed.data as typeof response).model).toBe('gpt-5.5')
    expect((slimmed.data as typeof response).thread.modelProvider).toBe('opencode_zen')
    expect(slimmed.stats.blockCount).toBe(1)
    expect(item.aggregatedOutput.length).toBeLessThan(output.length)
    expect(item.outputBlock).toMatchObject({
      itemId: 'cmd-1',
      truncated: true,
      fullBytes: Buffer.byteLength(output, 'utf8'),
    })

    const stored = getStoredCommandOutputBlock('thread-1', item.outputBlock?.blockId ?? '', 'cmd-1', item.outputBlock?.digest ?? '')
    expect(stored?.output).toBe(output)
    expect(findCommandOutputInTurns(response.thread.turns, 'cmd-1', item.outputBlock?.digest ?? '')).toBe(output)
  })

  it('also supports legacy conversationState live-state shape', () => {
    const output = '0123456789abcdef\n'.repeat(3000)
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
    const item = (slimmed.data as typeof response).conversationState.turns[0]?.items[0] as { outputBlock?: { truncated: boolean } }
    expect(item.outputBlock?.truncated).toBe(true)
  })

  it('still returns a bounded preview when full output is too large for the cache', () => {
    const output = 'overflow-output\n'.repeat(3000)
    const response = {
      thread: {
        id: 'thread-1',
        turns: [{
          id: 'turn-1',
          items: [{
            id: 'cmd-overflow',
            type: 'commandExecution',
            status: 'completed',
            aggregatedOutput: output,
            exitCode: 0,
          }],
        }],
      },
      isInProgress: false,
    }

    const slimmed = slimLiveStateCommandOutputs('thread-1', response, { commandOutputBlockCacheMaxBytes: 1 })
    const item = (slimmed.data as typeof response).thread.turns[0]?.items[0] as {
      aggregatedOutput: string
      outputBlock?: {
        blockId: string
        itemId: string
        digest: string
        truncated: boolean
        fullBytes: number
      }
    }

    expect(item.aggregatedOutput.length).toBeLessThan(output.length)
    expect(item.outputBlock).toMatchObject({
      blockId: expect.stringMatching(/^uncached-/),
      itemId: 'cmd-overflow',
      truncated: true,
      fullBytes: Buffer.byteLength(output, 'utf8'),
    })
    expect(getStoredCommandOutputBlock('thread-1', item.outputBlock?.blockId ?? '', 'cmd-overflow', item.outputBlock?.digest ?? '')).toBeNull()
  })
})

describe('live-state digest preparation', () => {
  it('marks identical completed live-state responses as no-content when the client sends the digest', () => {
    const response = {
      thread: {
        id: 'thread-1',
        turns: [{ id: 'turn-1', items: [] }],
      },
      isInProgress: false,
    }

    const first = prepareLiveStateResponse(requestWithDigest(), 'thread-1', response, metadata(false))
    const second = prepareLiveStateResponse(requestWithDigest(first.digest), 'thread-1', response, metadata(false))

    expect(first.statusCode).toBe(200)
    expect(first.digest).toMatch(/^[a-f0-9]{40}$/u)
    expect(second.statusCode).toBe(204)
  })

  it('does not return no-content for in-progress responses', () => {
    const response = {
      thread: {
        id: 'thread-1',
        turns: [{ id: 'turn-1', status: 'inProgress', items: [] }],
      },
      isInProgress: true,
    }

    const first = prepareLiveStateResponse(requestWithDigest(), 'thread-1', response, metadata(true))
    const second = prepareLiveStateResponse(requestWithDigest(first.digest), 'thread-1', response, metadata(true))

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
  })

  it('does not send fast no-content when generation changes during session stat', async () => {
    const response = {
      thread: {
        id: 'thread-1',
        turns: [{ id: 'turn-1', items: [] }],
      },
      isInProgress: false,
    }
    const first = prepareLiveStateResponse(requestWithDigest(), 'thread-1', response, {
      ...metadata(false),
      sessionPath: '/tmp/session.jsonl',
      sessionSize: 10,
      sessionMtimeMs: 20,
    })
    let generation = 0
    const res = {
      setHeader: vi.fn(),
      end: vi.fn(),
      headersSent: false,
      statusCode: 200,
    } as unknown as ServerResponse

    const sent = await maybeSendFastLiveStateUnchanged(
      requestWithDigest(first.digest),
      res,
      'thread-1',
      0,
      async () => {
        generation = 1
        return { size: 10, mtimeMs: 20 }
      },
      () => generation,
    )

    expect(sent).toBe(false)
    expect(res.end).not.toHaveBeenCalled()
  })

  it('does not use the fast no-content path without session metadata', async () => {
    const response = {
      thread: {
        id: 'thread-1',
        turns: [{ id: 'turn-1', items: [] }],
      },
      isInProgress: false,
    }
    const first = prepareLiveStateResponse(requestWithDigest(), 'thread-1', response, metadata(false))
    const res = {
      setHeader: vi.fn(),
      end: vi.fn(),
      headersSent: false,
      statusCode: 200,
    } as unknown as ServerResponse

    const sent = await maybeSendFastLiveStateUnchanged(
      requestWithDigest(first.digest),
      res,
      'thread-1',
      0,
      async () => null,
    )

    expect(sent).toBe(false)
    expect(res.end).not.toHaveBeenCalled()
  })
})
