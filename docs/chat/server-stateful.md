---
title: Server-Stateful Chat
id: server-stateful-chat
order: 4
---

TanStack AI is storage-agnostic. The default pattern keeps the client as the owner of the full transcript, but tool-heavy apps sometimes need the server to own the full message history while the client only sees a filtered view.

This pattern is useful when:

- tool inputs contain server-only context
- tool outputs contain data the model should keep using but the browser should not receive
- conversations are persisted and later rehydrated

## Tool Projection Primitives

Projection lives on the tool definition so live streaming and hydration use the same rules.

```ts
const executeTypescript = toolDefinition({
  name: 'execute_typescript',
  inputSchema: z.object({
    description: z.string(),
    code: z.string(),
  }),
  outputSchema: z.object({
    summary: z.string(),
    logs: z.array(z.string()),
  }),
  clientInput: z.object({
    description: z.string(),
  }),
  clientOutput: (result) => ({
    summary: result.summary,
  }),
}).server(async ({ code }) => runOnServer(code))
```

`clientInput` controls what the client sees for tool arguments.

`clientOutput` controls what the client sees for tool results.

Each projection can be either:

- a synchronous transform function
- a Standard Schema validator such as Zod, ArkType, or Valibot

Schema-based projections are useful when the client shape is just a validated subset of the full server value.

The full tool input and output still remain available to the server and to the model transcript.

## Hydration Utilities

Use the same projection rules when rehydrating persisted history.

```ts
import {
  modelMessagesToUIMessages,
  toClientMessages,
  toClientUIMessages,
} from '@tanstack/ai'

const clientModelMessages = toClientMessages(fullModelMessages, tools)

const clientUIMessages = toClientUIMessages(
  modelMessagesToUIMessages(fullModelMessages),
  tools,
)
```

Use `toClientMessages` if your boundary works with `ModelMessage[]`.

Use `toClientUIMessages` if you are rehydrating UI state for `useChat`.

## Request Shaping

Built-in fetch adapters support `buildRequestBody`, which lets the client send only the new event plus routing metadata instead of the entire transcript.

```ts
const chat = useChat({
  connection: fetchServerSentEvents('/api/chat', {
    buildRequestBody: ({ messages, data }) => ({
      conversationId: data?.conversationId,
      event: {
        type: 'user-message',
        message: messages[messages.length - 1],
      },
    }),
  }),
  body: { conversationId },
  tools: [executeTypescriptTool, lookupUserTool, getWeatherTool] as const,
})
```

`sendMessage(content, body?)` can also supply per-message request metadata when a server-owned conversation needs request-specific routing.

Passing shared tool definitions to `useChat` also propagates the projected client types through `part.input` and `part.output` in the browser.

```ts
if (part.type === 'tool-call' && part.name === 'execute_typescript') {
  part.input?.description
  part.output?.summary
}
```

## Recommended Flow

1. The client sends `conversationId` plus the new event.
2. The server loads the full transcript from storage.
3. The server appends the new event in canonical order.
4. The server calls `chat()` with the full transcript.
5. Live tool chunks are projected with `clientInput` and `clientOutput` before they reach the client.
6. The server persists the full transcript from middleware hooks such as `onToolPhaseComplete` or `onFinish`.
7. Hydration returns `toClientUIMessages(...)` so reloads see the same filtered view as live streaming.

## Persistence Recipe

Persist the full transcript from middleware, not the projected client view.

```ts
const finalAssistantChunks: string[] = []

const stream = chat({
  adapter,
  messages: fullMessagesFromStore,
  tools: serverTools,
  middleware: [
    {
      name: 'persist',
      onChunk: (_ctx, chunk) => {
        if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
          finalAssistantChunks.push(chunk.delta)
        }
      },
      onFinish: async (ctx) => {
        await saveConversation({
          messages: ctx.messages,
          finalAssistantText: finalAssistantChunks.join(''),
        })
      },
    },
  ],
})
```

The important split is:

- `onChunk` sees the client-visible projected stream
- `ctx.messages` remains the full server transcript
- hydration should derive the client view later with `toClientUIMessages(...)`

## Notes

- This pattern does not require hidden `serverOnly` messages.
- The server-owned transcript remains the source of truth.
- The client receives a projection of that transcript, not a second canonical history.
- Storage remains fully userland. You can use a database, KV store, or files behind the same projection flow.
