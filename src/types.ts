/**
 * The wire-neutral event model.
 *
 * Claude Code speaks Anthropic Messages; Codex speaks OpenAI Responses; dsh
 * speaks whatever its adapter is pointed at. Each has a different envelope for
 * the same five facts: a request went out, text streamed back, tools were
 * called, tokens were charged, and it took some time. Everything downstream —
 * the trajectory, the dashboard, the totals — reads only the model below, so
 * adding a fourth agent means writing one adapter and nothing else.
 *
 * @module
 */

/** Which product produced a session. Enum, never free text. */
export type AgentKind = 'claude-code' | 'codex' | 'cursor' | 'dsh' | 'workbuddy' | 'unknown'

/**
 * Who makes the agent, said out loud.
 *
 * A board that says only `codex` leaves the reader to know that is OpenAI's.
 * Anyone comparing two agents is comparing two vendors, so the vendor is on
 * the tab, not implied by a product name.
 */
export const AGENT_VENDOR: Readonly<Record<AgentKind, { vendor: string; product: string }>> = {
  'claude-code': { vendor: 'Anthropic', product: 'Claude Code' },
  'codex': { vendor: 'OpenAI', product: 'Codex' },
  'cursor': { vendor: 'Anysphere', product: 'Cursor' },
  'dsh': { vendor: 'DeepSeek', product: 'Harness' },
  // WorkBuddy runs several vendors' models, so the vendor slot is the product
  // itself rather than a maker this tool would be guessing at.
  'workbuddy': { vendor: 'WorkBuddy', product: '' },
  'unknown': { vendor: '未知来源', product: '' },
}

/** `Anthropic · Claude Code`, for a tab or a heading. */
export function agentLabel(agent: string): string {
  const known = AGENT_VENDOR[agent as AgentKind]
  if (known === undefined) return agent
  return known.product === '' ? known.vendor : `${known.vendor} · ${known.product}`
}

/** The wire dialect a request used. */
export type Wire = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'unknown'

/**
 * Token accounting for one request, normalised.
 *
 * The two providers disagree about what "input" means: Anthropic reports
 * `input_tokens` *beside* `cache_read_input_tokens`, OpenAI reports
 * `cached_input_tokens` *inside* `input_tokens`. Adapters convert to the
 * Anthropic reading — `input` is fresh input only, never counting anything
 * already in `cacheRead`. Without that, adding the two together
 * double-charges one provider and the cache hit rates are not comparable.
 */
export interface Usage {
  /** Input tokens charged fresh. Excludes everything in `cacheRead`. */
  input: number
  output: number
  /** Tokens served from cache — charged differently, but still occupying context. */
  cacheRead: number
  /** Tokens written into cache on this request. */
  cacheWrite: number
}

/** One tool invocation observed inside a step. */
export interface ToolCall {
  name: string
  /** Serialized argument size. The arguments themselves are never retained here. */
  argBytes: number
  /** Present once the following request carries the result. */
  resultBytes?: number
}

/**
 * One model request and everything that came back from it.
 *
 * A step is the unit both products already think in: one call to the model,
 * plus whatever tools that call asked for.
 */
export interface Step {
  index: number
  startedAt: number
  /** Wall time until the first content token arrived. */
  ttftMs?: number
  /** Wall time until the stream closed. */
  durationMs?: number
  model: string
  wire: Wire
  /** Static payload the request carried before any conversation. */
  staticTokens: { prompt: number; tools: number }
  toolCount: number
  /** Number of messages in the request — conversation depth at this point. */
  historyLength: number
  usage?: Usage
  calls: ToolCall[]
  /** Set when the upstream failed; the proxy still records the attempt. */
  error?: string
}

/**
 * How long an operation took, and how confidently we know it.
 *
 * `measured` is a real interval between two recorded facts — a tool call and
 * the record carrying its result. `gap` is the distance to the previous
 * record, which is all a transcript offers for the model's own time: it
 * contains the request, but also whatever the harness and the person did in
 * between. The two must never be added together or drawn alike.
 */
export type Timing = 'measured' | 'gap'

/** One line in the session ledger — what happened, in order. */
export interface LedgerEvent {
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'context'
  at: number
  /** Which turn this belongs to; turns are numbered from 1. */
  turn: number
  /** One-line summary, for the row. */
  text: string
  /** Tool name, when kind is 'tool'. */
  tool?: string
  /** Short result summary, when the following record carried one. */
  result?: string
  /** Full text behind {@link text}, for the details panel. */
  full?: string
  /** Full text behind {@link result}. */
  resultFull?: string
  /** How long this operation took. */
  durationMs?: number
  /** Whether {@link durationMs} was measured or inferred from the record gap. */
  timing?: Timing
  /** Token accounting for the request that produced this record. Assistant only. */
  usage?: Usage
  /** The tool reported a failure. */
  isError?: boolean
  /**
   * Which record in the file produced this event.
   *
   * Sources that stamp their records let the live board trim by time. Cursor
   * writes no timestamp at all, so its board trims by position instead: the
   * records past the byte offset the baseline recorded are the new ones.
   */
  seq?: number
  /**
   * Which skill this record was produced under, when the harness attributes
   * it. Claude Code records this; Codex rollouts carry no equivalent, so a
   * panel built on it must say the field is absent rather than show a zero.
   */
  skill?: string
  /** Which subagent produced this record, when it was not the main loop. */
  subagent?: string
  /** The record belongs to a subagent's own conversation. */
  sidechain?: boolean
  /** The model that produced this record. Assistant only. */
  model?: string
}

/** A run of steps captured from one agent process. */
export interface Session {
  id: string
  agent: AgentKind
  agentVersion?: string
  startedAt: number
  endedAt?: number
  steps: Step[]
  /** Ordered ledger of what happened, when the source records it. */
  events?: LedgerEvent[]
  /** Working directory the session ran in, when recorded. */
  cwd?: string
  /** Git branch at the time, when recorded. */
  gitBranch?: string
}

/** Roll-up across one or many sessions. */
export interface Totals {
  sessions: number
  steps: number
  toolCalls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Share of input tokens served from cache, 0..1. */
  cacheHitRate: number
  /** Median time-to-first-token across steps that reported one. */
  medianTtftMs: number
  /**
   * Wall time the steps span, end to end.
   *
   * Transcripts record no duration, so a step's is the gap since the previous
   * record — which contains the model, the tool it ran, and however long the
   * person took to read the answer. That makes this a span, not a cost. Naming
   * it after the model would invite the reader to divide it by steps and
   * believe the result.
   */
  spanMs: number
  /** Per-tool call counts, most used first. */
  topTools: { name: string; calls: number }[]
}
