import { describe, it, expect } from 'vitest'
import type { ModelMessage, Tool, UIMessage } from '../src/types'
import {
  toClientMessages,
  toClientUIMessages,
} from '../src/activities/chat/messages'

function makeTool(
  name: string,
  opts?: {
    clientInput?: (args: any) => unknown
    clientOutput?: (result: any) => unknown
  },
): Tool {
  return {
    name,
    description: `Tool ${name}`,
    ...opts,
  }
}

describe('toClientMessages', () => {
  it('should filter tool call arguments via clientInput', () => {
    const tools = [
      makeTool('execute_typescript', {
        clientInput: (args: any) => ({ description: args.description }),
      }),
    ]

    const messages: ModelMessage[] = [
      { role: 'user', content: 'Run some code' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'execute_typescript',
              arguments: JSON.stringify({
                typescriptCode: 'const x = 1 + 2;',
                description: 'Add numbers',
              }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ success: true, result: 3 }),
        toolCallId: 'tc1',
      },
    ]

    const filtered = toClientMessages(messages, tools)

    // User message unchanged
    expect(filtered[0]).toBe(messages[0])

    // Tool call arguments filtered
    const assistantMsg = filtered[1]!
    expect(assistantMsg.toolCalls![0]!.function.arguments).toBe(
      JSON.stringify({ description: 'Add numbers' }),
    )

    // Tool result unchanged (no clientOutput)
    expect(filtered[2]!.content).toBe(
      JSON.stringify({ success: true, result: 3 }),
    )
  })

  it('should filter tool results via clientOutput', () => {
    const tools = [
      makeTool('lookup_user', {
        clientOutput: (result: any) => ({ name: result.name }),
      }),
    ]

    const messages: ModelMessage[] = [
      { role: 'user', content: 'Find user 123' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'lookup_user',
              arguments: JSON.stringify({ userId: '123' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({
          name: 'Alice',
          email: 'alice@test.com',
          ssn: '123-45-6789',
        }),
        toolCallId: 'tc1',
      },
    ]

    const filtered = toClientMessages(messages, tools)

    // Tool result filtered -- only name remains
    expect(JSON.parse(filtered[2]!.content as string)).toEqual({ name: 'Alice' })

    // Tool call arguments unchanged (no clientInput)
    expect(filtered[1]!.toolCalls![0]!.function.arguments).toBe(
      JSON.stringify({ userId: '123' }),
    )
  })

  it('should pass through messages for tools without filters', () => {
    const tools = [makeTool('plain_tool')]

    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'plain_tool',
              arguments: JSON.stringify({ secret: 'data' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ secret: 'result' }),
        toolCallId: 'tc1',
      },
    ]

    const filtered = toClientMessages(messages, tools)

    // Everything passes through unchanged
    expect(filtered[0]).toBe(messages[0])
    expect(filtered[1]!.toolCalls![0]!.function.arguments).toBe(
      JSON.stringify({ secret: 'data' }),
    )
    expect(filtered[2]!.content).toBe(JSON.stringify({ secret: 'result' }))
  })

  it('should handle mixed tools -- some filtered, some not', () => {
    const tools = [
      makeTool('filtered_tool', {
        clientOutput: (result: any) => ({ public: result.public }),
      }),
      makeTool('open_tool'),
    ]

    const messages: ModelMessage[] = [
      { role: 'user', content: 'Do things' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'filtered_tool',
              arguments: JSON.stringify({ x: 1 }),
            },
          },
          {
            id: 'tc2',
            type: 'function',
            function: {
              name: 'open_tool',
              arguments: JSON.stringify({ y: 2 }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ public: 'yes', private: 'no' }),
        toolCallId: 'tc1',
      },
      {
        role: 'tool',
        content: JSON.stringify({ all: 'visible' }),
        toolCallId: 'tc2',
      },
    ]

    const filtered = toClientMessages(messages, tools)

    // filtered_tool result is stripped
    expect(JSON.parse(filtered[2]!.content as string)).toEqual({ public: 'yes' })

    // open_tool result unchanged
    expect(JSON.parse(filtered[3]!.content as string)).toEqual({
      all: 'visible',
    })
  })

  it('should preserve malformed historical tool results', () => {
    const tools = [
      makeTool('lookup_user', {
        clientOutput: (result: any) => ({ name: result.name }),
      }),
    ]

    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'lookup_user',
              arguments: JSON.stringify({ userId: '123' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{not valid json',
        toolCallId: 'tc1',
      },
    ]

    const filtered = toClientMessages(messages, tools)

    expect(filtered[1]!.content).toBe('{not valid json')
  })
})

