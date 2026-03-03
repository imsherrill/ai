import { describe, it, expect, vi } from 'vitest'
import {
  streamGenerationResult,
  streamVideoGeneration,
} from '../src/stream-generation'
import type { StreamChunk, VideoStatusResult } from '../src/types'

// Helper to collect all chunks from an async iterable
async function collectChunks(
  stream: AsyncIterable<StreamChunk>,
): Promise<Array<StreamChunk>> {
  const chunks: Array<StreamChunk> = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

describe('streamGenerationResult', () => {
  it('should emit RUN_STARTED, CUSTOM result, and RUN_FINISHED', async () => {
    const mockResult = {
      id: '1',
      images: [{ url: 'http://example.com/img.png' }],
    }

    const chunks = await collectChunks(
      streamGenerationResult(async () => mockResult),
    )

    expect(chunks).toHaveLength(3)

    expect(chunks[0]!.type).toBe('RUN_STARTED')
    expect(chunks[0]!).toHaveProperty('runId')

    expect(chunks[1]!.type).toBe('CUSTOM')
    if (chunks[1]!.type === 'CUSTOM') {
      expect(chunks[1]!.name).toBe('generation:result')
      expect(chunks[1]!.value).toEqual(mockResult)
    }

    expect(chunks[2]!.type).toBe('RUN_FINISHED')
    if (chunks[2]!.type === 'RUN_FINISHED') {
      expect(chunks[2]!.finishReason).toBe('stop')
    }
  })

  it('should emit RUN_ERROR when generator throws', async () => {
    const chunks = await collectChunks(
      streamGenerationResult(async () => {
        throw new Error('Generation failed')
      }),
    )

    expect(chunks).toHaveLength(2)

    expect(chunks[0]!.type).toBe('RUN_STARTED')

    expect(chunks[1]!.type).toBe('RUN_ERROR')
    if (chunks[1]!.type === 'RUN_ERROR') {
      expect(chunks[1]!.error.message).toBe('Generation failed')
    }
  })

  it('should use provided runId', async () => {
    const chunks = await collectChunks(
      streamGenerationResult(async () => ({ id: '1' }), {
        runId: 'custom-run',
      }),
    )

    if (chunks[0]!.type === 'RUN_STARTED') {
      expect(chunks[0]!.runId).toBe('custom-run')
    }
  })

  it('should include timestamps on all events', async () => {
    const before = Date.now()
    const chunks = await collectChunks(
      streamGenerationResult(async () => ({ id: '1' })),
    )
    const after = Date.now()

    for (const chunk of chunks) {
      expect(chunk.timestamp).toBeGreaterThanOrEqual(before)
      expect(chunk.timestamp).toBeLessThanOrEqual(after)
    }
  })

  it('should emit null result when generator returns null', async () => {
    const chunks = await collectChunks(streamGenerationResult(async () => null))

    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.type).toBe('RUN_STARTED')

    expect(chunks[1]!.type).toBe('CUSTOM')
    if (chunks[1]!.type === 'CUSTOM') {
      expect(chunks[1]!.name).toBe('generation:result')
      expect(chunks[1]!.value).toBeNull()
    }

    expect(chunks[2]!.type).toBe('RUN_FINISHED')
  })

  it('should use fallback message when error has no message', async () => {
    const chunks = await collectChunks(
      streamGenerationResult(async () => {
        throw { code: 'TIMEOUT' }
      }),
    )

    expect(chunks).toHaveLength(2)
    expect(chunks[1]!.type).toBe('RUN_ERROR')
    if (chunks[1]!.type === 'RUN_ERROR') {
      expect(chunks[1]!.error.message).toBe('Generation failed')
      expect(chunks[1]!.error.code).toBe('TIMEOUT')
    }
  })
})

