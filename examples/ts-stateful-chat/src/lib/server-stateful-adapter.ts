import type { ConnectConnectionAdapter, UIMessage } from '@tanstack/ai-client'
import type { StreamChunk } from '@tanstack/ai'

/**
 * A connection adapter for server-stateful chat.
 *
 * Unlike fetchServerSentEvents which sends the full message history,
 * this adapter sends only the conversationId + the latest user message.
 * The server owns the full message history.
 *
 * The conversationId is passed via the `body` option on useChat/ChatClient.
 * Since useChat's sendMessage doesn't forward per-message body params,
 * we extract the latest user message from the messages array instead.
 */
export function fetchServerStateful(
  url: string,
): ConnectConnectionAdapter {
  return {
    async *connect(
      messages,
      data,
      abortSignal,
    ): AsyncIterable<StreamChunk> {
      // Extract the latest user message from the messages array
      // (the ChatClient adds it before calling connect)
      const lastUserMsg = [...(messages as UIMessage[])]
        .reverse()
        .find((m) => m.role === 'user')
      const lastUserText = lastUserMsg?.parts
        .filter((p): p is { type: 'text'; content: string } => p.type === 'text')
        .map((p) => p.content)
        .join('')

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: data?.chatId,
          message: lastUserText || undefined,
          toolResult: data?.toolResult,
        }),
        signal: abortSignal,
      })

      if (!response.ok) {
        throw new Error(`Chat request failed: ${response.status}`)
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed === 'data: [DONE]') continue
          const jsonStr = trimmed.startsWith('data: ')
            ? trimmed.slice(6)
            : trimmed
          if (jsonStr) {
            try {
              yield JSON.parse(jsonStr)
            } catch {
              // Skip malformed chunks
            }
          }
        }
      }
    },
  }
}
