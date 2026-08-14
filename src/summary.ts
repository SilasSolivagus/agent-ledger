/**
 * Roll-ups over recorded sessions.
 *
 * Pure functions over the neutral model, so the dashboard means the same thing
 * whichever agent produced the data.
 *
 * @module
 */

import type { Session, Step, Totals } from './types.js'

/** Median of a numeric sample; zero for an empty one. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
    : (sorted[mid] as number)
}

/** Every step across the given sessions, in order. */
function allSteps(sessions: readonly Session[]): Step[] {
  return sessions.flatMap(s => s.steps)
}

/**
 * Summarise sessions into the figures a dashboard shows.
 * @param sessions - recorded sessions.
 * @returns totals; all zeroes for an empty input rather than NaN.
 */
export function summarise(sessions: readonly Session[]): Totals {
  const steps = allSteps(sessions)
  const usage = steps.map(s => s.usage).filter((u): u is NonNullable<typeof u> => u !== undefined)

  const input = usage.reduce((t, u) => t + u.input, 0)
  const cacheRead = usage.reduce((t, u) => t + u.cacheRead, 0)
  const counts = new Map<string, number>()
  for (const step of steps) {
    for (const call of step.calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  }

  return {
    sessions: sessions.length,
    steps: steps.length,
    toolCalls: steps.reduce((t, s) => t + s.calls.length, 0),
    input,
    output: usage.reduce((t, u) => t + u.output, 0),
    cacheRead,
    cacheWrite: usage.reduce((t, u) => t + u.cacheWrite, 0),
    // Cache reads are billed apart from fresh input, so the hit rate is over
    // their sum — not over `input` alone, which excludes them.
    cacheHitRate: input + cacheRead === 0 ? 0 : cacheRead / (input + cacheRead),
    medianTtftMs: median(steps.map(s => s.ttftMs).filter((v): v is number => v !== undefined)),
    spanMs: steps.reduce((t, s) => t + (s.durationMs ?? 0), 0),
    topTools: [...counts.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1)),
  }
}

/**
 * The static payload carried on every step, averaged.
 *
 * This is the number the whole exercise started from: what an agent brings to
 * the table before the conversation is counted.
 * @param sessions - recorded sessions.
 * @returns average prompt and tool tokens per request, and the tool count.
 */
export function averageStatic(sessions: readonly Session[]): {
  prompt: number; tools: number; total: number; toolCount: number; measuredSteps: number
} {
  // Transcripts do not record the request envelope, so most steps have no
  // static figure at all. Averaging zeroes in would report "4 tokens per
  // request" for a fleet that actually carries tens of thousands — a number
  // worse than none. Only steps that were actually measured count.
  const steps = allSteps(sessions).filter(s => s.staticTokens.prompt + s.staticTokens.tools > 0)
  if (steps.length === 0) return { prompt: 0, tools: 0, total: 0, toolCount: 0, measuredSteps: 0 }
  const prompt = Math.round(steps.reduce((t, s) => t + s.staticTokens.prompt, 0) / steps.length)
  const tools = Math.round(steps.reduce((t, s) => t + s.staticTokens.tools, 0) / steps.length)
  return {
    prompt, tools, total: prompt + tools,
    toolCount: Math.round(steps.reduce((t, s) => t + s.toolCount, 0) / steps.length),
    measuredSteps: steps.length,
  }
}

/** Group sessions by the agent that produced them. */
export function byAgent(sessions: readonly Session[]): Map<string, Session[]> {
  const out = new Map<string, Session[]>()
  for (const session of sessions) {
    const list = out.get(session.agent) ?? []
    list.push(session)
    out.set(session.agent, list)
  }
  return out
}