describe('streamVideoGeneration', () => {
  function createMockVideoAdapter(options?: {
    pollsBeforeComplete?: number
    failOnPoll?: number
  }) {
    const pollsBeforeComplete = options?.pollsBeforeComplete ?? 2
    const failOnPoll = options?.failOnPoll
    let pollCount = 0

    return {
      kind: 'video' as const,
      name: 'test-video',
      model: 'test-model',
      '~types': {} as any,

      createVideoJob: vi.fn(async () => ({
        jobId: 'job-123',
        model: 'test-model',
      })),

      getVideoStatus: vi.fn(async (): Promise<VideoStatusResult> => {
        pollCount++
        if (failOnPoll && pollCount >= failOnPoll) {
          return {
            jobId: 'job-123',
            status: 'failed',
            error: 'Video processing error',
          }
        }
        if (pollCount >= pollsBeforeComplete) {
          return {
            jobId: 'job-123',
            status: 'completed',
            progress: 100,
          }
        }
        return {
          jobId: 'job-123',
          status: 'processing',
          progress: Math.round((pollCount / pollsBeforeComplete) * 100),
        }
      }),

      getVideoUrl: vi.fn(async () => ({
        jobId: 'job-123',
        url: 'https://example.com/video.mp4',
        expiresAt: new Date('2030-01-01'),
      })),
    }
  }

  it('should emit job lifecycle events until completion', async () => {
    const adapter = createMockVideoAdapter({ pollsBeforeComplete: 2 })

    const chunks = await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'test' },
        { pollingInterval: 10 },
      ),
    )

    // RUN_STARTED, video:job:created, video:status (processing), video:status (completed), generation:result, RUN_FINISHED
    const types = chunks.map((c) =>
      c.type === 'CUSTOM' ? `CUSTOM:${c.name}` : c.type,
    )

    expect(types).toContain('RUN_STARTED')
    expect(types).toContain('CUSTOM:video:job:created')
    expect(types).toContain('CUSTOM:video:status')
    expect(types).toContain('CUSTOM:generation:result')
    expect(types).toContain('RUN_FINISHED')

    // Check job created event
    const jobCreated = chunks.find(
      (c) => c.type === 'CUSTOM' && c.name === 'video:job:created',
    )
    if (jobCreated?.type === 'CUSTOM') {
      expect(jobCreated.value).toEqual({ jobId: 'job-123' })
    }

    // Check result
    const result = chunks.find(
      (c) => c.type === 'CUSTOM' && c.name === 'generation:result',
    )
    if (result?.type === 'CUSTOM') {
      const value = result.value as any
      expect(value.url).toBe('https://example.com/video.mp4')
      expect(value.jobId).toBe('job-123')
      expect(value.status).toBe('completed')
    }
  })

  it('should emit RUN_ERROR when video generation fails', async () => {
    const adapter = createMockVideoAdapter({ failOnPoll: 1 })

    const chunks = await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'test' },
        { pollingInterval: 10 },
      ),
    )

    const types = chunks.map((c) => c.type)
    expect(types).toContain('RUN_ERROR')

    const error = chunks.find((c) => c.type === 'RUN_ERROR')
    if (error?.type === 'RUN_ERROR') {
      expect(error.error.message).toBe('Video processing error')
    }
  })

  it('should pass input parameters to createVideoJob', async () => {
    const adapter = createMockVideoAdapter({ pollsBeforeComplete: 1 })

    await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'A flying car', size: '1280x720', duration: 5 },
        { pollingInterval: 10 },
      ),
    )

    expect(adapter.createVideoJob).toHaveBeenCalledWith({
      model: 'test-model',
      prompt: 'A flying car',
      size: '1280x720',
      duration: 5,
      modelOptions: undefined,
    })
  })

  it('should timeout after maxDuration', async () => {
    // Adapter that never completes
    const adapter = createMockVideoAdapter({ pollsBeforeComplete: 999999 })

    const chunks = await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'test' },
        { pollingInterval: 10, maxDuration: 50 },
      ),
    )

    const error = chunks.find((c) => c.type === 'RUN_ERROR')
    if (error?.type === 'RUN_ERROR') {
      expect(error.error.message).toBe('Video generation timed out')
    }
  })

  it('should emit RUN_ERROR when createVideoJob throws', async () => {
    const adapter = createMockVideoAdapter()
    adapter.createVideoJob = vi.fn(async () => {
      throw new Error('Job creation failed')
    })

    const chunks = await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'test' },
        { pollingInterval: 10 },
      ),
    )

    const types = chunks.map((c) =>
      c.type === 'CUSTOM' ? `CUSTOM:${c.name}` : c.type,
    )
    expect(types).toContain('RUN_STARTED')
    expect(types).toContain('RUN_ERROR')
    expect(types).not.toContain('CUSTOM:video:job:created')

    const error = chunks.find((c) => c.type === 'RUN_ERROR')
    if (error?.type === 'RUN_ERROR') {
      expect(error.error.message).toBe('Job creation failed')
    }
  })

  it('should emit RUN_ERROR when getVideoUrl throws after completed status', async () => {
    const adapter = createMockVideoAdapter({ pollsBeforeComplete: 1 })
    adapter.getVideoUrl = vi.fn(async () => {
      throw new Error('Failed to retrieve video URL')
    })

    const chunks = await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'test' },
        { pollingInterval: 10 },
      ),
    )

    const error = chunks.find((c) => c.type === 'RUN_ERROR')
    expect(error).toBeDefined()
    if (error?.type === 'RUN_ERROR') {
      expect(error.error.message).toBe('Failed to retrieve video URL')
    }
  })

  it('should propagate error message from failed status', async () => {
    const adapter = createMockVideoAdapter()
    let pollCount = 0
    adapter.getVideoStatus = vi.fn(async () => {
      pollCount++
      return {
        jobId: 'job-123',
        status: 'failed' as const,
        error: 'Content policy violation',
      }
    })

    const chunks = await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'test' },
        { pollingInterval: 10 },
      ),
    )

    const error = chunks.find((c) => c.type === 'RUN_ERROR')
    if (error?.type === 'RUN_ERROR') {
      expect(error.error.message).toBe('Content policy violation')
    }
  })

  it('should use default message when failed status has no error', async () => {
    const adapter = createMockVideoAdapter()
    adapter.getVideoStatus = vi.fn(async () => ({
      jobId: 'job-123',
      status: 'failed' as const,
    }))

    const chunks = await collectChunks(
      streamVideoGeneration(
        adapter,
        { prompt: 'test' },
        { pollingInterval: 10 },
      ),
    )

    const error = chunks.find((c) => c.type === 'RUN_ERROR')
    if (error?.type === 'RUN_ERROR') {
      expect(error.error.message).toBe('Video generation failed')
    }
  })
})
