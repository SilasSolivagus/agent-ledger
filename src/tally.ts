/**
 * Totals that cover the whole window, without parsing everything on the way
 * to a page.
 *
 * `--limit` exists because parsing 1,906 transcripts costs about 33 seconds,
 * and a board cannot spend that on a click. But the cap was applied to the
 * aggregate figures too, and those are the ones people check against a
 * vendor's usage page — so a reconciliation number was quietly showing a tenth
 * of the truth. Capping the session list is right; capping the total is not.
 *
 * So the two are separated. The list still takes the newest `--limit` per
 * source. The totals come from here: every file counted once, the result kept
 * on disk against its path, mtime and size, and refilled in the background
 * rather than on the request that needs it.
 *
 * Counts are bucketed by local calendar day. A transcript spans hours, so a
 * file-level total could not answer "the last seven days"; a day is the
 * coarsest bucket that can, and it happens to line up with how vendors publish
 * their own weekly figures. Windows finer than a day — the watch baseline —
 * are answered by parsing the few files that moved, as before.
 *
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { Session } from './types.js'
import type { TranscriptFile } from './transcript.js'
import { readTranscript } from './transcript.js'
import { spendOf, type Money } from './price.js'

/** What one day of one transcript came to. */
export interface Bucket {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  steps: number
  /** Spend by currency, already priced — rates can change, so this is frozen. */
  usd: number
  cny: number
  /** Records that carried usage but could not be priced. */
  unpriced: number
}

/** One transcript's contribution, and the identity that says it is still valid. */
export interface FileTally {
  path: string
  mtimeMs: number
  size: number
  agent: string
  /** Local `YYYY-MM-DD` to that day's totals. */
  days: Record<string, Bucket>
}

/** Everything counted so far, plus how much is left. */
export interface Tally {
  files: Map<string, FileTally>
  /** Files not yet counted. Zero means the totals are complete. */
  pending: number
}

/** The sum over a window, and what it could not price. */
export interface Totals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  steps: number
  gross: number
  money: Money[]
  unpriced: number
  /** Files still uncounted when this was taken. */
  pending: number
}

const EMPTY = (): Bucket => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0, usd: 0, cny: 0, unpriced: 0,
})

/** Local calendar day, which is the unit a reader compares against a bill. */
export function dayOf(at: number): string {
  const d = new Date(at)
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`
}

/** Where a real installation keeps it. Never defaulted for callers. */
export function defaultTallyPath(): string {
  return join(homedir(), '.runledger', 'tally.json')
}

/**
 * Count one parsed session into day buckets.
 * @param file - the transcript it came from.
 * @param session - the parsed session.
 * @returns the contribution, ready to cache.
 */
export function tallyOf(file: TranscriptFile, session: Session): FileTally {
  const days: Record<string, Bucket> = {}
  const at = (t: number): Bucket => {
    const key = dayOf(t)
    days[key] ??= EMPTY()
    return days[key] as Bucket
  }
  for (const step of session.steps) {
    const b = at(step.startedAt > 0 ? step.startedAt : file.mtimeMs)
    b.steps += 1
    if (step.usage === undefined) continue
    b.input += step.usage.input
    b.output += step.usage.output
    b.cacheRead += step.usage.cacheRead
    b.cacheWrite += step.usage.cacheWrite
  }
  // Money is frozen at count time on purpose. Rates change, and a total that
  // silently restated last month's spend when the table was updated would be
  // worse than one that is a little stale and says when it was taken.
  for (const event of session.events ?? []) {
    if (event.usage === undefined) continue
    const b = at(event.at > 0 ? event.at : file.mtimeMs)
    const spend = spendOf([event])
    b.unpriced += spend.unpriced
    for (const m of spend.totals) {
      if (m.currency === 'CNY') b.cny += m.amount
      else b.usd += m.amount
    }
  }
  return { path: file.path, mtimeMs: file.mtimeMs, size: file.size, agent: file.agent, days }
}

/**
 * Sum a window out of what has been counted.
 * @param tally - the cache.
 * @param since - window start; anything on that calendar day or later counts.
 * @param agent - one source, or undefined for all.
 */
export function totalsSince(tally: Tally, since: number, agent?: string): Totals {
  const from = since <= 0 ? '' : dayOf(since)
  const out: Totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0,
    gross: 0, money: [], unpriced: 0, pending: tally.pending,
  }
  let usd = 0
  let cny = 0
  for (const file of tally.files.values()) {
    if (agent !== undefined && file.agent !== agent) continue
    for (const [day, b] of Object.entries(file.days)) {
      if (day < from) continue
      out.input += b.input
      out.output += b.output
      out.cacheRead += b.cacheRead
      out.cacheWrite += b.cacheWrite
      out.steps += b.steps
      out.unpriced += b.unpriced
      usd += b.usd
      cny += b.cny
    }
  }
  out.gross = out.input + out.output + out.cacheRead + out.cacheWrite
  if (cny > 0) out.money.push({ amount: cny, currency: 'CNY' })
  if (usd > 0) out.money.push({ amount: usd, currency: 'USD' })
  return out
}

/**
 * Load what was counted last time.
 * @param path - the file, or undefined to skip persistence entirely.
 */
export async function readTally(path: string | undefined): Promise<Map<string, FileTally>> {
  const out = new Map<string, FileTally>()
  if (path === undefined) return out
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch { return out }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return out
    for (const one of parsed as FileTally[]) {
      if (typeof one?.path === 'string' && typeof one.mtimeMs === 'number') out.set(one.path, one)
    }
  } catch { /* a half-written cache counts as none */ }
  return out
}

/** Store what has been counted. Silent on failure: a cache is not the product. */
export async function writeTally(
  path: string | undefined, files: Map<string, FileTally>,
): Promise<void> {
  if (path === undefined) return
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify([...files.values()]), 'utf8')
  } catch { /* an unwritable state dir costs the cache, not the session */ }
}

/**
 * Count everything not already counted, a few files at a time.
 *
 * Runs after the server is listening rather than before, so the first request
 * is answered while this is still going. `pending` is what the page shows in
 * the meantime — a total that is still filling says so instead of pretending
 * to be final.
 *
 * @param tally - the live cache, mutated as files land.
 * @param files - the current scan.
 * @param path - where to persist, or undefined.
 * @param onProgress - called after each batch.
 */
export async function fillTally(
  tally: Tally,
  files: readonly TranscriptFile[],
  path: string | undefined,
  onProgress?: () => void,
): Promise<void> {
  const stale = files.filter(file => {
    const had = tally.files.get(file.path)
    return had === undefined || had.mtimeMs !== file.mtimeMs || had.size !== file.size
  })
  tally.pending = stale.length
  let done = 0
  for (const file of stale) {
    try {
      const session = await readTranscript(file)
      if (session !== undefined) tally.files.set(file.path, tallyOf(file, session))
      else tally.files.set(file.path, {
        path: file.path, mtimeMs: file.mtimeMs, size: file.size, agent: file.agent, days: {},
      })
    } catch { /* one unreadable transcript must not stop the count */ }
    tally.pending -= 1
    done += 1
    // Persist periodically: a run interrupted after twenty minutes should not
    // start over, which is the whole reason this is on disk.
    if (done % 200 === 0) { await writeTally(path, tally.files); onProgress?.() }
  }
  // Drop entries for files that are gone, or the cache grows forever.
  const alive = new Set(files.map(f => f.path))
  for (const key of [...tally.files.keys()]) if (!alive.has(key)) tally.files.delete(key)
  await writeTally(path, tally.files)
  onProgress?.()
}
