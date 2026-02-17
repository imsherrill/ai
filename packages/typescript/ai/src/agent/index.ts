/**
 * Agent Loop (Experimental)
 *
 * Orchestrates agentic text generation by wrapping the text() function
 * and handling automatic tool execution and looping.
 *
 * Dependency graph: text ← agentLoop ← chat (no cycles)
 */

import { aiEventClient } from '../event-client.js'
import {
  ToolCallManager,
  executeToolCalls,
} from '../activities/chat/tools/tool-calls'
import { maxIterations as maxIterationsStrategy } from '../activities/chat/agent-loop-strategies'
import { text } from '../activities/text/index'
import { convertMessagesToModelMessages } from '../activities/chat/messages'
import type {
  ApprovalRequest,
  ClientToolRequest,
  ToolResult,
} from '../activities/chat/tools/tool-calls'
import type { AnyTextAdapter } from '../activities/chat/adapter'
import type { z } from 'zod'
import type {
  AgentLoopStrategy,
  ConstrainedModelMessage,
  ModelMessage,
  RunFinishedEvent,
  StreamChunk,
  TextMessageContentEvent,
  Tool,
  ToolCall,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from '../types'

// ===========================
// Types
// ===========================

/**
 * Options passed to the text creator function.
 * The creator function should spread these into its text() call.
 */
export interface TextCreatorOptions {
  /** Conversation messages (updated each iteration with tool results) */
  messages: Array<ModelMessage>
  /** Tools for function calling */
  tools?: ReadonlyArray<Tool>
  /** System prompts */
  systemPrompts?: Array<string>
  /** AbortController for cancellation */
  abortController?: AbortController
  /** Zod schema for structured output (when provided, returns Promise instead of stream) */
  outputSchema?: z.ZodType
}

/**
 * A function that creates a text stream or structured output.
 * This is typically a partial application of the text() function with adapter and model pre-configured.
 *
 * @example
 * ```ts
 * const textFn: TextCreator = (opts) => text({
 *   adapter: openaiText(),
 *   model: 'gpt-4o',
 *   ...opts
 * })
 * ```
 */
export type TextCreator = <TSchema extends z.ZodType | undefined = undefined>(
  options: TextCreatorOptions & { outputSchema?: TSchema },
) => TSchema extends z.ZodType
  ? Promise<z.infer<TSchema>>
  : AsyncIterable<StreamChunk>

/**
 * Base options for the agent loop.
 */
export interface AgentLoopBaseOptions {
  /** Conversation messages */
  messages: Array<ModelMessage>
  /** System prompts to prepend to the conversation */
  systemPrompts?: Array<string>
  /** Tools for function calling (auto-executed when called) */
  tools?: ReadonlyArray<Tool>
  /** AbortController for cancellation */
  abortController?: AbortController
  /** Strategy for controlling the agent loop */
  agentLoopStrategy?: AgentLoopStrategy
  /** Unique conversation identifier for tracking */
  conversationId?: string
}

/**
 * Options for streaming agent loop (no structured output).
 */
export interface AgentLoopStreamOptions extends AgentLoopBaseOptions {
  outputSchema?: undefined
}

/**
 * Options for structured output agent loop.
 */
export interface AgentLoopStructuredOptions<
  TSchema extends z.ZodType,
> extends AgentLoopBaseOptions {
  /** Zod schema for structured output - determines return type */
  outputSchema: TSchema
}

/**
 * Combined options type for the agent loop.
 */
export type AgentLoopOptions<
  TSchema extends z.ZodType | undefined = undefined,
> = TSchema extends z.ZodType
  ? AgentLoopStructuredOptions<TSchema>
  : AgentLoopStreamOptions

// ===========================
// Direct Options Types (adapter-based API)
// ===========================

/**
 * Direct chat options for agent loop (adapter-based API).
 * Provides full chat() parity with adapter-aware typing.
 *
 * @template TAdapter - The text adapter type (created by a provider function)
 * @template TSchema - Optional schema for structured output
 */
export interface AgentLoopDirectOptions<
  TAdapter extends AnyTextAdapter,
  TSchema extends z.ZodType | undefined = undefined,
> {
  /** The text adapter to use (created by a provider function like openaiText('gpt-4o')) */
  adapter: TAdapter
  /** Conversation messages - content types are constrained by the adapter's input modalities */
  messages: Array<
    ConstrainedModelMessage<{
      inputModalities: TAdapter['~types']['inputModalities']
      messageMetadataByModality: TAdapter['~types']['messageMetadataByModality']
    }>
  >
  /** System prompts to prepend to the conversation */
  systemPrompts?: Array<string>
  /** Tools for function calling (auto-executed when called) */
  tools?: ReadonlyArray<Tool>
  /** Controls the randomness of the output. Range: [0.0, 2.0] */
  temperature?: number
  /** Nucleus sampling parameter. */
  topP?: number
  /** The maximum number of tokens to generate in the response. */
  maxTokens?: number
  /** Additional metadata to attach to the request. */
  metadata?: Record<string, unknown>
  /** Model-specific provider options (type comes from adapter) */
  modelOptions?: TAdapter['~types']['providerOptions']
  /** AbortController for cancellation */
  abortController?: AbortController
  /** Strategy for controlling the agent loop */
  agentLoopStrategy?: AgentLoopStrategy
  /** Unique conversation identifier for tracking */
  conversationId?: string
  /** Zod schema for structured output - determines return type */
  outputSchema?: TSchema
}

/**
 * Streaming options for direct agent loop (no outputSchema).
 */
export interface AgentLoopDirectStreamOptions<
  TAdapter extends AnyTextAdapter,
> extends AgentLoopDirectOptions<TAdapter, undefined> {
  outputSchema?: undefined
}

/**
 * Structured output options for direct agent loop.
 */
export interface AgentLoopDirectStructuredOptions<
  TAdapter extends AnyTextAdapter,
  TSchema extends z.ZodType,
> extends AgentLoopDirectOptions<TAdapter, TSchema> {
  outputSchema: TSchema
}

// ===========================
// Agent Loop Engine
// ===========================

interface AgentLoopEngineConfig {
  textFn: TextCreator
  options: AgentLoopBaseOptions
  /** Adapter for event context (when using direct options API) */
  adapter?: AnyTextAdapter
}

type ToolPhaseResult = 'continue' | 'stop' | 'wait'
type CyclePhase = 'processText' | 'executeToolCalls'

class AgentLoopEngine {
  private readonly textFn: TextCreator
  private readonly options: AgentLoopBaseOptions
  private readonly tools: ReadonlyArray<Tool>
  private readonly loopStrategy: AgentLoopStrategy
  private readonly toolCallManager: ToolCallManager
  private readonly initialMessageCount: number
  private readonly requestId: string
  private readonly streamId: string
  private readonly effectiveSignal?: AbortSignal

  // Adapter context for events
  private readonly adapterModel: string
  private readonly adapterProvider: string
  private readonly eventOptions?: Record<string, unknown>
  private readonly eventModelOptions?: Record<string, unknown>
  private readonly systemPrompts: Array<string>

  // Client state extracted from initial messages (before conversion)
  private readonly initialApprovals: Map<string, boolean>
  private readonly initialClientToolResults: Map<string, any>

  private messages: Array<ModelMessage>
  private iterationCount = 0
  private lastFinishReason: string | null = null
  private streamStartTime = 0
  private totalChunkCount = 0
  private currentMessageId: string | null = null
  private accumulatedContent = ''
  private finishedEvent: RunFinishedEvent | null = null
  private shouldEmitStreamEnd = true
  private earlyTermination = false
  private toolPhase: ToolPhaseResult = 'continue'
  private cyclePhase: CyclePhase = 'processText'

  constructor(config: AgentLoopEngineConfig) {
    this.textFn = config.textFn
    this.options = config.options
    this.tools = config.options.tools || []
    this.loopStrategy =
      config.options.agentLoopStrategy || maxIterationsStrategy(5)
    this.toolCallManager = new ToolCallManager(this.tools)
    this.initialMessageCount = config.options.messages.length
    this.requestId = this.createId('agent')
    this.streamId = this.createId('stream')
    this.effectiveSignal = config.options.abortController?.signal

    // Set adapter context for events
    this.adapterModel = config.adapter?.model ?? 'agent-loop'
    this.adapterProvider = config.adapter?.name ?? 'agent'
    this.systemPrompts = config.options.systemPrompts || []

    // Extract client state from original messages BEFORE conversion
    const { approvals, clientToolResults } =
      this.extractClientStateFromOriginalMessages(
        config.options.messages as Array<any>,
      )
    this.initialApprovals = approvals
    this.initialClientToolResults = clientToolResults

    // Convert messages to ModelMessage format (handles both UIMessage and ModelMessage input)
    this.messages = convertMessagesToModelMessages(
      config.options.messages as Array<any>,
    )
  }

  /** Get the accumulated content after the loop completes */
  getAccumulatedContent(): string {
    return this.accumulatedContent
  }

  /** Get the final messages array after the loop completes */
  getMessages(): Array<ModelMessage> {
    return this.messages
  }

  async *run(): AsyncGenerator<StreamChunk> {
    this.beforeRun()

    try {
      const pendingPhase = yield* this.checkForPendingToolCalls()
      if (pendingPhase === 'wait') {
        return
      }

      do {
        if (this.earlyTermination || this.isAborted()) {
          return
        }

        this.beginCycle()

        if (this.cyclePhase === 'processText') {
          yield* this.streamTextResponse()
        } else {
          yield* this.processToolCalls()
        }

        this.endCycle()
      } while (this.shouldContinue())
    } finally {
      this.afterRun()
    }
  }

  private beforeRun(): void {
    this.streamStartTime = Date.now()

    aiEventClient.emit('text:request:started', {
      ...this.buildEventContext(),
      timestamp: Date.now(),
    })

    // Emit messages for tracking
    const messagesToEmit = this.options.conversationId
      ? this.messages.slice(-1).filter((m) => m.role === 'user')
      : this.messages

    messagesToEmit.forEach((message, index) => {
      const messageIndex = this.options.conversationId
        ? this.messages.length - 1
        : index
      const messageId = this.createId('msg')
      const content = this.getContentString(message.content)

      aiEventClient.emit('text:message:created', {
        ...this.buildEventContext(),
        messageId,
        role: message.role,
        content,
        toolCalls: message.toolCalls,
        messageIndex,
        timestamp: Date.now(),
      })

      if (message.role === 'user') {
        aiEventClient.emit('text:message:user', {
          ...this.buildEventContext(),
          messageId,
          role: 'user',
          content,
          messageIndex,
          timestamp: Date.now(),
        })
      }
    })
  }

  private afterRun(): void {
    if (!this.shouldEmitStreamEnd) {
      return
    }

    const now = Date.now()

    aiEventClient.emit('text:request:completed', {
      ...this.buildEventContext(),
      content: this.accumulatedContent,
      messageId: this.currentMessageId || undefined,
      finishReason: this.lastFinishReason || undefined,
      usage: this.finishedEvent?.usage,
      duration: now - this.streamStartTime,
      timestamp: now,
    })
  }

  private beginCycle(): void {
    if (this.cyclePhase === 'processText') {
      this.beginIteration()
    }
  }

  private endCycle(): void {
    if (this.cyclePhase === 'processText') {
      this.cyclePhase = 'executeToolCalls'
      return
    }

    this.cyclePhase = 'processText'
    this.iterationCount++
  }

  private beginIteration(): void {
    this.currentMessageId = this.createId('msg')
    this.accumulatedContent = ''
    this.finishedEvent = null

    aiEventClient.emit('text:message:created', {
      ...this.buildEventContext(),
      messageId: this.currentMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    })
  }

  private async *streamTextResponse(): AsyncGenerator<StreamChunk> {
    // Call the user-provided text function with current state (no outputSchema for streaming)
    const stream = this.textFn({
      messages: this.messages,
      tools: this.tools,
      systemPrompts: this.options.systemPrompts,
      abortController: this.options.abortController,
    })

    for await (const chunk of stream) {
      if (this.isAborted()) {
        break
      }

      this.totalChunkCount++

      yield chunk
      this.handleStreamChunk(chunk)

      if (this.earlyTermination) {
        break
      }
    }
  }

  private handleStreamChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'TEXT_MESSAGE_CONTENT':
        this.handleTextMessageContentEvent(chunk)
        break
      case 'TOOL_CALL_START':
        this.handleToolCallStartEvent(chunk)
        break
      case 'TOOL_CALL_ARGS':
        this.handleToolCallArgsEvent(chunk)
        break
      case 'TOOL_CALL_END':
        this.handleToolCallEndEvent(chunk)
        break
      case 'RUN_FINISHED':
        this.handleRunFinishedEvent(chunk)
        break
      case 'RUN_ERROR':
        this.handleRunErrorEvent(chunk)
        break
      case 'STEP_FINISHED':
        this.handleStepFinishedEvent(chunk)
        break
      default:
        break
    }
  }

  private handleTextMessageContentEvent(chunk: TextMessageContentEvent): void {
    if (chunk.content) {
      this.accumulatedContent = chunk.content
    } else {
      this.accumulatedContent += chunk.delta
    }
    aiEventClient.emit('text:chunk:content', {
      ...this.buildEventContext(),
      messageId: this.currentMessageId || undefined,
      content: this.accumulatedContent,
      delta: chunk.delta,
      timestamp: Date.now(),
    })
  }

  private handleToolCallStartEvent(chunk: ToolCallStartEvent): void {
    this.toolCallManager.addToolCallStartEvent(chunk)
    aiEventClient.emit('text:chunk:tool-call', {
      ...this.buildEventContext(),
      messageId: this.currentMessageId || undefined,
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      index: chunk.index ?? 0,
      arguments: '',
      timestamp: Date.now(),
    })
  }

  private handleToolCallArgsEvent(chunk: ToolCallArgsEvent): void {
    this.toolCallManager.addToolCallArgsEvent(chunk)
    aiEventClient.emit('text:chunk:tool-call', {
      ...this.buildEventContext(),
      messageId: this.currentMessageId || undefined,
      toolCallId: chunk.toolCallId,
      toolName: '',
      index: 0,
      arguments: chunk.delta,
      timestamp: Date.now(),
    })
  }

  private handleToolCallEndEvent(chunk: ToolCallEndEvent): void {
    this.toolCallManager.completeToolCall(chunk)
    aiEventClient.emit('text:chunk:tool-result', {
      ...this.buildEventContext(),
      messageId: this.currentMessageId || undefined,
      toolCallId: chunk.toolCallId,
      result: chunk.result || '',
      timestamp: Date.now(),
    })
  }

  private handleRunFinishedEvent(chunk: RunFinishedEvent): void {
    aiEventClient.emit('text:chunk:done', {
      ...this.buildEventContext(),
      messageId: this.currentMessageId || undefined,
      finishReason: chunk.finishReason,
      usage: chunk.usage,
      timestamp: Date.now(),
    })

    if (chunk.usage) {
      aiEventClient.emit('text:usage', {
        ...this.buildEventContext(),
        messageId: this.currentMessageId || undefined,
        usage: chunk.usage,
        timestamp: Date.now(),
      })
    }

    this.finishedEvent = chunk
    this.lastFinishReason = chunk.finishReason
  }

  private handleRunErrorEvent(
    chunk: Extract<StreamChunk, { type: 'RUN_ERROR' }>,
  ): void {
    aiEventClient.emit('text:chunk:error', {
      ...this.buildEventContext(),
      messageId: this.currentMessageId || undefined,
      error: chunk.error.message,
      timestamp: Date.now(),
    })
    this.earlyTermination = true
    this.shouldEmitStreamEnd = false
  }

  private handleStepFinishedEvent(
    chunk: Extract<StreamChunk, { type: 'STEP_FINISHED' }>,
  ): void {
    if (chunk.content || chunk.delta) {
      aiEventClient.emit('text:chunk:thinking', {
        ...this.buildEventContext(),
        messageId: this.currentMessageId || undefined,
        content: chunk.content || '',
        delta: chunk.delta,
        timestamp: Date.now(),
      })
    }
  }

  private async *checkForPendingToolCalls(): AsyncGenerator<
    StreamChunk,
    ToolPhaseResult,
    void
  > {
    const pendingToolCalls = this.getPendingToolCallsFromMessages()
    if (pendingToolCalls.length === 0) {
      return 'continue'
    }

    const finishEvent = this.createSyntheticFinishedEvent()

    const { approvals, clientToolResults } = this.collectClientState()

    const executionResult = await executeToolCalls(
      pendingToolCalls,
      this.tools,
      approvals,
      clientToolResults,
    )

    if (
      executionResult.needsApproval.length > 0 ||
      executionResult.needsClientExecution.length > 0
    ) {
      for (const chunk of this.emitApprovalRequests(
        executionResult.needsApproval,
        finishEvent,
      )) {
        yield chunk
      }

      for (const chunk of this.emitClientToolInputs(
        executionResult.needsClientExecution,
        finishEvent,
      )) {
        yield chunk
      }

      this.shouldEmitStreamEnd = false
      return 'wait'
    }

    const toolResultChunks = this.emitToolResults(
      executionResult.results,
      finishEvent,
    )

    for (const chunk of toolResultChunks) {
      yield chunk
    }

    return 'continue'
  }

  private async *processToolCalls(): AsyncGenerator<StreamChunk, void, void> {
    if (!this.shouldExecuteToolPhase()) {
      this.setToolPhase('stop')
      return
    }

    const toolCalls = this.toolCallManager.getToolCalls()
    const finishEvent = this.finishedEvent

    if (!finishEvent || toolCalls.length === 0) {
      this.setToolPhase('stop')
      return
    }

    this.addAssistantToolCallMessage(toolCalls)

    const { approvals, clientToolResults } = this.collectClientState()

    const executionResult = await executeToolCalls(
      toolCalls,
      this.tools,
      approvals,
      clientToolResults,
    )

    if (
      executionResult.needsApproval.length > 0 ||
      executionResult.needsClientExecution.length > 0
    ) {
      for (const chunk of this.emitApprovalRequests(
        executionResult.needsApproval,
        finishEvent,
      )) {
        yield chunk
      }

      for (const chunk of this.emitClientToolInputs(
        executionResult.needsClientExecution,
        finishEvent,
      )) {
        yield chunk
      }

      this.setToolPhase('wait')
      return
    }

    const toolResultChunks = this.emitToolResults(
      executionResult.results,
      finishEvent,
    )

    for (const chunk of toolResultChunks) {
      yield chunk
    }

    this.toolCallManager.clear()

    this.setToolPhase('continue')
  }

  private shouldExecuteToolPhase(): boolean {
    return (
      this.finishedEvent?.finishReason === 'tool_calls' &&
      this.tools.length > 0 &&
      this.toolCallManager.hasToolCalls()
    )
  }

  private addAssistantToolCallMessage(toolCalls: Array<ToolCall>): void {
    const messageId = this.currentMessageId ?? this.createId('msg')
    this.messages = [
      ...this.messages,
      {
        role: 'assistant',
        content: this.accumulatedContent || null,
        toolCalls,
      },
    ]

    aiEventClient.emit('text:message:created', {
      ...this.buildEventContext(),
      messageId,
      role: 'assistant',
      content: this.accumulatedContent || '',
      toolCalls,
      timestamp: Date.now(),
    })
  }

  /**
   * Extract client state (approvals and client tool results) from original messages.
   * Called in the constructor BEFORE converting to ModelMessage format,
   * because the parts array (which contains approval state) is lost during conversion.
   */
  private extractClientStateFromOriginalMessages(
    originalMessages: Array<any>,
  ): {
    approvals: Map<string, boolean>
    clientToolResults: Map<string, any>
  } {
    const approvals = new Map<string, boolean>()
    const clientToolResults = new Map<string, any>()

    for (const message of originalMessages) {
      if (message.role === 'assistant' && message.parts) {
        for (const part of message.parts) {
          if (part.type === 'tool-call') {
            if (part.output !== undefined && !part.approval) {
              clientToolResults.set(part.id, part.output)
            }
            if (
              part.approval?.id &&
              part.approval?.approved !== undefined &&
              part.state === 'approval-responded'
            ) {
              approvals.set(part.approval.id, part.approval.approved)
            }
          }
        }
      }
    }

    return { approvals, clientToolResults }
  }

  private collectClientState(): {
    approvals: Map<string, boolean>
    clientToolResults: Map<string, any>
  } {
    const approvals = new Map(this.initialApprovals)
    const clientToolResults = new Map(this.initialClientToolResults)

    for (const message of this.messages) {
      if (message.role === 'tool' && message.toolCallId) {
        let output: unknown
        try {
          output = JSON.parse(message.content as string)
        } catch {
          output = message.content
        }
        // Skip pendingExecution markers
        if (
          output &&
          typeof output === 'object' &&
          (output as any).pendingExecution === true
        ) {
          continue
        }
        clientToolResults.set(message.toolCallId, output)
      }
    }

    return { approvals, clientToolResults }
  }

  private emitApprovalRequests(
    approvals: Array<ApprovalRequest>,
    finishEvent: RunFinishedEvent,
  ): Array<StreamChunk> {
    const chunks: Array<StreamChunk> = []

    for (const approval of approvals) {
      aiEventClient.emit('tools:approval:requested', {
        ...this.buildEventContext(),
        messageId: this.currentMessageId || undefined,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        input: approval.input,
        approvalId: approval.approvalId,
        timestamp: Date.now(),
      })

      // Emit a CUSTOM event for approval requests
      chunks.push({
        type: 'CUSTOM',
        timestamp: Date.now(),
        model: finishEvent.model,
        name: 'approval-requested',
        data: {
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          input: approval.input,
          approval: {
            id: approval.approvalId,
            needsApproval: true,
          },
        },
      })
    }

    return chunks
  }

  private emitClientToolInputs(
    clientRequests: Array<ClientToolRequest>,
    finishEvent: RunFinishedEvent,
  ): Array<StreamChunk> {
    const chunks: Array<StreamChunk> = []

    for (const clientTool of clientRequests) {
      aiEventClient.emit('tools:input:available', {
        ...this.buildEventContext(),
        messageId: this.currentMessageId || undefined,
        toolCallId: clientTool.toolCallId,
        toolName: clientTool.toolName,
        input: clientTool.input,
        timestamp: Date.now(),
      })

      // Emit a CUSTOM event for client tool inputs
      chunks.push({
        type: 'CUSTOM',
        timestamp: Date.now(),
        model: finishEvent.model,
        name: 'tool-input-available',
        data: {
          toolCallId: clientTool.toolCallId,
          toolName: clientTool.toolName,
          input: clientTool.input,
        },
      })
    }

    return chunks
  }

  private emitToolResults(
    results: Array<ToolResult>,
    finishEvent: RunFinishedEvent,
  ): Array<StreamChunk> {
    const chunks: Array<StreamChunk> = []

    for (const result of results) {
      aiEventClient.emit('tools:call:completed', {
        ...this.buildEventContext(),
        messageId: this.currentMessageId || undefined,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: result.result,
        duration: result.duration ?? 0,
        timestamp: Date.now(),
      })

      const content = JSON.stringify(result.result)

      // Emit TOOL_CALL_END event
      chunks.push({
        type: 'TOOL_CALL_END',
        timestamp: Date.now(),
        model: finishEvent.model,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: content,
      })

      this.messages = [
        ...this.messages,
        {
          role: 'tool',
          content,
          toolCallId: result.toolCallId,
        },
      ]

      aiEventClient.emit('text:message:created', {
        ...this.buildEventContext(),
        messageId: this.createId('msg'),
        role: 'tool',
        content,
        timestamp: Date.now(),
      })
    }

    return chunks
  }

  private getPendingToolCallsFromMessages(): Array<ToolCall> {
    const completedToolIds = new Set<string>()

    for (const message of this.messages) {
      if (message.role === 'tool' && message.toolCallId) {
        let hasPendingExecution = false
        if (typeof message.content === 'string') {
          try {
            const parsed = JSON.parse(message.content)
            if (parsed.pendingExecution === true) {
              hasPendingExecution = true
            }
          } catch {
            // Not JSON, treat as regular tool result
          }
        }

        if (!hasPendingExecution) {
          completedToolIds.add(message.toolCallId)
        }
      }
    }

    const pending: Array<ToolCall> = []

    for (const message of this.messages) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          if (!completedToolIds.has(toolCall.id)) {
            pending.push(toolCall)
          }
        }
      }
    }

    return pending
  }

  private createSyntheticFinishedEvent(): RunFinishedEvent {
    return {
      type: 'RUN_FINISHED',
      runId: this.createId('pending'),
      model: this.adapterModel,
      timestamp: Date.now(),
      finishReason: 'tool_calls',
    }
  }

  private shouldContinue(): boolean {
    if (this.cyclePhase === 'executeToolCalls') {
      return true
    }

    return (
      this.loopStrategy({
        iterationCount: this.iterationCount,
        messages: this.messages,
        finishReason: this.lastFinishReason,
      }) && this.toolPhase === 'continue'
    )
  }

  private isAborted(): boolean {
    return !!this.effectiveSignal?.aborted
  }

  private buildEventContext(): {
    requestId: string
    streamId: string
    provider: string
    model: string
    clientId?: string
    source?: 'client' | 'server'
    systemPrompts?: Array<string>
    toolNames?: Array<string>
    options?: Record<string, unknown>
    modelOptions?: Record<string, unknown>
    messageCount: number
    hasTools: boolean
    streaming: boolean
  } {
    const toolNames = this.tools.map((t) => t.name)
    return {
      requestId: this.requestId,
      streamId: this.streamId,
      provider: this.adapterProvider,
      model: this.adapterModel,
      clientId: this.options.conversationId,
      source: 'server',
      systemPrompts:
        this.systemPrompts.length > 0 ? this.systemPrompts : undefined,
      toolNames: toolNames.length > 0 ? toolNames : undefined,
      options: this.eventOptions,
      modelOptions: this.eventModelOptions,
      messageCount: this.initialMessageCount,
      hasTools: this.tools.length > 0,
      streaming: true,
    }
  }

  private getContentString(content: ModelMessage['content']): string {
    if (typeof content === 'string') return content
    const textContent =
      content
        ?.map((part) => (part.type === 'text' ? part.content : ''))
        .join('') || ''
    return textContent
  }

  private setToolPhase(phase: ToolPhaseResult): void {
    this.toolPhase = phase
    if (phase === 'wait') {
      this.shouldEmitStreamEnd = false
    }
  }

  private createId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }
}

