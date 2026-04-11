# Server-Stateful Chat POC

A proof-of-concept for server-owned message history in TanStack AI, with `clientInput`/`clientOutput` filtering on tool definitions.

## Motivation

TanStack AI's current architecture is stateless on the server -- the client owns the full message history and sends it all on every request. This breaks down with persistence:

1. Tool results that should stay server-only (code mode output, PII, internal data) leak to the client during hydration from a DB
2. Middleware hooks (`onChunk`, `onAfterToolCall`) only run during live streaming, not hydration -- filtering logic must be duplicated
3. If both client and server hold messages, you get duplicates in LLM context

Jack Herrington approved exploration of this direction. The architecture: server POST takes chat ID + new message, pulls history from DB, appends, calls `chat()`, streams back filtered response.

**Discord thread:** https://discord.com/channels/719702312431386674/1446303229192310996/1491397457396109363
**Original clientOutput PR:** https://github.com/TanStack/ai/pull/398

## What's in this POC

### Core library changes (non-breaking, additive)

- `clientInput` and `clientOutput` optional transform functions on the `Tool` interface (`packages/typescript/ai/src/types.ts`)
- Propagated through `ToolDefinitionConfig`, `ClientTool`, and `.server()`/`.client()` builders
- `toClientMessages(messages, tools)` and `toClientUIMessages(messages, tools)` utilities that apply filters to produce the client view of a message array
- Exported from `@tanstack/ai`

### This example

- **ConversationStore** (`src/lib/conversation-store.ts`) -- JSON file persistence in `/tmp/tanstack-ai-conversations/` behind a DB-like interface
- **Server endpoints** (`src/routes/api.chat.ts`) -- POST sends a message (server loads history, calls `chat()`, persists), GET rehydrates with filtered UIMessages via `toClientUIMessages()`
- **Custom connection adapter** (`src/lib/server-stateful-adapter.ts`) -- sends only `{ conversationId, message }` instead of full history
- **Client filter middleware** (`src/lib/client-filter-middleware.ts`) -- `onChunk` middleware that filters `TOOL_CALL_END.input` via `clientInput`
- **3 example tools** (`src/shared/tools.ts`):
  - `execute_typescript` -- `clientInput` hides raw code, `clientOutput` hides internal result data
  - `lookup_user` -- `clientOutput` strips PII (email, SSN, internal score)
  - `get_weather` -- no filtering (all data safe for client)

## How it works

```
Client                          Server
  |                               |
  |-- POST {chatId, message} ---> |
  |                               | load(chatId) -> messages from DB
  |                               | messages.push(user message)
  |                               | chat({ messages, tools, middleware })
  |                               |   middleware filters chunks via clientInput
  |                               |   onFinish persists full messages to DB
  | <--- SSE stream (filtered) ---|
  |                               |
  |-- GET ?conversationId=xxx --> |
  |                               | load(id) -> messages from DB
  |                               | modelMessagesToUIMessages(messages)
  |                               | toClientUIMessages(uiMessages, tools)
  | <--- JSON (filtered) ---------|
```

The same `clientInput`/`clientOutput` functions from the tool definitions are used for both streaming and rehydration.

## Running

```bash
# From repo root
pnpm install
pnpm --filter @tanstack/ai build

# Start the example
cd examples/ts-stateful-chat
pnpm dev
# Opens on http://localhost:3001
```

Requires `OPENAI_API_KEY` in your environment.

## What works

- Server-stateful architecture end-to-end
- Persistence (JSON files, conversation list in sidebar)
- Rehydration with `clientOutput` filtering -- reloading a conversation shows `{"id":"123","name":"Alice Johnson"}` instead of full record with SSN/email/internalScore
- `toClientUIMessages()` correctly applies filters on hydration path
- All three tools callable by the LLM

## Known issues to discuss

### 1. `onChunk` middleware doesn't see tool result chunks

`buildToolResultChunks` in `TextEngine` yields `TOOL_CALL_END` chunks through `processToolCalls()`, which bypasses the `onChunk` middleware pipeline (only `streamModelResponse` pipes through middleware). This means `clientOutput` can't filter tool results during live streaming -- only during rehydration.

This is likely a bug/oversight in the engine. For a complete solution, `processToolCalls()` chunks should flow through `onChunk` middleware too.

### 2. `useChat.sendMessage` drops per-message body

The React hook signature is `sendMessage(content)` -- it doesn't forward the second `body` parameter that `ChatClient.sendMessage(content, body)` supports. The adapter works around this by extracting the latest user message from the messages array.

### 3. ChatClient hardcodes `conversationId` override

Line 585 of `chat-client.ts`: `conversationId: this.uniqueId` always overwrites whatever the user sets in the `body` option. The adapter works around this by using a separate key (`chatId`).

### 4. Live stream vs. rehydration asymmetry

Because of issue #1, the client sees full unfiltered tool results during the live stream but sees filtered results after reload. For a complete implementation, the engine needs to pipe `processToolCalls()` chunks through middleware.

## Next steps

- Fix the engine to pipe tool result chunks through `onChunk` middleware
- Consider whether `useChat.sendMessage` should forward the body parameter
- Consider a `serverStateful` option on ChatClient that changes the default behavior (don't send full history, use server-provided conversationId)
- Consider promoting `toClientMessages`/`toClientUIMessages` to a first-class concept in the library
