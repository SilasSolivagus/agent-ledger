/**
 * Making a report safe to hand to someone else.
 *
 * The tempting design is a filter: scan the text for keys, tokens, home
 * directories, and blank them out. Do not build that. A pattern-matching
 * redactor is wrong in the one direction that matters — it misses something,
 * and it has already told you the page is safe, so you send it. A tool that
 * quietly converts "I did not think of that pattern" into "you published your
 * production credentials" is worse than no tool, because without it you would
 * have read the page yourself.
 *
 * So nothing here inspects content in order to keep it. Free text is dropped
 * wholesale and what remains is shape: how many turns, in what order, which
 * tools, how many tokens, how long. That is the half worth showing anyway —
 * the trajectory and the ledger's rhythm survive, the sentences do not.
 *
 * Redaction happens on the session model, before rendering. Doing it on the
 * rendered HTML would mean every new template is a new chance to leak.
 *
 * What is deliberately kept, and why:
 *
 * - **Tool names** (`Bash`, `exec_command`, `apply_patch`). They are the
 *   substance of a trajectory and carry no content of yours. The exception
 *   worth knowing about: an MCP tool's name can carry an internal service
 *   name. If that matters to you, do not share the page.
 * - **Model names, token counts, timings, step and turn structure.** None of
 *   these are yours in any private sense.
 *
 * What is dropped: everything you or the model wrote, every command, every
 * path, every tool result, the working directory, and the git branch.
 *
 * @module
 */

import type { LedgerEvent, Session } from './types.js'

/** A stand-in that keeps the one honest fact about the text: how much there was. */
function elided(text: string): string {
  return text === '' ? '' : `··· ${String([...text].length)} 字`
}

/** Strip one event down to its shape. */
function redactEvent(event: LedgerEvent): LedgerEvent {
  const out: LedgerEvent = {
    kind: event.kind,
    at: event.at,
    turn: event.turn,
    text: elided(event.text),
  }
  // The tool's name stays; everything it was asked to do, and everything it
  // answered, does not. `full` and `resultFull` hold the untruncated originals
  // behind the details panel and are dropped outright rather than elided —
  // there is nothing a reader gains from the length of text they cannot see.
  if (event.tool !== undefined) out.tool = event.tool
  if (event.result !== undefined) out.result = elided(event.result)
  // Timing and token facts are measurements, not content.
  if (event.durationMs !== undefined) out.durationMs = event.durationMs
  if (event.timing !== undefined) out.timing = event.timing
  if (event.usage !== undefined) out.usage = event.usage
  if (event.isError !== undefined) out.isError = event.isError
  if (event.model !== undefined) out.model = event.model
  if (event.sidechain !== undefined) out.sidechain = event.sidechain
  // Skill and subagent names are yours: a skill catalogue is a description of
  // how you work, and a subagent name can carry a project's vocabulary.
  return out
}

/**
 * Strip one session down to what is safe to show a stranger.
 * @param session - the session as read from disk.
 * @returns a copy carrying structure and figures but no content.
 */
export function redactSession(session: Session): Session {
  const out: Session = {
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    // Steps hold counts and timings only — no text ever reaches them, and the
    // tool names inside `calls` are kept for the same reason as above.
    steps: session.steps,
  }
  if (session.agentVersion !== undefined) out.agentVersion = session.agentVersion
  if (session.endedAt !== undefined) out.endedAt = session.endedAt
  if (session.events !== undefined) out.events = session.events.map(redactEvent)
  // cwd and gitBranch are dropped outright: a path carries your account name
  // and your clients' project names, and a branch name is often a ticket title.
  return out
}

/**
 * Strip every session.
 * @param sessions - sessions as read from disk.
 * @param on - when false, hand the sessions back untouched.
 * @returns the sessions, redacted or not.
 */
export function redactAll(sessions: readonly Session[], on: boolean): readonly Session[] {
  return on ? sessions.map(redactSession) : sessions
}
