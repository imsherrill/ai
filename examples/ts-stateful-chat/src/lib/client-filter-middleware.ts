import type { ChatMiddleware, Tool } from '@tanstack/ai'

/**
 * Creates a middleware that filters tool data before it streams to the client.
 *
 * For tools with `clientInput`: suppresses TOOL_CALL_ARGS streaming and sends
 * filtered input only on TOOL_CALL_END (can't reliably filter partial JSON).
 *
 * For tools with `clientOutput`: filters the result on TOOL_CALL_END.
 */
export function createClientFilterMiddleware(
  tools: Array<Tool>,
): ChatMiddleware {
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  // Track toolCallId -> toolName since TOOL_CALL_ARGS doesn't carry toolName
  const callIdToName = new Map<string, string>()

  return {
    name: 'client-filter',
    onChunk(_ctx, chunk) {

      if (chunk.type === 'TOOL_CALL_START') {
        callIdToName.set(chunk.toolCallId, chunk.toolName)
      }

      if (chunk.type === 'TOOL_CALL_ARGS') {
        const toolName = callIdToName.get(chunk.toolCallId)
        const tool = toolName ? toolMap.get(toolName) : undefined
        if (tool?.clientInput) {
          // Suppress streaming args -- filtered input sent on TOOL_CALL_END
          return null
        }
      }

      if (chunk.type === 'TOOL_CALL_END') {
        const tool = toolMap.get(chunk.toolName)
        const hasInputFilter = tool?.clientInput && chunk.input
        const hasOutputFilter = tool?.clientOutput && chunk.result

        if (hasInputFilter || hasOutputFilter) {
          return {
            ...chunk,
            input: hasInputFilter
              ? tool!.clientInput!(chunk.input)
              : chunk.input,
            result: hasOutputFilter
              ? JSON.stringify(tool!.clientOutput!(JSON.parse(chunk.result!)))
              : chunk.result,
          }
        }
      }

      return // pass through everything else
    },
  }
}