// ===========================
// Direct Options Helpers
// ===========================

/**
 * Detect if the first argument is direct options (has adapter property)
 */
function isDirectOptions(
  arg: unknown,
): arg is AgentLoopDirectOptions<AnyTextAdapter, z.ZodType | undefined> {
  return typeof arg === 'object' && arg !== null && 'adapter' in arg
}

/**
 * Create a TextCreator function from direct options.
 * This wraps the text() function with the adapter and model-specific options,
 * using _skipEvents to prevent duplicate event emission.
 */
function createTextFnFromDirectOptions(
  options: AgentLoopDirectOptions<AnyTextAdapter, z.ZodType | undefined>,
): TextCreator {
  const { adapter, temperature, topP, maxTokens, metadata, modelOptions } =
    options

  return ((
    creatorOptions: TextCreatorOptions & { outputSchema?: z.ZodType },
  ) => {
    if (creatorOptions.outputSchema !== undefined) {
      // For structured output, call text() without _skipEvents since it's a final call
      return text({
        adapter,
        messages: creatorOptions.messages,
        tools: creatorOptions.tools as Array<Tool>,
        systemPrompts: creatorOptions.systemPrompts,
        abortController: creatorOptions.abortController,
        temperature,
        topP,
        maxTokens,
        metadata,
        modelOptions,
        outputSchema: creatorOptions.outputSchema,
      })
    }

    return text({
      adapter,
      messages: creatorOptions.messages,
      tools: creatorOptions.tools as Array<Tool>,
      systemPrompts: creatorOptions.systemPrompts,
      abortController: creatorOptions.abortController,
      temperature,
      topP,
      maxTokens,
      metadata,
      modelOptions,
      _skipEvents: true,
    })
  }) as TextCreator
}

