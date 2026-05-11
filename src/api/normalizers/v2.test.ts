import { describe, expect, it } from 'vitest'
import { normalizeThreadMessagesV2, normalizeThreadSummaryV2 } from './v2'
import type { ThreadReadResponse } from '../appServerDtos'

function threadReadResponseWithContent(content: ThreadReadResponse['thread']['turns'][number]['items'][number][]): ThreadReadResponse {
  return {
    thread: {
      id: 'thread-1',
      preview: 'Use a skill',
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 2,
      path: null,
      cwd: '/tmp/project',
      cliVersion: 'test',
      source: 'appServer',
      gitInfo: null,
      turns: [{
        id: 'turn-1',
        status: 'completed',
        error: null,
        items: content,
      }],
    },
  }
}

describe('normalizeThreadMessagesV2', () => {
  it('preserves selected skill inputs on the rendered user message', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-1',
      content: [
        { type: 'text', text: 'Use the browser skill', text_elements: [] },
        { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/skills/browser/SKILL.md' },
      ],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      text: 'Use the browser skill',
      skills: [{ name: 'browser-use:browser', path: '/Users/igor/.codex/skills/browser/SKILL.md' }],
    })
  })

  it('renders skill-only user messages instead of dropping them as raw blocks', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-2',
      content: [
        { type: 'skill', name: 'composio-cli', path: '/Users/igor/.codex/skills/composio-cli/SKILL.md' },
      ],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-2',
      role: 'user',
      text: '',
      skills: [{ name: 'composio-cli', path: '/Users/igor/.codex/skills/composio-cli/SKILL.md' }],
    })
    expect(messages[0].isUnhandled).toBeUndefined()
  })

  it('decodes escaped heartbeat instructions without exposing raw XML', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'automation-user-1',
      content: [{
        type: 'text',
        text: `<heartbeat>
<automation_id>automation-1</automation_id>
<current_time_iso>2026-05-09T00:00:00.000Z</current_time_iso>
<instructions>
Reply with &lt;/instructions&gt; and A &amp; B
</instructions>
</heartbeat>`,
        text_elements: [],
      }],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'automation-user-1',
      role: 'user',
      text: 'Reply with </instructions> and A & B',
      isAutomationRun: true,
      automationDisplayName: 'automation-1',
    })
  })

  it('keeps command output block metadata for lazy full-output loading', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'pnpm test',
      cwd: '/tmp/project',
      status: 'completed',
      aggregatedOutput: 'preview',
      exitCode: 0,
      outputBlock: {
        blockId: 'block-1',
        itemId: 'cmd-1',
        digest: 'a'.repeat(40),
        truncated: true,
        fullBytes: 65536,
        previewBytes: 8192,
      },
    } as unknown as ThreadReadResponse['thread']['turns'][number]['items'][number]]))

    expect(messages[0]?.commandExecution?.outputBlock).toMatchObject({
      blockId: 'block-1',
      itemId: 'cmd-1',
      digest: 'a'.repeat(40),
      truncated: true,
      fullBytes: 65536,
      previewBytes: 8192,
    })
  })
})

describe('normalizeThreadSummaryV2', () => {
  it('prefers a generated title over a stale thread name', () => {
    const response = threadReadResponseWithContent([]) as ThreadReadResponse & {
      thread: ThreadReadResponse['thread'] & { name?: string; title?: string }
    }
    response.thread.name = 'Stale first prompt title'
    response.thread.title = 'Generated completed conversation title'

    expect(normalizeThreadSummaryV2(response).title).toBe('Generated completed conversation title')
  })
})
