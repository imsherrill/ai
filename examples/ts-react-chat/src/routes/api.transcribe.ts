import { createFileRoute } from '@tanstack/react-router'
import {
  streamGenerationResult,
  generateTranscription,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { openaiTranscription } from '@tanstack/ai-openai'

export const Route = createFileRoute('/api/transcribe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json()
        const { audio, language, model } = body.data

        const stream = streamGenerationResult(() =>
          generateTranscription({
            adapter: openaiTranscription(model ?? 'whisper-1'),
            audio,
            language,
          }),
        )

        return toServerSentEventsResponse(stream)
      },
    },
  },
})
