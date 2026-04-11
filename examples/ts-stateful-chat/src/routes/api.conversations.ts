import { createFileRoute } from '@tanstack/react-router'
import { conversationStore } from '@/lib/conversation-store'

export const Route = createFileRoute('/api/conversations')({
  server: {
    handlers: {
      async GET() {
        const conversations = await conversationStore.list()
        return Response.json(conversations)
      },
    },
  },
})
