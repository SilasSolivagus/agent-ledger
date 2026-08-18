/**
 * Watching what is happening now, not what happened before.
 *
 * The machine this runs on holds nearly two thousand past sessions and a
 * gigabyte of transcript. None of it is what you want to look at while you
 * are working — you want the session you are in. So the server takes a
 * baseline the moment it starts, and everything already on disk at that
 * instant stops existing as far as the board is concerned.
 *
 * Two things count as new after that. A transcript file that did not exist is
 * a session you just started. A file that has grown past its baseline size is
 * the session you were already in, carrying on. The second case is why the
 * baseline stores bytes rather than just a set of paths: resuming a session
 * appends to a file that was already there, and a path-only baseline would
 * never notice.
 *
 * Records written before the baseline are still in that file, so a resumed
 * session is trimmed to the part that happened after the server started.
 * Turn numbers are left alone — seeing a board open at 第 7 轮 is the honest
 * signal that you resumed something rather than started fresh.
 *
 * @module
 */

import type { Session } from './types.js'
import type { TranscriptFile } from './transcript.js'

/** What existed the moment watching began. */
export interface Baseline {
  /** When watching started. Records older than this are history. */
  at: number
  /** Bytes each transcript held at that moment. */
  sizes: ReadonlyMap<string, number>
}

/**
 * Freeze what is already on disk.
 * @param files - every transcript found at startup.
 * @param at - the instant watching begins.
 * @returns the baseline to compare later scans against.
 */
export function baselineFrom(files: readonly TranscriptFile[], at: number): Baseline {
  return { at, sizes: new Map(files.map(file => [file.path, file.size])) }
}

/**
 * Which transcripts have moved since the baseline.
 * @param files - a fresh scan.
 * @param baseline - what existed when watching began.
 * @returns files that are new, or that have grown.
 */
export function movedSince(
  files: readonly TranscriptFile[],
  baseline: Baseline,
): TranscriptFile[] {
  return files.filter(file => {
    // mtime is checked as well as size because the baseline scan is not
    // instantaneous: a file written while it was still walking the tree would
    // be recorded at its post-write size and then never look grown. Its
    // modification time still lands after the baseline instant, and
    // `sinceBaseline` trims the records, so nothing older leaks in either way.
    if (file.mtimeMs >= baseline.at) return true
    const was = baseline.sizes.get(file.path)
    return was === undefined || file.size > was
  })
}

/**
 * Cut a session down to what happened after watching began.
 *
 * A resumed session's file still holds everything that came before. Keeping
 * it would put yesterday's work on a board that claims to show now.
 * @param session - the session as parsed from the whole file.
 * @param since - the baseline instant.
 * @returns the session with only its new records, or undefined when none are.
 */
export function sinceBaseline(session: Session, since: number): Session | undefined {
  // Cursor stamps nothing, so its records all read as time zero and a
  // timestamp filter would discard the whole session. Those files are trimmed
  // by byte offset when they are parsed, so whatever arrives here is already
  // the new part and must pass through untouched.
  const timeless = (session.events ?? []).every(event => event.at === 0)
  if (timeless && session.steps.length === 0) {
    return (session.events ?? []).length === 0 ? undefined : session
  }
  const steps = session.steps.filter(step => step.startedAt >= since)
  const events = (session.events ?? []).filter(event => event.at >= since)
  if (steps.length === 0 && events.length === 0) return undefined

  const out: Session = {
    id: session.id,
    agent: session.agent,
    // The board is about this stretch of work, so it starts when this stretch
    // did — not when the session was first opened, possibly days ago.
    startedAt: events[0]?.at ?? steps[0]?.startedAt ?? since,
    steps,
  }
  if (session.agentVersion !== undefined) out.agentVersion = session.agentVersion
  if (session.cwd !== undefined) out.cwd = session.cwd
  if (session.gitBranch !== undefined) out.gitBranch = session.gitBranch
  if (events.length > 0) out.events = events
  return out
}

/** Live sessions grouped by the agent that produced them, busiest first. */
export function boardsOf(sessions: readonly Session[]): Map<string, Session[]> {
  const out = new Map<string, Session[]>()
  for (const session of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const list = out.get(session.agent) ?? []
    list.push(session)
    out.set(session.agent, list)
  }
  return out
}

/**
 * The windows a board can look through.
 *
 * `watch` is the product's default and its original idea: only what moved
 * after the server started. The others exist because that default throws away
 * the afternoon the moment you restart, and because "how much did today cost"
 * is a question the baseline cannot answer. The baseline is now one option
 * among four rather than the only filter.
 */
export const RANGES: Readonly<Record<string, string>> = {
  watch: '本次监视',
  today: '今天',
  week: '近 7 天',
  all: '全部',
}

/**
 * The instant a window opens.
 * @param range - one of {@link RANGES}; anything else is treated as `watch`.
 * @param baseline - when watching began.
 * @param now - the current instant.
 * @returns records at or after this are inside the window.
 */
export function windowFrom(range: string, baseline: Baseline, now: number): number {
  if (range === 'all') return 0
  if (range === 'week') return now - 7 * 86400_000
  if (range === 'today') {
    const d = new Date(now)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  return baseline.at
}