describe('toClientUIMessages', () => {
  it('should filter tool-call arguments and tool-result content', () => {
    const tools = [
      makeTool('execute_typescript', {
        clientInput: (args: any) => ({ description: args.description }),
        clientOutput: (result: any) => ({ success: result.success }),
      }),
    ]

    const messages: UIMessage[] = [
      {
        id: 'msg1',
        role: 'user',
        parts: [{ type: 'text', content: 'Run code' }],
      },
      {
        id: 'msg2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            id: 'tc1',
            name: 'execute_typescript',
            arguments: JSON.stringify({
              typescriptCode: 'console.log("hi")',
              description: 'Log greeting',
            }),
            state: 'input-complete',
            output: { success: true, result: undefined, logs: ['hi'] },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            content: JSON.stringify({
              success: true,
              result: undefined,
              logs: ['hi'],
            }),
            state: 'complete',
          },
        ],
      },
    ]

    const filtered = toClientUIMessages(messages, tools)

    // User message unchanged (same reference)
    expect(filtered[0]).toBe(messages[0])

    // Tool-call part has filtered arguments and output
    const toolCallPart = filtered[1]!.parts[0] as any
    expect(JSON.parse(toolCallPart.arguments)).toEqual({
      description: 'Log greeting',
    })
    expect(toolCallPart.output).toEqual({ success: true })

    // Tool-result part has filtered content
    const toolResultPart = filtered[1]!.parts[1] as any
    expect(JSON.parse(toolResultPart.content)).toEqual({ success: true })
  })

  it('should pass through messages without tool parts', () => {
    const tools = [
      makeTool('some_tool', {
        clientOutput: () => ({}),
      }),
    ]

    const messages: UIMessage[] = [
      {
        id: 'msg1',
        role: 'user',
        parts: [{ type: 'text', content: 'Hello' }],
      },
      {
        id: 'msg2',
        role: 'assistant',
        parts: [{ type: 'text', content: 'Hi there' }],
      },
    ]

    const filtered = toClientUIMessages(messages, tools)

    // Same references -- no filtering needed
    expect(filtered[0]).toBe(messages[0])
    expect(filtered[1]).toBe(messages[1])
  })

  it('should handle clientOutput only (no clientInput)', () => {
    const tools = [
      makeTool('lookup_user', {
        clientOutput: (result: any) => ({ id: result.id, name: result.name }),
      }),
    ]

    const messages: UIMessage[] = [
      {
        id: 'msg1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            id: 'tc1',
            name: 'lookup_user',
            arguments: JSON.stringify({ userId: '123' }),
            state: 'input-complete',
            output: {
              id: '123',
              name: 'Alice',
              ssn: '999-99-9999',
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            content: JSON.stringify({
              id: '123',
              name: 'Alice',
              ssn: '999-99-9999',
            }),
            state: 'complete',
          },
        ],
      },
    ]

    const filtered = toClientUIMessages(messages, tools)

    // Arguments unchanged
    const tcPart = filtered[0]!.parts[0] as any
    expect(JSON.parse(tcPart.arguments)).toEqual({ userId: '123' })

    // Output filtered
    expect(tcPart.output).toEqual({ id: '123', name: 'Alice' })

    // Tool result filtered
    const trPart = filtered[0]!.parts[1] as any
    expect(JSON.parse(trPart.content)).toEqual({ id: '123', name: 'Alice' })
  })

  it('should preserve malformed tool result parts during hydration', () => {
    const tools = [
      makeTool('lookup_user', {
        clientOutput: (result: any) => ({ name: result.name }),
      }),
    ]

    const messages: UIMessage[] = [
      {
        id: 'msg1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            id: 'tc1',
            name: 'lookup_user',
            arguments: JSON.stringify({ userId: '123' }),
            state: 'input-complete',
          },
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            content: '{broken',
            state: 'complete',
          },
        ],
      },
    ]

    const filtered = toClientUIMessages(messages, tools)
    const trPart = filtered[0]!.parts[1] as any

    expect(trPart.content).toBe('{broken')
  })
})
