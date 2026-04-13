import { createFileRoute } from '@tanstack/react-router'
import {
  type AnyTextAdapter,
  chat,
  convertMessagesToModelMessages,
  type ModelMessage,
  type StreamChunk,
  type UIMessage,
  toServerSentEventsResponse,
  modelMessagesToUIMessages,
  toClientUIMessages,
} from '@tanstack/ai'
import { createOpenaiChat } from '@tanstack/ai-openai'
import { conversationStore } from '@/lib/conversation-store'
import { serverTools } from '@/shared/tools'

const SYSTEM_PROMPT = `You are a helpful assistant that can execute code, look up users, and check the weather.

When asked to run code or do calculations, use the execute_typescript tool.
When asked about a user, use the lookup_user tool with their ID.
When asked about weather, use the get_weather tool.

Be concise in your responses.`

function getExampleOpenAIKey(): string | undefined {
  return (
    process.env.OPENAI_API_KEY ||
    ((import.meta.env as Record<string, string | undefined>).OPENAI_API_KEY ??
      undefined)
  )
}

function chunk<T extends StreamChunk['type']>(
  type: T,
  fields: Omit<Extract<StreamChunk, { type: T }>, 'type' | 'timestamp'>,
): StreamChunk {
  return {
    type,
    timestamp: Date.now(),
    ...fields,
  } as unknown as StreamChunk
}

function getLatestUserText(messages: Array<ModelMessage>): string {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')

  if (!latestUser) {
    return ''
  }

  if (typeof latestUser.content === 'string') {
    return latestUser.content
  }

  if (!Array.isArray(latestUser.content)) {
    return ''
  }

  return latestUser.content
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join(' ')
}

function createFallbackAdapter(): AnyTextAdapter {
  return {
    kind: 'text',
    name: 'example-fallback',
    model: 'example-fallback',
    '~types': {
      providerOptions: {} as Record<string, unknown>,
      inputModalities: ['text'] as const,
      messageMetadataByModality: {
        text: undefined as unknown,
        image: undefined as unknown,
        audio: undefined as unknown,
        video: undefined as unknown,
        document: undefined as unknown,
      },
    },
    chatStream: (opts) =>
      (async function* () {
        const messages = opts.messages as Array<ModelMessage>
        const lastMessage = messages[messages.length - 1]

        if (lastMessage?.role === 'tool' && lastMessage.toolCallId) {
          const matchingAssistant = [...messages]
            .reverse()
            .find(
              (message) =>
                message.role === 'assistant' &&
                message.toolCalls?.some((toolCall) => toolCall.id === lastMessage.toolCallId),
            )
          const matchingToolCall = matchingAssistant?.toolCalls?.find(
            (toolCall) => toolCall.id === lastMessage.toolCallId,
          )
          const toolName = matchingToolCall?.function.name
          const payload =
            typeof lastMessage.content === 'string'
              ? JSON.parse(lastMessage.content)
              : lastMessage.content

          let responseText = 'Done.'

          if (toolName === 'lookup_user') {
            responseText = `User ${payload.id} is ${payload.name}.`
          } else if (toolName === 'get_weather') {
            responseText = `The weather in the requested location is ${payload.condition} and ${payload.temperature}F with ${payload.humidity}% humidity.`
          } else if (toolName === 'execute_typescript') {
            responseText = `The code execution ${payload.success ? 'succeeded' : 'failed'} in ${payload.executionTimeMs}ms.`
          }

          const messageId = `assistant-${Date.now()}`
          yield chunk('TEXT_MESSAGE_CONTENT', {
            messageId,
            delta: responseText,
            content: responseText,
          })
          yield chunk('RUN_FINISHED', {
            runId: `run-${Date.now()}`,
            finishReason: 'stop',
          })
          return
        }

        const prompt = getLatestUserText(messages).toLowerCase()

        if (prompt.includes('look up user')) {
          const userId = prompt.match(/\b\d+\b/)?.[0] ?? '123'
          const toolCallId = `lookup-${Date.now()}`
          const args = JSON.stringify({ userId })
          yield chunk('TOOL_CALL_START', {
            toolCallId,
            toolName: 'lookup_user',
          })
          yield chunk('TOOL_CALL_ARGS', {
            toolCallId,
            delta: args,
          })
          yield chunk('TOOL_CALL_END', {
            toolCallId,
            toolName: 'lookup_user',
            input: { userId },
          })
          yield chunk('RUN_FINISHED', {
            runId: `run-${Date.now()}`,
            finishReason: 'tool_calls',
          })
          return
        }

        if (prompt.includes('weather')) {
          const location = prompt.match(/in (.+)$/i)?.[1] ?? 'Paris'
          const toolCallId = `weather-${Date.now()}`
          const args = JSON.stringify({ location })
          yield chunk('TOOL_CALL_START', {
            toolCallId,
            toolName: 'get_weather',
          })
          yield chunk('TOOL_CALL_ARGS', {
            toolCallId,
            delta: args,
          })
          yield chunk('TOOL_CALL_END', {
            toolCallId,
            toolName: 'get_weather',
            input: { location },
          })
          yield chunk('RUN_FINISHED', {
            runId: `run-${Date.now()}`,
            finishReason: 'tool_calls',
          })
          return
        }

        if (prompt.includes('typescript') || prompt.includes('calculate')) {
          const description = 'Run a simple calculation'
          const typescriptCode = 'const result = 2 + 2'
          const toolCallId = `ts-${Date.now()}`
          const args = JSON.stringify({ description, typescriptCode })
          yield chunk('TOOL_CALL_START', {
            toolCallId,
            toolName: 'execute_typescript',
          })
          yield chunk('TOOL_CALL_ARGS', {
            toolCallId,
            delta: args,
          })
          yield chunk('TOOL_CALL_END', {
            toolCallId,
            toolName: 'execute_typescript',
            input: { description, typescriptCode },
          })
          yield chunk('RUN_FINISHED', {
            runId: `run-${Date.now()}`,
            finishReason: 'tool_calls',
          })
          return
        }

        const fallbackText =
          'Try asking me to look up a user, run TypeScript, or check the weather.'
        yield chunk('TEXT_MESSAGE_CONTENT', {
          messageId: `assistant-${Date.now()}`,
          delta: fallbackText,
          content: fallbackText,
        })
        yield chunk('RUN_FINISHED', {
          runId: `run-${Date.now()}`,
          finishReason: 'stop',
        })
      })(),
    structuredOutput: async () => ({ data: {}, rawText: '{}' }),
  }
}

