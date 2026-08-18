/**
 * Reading WorkBuddy, which keeps a database rather than a transcript.
 *
 * Claude Code and Codex both append a JSONL file per session, so one file is
 * one session and everything that happened is in it. WorkBuddy keeps
 * `~/.workbuddy/workbuddy.db` — a SQLite database with one row per session and
 * a usage row beside it. The conversation itself is not on this machine.
 *
 * That makes WorkBuddy a different capability tier, and the difference is not
 * a gap to be papered over:
 *
 * - **Available**: session identity, working directory, title, model, mode,
 *   status, created/updated/last-activity times, and context occupancy
 *   (`used` of `size` tokens).
 * - **Absent**: every per-record fact. No events, so no trajectory. No tool
 *   calls, so no measured durations. No per-step usage, so no input/output
 *   split and no cache figures. No skill attribution.
 *
 * A board that rendered empty charts here would be claiming those figures are
 * zero. They are unavailable, which is a different statement, so the sessions
 * this module returns carry no `steps` and no `events` and the view says why.
 *
 * Read-only, and opened read-only: the file belongs to a running application.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from './types.js'

/** Where WorkBuddy keeps its database. */
export const WORKBUDDY_DB = join(homedir(), '.workbuddy', 'workbuddy.db')

/** What WorkBuddy knows about one session, beyond the neutral model. */
export interface WorkbuddyDetail {
  id: string
  title: string
  model: string
  mode: string
  status: string
  /** Context tokens occupied, and the window they occupy. */
  used: number
  size: number
}

/** A session from WorkBuddy, plus the facts only WorkBuddy records. */
export interface WorkbuddySession {
  session: Session
  detail: WorkbuddyDetail
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Read WorkBuddy's sessions.
 *
 * `node:sqlite` ships with Node, so this adds no dependency. It is flagged
 * experimental, which is why the import is guarded: a runtime without it must
 * lose WorkBuddy, not the whole board.
 * @param path - database path; defaults to the standard location.
 * @returns sessions newest first, empty when WorkBuddy is not installed.
 */
export async function readWorkbuddySessions(path: string = WORKBUDDY_DB): Promise<WorkbuddySession[]> {
  if (!existsSync(path)) return []
  let DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
    prepare: (sql: string) => { all: () => unknown[] }
    close: () => void
  }
  try {
    ({ DatabaseSync } = await import('node:sqlite') as never)
  } catch {
    // A Node without node:sqlite simply has no WorkBuddy source.
    return []
  }

  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    // The application holds this file; a locked or half-migrated database is
    // not an error worth taking the board down for.
    return []
  }
  try {
    const rows = db.prepare(`
      SELECT s.id, s.cwd, s.title, s.custom_title, s.model, s.mode, s.status,
             s.created_at, s.last_activity_at, s.updated_at,
             u.used AS used, u.size AS size
      FROM sessions s LEFT JOIN session_usage u ON u.session_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY COALESCE(s.last_activity_at, s.updated_at, s.created_at) DESC
    `).all() as Record<string, unknown>[]

    return rows.map(row => {
      const at = num(row['last_activity_at']) || num(row['updated_at']) || num(row['created_at'])
      const session: Session = {
        id: text(row['id']),
        agent: 'workbuddy',
        startedAt: num(row['created_at']) || at,
        // No steps and no events: WorkBuddy records neither. Leaving them out
        // is what makes every downstream figure read as unavailable rather
        // than as zero.
        steps: [],
      }
      if (at > 0) session.endedAt = at
      const cwd = text(row['cwd'])
      if (cwd !== '') session.cwd = cwd
      return {
        session,
        detail: {
          id: text(row['id']),
          title: text(row['custom_title']) || text(row['title']),
          model: text(row['model']),
          mode: text(row['mode']),
          status: text(row['status']),
          used: num(row['used']),
          size: num(row['size']),
        },
      }
    })
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* already gone */ }
  }
}

/**
 * When WorkBuddy's database last changed.
 *
 * The live board needs a baseline per source, and one file stands for every
 * WorkBuddy session — so liveness is decided per row by `last_activity_at`,
 * with this only telling the board whether anything moved at all.
 * @param path - database path.
 * @returns modification time in epoch milliseconds, or 0 when absent.
 */
export async function workbuddyTouchedAt(path: string = WORKBUDDY_DB): Promise<number> {
  try { return (await stat(path)).mtimeMs } catch { return 0 }
}
