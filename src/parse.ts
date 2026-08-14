/**
 * Wire adapters: turn one request/response pair into a `Step`.
 *
 * Every function here is total. A frame it does not recognise, a field that
 * moved, a stream that got cut — all degrade to "what could be read" rather
 * than throwing, because this code runs inside a proxy that must not fail a
 * user's request over a parsing detail.
 *
 * @module
 */

import type { Step, ToolCall, Usage, Wire } from './types.js'

/** Estimate tokens the way the industry's rough heuristic does. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Size a JSON value by its serialized form, which is what the wire carries. */
export function jsonTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  try { return estimateTokens(JSON.stringify(value) ?? '') } catch { return 0 }
}

/**
 * Split an SSE body into its decoded `data:` payloads.
 *
 * Non-JSON payloads (`[DONE]`, keep-alives, comments) are dropped rather than
 * reported — they carry no accounting.
 * @param body - the raw response text.
 * @returns every payload that parsed as a JSON object.
 */
export function sseEvents(body: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed === 'object' && parsed !== null) out.push(parsed as Record<string, unknown>)
    } catch {
      // A partial final frame is normal when a stream is cut.
    }
  }
  return out
}

/** Read a nested number, tolerating absence at any level. */
function num(source: unknown, ...path: string[]): number {
  let cursor: unknown = source
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return 0
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0
}

/** Read a nested string, tolerating absence at any level. */
function str(source: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = source
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

/** Sum usage across the frames that report it, last value winning per field. */
function foldUsage(events: readonly Record<string, unknown>[], wire: Wire): Usage | undefined {
  let seen = false
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const event of events) {
    // Anthropic reports initial usage on message_start and output on message_delta.
    const anthropic = (event['message'] as Record<string, unknown> | undefined)?.['usage'] ?? event['usage']
    const openai = (event['response'] as Record<string, unknown> | undefined)?.['usage'] ?? event['usage']
    const source = wire === 'anthropic-messages' ? anthropic : openai
    if (source === undefined || typeof source !== 'object') continue
    seen = true
    if (wire === 'anthropic-messages') {
      usage.input = num(source, 'input_tokens') || usage.input
      usage.output = num(source, 'output_tokens') || usage.output
      usage.cacheRead = num(source, 'cache_read_input_tokens') || usage.cacheRead
      usage.cacheWrite = num(source, 'cache_creation_input_tokens') || usage.cacheWrite
    } else {
      usage.input = num(source, 'input_tokens') || usage.input
      usage.output = num(source, 'output_tokens') || usage.output
      usage.cacheRead = num(source, 'input_tokens_details', 'cached_tokens') || usage.cacheRead
    }
  }
  return seen ? usage : undefined
}

/** Collect tool invocations announced in the stream. */
function foldCalls(events: readonly Record<string, unknown>[], wire: Wire): ToolCall[] {
  const calls: ToolCall[] = []
  for (const event of events) {
    if (wire === 'anthropic-messages') {
      const block = event['content_block'] as Record<string, unknown> | undefined
      if (block?.['type'] === 'tool_use') {
        calls.push({ name: str(block, 'name') ?? 'unknown', argBytes: jsonTokens(block['input']) })
      }
    } else {
      // Responses announces a function call as an added output item.
      const item = event['item'] as Record<string, unknown> | undefined
      const type = str(item ?? {}, 'type')
      if (type === 'function_call' || type === 'custom_tool_call') {
        calls.push({
          name: str(item ?? {}, 'name') ?? 'unknown',
          argBytes: estimateTokens(str(item ?? {}, 'arguments') ?? ''),
        })
      }
    }
  }
  return calls
}

/** Price the static payload an Anthropic Messages request carried. */
function anthropicStatic(request: Record<string, unknown>): { prompt: number; tools: number; tools_n: number; history: number } {
  const system = request['system']
  const prompt = Array.isArray(system)
    ? system.reduce((sum: number, block: unknown) => sum + estimateTokens(str(block, 'text') ?? ''), 0)
    : estimateTokens(typeof system === 'string' ? system : '')
  const tools = Array.isArray(request['tools']) ? request['tools'] : []
  const messages = Array.isArray(request['messages']) ? request['messages'] : []
  return { prompt, tools: jsonTokens(tools), tools_n: tools.length, history: messages.length }
}

/** Price the static payload an OpenAI Responses request carried. */
function openaiStatic(request: Record<string, unknown>): { prompt: number; tools: number; tools_n: number; history: number } {
  const instructions = estimateTokens(typeof request['instructions'] === 'string' ? request['instructions'] : '')
  const input = Array.isArray(request['input']) ? request['input'] : []
  // A leading developer message is per-request scaffolding, not conversation:
  // it is reissued every turn, so it belongs with the static payload.
  const lead = input[0] as Record<string, unknown> | undefined
  const developer = str(lead ?? {}, 'role') === 'developer' ? jsonTokens(lead) : 0
  const tools = Array.isArray(request['tools']) ? request['tools'] : []
  return {
    prompt: instructions + developer,
    tools: jsonTokens(tools),
    tools_n: tools.length,
    history: Math.max(0, input.length - (developer > 0 ? 1 : 0)),
  }
}

/**
 * Build a step from one exchange.
 *
 * @param input - what the proxy observed.
 * @returns a step; fields that could not be read are simply absent.
 */
export function parseStep(input: {
  wire: Wire
  requestBody: unknown
  startedAt: number
  firstByteAt?: number
  endedAt: number
  responseText: string
  status: number
  index: number
}): Step {
  const request = (typeof input.requestBody === 'object' && input.requestBody !== null
    ? input.requestBody
    : {}) as Record<string, unknown>
  const isAnthropic = input.wire === 'anthropic-messages'
  const stat = isAnthropic ? anthropicStatic(request) : openaiStatic(request)
  const events = sseEvents(input.responseText)

  const step: Step = {
    index: input.index,
    startedAt: input.startedAt,
    durationMs: input.endedAt - input.startedAt,
    model: str(request, 'model') ?? 'unknown',
    wire: input.wire,
    staticTokens: { prompt: stat.prompt, tools: stat.tools },
    toolCount: stat.tools_n,
    historyLength: stat.history,
    calls: foldCalls(events, input.wire),
  }
  if (input.firstByteAt !== undefined) step.ttftMs = input.firstByteAt - input.startedAt
  const usage = foldUsage(events, input.wire)
  if (usage !== undefined) step.usage = usage
  if (input.status >= 400) step.error = `HTTP ${String(input.status)}`
  return step
}

/** Identify the agent from the headers it sends, falling back to unknown. */
export function agentFromUserAgent(userAgent: string | undefined): 'claude-code' | 'codex' | 'dsh' | 'unknown' {
  if (userAgent === undefined) return 'unknown'
  const ua = userAgent.toLowerCase()
  if (ua.includes('claude-cli') || ua.includes('claude-code')) return 'claude-code'
  if (ua.includes('codex')) return 'codex'
  if (ua.includes('dsh') || ua.includes('deepseek-harness')) return 'dsh'
  return 'unknown'
}
