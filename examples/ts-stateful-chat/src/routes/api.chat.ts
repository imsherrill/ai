import { createFileRoute } from '@tanstack/react-router'
import {
  chat,
  toServerSentEventsResponse,
  modelMessagesToUIMessages,
  toClientUIMessages,
} from '@tanstack/ai'
import { openaiText } from '@tanstack/ai-openai'
import { conversationStore } from '@/lib/conversation-store'
import { createClientFilterMiddleware } from '@/lib/client-filter-middleware'
import { serverTools } from '@/shared/tools'

const SYSTEM_PROMPT = `You are a helpful assistant that can execute code, look up users, and check the weather.

When asked to run code or do calculations, use the execute_typescript tool.
When asked about a user, use the lookup_user tool with their ID.
When asked about weather, use the get_weather tool.

Be concise in your responses.`

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
        const {
          conversationId,
          message,
          toolResult,
        }: {
          conversationId: string
          message?: string
          toolResult?: { toolCallId: string; result: unknown }
        } = body

        // Load existing conversation or start fresh
        const conversation = await conversationStore.load(conversationId)
        const messages = conversation?.messages ?? []

        // Append new content
        if (message) {
          messages.push({ role: 'user' as const, content: message })
        }
        if (toolResult) {
          messages.push({
            role: 'tool' as const,
            content: JSON.stringify(toolResult.result),
            toolCallId: toolResult.toolCallId,
          })
        }

        console.log('[stateful-chat] raw body:', JSON.stringify(body, null, 2))

        const abortController = new AbortController()

        const stream = chat({
          adapter: openaiText('gpt-4o-mini'),
          messages,
          tools: serverTools,
          systemPrompts: [SYSTEM_PROMPT],
          abortController,
          conversationId,
          middleware: [
            createClientFilterMiddleware(serverTools),
            {
              name: 'persist',
              onFinish(ctx) {
                conversationStore.save(conversationId, [...ctx.messages])
              },
              onToolPhaseComplete(ctx) {
                conversationStore.save(conversationId, [...ctx.messages])
              },
            },
          ],
        })

        return toServerSentEventsResponse(stream, { abortController })
      },
    },
  },
})