/**
 * Extract loop-specific options from direct options.
 */
function extractLoopOptions(
  options: AgentLoopDirectOptions<AnyTextAdapter, z.ZodType | undefined>,
): AgentLoopBaseOptions & { outputSchema?: z.ZodType } {
  return {
    messages: options.messages as Array<ModelMessage>,
    systemPrompts: options.systemPrompts,
    tools: options.tools,
    abortController: options.abortController,
    agentLoopStrategy: options.agentLoopStrategy,
    conversationId: options.conversationId,
    outputSchema: options.outputSchema,
  }
}

// ===========================
// Public API
// ===========================

/**
 * Agent loop - orchestrates agentic text generation with automatic tool execution.
 *
 * Takes a text creator function and loop options, then handles the agentic loop:
 * - Calls the text function to get model responses
 * - Automatically executes tool calls
 * - Continues looping until the strategy says stop
 *
 * The return type depends on whether `outputSchema` is provided:
 * - Without outputSchema: Returns `AsyncIterable<StreamChunk>`
 * - With outputSchema: Returns `Promise<z.infer<TSchema>>`
 *
 * @param options - Direct options with adapter, messages, tools, etc. (preferred)
 * @param textFn - Alternative: A function that creates a text stream (legacy API)
 *
 * @example Streaming mode (recommended)
 * ```ts
 * import { experimental_agentLoop as agentLoop } from '@tanstack/ai'
 * import { openaiText } from '@tanstack/ai-openai'
 *
 * for await (const chunk of agentLoop({
 *   adapter: openaiText('gpt-4o'),
 *   messages: [{ role: 'user', content: 'What is the weather?' }],
 *   tools: [weatherTool],
 * })) {
 *   if (chunk.type === 'content') {
 *     process.stdout.write(chunk.delta)
 *   }
 * }
 * ```
 *
 * @example Structured output mode
 * ```ts
 * const result = await agentLoop({
 *   adapter: openaiText('gpt-4o'),
 *   messages: [{ role: 'user', content: 'Research and summarize' }],
 *   tools: [searchTool],
 *   outputSchema: z.object({ summary: z.string() }),
 * })
 * // result is { summary: string }
 * ```
 *
 * @example Collect text with streamToText helper
 * ```ts
 * const result = await streamToText(agentLoop({
 *   adapter: openaiText('gpt-4o'),
 *   messages: [{ role: 'user', content: 'Research this topic' }],
 *   tools: [searchTool],
 * }))
 * ```
 *
 * @example With model options (temperature, etc.)
 * ```ts
 * for await (const chunk of agentLoop({
 *   adapter: openaiText('gpt-4o'),
 *   messages: [{ role: 'user', content: 'Be creative' }],
 *   tools: [searchTool],
 *   temperature: 0.9,
 *   maxTokens: 2000,
 * })) {
 *   // ...
 * }
 * ```
 *
 * @example Legacy textFn API (still supported)
 * ```ts
 * const textFn = (opts) => chat({ adapter: openaiText('gpt-4o'), ...opts })
 *
 * for await (const chunk of agentLoop(textFn, {
 *   messages: [{ role: 'user', content: 'What is the weather?' }],
 *   tools: [weatherTool]
 * })) {
 *   // ...
 * }
 * ```
 */
