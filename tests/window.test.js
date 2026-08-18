/**
 * Widening the window, and surviving a restart.
 *
 * The board's default is still "since I started watching", but that default
 * threw away the afternoon every time the server was restarted, and it could
 * never answer "what did today cost". So the baseline became one window of
 * four, and it now lives on disk.
 *
 * The rule the state file follows is the one the transcript roots already
 * follow: a caller that does not name a path gets no persistence at all,
 * never the developer's own state directory.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLedgerServer } from '../lib/serve.js'
import { noSources } from '../lib/transcript.js'
import { windowFrom, RANGES } from '../lib/live.js'
import { readBaseline, writeBaseline, defaultStatePath } from '../lib/baseline.js'

const T = n => `2026-08-17T10:0${n}:00.000Z`
const ms = n => Date.parse(T(n))

function claudeTurn(said, minute) {
  return [
    JSON.stringify({
      type: 'user', timestamp: T(minute), cwd: '/tmp/win-proj', gitBranch: 'main',
      message: { content: said },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: T(minute), message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: `answering ${said}` }],
      },
    }),
    '',
  ].join('\n')
}

/** The board for one vendor, which is where a session becomes readable. */
const get2 = async b => await b.get('/?agent=claude-code')

/** A machine with one old session, and a server that starts afterwards. */
async function board({ startedAt = ms(2), state, fresh } = {}) {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-win-c-'))
  const codex = await mkdtemp(join(tmpdir(), 'agent-ledger-win-x-'))
  await writeFile(join(claude, 'session-before.jsonl'), claudeTurn('OLD-WORK', 0), 'utf8')
  const server = createLedgerServer({
    port: 0, limit: 40, state, fresh,
    roots: { ...noSources(codex), claude, codex },
  }, startedAt)
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  const get = async path => (await fetch(`${base}${path}`)).text()
  const stop = () => { server.close(); server.closeAllConnections() }
  return { claude, codex, get, stop }
}

test('the default window is still the baseline, and it still hides what came before', async () => {
  const { get, stop } = await board()
  try {
    const body = await get('/')
    assert.match(body, /还没有新活动/, 'the board is empty, not full of history')
    // Asking for that session by name is the strong form: the board must not
    // serve it even when pointed straight at it.
    assert.ok(!/OLD-WORK/.test(await get('/?agent=claude-code&s=session-before')))
    assert.match(body, /class="on">本次监视/, 'and the picker says which window that is')
  } finally { stop() }
})

test('widening to 全部 reaches back past the baseline', async () => {
  const { get, stop } = await board()
  try {
    const body = await get('/?agent=claude-code&range=all&s=session-before')
    assert.match(body, /OLD-WORK/, 'the session the baseline was hiding is readable now')
  } finally { stop() }
})

test('an unknown window falls back to the baseline rather than to everything', async () => {
  // A typo in the URL must not quietly widen the board to a thousand sessions.
  const { get, stop } = await board()
  try {
    assert.ok(!/OLD-WORK/.test(
      await get('/?agent=claude-code&range=everything&s=session-before')))
  } finally { stop() }
})

test('the window survives a click on a vendor tab', async () => {
  // Losing it there reads as "the data vanished", not as "the filter reset".
  const { get, stop } = await board()
  try {
    const body = await get('/?agent=claude-code&range=all')
    assert.match(body, /class="atab[^"]*" href="\?agent=codex&amp;range=all"/,
      'every tab carries the window forward')
  } finally { stop() }
})

test('the picker offers exactly the windows the code knows about', async () => {
  const { get, stop } = await board()
  try {
    const body = await get('/')
    for (const label of Object.values(RANGES)) assert.match(body, new RegExp(label))
  } finally { stop() }
})

test('a restart resumes the baseline instead of throwing the afternoon away', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-state-'))
  const state = join(dir, 'baseline.json')
  const first = await board({ startedAt: ms(2), state })
  try {
    await new Promise(r => setTimeout(r, 60))
    assert.ok(existsSync(state), 'starting the server records where watching began')
  } finally { first.stop() }

  // A second server started much later would, without the stored baseline,
  // take a fresh one and drop everything the first one had been showing.
  const second = await board({ startedAt: ms(9), state })
  try {
    const stored = await readBaseline(state)
    assert.equal(stored.at, ms(2), 'the second start keeps the first start time')
    assert.ok(!/OLD-WORK/.test(await get2(second)), 'and still hides what predates it')
  } finally { second.stop() }
})


test('--fresh throws the stored baseline away on purpose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-state-'))
  const state = join(dir, 'baseline.json')
  await writeBaseline(state, { at: ms(0), sizes: new Map() })
  const { get, stop } = await board({ startedAt: ms(2), state, fresh: true })
  try {
    await get('/')
    const stored = await readBaseline(state)
    assert.equal(stored.at, ms(2), 'the old start time is replaced, not kept')
  } finally { stop() }
})

test('a server that names no state file writes nothing at all', async () => {
  // The same rule the transcript roots follow: forgetting an argument must
  // mean "nothing", never "the developer's own machine".
  const before = existsSync(defaultStatePath())
  const { get, stop } = await board({ state: undefined })
  try {
    await get('/')
    assert.equal(await readBaseline(undefined), undefined)
    assert.equal(existsSync(defaultStatePath()), before,
      'the real state directory is untouched by a test that forgot the path')
  } finally { stop() }
})

test('a corrupt state file reads as no baseline, not as an empty one', async () => {
  // An empty `sizes` map would make every resumed session look brand new and
  // replay it from the top, which is worse than starting over honestly.
  const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-state-'))
  const path = join(dir, 'baseline.json')
  await writeFile(path, '{"at":', 'utf8')
  assert.equal(await readBaseline(path), undefined)
  await writeFile(path, '{"at":0,"sizes":{}}', 'utf8')
  assert.equal(await readBaseline(path), undefined, 'a zero start time is not a baseline')
})

test('windowFrom puts the four windows in the right order', () => {
  const baseline = { at: 5000, sizes: new Map() }
  const now = Date.UTC(2026, 7, 18, 12, 0, 0)
  assert.equal(windowFrom('watch', baseline, now), 5000)
  assert.equal(windowFrom('all', baseline, now), 0)
  assert.equal(windowFrom('week', baseline, now), now - 7 * 86400_000)
  assert.ok(windowFrom('today', baseline, now) <= now)
  assert.ok(windowFrom('today', baseline, now) > now - 86400_000)
})

test('a board that dropped sessions to stay small says so', async () => {
  // Silent truncation reads as "this is everything", which on a machine with
  // 1,806 transcripts is the most misleading thing the page could imply.
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-cap-'))
  for (const n of [3, 4, 5]) {
    await writeFile(join(claude, `session-${n}.jsonl`), claudeTurn(`WORK-${n}`, n), 'utf8')
  }
  const server = createLedgerServer({
    port: 0, limit: 1, roots: { ...noSources(claude), claude },
  }, ms(9))
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  try {
    const body = await (await fetch(`${base}/?agent=claude-code&range=all`)).text()
    assert.match(body, /另有 2 个会话没读进来/, 'the two it skipped are counted out loud')
    assert.match(body, /--limit/, 'and the reader is told which knob changes it')
  } finally { server.close(); server.closeAllConnections() }
})
