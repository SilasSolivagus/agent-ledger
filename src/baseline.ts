/**
 * Keeping the baseline across a restart.
 *
 * Without this, closing the server throws away the afternoon: the next start
 * takes a fresh baseline and everything you had been watching drops off the
 * board. The file holds the same two facts the in-memory baseline does — when
 * watching began, and how large each transcript was at that moment.
 *
 * The path is never defaulted. A caller that does not pass one gets no
 * persistence at all, which is the same rule the transcript roots follow and
 * for the same reason: a test that forgets this argument must read and write
 * nothing, rather than reach into the developer's own state directory.
 *
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { Baseline } from './live.js'

/** Where a real installation keeps it. */
export function defaultStatePath(): string {
  return join(homedir(), '.runledger', 'baseline.json')
}

/**
 * Read a stored baseline.
 * @param path - the file, or undefined to skip persistence entirely.
 * @returns the baseline, or undefined when there is none to resume.
 */
export async function readBaseline(path: string | undefined): Promise<Baseline | undefined> {
  if (path === undefined) return undefined
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch { return undefined }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { at?: unknown; sizes?: unknown }
    if (typeof record.at !== 'number' || record.at <= 0) return undefined
    // A hand-edited or half-written file is treated as no baseline rather than
    // as an empty one: an empty `sizes` map would make every resumed session
    // look brand new and replay it from the top.
    if (typeof record.sizes !== 'object' || record.sizes === null) return undefined
    const sizes = new Map<string, number>()
    for (const [file, size] of Object.entries(record.sizes as Record<string, unknown>)) {
      if (typeof size === 'number') sizes.set(file, size)
    }
    return { at: record.at, sizes }
  } catch { return undefined }
}

/**
 * Store a baseline for the next start.
 * @param path - the file, or undefined to skip persistence entirely.
 * @param baseline - what to remember.
 */
export async function writeBaseline(
  path: string | undefined, baseline: Baseline,
): Promise<void> {
  if (path === undefined) return
  const body = JSON.stringify({
    at: baseline.at,
    sizes: Object.fromEntries(baseline.sizes),
  })
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body, 'utf8')
  } catch { /* an unwritable state dir costs the resume, not the session */ }
}
