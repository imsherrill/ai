import { createFileRoute } from '@tanstack/react-router'
import {
  generateSpeech,
  streamGenerationResult,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { openaiSpeech } from '@tanstack/ai-openai'

export const Route = createFileRoute('/api/generate/speech')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json()
        const { text, voice, format, model } = body.data

        const stream = streamGenerationResult(() =>
          generateSpeech({
            adapter: openaiSpeech(model ?? 'tts-1'),
            text,
            voice,
            format,
          }),
        )

        return toServerSentEventsResponse(stream)
      },
    },
  },
})
