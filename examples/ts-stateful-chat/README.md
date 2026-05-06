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

- `clientInput` and `clientOutput` optional client projection hooks on the `Tool` interface (`packages/typescript/ai/src/types.ts`)
- Each projection can be either a synchronous transform function or a Standard Schema validator such as Zod
- Propagated through `ToolDefinitionConfig`, `ClientTool`, and `.server()`/`.client()` builders
- `toClientMessages(messages, tools)` and `toClientUIMessages(messages, tools)` utilities that apply filters to produce the client view of a message array
- Exported from `@tanstack/ai`

### This example

- **ConversationStore** (`src/lib/conversation-store.ts`) -- JSON file persistence in `/tmp/tanstack-ai-conversations/` behind a DB-like interface
- **Server endpoints** (`src/routes/api.chat.ts`) -- POST accepts `{ conversationId, event }`, loads full history, calls `chat()`, persists the full transcript, and GET rehydrates filtered UIMessages via `toClientUIMessages()`
- **Built-in fetch adapter request shaping** (`src/routes/index.tsx`) -- uses `fetchServerSentEvents(..., { buildRequestBody })` to send only `{ conversationId, event }` instead of the full history
- **Typed client tool definitions** (`src/shared/tools.ts`) -- the browser imports shared tool definitions, so projected `part.input` and `part.output` types flow through `useChat`
- **3 example tools** (`src/shared/tools.ts`):
  - `execute_typescript` -- `clientInput` hides raw code, `clientOutput` hides internal result data
  - `lookup_user` -- `clientOutput` strips PII (email, SSN, internal score)
  - `get_weather` -- no filtering (all data safe for client)

## How it works

```
Client                          Server
  |                               |
  |-- POST {conversationId, event}|
  |                               | load(chatId) -> messages from DB
  |                               | append new event to full transcript
  |                               | chat({ messages, tools })
  |                               |   core projects outbound tool data
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

The example uses a deterministic local adapter by default so the server-stateful
flow, tool projection, and hydration path are reproducible in local development.

To opt into a real model, set both:

```bash
export OPENAI_API_KEY=...
export TANSTACK_AI_STATEFUL_CHAT_USE_OPENAI=true
```

When both are present, the example uses `openaiText('gpt-4o-mini')`.

## What works

- Server-stateful architecture end-to-end
- Persistence (JSON files, conversation list in sidebar)
- Live streaming uses the same tool projection rules as hydration
- Rehydration with `clientOutput` filtering -- reloading a conversation shows `{"id":"123","name":"Alice Johnson"}` instead of full record with SSN/email/internalScore
- `toClientUIMessages()` correctly applies filters on hydration path
- All three tools callable by the LLM

## Notes

- The server still owns the full `ModelMessage[]` transcript. The client receives a projected UI view.
- The example stays storage-agnostic. Swap the JSON store for a database and keep the same request/hydration flow.
- `buildRequestBody` is what makes the built-in fetch adapter fit the server-stateful recipe without a custom transport.