function getExampleAdapter(): AnyTextAdapter {
  const apiKey = getExampleOpenAIKey()
  if (!apiKey) {
    return createFallbackAdapter()
  }

  return createOpenaiChat('gpt-4o-mini', apiKey)
}

function buildPersistedMessages(
  messages: Array<ModelMessage>,
  content?: string,
): Array<ModelMessage> {
  if (!content) {
    return [...messages]
  }

  const lastMessage = messages[messages.length - 1]
  if (
    lastMessage?.role === 'assistant' &&
    typeof lastMessage.content === 'string' &&
    lastMessage.content === content &&
    !lastMessage.toolCalls?.length
  ) {
    return [...messages]
  }

  return [
    ...messages,
    {
      role: 'assistant',
      content,
    },
  ]
}

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      async GET({ request }) {
        const url = new URL(request.url)
        const conversationId = url.searchParams.get('conversationId')
        if (!conversationId) {
          return Response.json([])
        }

        const conversation = await conversationStore.load(conversationId)
        if (!conversation) {
          return Response.json([])
        }

        // Convert to UIMessages, then filter for client view
        const uiMessages = modelMessagesToUIMessages(conversation.messages)
        const clientMessages = toClientUIMessages(uiMessages, serverTools)

        return Response.json(clientMessages)
      },

      async POST({ request }) {
        const body = await request.json()
        const { conversationId, event }: {
          conversationId: string
          event?:
            | {
                type: 'user-message'
                message: UIMessage | ModelMessage | { content: string }
              }
            | {
                type: 'tool-result'
                toolCallId: string
                result: unknown
              }
        } = body

        // Load existing conversation or start fresh
        const conversation = await conversationStore.load(conversationId)
        const messages = [...(conversation?.messages ?? [])]

        if (event?.type === 'user-message') {
          if ('role' in event.message) {
            messages.push(...convertMessagesToModelMessages([event.message]))
          } else {
            messages.push({
              role: 'user',
              content: event.message.content,
            })
          }
        }

        if (event?.type === 'tool-result') {
          messages.push({
            role: 'tool' as const,
            content: JSON.stringify(event.result),
            toolCallId: event.toolCallId,
          })
        }

        const abortController = new AbortController()
        let finalAssistantContent = ''

        const stream = chat({
          adapter: getExampleAdapter(),
          messages: messages as any,
          tools: serverTools,
          systemPrompts: [SYSTEM_PROMPT],
          abortController,
          conversationId,
          middleware: [
            {
              name: 'persist',
              onChunk(_ctx, chunk) {
                if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
                  finalAssistantContent = chunk.content || finalAssistantContent + chunk.delta
                }
              },
              async onFinish(ctx, info) {
                await conversationStore.save(
                  conversationId,
                  buildPersistedMessages(
                    [...ctx.messages],
                    finalAssistantContent || info.content,
                  ),
                )
              },
              async onToolPhaseComplete(ctx) {
                await conversationStore.save(conversationId, [...ctx.messages])
              },
            },
          ],
        })

        return toServerSentEventsResponse(stream, { abortController })
      },
    },
  },
})