// Direct options overloads (adapter-based API)
export function agentLoop<
  TAdapter extends AnyTextAdapter,
  TSchema extends z.ZodType,
>(
  options: AgentLoopDirectStructuredOptions<TAdapter, TSchema>,
): Promise<z.infer<TSchema>>
export function agentLoop<TAdapter extends AnyTextAdapter>(
  options: AgentLoopDirectStreamOptions<TAdapter>,
): AsyncIterable<StreamChunk>
// TextFn overloads (callback-based API)
export function agentLoop<TSchema extends z.ZodType>(
  textFn: TextCreator,
  options: AgentLoopStructuredOptions<TSchema>,
): Promise<z.infer<TSchema>>
export function agentLoop(
  textFn: TextCreator,
  options: AgentLoopStreamOptions,
): AsyncIterable<StreamChunk>
export function agentLoop<TSchema extends z.ZodType | undefined = undefined>(
  textFn: TextCreator,
  options: AgentLoopOptions<TSchema>,
): TSchema extends z.ZodType
  ? Promise<z.infer<TSchema>>
  : AsyncIterable<StreamChunk>
// Implementation
export function agentLoop<
  TAdapter extends AnyTextAdapter,
  TSchema extends z.ZodType | undefined = undefined,
>(
  textFnOrOptions: TextCreator | AgentLoopDirectOptions<TAdapter, TSchema>,
  maybeOptions?: AgentLoopOptions<TSchema>,
): Promise<z.infer<TSchema>> | AsyncIterable<StreamChunk> {
  // Detect which API is being used
  if (isDirectOptions(textFnOrOptions)) {
    // New direct options API
    const directOptions = textFnOrOptions
    const textFn = createTextFnFromDirectOptions(directOptions)
    const loopOptions = extractLoopOptions(directOptions)

    if (directOptions.outputSchema !== undefined) {
      return runStructuredAgentLoop(
        textFn,
        loopOptions as AgentLoopStructuredOptions<z.ZodType>,
        directOptions.adapter,
      ) as Promise<z.infer<TSchema>>
    }

    const engine = new AgentLoopEngine({
      textFn,
      options: loopOptions,
      adapter: directOptions.adapter,
    })
    return engine.run()
  }

  // Existing textFn API
  const textFn = textFnOrOptions as TextCreator
  const options = maybeOptions!

  // Check if structured output is requested
  if ('outputSchema' in options && options.outputSchema !== undefined) {
    return runStructuredAgentLoop(textFn, options) as Promise<z.infer<TSchema>>
  }

  // Otherwise return streaming
  const engine = new AgentLoopEngine({ textFn, options })
  return engine.run()
}

/**
 * Run the agent loop and return structured output.
 */
async function runStructuredAgentLoop<TSchema extends z.ZodType>(
  textFn: TextCreator,
  options: AgentLoopStructuredOptions<TSchema>,
  adapter?: AnyTextAdapter,
): Promise<z.infer<TSchema>> {
  const { outputSchema, ...loopOptions } = options

  const engine = new AgentLoopEngine({ textFn, options: loopOptions, adapter })

  // Consume the stream to run the agentic loop
  for await (const _chunk of engine.run()) {
    // Just consume the stream to execute the agentic loop
  }

  // Get the final messages
  const finalMessages = engine.getMessages()

  // Call textFn with outputSchema to get structured output
  const result = await textFn({
    messages: finalMessages,
    systemPrompts: options.systemPrompts,
    abortController: options.abortController,
    outputSchema,
  })

  return result as z.infer<TSchema>
}

// Re-export types
export type { AgentLoopStrategy } from '../types'
