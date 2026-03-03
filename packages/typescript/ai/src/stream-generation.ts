/**
 * Server-side streaming helpers for wrapping generation activities
 * as StreamChunk async iterables. These are compatible with
 * toServerSentEventsResponse() and toHttpResponse().
 */

import type { StreamChunk } from './types'
import type { AnyVideoAdapter } from './activities/generateVideo/adapter'

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wrap a one-shot generation result as a StreamChunk async iterable.
 *
 * This allows non-streaming activities (image, speech, transcription, summarize)
 * to be sent over the same streaming transport as chat.
 *
 * @param generator - An async function that performs the generation and returns the result
 * @param options - Optional configuration (runId)
 * @returns An AsyncIterable of StreamChunks with RUN_STARTED, CUSTOM(generation:result), and RUN_FINISHED events
 *
 * @example
 * ```typescript
 * import { generateImage, streamGenerationResult, toServerSentEventsResponse } from '@tanstack/ai'
 * import { openaiImage } from '@tanstack/ai-openai'
 *
 * app.post('/api/generate/image', async (req) => {
 *   const { prompt, size } = await req.json()
 *   const stream = streamGenerationResult(() =>
 *     generateImage({ adapter: openaiImage('dall-e-3'), prompt, size })
 *   )
 *   return toServerSentEventsResponse(stream)
 * })
 * ```
 */
export async function* streamGenerationResult<TResult>(
  generator: () => Promise<TResult>,
  options?: { runId?: string },
): AsyncIterable<StreamChunk> {
  const runId = options?.runId ?? createId('run')

  yield {
    type: 'RUN_STARTED',
    runId,
    timestamp: Date.now(),
  }

  try {
    const result = await generator()

    yield {
      type: 'CUSTOM',
      name: 'generation:result',
      value: result as unknown,
      timestamp: Date.now(),
    }

    yield {
      type: 'RUN_FINISHED',
      runId,
      finishReason: 'stop',
      timestamp: Date.now(),
    }
  } catch (error: any) {
    yield {
      type: 'RUN_ERROR',
      runId,
      error: {
        message: error.message || 'Generation failed',
        code: error.code,
      },
      timestamp: Date.now(),
    }
  }
}

/**
 * Options for streamVideoGeneration.
 */
export interface StreamVideoGenerationOptions {
  /** Polling interval in milliseconds. Default: 2000 */
  pollingInterval?: number
  /** Maximum time to wait before timing out in milliseconds. Default: 600000 (10 min) */
  maxDuration?: number
  /** Custom run ID */
  runId?: string
}

/**
 * Create a video generation job and stream status updates until completion.
 *
 * This wraps the job-based video generation workflow into a StreamChunk iterable
 * that can be sent over SSE or HTTP streaming. The server handles the polling loop
 * internally and streams status updates to the client.
 *
 * @param adapter - The video adapter to use
 * @param input - Video generation input (prompt, size, duration, etc.)
 * @param options - Optional configuration (pollingInterval, maxDuration, runId)
 * @returns An AsyncIterable of StreamChunks with job lifecycle events
 *
 * @example
 * ```typescript
 * import { streamVideoGeneration, toServerSentEventsResponse } from '@tanstack/ai'
 * import { openaiVideo } from '@tanstack/ai-openai'
 *
 * app.post('/api/generate/video', async (req) => {
 *   const input = await req.json()
 *   const stream = streamVideoGeneration(
 *     openaiVideo('sora'),
 *     input,
 *     { pollingInterval: 3000 }
 *   )
 *   return toServerSentEventsResponse(stream)
 * })
 * ```
 */
export async function* streamVideoGeneration(
  adapter: AnyVideoAdapter,
  input: {
    prompt: string
    size?: string
    duration?: number
    modelOptions?: Record<string, any>
  },
  options?: StreamVideoGenerationOptions,
): AsyncIterable<StreamChunk> {
  const runId = options?.runId ?? createId('run')
  const pollingInterval = options?.pollingInterval ?? 2000
  const maxDuration = options?.maxDuration ?? 600_000

  yield {
    type: 'RUN_STARTED',
    runId,
    timestamp: Date.now(),
  }

  try {
    // Create the video generation job
    const jobResult = await adapter.createVideoJob({
      model: adapter.model,
      prompt: input.prompt,
      size: input.size,
      duration: input.duration,
      modelOptions: input.modelOptions,
    })

    yield {
      type: 'CUSTOM',
      name: 'video:job:created',
      value: { jobId: jobResult.jobId },
      timestamp: Date.now(),
    }

    // Poll for completion
    const startTime = Date.now()
    while (Date.now() - startTime < maxDuration) {
      await sleep(pollingInterval)

      const statusResult = await adapter.getVideoStatus(jobResult.jobId)

      yield {
        type: 'CUSTOM',
        name: 'video:status',
        value: {
          jobId: jobResult.jobId,
          status: statusResult.status,
          progress: statusResult.progress,
          error: statusResult.error,
        },
        timestamp: Date.now(),
      }

      if (statusResult.status === 'completed') {
        const urlResult = await adapter.getVideoUrl(jobResult.jobId)

        yield {
          type: 'CUSTOM',
          name: 'generation:result',
          value: {
            jobId: jobResult.jobId,
            status: 'completed',
            url: urlResult.url,
            expiresAt: urlResult.expiresAt,
          },
          timestamp: Date.now(),
        }

        yield {
          type: 'RUN_FINISHED',
          runId,
          finishReason: 'stop',
          timestamp: Date.now(),
        }
        return
      }

      if (statusResult.status === 'failed') {
        throw new Error(statusResult.error || 'Video generation failed')
      }
    }

    throw new Error('Video generation timed out')
  } catch (error: any) {
    yield {
      type: 'RUN_ERROR',
      runId,
      error: {
        message: error.message || 'Video generation failed',
        code: error.code,
      },
      timestamp: Date.now(),
    }
  }
}
