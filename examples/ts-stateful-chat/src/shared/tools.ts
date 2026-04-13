import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

/**
 * Simulated execute_typescript tool.
 * - clientInput: hides the raw code from the client, shows only description
 * - clientOutput: hides internal result data, shows only success/timing
 */
export const executeTypescriptTool = toolDefinition({
  name: 'execute_typescript',
  description:
    'Execute TypeScript code in a sandbox. Use this to perform calculations, data transformations, or any computation.',
  inputSchema: z.object({
    typescriptCode: z.string().describe('The TypeScript code to execute'),
    description: z.string().describe('A brief description of what the code does'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.unknown(),
    logs: z.array(z.string()),
    executionTimeMs: z.number(),
  }),
  clientInput: (args) => ({
    description: args.description,
  }),
  clientOutput: (result) => ({
    success: result.success,
    executionTimeMs: result.executionTimeMs,
  }),
})

export const executeTypescript = executeTypescriptTool.server(async (args) => {
  // Simulate code execution
  const start = Date.now()
  let result: unknown
  const logs: string[] = []

  try {
    // Simple simulation -- in a real app this would run in a sandbox
    logs.push(`Executing: ${args.description}`)
    result = { computed: true, description: args.description }
    logs.push('Execution complete')
  } catch (err: any) {
    return {
      success: false,
      result: null,
      logs: [err.message],
      executionTimeMs: Date.now() - start,
    }
  }

  return {
    success: true,
    result,
    logs,
    executionTimeMs: Date.now() - start,
  }
})

/**
 * Lookup a user by ID.
 * - clientOutput strips PII (email, SSN, internal score)
 * - clientInput is not set, so the input passes through unchanged
 */
export const lookupUserTool = toolDefinition({
  name: 'lookup_user',
  description: 'Look up a user by their ID. Returns user profile information.',
  inputSchema: z.object({
    userId: z.string().describe('The user ID to look up'),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    ssn: z.string(),
    internalScore: z.number(),
  }),
  clientOutput: (result) => ({
    id: result.id,
    name: result.name,
  }),
})

export const lookupUser = lookupUserTool.server(async ({ userId }) => {
  // Simulated user database
  const users: Record<string, any> = {
    '123': {
      id: '123',
      name: 'Alice Johnson',
      email: 'alice@internal.corp',
      ssn: '123-45-6789',
      internalScore: 87,
    },
    '456': {
      id: '456',
      name: 'Bob Smith',
      email: 'bob@internal.corp',
      ssn: '987-65-4321',
      internalScore: 92,
    },
  }

  const user = users[userId]
  if (!user) {
    return {
      id: userId,
      name: 'Unknown User',
      email: 'unknown',
      ssn: 'N/A',
      internalScore: 0,
    }
  }
  return user
})

/**
 * Get current weather for a location.
 * No client filtering -- all data is safe for the client.
 */
export const getWeatherTool = toolDefinition({
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  inputSchema: z.object({
    location: z.string().describe('City name or coordinates'),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    condition: z.string(),
    humidity: z.number(),
  }),
})

export const getWeather = getWeatherTool.server(async ({ location }) => {
  // Simulated weather data
  return {
    temperature: 72 + Math.floor(Math.random() * 20 - 10),
    condition: ['sunny', 'cloudy', 'rainy', 'partly cloudy'][
      Math.floor(Math.random() * 4)
    ],
    humidity: 40 + Math.floor(Math.random() * 40),
  }
})

/** All server tools for use in the chat endpoint */
export const chatTools = [
  executeTypescriptTool,
  lookupUserTool,
  getWeatherTool,
] as const

/** All server tools for use in the chat endpoint */
export const serverTools = [executeTypescript, lookupUser, getWeather]
