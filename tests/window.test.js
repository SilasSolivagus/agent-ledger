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

test('windowFrom puts every window at the right instant', () => {
  const baseline = { at: 5000, sizes: new Map() }
  const now = Date.UTC(2026, 7, 18, 12, 0, 0)
  assert.equal(windowFrom('watch', baseline, now), 5000)
  assert.equal(windowFrom('all', baseline, now), 0)
  assert.equal(windowFrom('week', baseline, now), now - 7 * 86400_000)
  assert.equal(windowFrom('month', baseline, now), now - 30 * 86400_000)
  assert.ok(windowFrom('month', baseline, now) < windowFrom('week', baseline, now),
    'and they widen in the order the picker lists them')
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
    // The cap applies to the list only; the totals cover the window. The
    // notice has to say which, or a reader takes the figures as truncated.
    assert.match(body, /另有 2 个未列出，但已计入总量/, 'the two it skipped are counted out loud')
    assert.match(body, /--limit/, 'and the reader is told which knob changes it')
  } finally { server.close(); server.closeAllConnections() }
})

test('a machine with no agent at all says so, and says where it looked', async () => {
  // Every tab is a source that exists on disk. With none, there is no board to
  // open and no tab to click, so the page has to answer the only question left:
  // what did you look for, and where.
  const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-bare-'))
  const server = createLedgerServer({ port: 0, limit: 40, roots: noSources(dir) }, ms(2))
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  try {
    const body = await (await fetch(`${base}/`)).text()
    assert.match(body, /未检测到 agent/)
    assert.match(body, /no-claude/, 'the paths it searched are named, so this is diagnosable')
    assert.match(body, /no-workbuddy/)
    assert.ok(!/class="atab[ "]/.test(body), 'and there is no tab pretending a source exists')
  } finally { server.close(); server.closeAllConnections() }
})

test('the empty board does not repeat what the sidebar already shows', async () => {
  // It used to restate the window, the instant, the roll-call of watched
  // sources and their counts — all of which are on screen. The emptiest page
  // in the product was the wordiest.
  const { get, stop } = await board()
  try {
    const body = await get('/')
    // The panel only, not the rest of the document that follows it.
    const panel = body.slice(body.indexOf('class="waiting"'), body.indexOf('</main>'))
    assert.ok(!/正在监听/.test(panel), 'the tabs are the roll-call')
    assert.ok(!/自 \d\d:\d\d:\d\d 之后/.test(panel), 'the footer names the instant')
    assert.ok(panel.length < 700, `the panel stays short, was ${panel.length} chars`)
    assert.match(panel, /拉宽到「今天」或「全部」/, 'what is left is the next click')
  } finally { stop() }
})

test('at the widest window there is no wider window to suggest', async () => {
  const { get, stop } = await board()
  try {
    const body = await get('/?agent=codex&range=all')
    assert.ok(!/拉宽到/.test(body), 'advice that suggests what you already did is noise')
  } finally { stop() }
})

test('with no agent installed the sidebar goes quiet too', async () => {
  // A summary of nothing, a window picker over nothing, and "this agent has
  // no activity" when there is no agent — three controls leading nowhere.
  const dir = await mkdtemp(join(tmpdir(), 'agent-ledger-bare2-'))
  const server = createLedgerServer({ port: 0, limit: 40, roots: noSources(dir) }, ms(2))
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  try {
    const body = await (await fetch(`${base}/`)).text()
    assert.ok(!/总览/.test(body), 'nothing to summarise')
    assert.ok(!/class="ranges"/.test(body), 'no window worth changing')
    assert.ok(!/这个 agent/.test(body), 'and no agent for that to name')
  } finally { server.close(); server.closeAllConnections() }
})

test('each window says which stretch of time it covers, and they differ', async () => {
  // `clock` prints a time of day and nothing else, so 近 7 天 and 近 30 天 both
  // read as the same `自 16:55:25 起` despite starting 23 days apart, and 全部
  // printed its epoch-zero start as `自 08:00:00 起` — 1970 as this morning.
  const { get, stop } = await board()
  try {
    const label = async r => {
      const body = await get(`/?agent=claude-code${r === '' ? '' : `&range=${r}`}`)
      return /class="wnote">([^<]*)/.exec(body)?.[1] ?? ''
    }
    const week = await label('week')
    const month = await label('month')
    assert.notEqual(week, month, 'two windows 23 days apart cannot read identically')
    assert.match(week, /月 \d+ 日/, 'a start outside today is useless without its date')
    assert.match(month, /月 \d+ 日/)
    assert.match(await label('all'), /全部记录/, 'and 全部 has no start worth printing')
    // This fixture's baseline is yesterday, so it earns a date like the rest.
    assert.match(await label(''), /月 \d+ 日/)
  } finally { stop() }
})

test('a window that opened today needs no date, only a clock', async () => {
  const today = await board({ startedAt: Date.now() })
  try {
    const body = await today.get('/?agent=claude-code')
    const foot = /class="wnote">([^<]*)/.exec(body)?.[1] ?? ''
    assert.match(foot, /自 \d\d:\d\d:\d\d 起/, 'a date would be noise inside today')
    assert.ok(!/月 \d+ 日/.test(foot))
  } finally { today.stop() }
})

test('the board asks a cheap question before it asks an expensive one', async () => {
  // Redrawing costs the browser a parse of the whole document and a rebuild
  // of every chart in it. Doing that every few seconds when nothing moved is
  // what made a tab left open go unresponsive, so the page carries the
  // fingerprint it was built with and the refresh compares before it fetches.
  const { get, stop, claude } = await board()
  try {
    const body = await get('/')
    const stamped = /data-pulse="([^"]+)"/.exec(body)?.[1]
    assert.ok(stamped, 'the page states what it was built from')

    const pulse = await get('/pulse')
    assert.equal(pulse, stamped, 'and the endpoint agrees with it')
    assert.ok(pulse.length < 80, `a pulse is cheap to fetch, was ${pulse.length} bytes`)

    await writeFile(join(claude, 'session-new.jsonl'), claudeTurn('NEW-WORK', 3), 'utf8')
    assert.notEqual(await get('/pulse'), pulse, 'a new transcript moves it')
  } finally { stop() }
})

test('a session that merely grows moves the pulse too', async () => {
  // A resumed session appends to a file that already existed. A fingerprint
  // built from names alone would never notice the conversation continuing.
  const { get, stop, claude } = await board()
  try {
    const before = await get('/pulse')
    await writeFile(join(claude, 'session-before.jsonl'),
      claudeTurn('OLD-WORK', 0) + claudeTurn('CARRIED-ON', 4), 'utf8')
    assert.notEqual(await get('/pulse'), before)
  } finally { stop() }
})

test('the refresh loop cannot overlap itself, and lets go of what it replaced', async () => {
  // Both faults were in the same eight lines. setInterval fired again whether
  // or not the previous cycle had finished, so a slow one piled up behind the
  // next; and the observer kept every card that innerHTML had detached,
  // because unobserve only ran for cards that had been scrolled into view.
  const { get, stop } = await board()
  try {
    const body = await get('/')
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1] ?? ''
    assert.ok(script, 'the board carries its script')
    assert.ok(!/setInterval/.test(script), 'a tick schedules the next one only when it is done')
    assert.match(script, /busy/, 'and refuses to start while one is running')
    assert.match(script, /io\.disconnect\(\)/, 'the observer lets go before the swap')
    assert.ok(!/innerHTML===/.test(script.replace(/\s/g, '')),
      'and nothing serialises half a megabyte just to decide whether to redraw')
  } finally { stop() }
})
