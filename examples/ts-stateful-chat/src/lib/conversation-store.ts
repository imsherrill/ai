import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from '@tanstack/ai'

const STORE_DIR = '/tmp/tanstack-ai-conversations'

interface ConversationData {
  messages: Array<ModelMessage>
  createdAt: string
  updatedAt: string
}

export interface ConversationStore {
  load(
    id: string,
  ): Promise<{ messages: Array<ModelMessage>; createdAt: string } | null>
  save(id: string, messages: Array<ModelMessage>): Promise<void>
  list(): Promise<
    Array<{ id: string; createdAt: string; messageCount: number }>
  >
  delete(id: string): Promise<void>
}

async function ensureDir() {
  await mkdir(STORE_DIR, { recursive: true })
}

function filePath(id: string): string {
  // Sanitize id to prevent path traversal
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '')
  return join(STORE_DIR, `${safe}.json`)
}

export const conversationStore: ConversationStore = {
  async load(id) {
    try {
      const data = await readFile(filePath(id), 'utf-8')
      const parsed: ConversationData = JSON.parse(data)
      return { messages: parsed.messages, createdAt: parsed.createdAt }
    } catch {
      return null
    }
  },

  async save(id, messages) {
    await ensureDir()
    const existing = await this.load(id)
    const data: ConversationData = {
      messages,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeFile(filePath(id), JSON.stringify(data, null, 2))
  },

  async list() {
    await ensureDir()
    const files = await readdir(STORE_DIR)
    const conversations = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const id = f.replace('.json', '')
          const data = await this.load(id)
          return data
            ? {
                id,
                createdAt: data.createdAt,
                messageCount: data.messages.length,
              }
            : null
        }),
    )
    return conversations
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
  },

  async delete(id) {
    try {
      await unlink(filePath(id))
    } catch {
      // Already deleted
    }
  },
}
