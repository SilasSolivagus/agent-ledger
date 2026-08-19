/**
 * Totals that are not capped, and are not recomputed every time.
 *
 * `--limit` was one number doing two jobs: keeping the session list short, and
 * keeping the page fast. It got applied to the aggregate figures as well, so
 * the number people check against a vendor's usage page was showing a tenth of
 * the truth on this machine. The list still gets capped. The totals no longer
 * do — they come from a per-file count kept on disk and refilled in the
 * background.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  dayOf, tallyOf, totalsSince, readTally, writeTally, fillTally, defaultTallyPath,
} from '../lib/tally.js'
import { listTranscripts, noSources } from '../lib/transcript.js'

const DAY = 86400_000

function turn(at, said) {
  return [
    JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), cwd: '/w/p', message: { content: said } }),
    JSON.stringify({
      type: 'assistant', timestamp: new Date(at + 500).toISOString(), message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 },
        content: [{ type: 'text', text: 'ok' }],
      },
    }),
    '',
  ].join('\n')
}

/** A root holding one transcript per day, going back `n` days. */
async function machine(n) {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-tally-'))
  for (let i = 0; i < n; i += 1) {
    const at = Date.now() - i * DAY
    await writeFile(join(claude, `session-d${String(i)}.jsonl`), turn(at, `WORK-${String(i)}`), 'utf8')
  }
  return claude
}

test('a window sums every file in it, however many that is', async () => {
  // Ten transcripts, a budget of two. The list would show two; the total is
  // over all ten, which is the difference this exists to make.
  const claude = await machine(10)
  const files = await listTranscripts(Infinity, { ...noSources(claude), claude })
  assert.equal(files.length, 10)
  const tally = { files: new Map(), pending: 0 }
  await fillTally(tally, files, undefined)
  const all = totalsSince(tally, 0)
  assert.equal(all.steps, 10, 'every file counted, not the newest few')
  assert.equal(all.input, 1000)
  assert.equal(all.gross, 10 * (100 + 50 + 9000 + 400))
  assert.ok(all.money.some(m => m.currency === 'USD' && m.amount > 0))
})

test('a narrower window takes only the days inside it', async () => {
  const claude = await machine(10)
  const files = await listTranscripts(Infinity, { ...noSources(claude), claude })
  const tally = { files: new Map(), pending: 0 }
  await fillTally(tally, files, undefined)
  const week = totalsSince(tally, Date.now() - 6 * DAY)
  assert.equal(week.steps, 7, 'seven calendar days, seven files')
  assert.ok(week.gross < totalsSince(tally, 0).gross)
})

test('counting survives a restart, and an unchanged file is not read twice', async () => {
  const claude = await machine(4)
  const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-tallyfile-'))
  const path = join(dir, 'tally.json')
  const files = await listTranscripts(Infinity, { ...noSources(claude), claude })

  const first = { files: new Map(), pending: 0 }
  await fillTally(first, files, path)
  assert.ok(existsSync(path))

  const second = { files: await readTally(path), pending: 0 }
  assert.equal(second.files.size, 4, 'the cache came back')
  await fillTally(second, files, path)
  assert.equal(second.pending, 0, 'nothing was stale, so nothing was re-read')
  assert.deepEqual(totalsSince(second, 0).gross, totalsSince(first, 0).gross)
})

test('a rewritten file is counted again, and a deleted one stops counting', async () => {
  const claude = await machine(3)
  const files = await listTranscripts(Infinity, { ...noSources(claude), claude })
  const tally = { files: new Map(), pending: 0 }
  await fillTally(tally, files, undefined)
  const before = totalsSince(tally, 0).gross

  await rm(files[0].path)
  const after = await listTranscripts(Infinity, { ...noSources(claude), claude })
  await fillTally(tally, after, undefined)
  assert.equal(tally.files.size, 2, 'the gone file left the cache')
  assert.ok(totalsSince(tally, 0).gross < before)
})

test('an unfinished count says so rather than passing for a total', async () => {
  // A page that showed a filling number as final would be the silent
  // truncation this replaces, wearing a different hat.
  const tally = { files: new Map(), pending: 7 }
  assert.equal(totalsSince(tally, 0).pending, 7)
})

test('the cache file is never defaulted for a caller that forgot it', async () => {
  const before = existsSync(defaultTallyPath())
  await writeTally(undefined, new Map())
  assert.equal(existsSync(defaultTallyPath()), before)
  assert.equal((await readTally(undefined)).size, 0)
})

test('days are local, because that is the unit a bill is read in', () => {
  const noon = new Date(2026, 7, 19, 12, 0, 0).getTime()
  assert.equal(dayOf(noon), '2026-08-19')
  assert.notEqual(dayOf(noon), dayOf(noon - DAY))
})
