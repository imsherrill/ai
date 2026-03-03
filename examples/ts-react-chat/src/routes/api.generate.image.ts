import { createFileRoute } from '@tanstack/react-router'
import {
  streamGenerationResult,
  generateImage,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { openaiImage } from '@tanstack/ai-openai'

export const Route = createFileRoute('/api/generate/image')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json()
        const { prompt, size, model, numberOfImages } = body.data

        const stream = streamGenerationResult(() =>
          generateImage({
            adapter: openaiImage(model ?? 'gpt-image-1'),
            prompt,
            size,
            numberOfImages,
          }),
        )

        return toServerSentEventsResponse(stream)
      },
    },
  },
})
