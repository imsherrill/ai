import type {
  MessagePart,
  ModelMessage,
  StreamChunk,
  Tool,
  UIMessage,
} from '../../types'

function tryParseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    return { ok: false }
  }
}

export function buildToolLookup(tools: Array<Tool>): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

export function projectToolArguments(
  tool: Tool | undefined,
  rawArguments: string,
): {
  arguments: string
  input?: unknown
  projected: boolean
} {
  if (!tool?.clientInput) {
    return { arguments: rawArguments, projected: false }
  }

  const parsed = tryParseJson(rawArguments)
  if (!parsed.ok) {
    return { arguments: rawArguments, projected: false }
  }

  const filtered = tool.clientInput(parsed.value)
  return {
    arguments: JSON.stringify(filtered),
    input: filtered,
    projected: true,
  }
}

export function projectToolInputValue(
  tool: Tool | undefined,
  rawInput: unknown,
): { input: unknown; projected: boolean } {
  if (!tool?.clientInput) {
    return { input: rawInput, projected: false }
  }

  return {
    input: tool.clientInput(rawInput),
    projected: true,
  }
}

export function projectToolResult(
  tool: Tool | undefined,
  rawResult: string,
): {
  result: string
  output?: unknown
  projected: boolean
} {
  if (!tool?.clientOutput) {
    return { result: rawResult, projected: false }
  }

  const parsed = tryParseJson(rawResult)
  if (!parsed.ok) {
    return { result: rawResult, projected: false }
  }

  const filtered = tool.clientOutput(parsed.value)
  return {
    result: JSON.stringify(filtered),
    output: filtered,
    projected: true,
  }
}

export function projectToClientMessages(
  messages: Array<ModelMessage>,
  toolMap: Map<string, Tool>,
): Array<ModelMessage> {
  const callIdToToolName = new Map<string, string>()

  return messages.map((message) => {
    if (
      message.role === 'assistant' &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      let changed = false
      const toolCalls = message.toolCalls.map((toolCall) => {
        const toolName = toolCall.function.name
        callIdToToolName.set(toolCall.id, toolName)
        const projected = projectToolArguments(
          toolMap.get(toolName),
          toolCall.function.arguments,
        )

        if (!projected.projected) {
          return toolCall
        }

        changed = true
        return {
          ...toolCall,
          function: {
            ...toolCall.function,
            arguments: projected.arguments,
          },
        }
      })

      return changed ? { ...message, toolCalls } : message
    }

    if (message.role === 'tool' && message.toolCallId) {
      const toolName = callIdToToolName.get(message.toolCallId)
      const projected = projectToolResult(
        toolName ? toolMap.get(toolName) : undefined,
        typeof message.content === 'string' ? message.content : '',
      )

      if (!projected.projected || typeof message.content !== 'string') {
        return message
      }

      return {
        ...message,
        content: projected.result,
      }
    }

    return message
  })
}

export function projectToClientUIMessages(
  messages: Array<UIMessage>,
  toolMap: Map<string, Tool>,
): Array<UIMessage> {
  const callIdToToolName = new Map<string, string>()

  return messages.map((message) => {
    let changed = false
    const parts = message.parts.map((part) => {
      if (part.type === 'tool-call') {
        callIdToToolName.set(part.id, part.name)

        const projectedArgs = projectToolArguments(
          toolMap.get(part.name),
          part.arguments,
        )
        const projectedOutput =
          part.output !== undefined
            ? projectToolResult(
                toolMap.get(part.name),
                JSON.stringify(part.output),
              )
            : null

        if (!projectedArgs.projected && !projectedOutput?.projected) {
          return part
        }

        changed = true
        return {
          ...part,
          arguments: projectedArgs.arguments,
          ...(projectedOutput?.projected
            ? { output: projectedOutput.output }
            : {}),
        }
      }

      if (part.type === 'tool-result') {
        const toolName = callIdToToolName.get(part.toolCallId)
        const projected = projectToolResult(
          toolName ? toolMap.get(toolName) : undefined,
          part.content,
        )

        if (!projected.projected) {
          return part
        }

        changed = true
        return {
          ...part,
          content: projected.result,
        }
      }

      return part
    }) as Array<MessagePart>

    return changed ? { ...message, parts } : message
  })
}

export function projectOutboundChunk(
  chunk: StreamChunk,
  toolMap: Map<string, Tool>,
  callIdToToolName: Map<string, string>,
  rawArgsForCall?: string,
): Array<StreamChunk> {
  if (chunk.type === 'TOOL_CALL_START') {
    callIdToToolName.set(chunk.toolCallId, chunk.toolName)
    return [chunk]
  }

  if (chunk.type === 'TOOL_CALL_ARGS') {
    const toolName = callIdToToolName.get(chunk.toolCallId)
    const tool = toolName ? toolMap.get(toolName) : undefined
    return tool?.clientInput ? [] : [chunk]
  }

  if (chunk.type === 'TOOL_CALL_END') {
    const toolName = chunk.toolName || callIdToToolName.get(chunk.toolCallId)
    const tool = toolName ? toolMap.get(toolName) : undefined

    let nextChunk: StreamChunk = chunk

    if (tool?.clientInput) {
      const parsedArgs = rawArgsForCall ? tryParseJson(rawArgsForCall) : undefined
      const rawInput =
        chunk.input ??
        (parsedArgs && parsedArgs.ok ? parsedArgs.value : undefined)

      if (rawInput !== undefined) {
        const projected = projectToolInputValue(tool, rawInput)
        nextChunk = {
          ...nextChunk,
          input: projected.input,
        }
      }
    }

    if (tool?.clientOutput && chunk.result) {
      const projected = projectToolResult(tool, chunk.result)
      if (projected.projected) {
        nextChunk = {
          ...nextChunk,
          result: projected.result,
        }
      }
    }

    return [nextChunk]
  }

  return [chunk]
}
