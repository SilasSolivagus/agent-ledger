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
export type AgentKind = 'claude-code' | 'codex' | 'dsh' | 'unknown'

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

/** One line in the session ledger — what happened, in order. */
export interface LedgerEvent {
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'context'
  at: number
  /** Which turn this belongs to; turns are numbered from 1. */
  turn: number
  /** Short human-readable summary. Full content is never copied here. */
  text: string
  /** Tool name, when kind is 'tool'. */
  tool?: string
  /** Short result summary, when the following record carried one. */
  result?: string
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
