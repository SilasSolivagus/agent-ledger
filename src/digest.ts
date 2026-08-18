/**
 * What a stretch of work added up to.
 *
 * Every figure here is either measured or explicitly not. The two traps this
 * module exists to avoid:
 *
 * **Summing concurrent time.** Four sessions running at once produce four
 * sets of tool durations, and adding them gives a number larger than the wall
 * clock it happened in. Tool time is therefore the union of the intervals,
 * not their sum, and the sum is reported beside it as "occupancy" so the
 * difference is visible rather than hidden.
 *
 * **Filling a gap with an inference.** The time that is not measured tool
 * time contains the model thinking, the harness working, and the person
 * reading — a transcript cannot separate them, so this module does not try.
 * It reports one bucket and names what is inside it.
 *
 * @module
 */

import type { LedgerEvent, Session } from './types.js'

/** One closed interval on the clock. */
interface Interval { start: number; end: number }

/**
 * Total length actually covered by a set of intervals.
 * @param spans - intervals, in any order.
 * @returns milliseconds covered at least once.
 */
export function unionMs(spans: readonly Interval[]): number {
  const sorted = [...spans].filter(s => s.end > s.start).sort((a, b) => a.start - b.start)
  let total = 0
  let open: Interval | undefined
  for (const span of sorted) {
    if (open === undefined) { open = { ...span }; continue }
    if (span.start > open.end) { total += open.end - open.start; open = { ...span }; continue }
    open.end = Math.max(open.end, span.end)
  }
  return total + (open === undefined ? 0 : open.end - open.start)
}

/** One row of a ranked breakdown. */
export interface Ranked {
  name: string
  calls: number
  totalMs: number
  medianMs: number
  /** Every measured duration in this row, for a per-record distribution. */
  durations: number[]
}

/** How many sessions were live at once, as the count changed. */
export interface Concurrency { at: number; live: number }

/** Everything one agent's live sessions add up to. */
export interface Digest {
  agent: string
  sessions: number
  turns: number
  steps: number
  calls: number
  errors: number

  /** Window the work happened in, first record to last. */
  spanMs: number
  /** Clock time during which some tool was running. Union, never a sum. */
  toolMs: number
  /** Sum of tool durations. Exceeds `toolMs` exactly when sessions overlapped. */
  toolOccupancyMs: number

  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheHitRate: number

  tools: Ranked[]
  models: Ranked[]
  skills: Ranked[]
  subagents: Ranked[]
  /** Whether this agent's transcripts carry skill attribution at all. */
  hasAttribution: boolean
  /** Every measured call duration, for the distribution. */
  durations: number[]
  concurrency: Concurrency[]
  /** Failed calls, newest first. */
  failures: { at: number; tool: string; text: string; result: string }[]
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : sorted[mid] ?? 0
}

/** Group measured events into a ranked table by whatever names them. */
function rank(events: readonly LedgerEvent[], name: (e: LedgerEvent) => string | undefined): Ranked[] {
  const buckets = new Map<string, number[]>()
  const counts = new Map<string, number>()
  for (const event of events) {
    const key = name(event)
    if (key === undefined || key === '') continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (event.timing === 'measured') {
      const list = buckets.get(key) ?? []
      list.push(event.durationMs ?? 0)
      buckets.set(key, list)
    }
  }
  return [...counts.entries()].map(([name2, calls]) => {
    const times = buckets.get(name2) ?? []
    return {
      name: name2,
      calls,
      totalMs: times.reduce((t, v) => t + v, 0),
      medianMs: median(times),
      durations: times,
    }
  }).sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls)
}

/** Rank by output tokens rather than time — for models and skills. */
function rankByOutput(events: readonly LedgerEvent[], name: (e: LedgerEvent) => string | undefined): Ranked[] {
  const out = new Map<string, { calls: number; tokens: number }>()
  for (const event of events) {
    const key = name(event)
    if (key === undefined || key === '') continue
    const seen = out.get(key) ?? { calls: 0, tokens: 0 }
    seen.calls += 1
    seen.tokens += event.usage?.output ?? 0
    out.set(key, seen)
  }
  return [...out.entries()]
    .map(([name2, v]) => ({ name: name2, calls: v.calls, totalMs: v.tokens, medianMs: 0, durations: [] }))
    .sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls)
}

