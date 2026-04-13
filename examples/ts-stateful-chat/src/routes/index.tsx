import { useState, useEffect, useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import type { UIMessage } from '@tanstack/ai-client'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const [conversationId, setConversationId] = useState<string>(() =>
    crypto.randomUUID(),
  )
  const [conversations, setConversations] = useState<
    Array<{ id: string; createdAt: string; messageCount: number }>
  >([])
  const [initialMessages, setInitialMessages] = useState<Array<UIMessage>>([])
  const [hydrated, setHydrated] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load conversation list
  useEffect(() => {
    fetch('/api/conversations')
      .then((r) => r.json())
      .then(setConversations)
      .catch(() => {})
  }, [])

  // Rehydrate conversation on mount or when switching conversations
  useEffect(() => {
    setHydrated(false)
    fetch(`/api/chat?conversationId=${conversationId}`)
      .then((r) => r.json())
      .then((msgs: Array<UIMessage>) => {
        setInitialMessages(msgs)
        setHydrated(true)
      })
      .catch(() => {
        setInitialMessages([])
        setHydrated(true)
      })
  }, [conversationId])

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="flex h-screen">
      <Sidebar
        conversations={conversations}
        activeId={conversationId}
        onSelect={setConversationId}
        onNew={() => setConversationId(crypto.randomUUID())}
      />
      <ChatPanel
        key={conversationId}
        conversationId={conversationId}
        initialMessages={initialMessages}
        inputRef={inputRef}
      />
    </div>
  )
}

function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: Array<{ id: string; createdAt: string; messageCount: number }>
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className="w-64 bg-gray-100 border-r border-gray-200 flex flex-col">
      <div className="p-4 border-b border-gray-200">
        <h1 className="text-lg font-bold">Stateful Chat</h1>
        <p className="text-xs text-gray-500 mt-1">Server owns message history</p>
      </div>
      <button
        onClick={onNew}
        className="m-3 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
      >
        New Conversation
      </button>
      <div className="flex-1 overflow-y-auto">
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`w-full text-left px-4 py-3 border-b border-gray-200 text-sm hover:bg-gray-200 ${
              c.id === activeId ? 'bg-blue-50 border-l-2 border-l-blue-600' : ''
            }`}
          >
            <div className="font-medium truncate">{c.id.slice(0, 8)}...</div>
            <div className="text-xs text-gray-500">
              {c.messageCount} messages
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function ChatPanel({
  conversationId,
  initialMessages,
  inputRef,
}: {
  conversationId: string
  initialMessages: Array<UIMessage>
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const { messages, sendMessage, isLoading } = useChat({
    connection: fetchServerSentEvents('/api/chat', {
      buildRequestBody: ({ messages, data }) => {
        const latestMessage = messages[messages.length - 1]

        return {
          conversationId: data?.conversationId,
          event:
            latestMessage && 'parts' in latestMessage && latestMessage.role === 'user'
              ? {
                  type: 'user-message',
                  message: latestMessage,
                }
              : undefined,
        }
      },
    }),
    body: { conversationId },
    initialMessages,
  })

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = (text: string) => {
    if (!text.trim()) return
    sendMessage(text)
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="px-6 py-3 border-b border-gray-200 bg-white">
        <div className="text-sm font-medium">
          Conversation: <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">{conversationId.slice(0, 8)}</code>
        </div>
        <div className="text-xs text-gray-500 mt-0.5">
          Tool data is filtered before reaching the client. Reload to test rehydration.
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-20">
            <p className="text-lg">Start a conversation</p>
            <p className="text-sm mt-2">
              Try: &quot;Look up user 123&quot; or &quot;Run some TypeScript to calculate 2+2&quot; or &quot;What&apos;s the weather in Paris?&quot;
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-gray-200 bg-white">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder={isLoading ? 'Thinking...' : 'Type a message...'}
            disabled={isLoading}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isLoading) {
                send(e.currentTarget.value)
                e.currentTarget.value = ''
              }
            }}
          />
          <button
            disabled={isLoading}
            onClick={() => {
              if (inputRef.current) {
                send(inputRef.current.value)
                inputRef.current.value = ''
              }
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] rounded-lg px-4 py-2 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-white border border-gray-200 shadow-sm'
        }`}
      >
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <p key={i} className="whitespace-pre-wrap">
                {part.content}
              </p>
            )
          }
          if (part.type === 'tool-call') {
            return (
              <div
                key={i}
                className="my-2 p-2 bg-gray-50 border border-gray-200 rounded text-sm"
              >
                <div className="font-medium text-gray-700">
                  Tool: {part.name}
                </div>
                <div className="mt-1">
                  <span className="text-gray-500 text-xs">Input (client view):</span>
                  <pre className="text-xs bg-gray-100 p-1 rounded mt-0.5 overflow-x-auto">
                    {part.arguments}
                  </pre>
                </div>
                {part.output !== undefined && (
                  <div className="mt-1">
                    <span className="text-gray-500 text-xs">Output (client view):</span>
                    <pre className="text-xs bg-gray-100 p-1 rounded mt-0.5 overflow-x-auto">
                      {JSON.stringify(part.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )
          }
          if (part.type === 'tool-result') {
            return (
              <div
                key={i}
                className="my-1 p-1 bg-green-50 border border-green-200 rounded text-xs"
              >
                <span className="text-green-700 font-medium">Result (client view):</span>
                <pre className="mt-0.5 overflow-x-auto">{part.content}</pre>
              </div>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