/**
 * How many sessions were live at each moment something changed.
 *
 * A session counts as live from its first record to its last. This is what
 * makes the difference between tool occupancy and tool wall time legible —
 * without it, "tools ran for 40 minutes" inside a 15-minute window reads as
 * an error rather than as four sessions at once.
 */
function concurrency(sessions: readonly Session[]): Concurrency[] {
  const edges: { at: number; delta: number }[] = []
  for (const session of sessions) {
    const events = (session.events ?? []).filter(e => e.at > 0)
    if (events.length === 0) continue
    // A session is live until its last operation finishes, not until its last
    // record was written. A tool call's timestamp is when it was issued, so a
    // fast turn writes every record at the same instant and a start-to-last
    // -record span collapses to zero length.
    const ends = events.map(e => e.at + (e.timing === 'measured' ? e.durationMs ?? 0 : 0))
    edges.push({ at: Math.min(...events.map(e => e.at)), delta: 1 })
    edges.push({ at: Math.max(...ends), delta: -1 })
  }
  edges.sort((a, b) => a.at - b.at || b.delta - a.delta)
  const out: Concurrency[] = []
  let live = 0
  for (const edge of edges) {
    live += edge.delta
    const last = out.at(-1)
    if (last !== undefined && last.at === edge.at) last.live = live
    else out.push({ at: edge.at, live })
  }
  return out
}

/**
 * Add up one agent's live sessions.
 * @param agent - the agent these sessions came from.
 * @param sessions - that agent's sessions, already trimmed to the window.
 * @returns the digest; zeroes rather than NaN for anything unmeasured.
 */
export function digest(agent: string, sessions: readonly Session[]): Digest {
  const events = sessions.flatMap(s => s.events ?? [])
  const steps = sessions.flatMap(s => s.steps)
  const measured = events.filter(e => e.timing === 'measured' && (e.durationMs ?? 0) > 0)
  const times = events.map(e => e.at).filter(v => v > 0)

  const usage = steps.map(s => s.usage).filter((u): u is NonNullable<typeof u> => u !== undefined)
  const input = usage.reduce((t, u) => t + u.input, 0)
  const cacheRead = usage.reduce((t, u) => t + u.cacheRead, 0)

  const spans = measured.map(e => ({ start: e.at, end: e.at + (e.durationMs ?? 0) }))
  const failures = events
    .filter(e => e.isError === true)
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
    .map(e => ({ at: e.at, tool: e.tool ?? '', text: e.text, result: e.result ?? '' }))

  return {
    agent,
    sessions: sessions.length,
    turns: sessions.reduce((t, s) => t + Math.max(0, ...(s.events ?? []).map(e => e.turn), 0), 0),
    steps: steps.length,
    calls: events.filter(e => e.kind === 'tool').length,
    errors: events.filter(e => e.isError === true).length,

    spanMs: times.length === 0 ? 0 : Math.max(...times) - Math.min(...times),
    toolMs: unionMs(spans),
    toolOccupancyMs: measured.reduce((t, e) => t + (e.durationMs ?? 0), 0),

    input,
    output: usage.reduce((t, u) => t + u.output, 0),
    cacheRead,
    cacheWrite: usage.reduce((t, u) => t + u.cacheWrite, 0),
    cacheHitRate: input + cacheRead === 0 ? 0 : cacheRead / (input + cacheRead),

    tools: rank(events.filter(e => e.kind === 'tool'), e => e.tool),
    models: rankByOutput(events.filter(e => e.kind === 'assistant'), e => e.model),
    skills: rankByOutput(events, e => e.skill),
    subagents: rankByOutput(events, e => e.subagent),
    hasAttribution: events.some(e => e.skill !== undefined || e.subagent !== undefined),
    durations: measured.map(e => e.durationMs ?? 0),
    concurrency: concurrency(sessions),
    failures,
  }
}
