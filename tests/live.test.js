/**
 * The board's one promise is that it shows now, not before. Everything here
 * tests that boundary: a machine full of old transcripts must produce an
 * empty board, a session started afterwards must appear, and a session that
 * was already open must appear from the point it carried on — not from its
 * beginning, which may be days back.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLedgerServer } from '../lib/serve.js'
import { agentLabel } from '../lib/types.js'
import { noSources } from '../lib/transcript.js'

const T = n => `2026-08-17T10:0${n}:00.000Z`
const ms = n => Date.parse(T(n))

/** One Claude turn: a person speaks, the model answers and runs a tool. */
function claudeTurn(said, minute) {
  return [
    JSON.stringify({
      type: 'user', timestamp: T(minute), cwd: '/tmp/live-proj', gitBranch: 'main',
      version: '2.0.0', message: { content: said },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: T(minute), message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [
          { type: 'text', text: `answering ${said}` },
          { type: 'tool_use', id: `t${minute}`, name: 'Bash', input: { command: `echo ${said}` } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user', timestamp: T(minute + 1),
      message: { content: [{ type: 'tool_result', tool_use_id: `t${minute}`, content: `out ${said}` }] },
    }),
    '',
  ].join('\n')
}

const CODEX_SESSION = [
  { timestamp: T(4), type: 'session_meta', payload: { id: 'cx', cwd: '/tmp/live-cx', cli_version: '0.137.0' } },
  { timestamp: T(4), type: 'turn_context', payload: { model: 'gpt-5.4' } },
  { timestamp: T(4), type: 'event_msg', payload: { type: 'user_message', message: 'CODEX-IS-LIVE' } },
  { timestamp: T(4), type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CODEX-ANSWERS' }],
  } },
  { timestamp: T(5), type: 'event_msg', payload: {
    type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 8, cached_input_tokens: 0 } },
  } },
].map(r => JSON.stringify(r)).join('\n')

/** A machine with history already on it, and a server that started after. */
async function watched(startedAt) {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-live-c-'))
  const codex = await mkdtemp(join(tmpdir(), 'agent-ledger-live-x-'))
  const old = join(claude, 'session-yesterday.jsonl')
  await writeFile(old, claudeTurn('OLD-WORK-FROM-BEFORE', 0), 'utf8')
  // Point every source at this fixture, including the one that is a database
  // path: without it the board reads the developer's own WorkBuddy install.
  const server = createLedgerServer({
    port: 0, limit: 40, roots: { ...noSources(codex), claude, codex },
  }, startedAt)
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  const get = async path => (await fetch(`${base}${path}`)).text()
  const stop = () => { server.close(); server.closeAllConnections() }
  return { claude, codex, old, get, stop }
}

test('a machine full of old sessions starts with an empty board', async () => {
  const { get, stop } = await watched(ms(2))
  try {
    const body = await get('/')
    assert.match(body, /没有活动/, 'empty is the correct answer, not a failure')
    assert.ok(!/OLD-WORK-FROM-BEFORE/.test(body), 'history must not leak onto the board')
    // What it is watching lives in the tabs, which is why the empty panel no
    // longer repeats it: every installed source has a tab whether busy or not.
    assert.match(body, /class="atab[^"]*" href="\?agent=claude-code"/)
    assert.match(body, /class="atab[^"]*" href="\?agent=codex"/)
    assert.match(body, /http-equiv="refresh"/, 'the board reloads itself')
  } finally { stop() }
})

test('the board names the vendor, not just the product', async () => {
  assert.equal(agentLabel('claude-code'), 'Anthropic · Claude Code')
  assert.equal(agentLabel('codex'), 'OpenAI · Codex')

  const { claude, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-new.jsonl'), claudeTurn('BRAND-NEW-SESSION', 3), 'utf8')
    const body = await get('/')
    assert.match(body, /Anthropic · Claude Code/)
  } finally { stop() }
})

test('a session started after watching began appears', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    assert.ok(!/live-proj/.test(await get('/')), 'nothing is listed yet')
    await writeFile(join(claude, 'session-new.jsonl'), claudeTurn('BRAND-NEW-SESSION', 3), 'utf8')

    // The vendor tab lands on its summary; the session is in the sidebar.
    const board = await get('/')
    assert.match(board, /1 个活跃会话/)
    assert.match(board, /href="\?agent=claude-code&amp;s=session-new"/, 'listed in the sidebar')

    const opened = await get('/?agent=claude-code&s=session-new')
    assert.match(opened, /BRAND-NEW-SESSION/, 'and its trajectory opens')
    assert.ok(!/OLD-WORK-FROM-BEFORE/.test(opened), 'the old session is still excluded')
  } finally { stop() }
})

test('a session already open appears from where it carried on, not from its start', async () => {
  const { old, get, stop } = await watched(ms(2))
  try {
    // The same file the machine already had, continued. A baseline that only
    // remembered paths would never notice this.
    await appendFile(old, claudeTurn('CARRIED-ON-JUST-NOW', 3), 'utf8')
    const body = await get('/?agent=claude-code&s=session-yesterday')
    assert.match(body, /CARRIED-ON-JUST-NOW/, 'the new turn shows')
    assert.ok(!/OLD-WORK-FROM-BEFORE/.test(body), 'the earlier part of the same file does not')
  } finally { stop() }
})

test('two vendors get two boards, and only one is shown at a time', async () => {
  const { claude, codex, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-new.jsonl'), claudeTurn('CLAUDE-IS-LIVE', 3), 'utf8')
    await writeFile(join(codex, 'rollout-2026-08-17T10-04-00-cx.jsonl'), `${CODEX_SESSION}\n`, 'utf8')

    const first = await get('/')
    assert.match(first, /href="\?agent=claude-code"/, 'a tab per vendor with activity')
    assert.match(first, /href="\?agent=codex"/)
    assert.match(first, /OpenAI · Codex/)

    const openai = await get('/?agent=codex&s=2026-08-17T10-04-00-cx')
    assert.match(openai, /CODEX-IS-LIVE/)
    assert.ok(!/CLAUDE-IS-LIVE/.test(openai), 'one board at a time')
  } finally { stop() }
})

test('a session that has spoken but not yet been answered is on the board', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    // What you see the instant you press enter, and what you see if the
    // request then fails: a turn exists, no model request has landed. A board
    // that waits for a step is blank at exactly that moment.
    await writeFile(join(claude, 'session-waiting.jsonl'), `${JSON.stringify({
      type: 'user', timestamp: T(3), cwd: '/tmp/live-proj', gitBranch: 'main',
      version: '2.0.0', message: { content: 'JUST-ASKED-NOTHING-BACK-YET' },
    })}\n`, 'utf8')
    assert.match(await get('/'), /1 个活跃会话/, 'it counts as live')
    const body = await get('/?agent=claude-code&s=session-waiting')
    assert.match(body, /JUST-ASKED-NOTHING-BACK-YET/, 'and the question is there to read')
  } finally { stop() }
})

test('a long session shows its newest rows, not its oldest', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    // A hundred turns in one file — comfortably past the board's row budget. A
    // board that sliced from the front would sit on turn one forever while
    // the agent kept working.
    const turns = Array.from({ length: 100 }, (_, i) => claudeTurn(`TURN-MARK-${i}`, 3)).join('')
    await writeFile(join(claude, 'session-long.jsonl'), turns, 'utf8')
    const body = await get('/?agent=claude-code&s=session-long')
    assert.match(body, /TURN-MARK-99/, 'the newest turn is on the board')
    assert.ok(!/TURN-MARK-0\b/.test(body), 'the oldest is not')
    assert.match(body, /更早的 \d+ 条<\/a>/, 'and it says so, with a link to them')
  } finally { stop() }
})

test('turn boundaries are marked without costing a header', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-two.jsonl'),
      claudeTurn('FIRST-TURN', 3) + claudeTurn('SECOND-TURN', 5), 'utf8')
    const body = await get('/?agent=claude-code&s=session-two')
    // Six columns now that money has one, so the marker spans five.
    const marks = [...body.matchAll(/class="turnmark"><td><\/td><td colspan="5">第 (\d+) 轮/g)]
    assert.deepEqual(marks.map(m => m[1]), ['1', '2'], 'one thin line per turn')
    // Every record is one row; a turn does not cost a card or a heading.
    assert.match(body, /<table class="log">/)
  } finally { stop() }
})

test('the sidebar lists a vendor tab and its sessions, and one opens on the right', async () => {
  const { claude, codex, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-a.jsonl'), claudeTurn('SESSION-A-WORK', 3), 'utf8')
    await writeFile(join(claude, 'session-b.jsonl'), claudeTurn('SESSION-B-WORK', 5), 'utf8')
    await writeFile(join(codex, 'rollout-2026-08-17T10-04-00-cx.jsonl'), `${CODEX_SESSION}\n`, 'utf8')

    const body = await get('/')
    assert.match(body, /class="atab on"[\s\S]*?Anthropic/, 'the busiest vendor is selected')
    assert.match(body, /OpenAI/, 'the other vendor is a tab, not hidden')
    // Two sessions plus the summary entry that the vendor tab lands on.
    assert.equal((body.match(/class="entry/g) ?? []).length, 3)
    assert.ok(!/SESSION-[AB]-WORK/.test(body), 'the tab shows the summary, not a trajectory')

    const pick = await get('/?agent=claude-code&s=session-b')
    assert.match(pick, /SESSION-B-WORK/, 'the picked session is the one shown')
    assert.ok(!/SESSION-A-WORK/.test(pick), 'and the other one is not')
  } finally { stop() }
})

test('the vendor tab lands on a summary that only counts overlapping time once', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    // Two sessions whose tool calls overlap in wall time. Summing their
    // durations would report more tool time than the window contains.
    await writeFile(join(claude, 'session-p.jsonl'), claudeTurn('PARALLEL-ONE', 3), 'utf8')
    await writeFile(join(claude, 'session-q.jsonl'), claudeTurn('PARALLEL-TWO', 3), 'utf8')
    const body = await get('/')
    assert.match(body, /区间并集/, 'it says how overlapping time was handled')
    assert.match(body, /工具耗时/)
    assert.match(body, /按总耗时排序，非按调用次数/, 'and why that ranking is by time')
    assert.match(body, /调用耗时分布/)
    // Every chart states what one mark is worth. That is the rule the whole
    // vocabulary rests on, and it holds across chart types, not just one.
    assert.match(body, /一个点 = 一次调用/, 'the jitter strip states its unit')
    assert.match(body, /一格 = /, 'the tick rows state theirs')
    assert.match(body, /一个点 = 一个百分点/, 'the hundred field states its unit')
    assert.match(body, /会话并发/)
  } finally { stop() }
})

test('an agent without attribution says the field is absent, not zero', async () => {
  const { claude, codex, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-a.jsonl'), claudeTurn('CLAUDE-WORK', 3), 'utf8')
    await writeFile(join(codex, 'rollout-2026-08-17T10-04-00-cx.jsonl'), `${CODEX_SESSION}\n`, 'utf8')
    const openai = await get('/?agent=codex')
    // A blank chart would read as "this agent used no skills", which is a
    // different claim from "this agent does not record skills".
    assert.match(openai, /不含 skill \/ 子代理归属字段/)
    assert.match(openai, /非零值，是该字段不存在/)
  } finally { stop() }
})

test('charts animate on load and stand still for reduced motion', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-anim.jsonl'), claudeTurn('ANIMATE-ME', 3), 'utf8')
    const body = await get('/')
    // The stagger is inline per mark, which is what lets it run without script.
    assert.match(body, /class="[^"]*pop"[^>]*animation-delay:/, 'marks pop with a per-mark delay')
    assert.match(body, /class="[^"]*fade"[^>]*animation-delay:/, 'and rows fade in sequence')
    assert.match(body, /@media \(prefers-reduced-motion:reduce\)/, 'and none of it runs when asked not to')
  } finally { stop() }
})

test('a source that keeps no transcript says what it cannot show', async () => {
  const { renderSourceBoard } = await import('../lib/render.js')
  const html = renderSourceBoard([
    { id: 'wb-1', title: '把项目做成插件', model: 'hy3', mode: 'craft', status: 'planning', used: 109445, size: 192000 },
    { id: 'wb-2', title: '问进展', model: 'kimi-k3-2', mode: 'craft', status: 'completed', used: 73067, size: 192000 },
  ])
  assert.match(html, /把项目做成插件/, 'it shows what the source does record')
  assert.match(html, /109,445/)
  assert.match(html, /57% of 192,000/, 'context occupancy against its window')

  // The point of this board: absent is not zero. Rendering the usual panels
  // would claim this source measured zero tool time.
  assert.match(html, /该来源不记录的项目/)
  assert.match(html, /不是零，是该来源不记录/)
  assert.match(html, /逐条轨迹/)
  assert.match(html, /工具调用与实测耗时/)
  assert.ok(!/一格 = .*秒/.test(html), 'and no duration chart is drawn at all')
})

test('the board holds its animation until a card is scrolled into view', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-still.jsonl'), claudeTurn('STILL-ME', 3), 'utf8')
    const board = await get('/')
    // With script running the marks hold still until their card is scrolled
    // into view; the CSS gate is what makes that possible without changing the
    // markup, so an exported file with no script animates on load instead.
    assert.match(board, /\.js \.pop/, 'the reveal gate is present')
    assert.match(board, /\.js \.in \.pop/, 'and reveal turns it back on')
    assert.match(board, /class="[^"]*pop"/, 'while the marks are unchanged')
    assert.match(board, /IntersectionObserver/, 'reveal is observed, not timed')
  } finally { stop() }
})

test('pausing stops the reload and is the only place the animation plays', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-pause.jsonl'), claudeTurn('PAUSE-ME', 3), 'utf8')

    const live = await get('/')
    // The meta refresh is the no-script fallback; with script the page swaps
    // in place, which is why the animation no longer has to be suppressed.
    assert.match(live, /<noscript><meta http-equiv="refresh"/, 'reload only without script')
    assert.match(live, /data-refresh="5"/, 'and the interval the script reads')
    assert.match(live, /live=off">暂停/, 'and offers a way to stop')

    const held = await get('/?agent=claude-code&live=off')
    assert.ok(!/http-equiv="refresh"/.test(held), 'paused means no reload at all')
    assert.ok(!/data-refresh=/.test(held), 'and nothing for the script to poll')
    assert.match(held, /已暂停/)
    assert.match(held, /继续自刷/, 'with a way back')
  } finally { stop() }
})

test('only the live board carries script; the export does not', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-js.jsonl'), claudeTurn('SCRIPTED', 3), 'utf8')
    assert.match(await get('/'), /<script>/, 'the board runs the reveal and the swap')

    // An exported file has to open from disk with no network and nothing
    // running, so the script belongs to the board alone.
    const { renderDashboard } = await import('../lib/render.js')
    assert.ok(!/<script/i.test(renderDashboard([])), 'the export stays script-free')
    // The board can host a session's trajectory, and that is still the board.
    // The standalone page at /s/<id> is the script-free one.
    const standalone = await get('/s/session-js')
    assert.ok(!/<script/i.test(standalone), 'and so does the standalone session page')
  } finally { stop() }
})

test('every installed source keeps its tab, busy or not', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    // Only Claude Code has activity. Codex is installed — its root exists —
    // so it must still be switchable, or there is no way to reach it and no
    // sign that it is supported.
    await writeFile(join(claude, 'session-busy.jsonl'), claudeTurn('ONLY-CLAUDE-MOVED', 3), 'utf8')
    const body = await get('/')
    assert.match(body, /href="\?agent=claude-code"/)
    assert.match(body, /href="\?agent=codex"/, 'the quiet agent is still a tab')
    const counts = [...body.matchAll(/<span class="count">([^<]*)<\/span>/g)].map(m => m[1])
    assert.ok(counts.includes('—'), 'and an agent with nothing yet reads as a dash')
    assert.ok(counts.includes('1'), 'while the busy one shows its count')
  } finally { stop() }
})

test('clicking a quiet agent stays on it instead of bouncing to a busy one', async () => {
  const { claude, get, stop } = await watched(ms(2))
  try {
    await writeFile(join(claude, 'session-busy.jsonl'), claudeTurn('CLAUDE-IS-BUSY', 3), 'utf8')

    const codex = await get('/?agent=codex')
    assert.match(codex, /<a class="atab on" href="\?agent=codex"/, 'codex stays selected')
    assert.match(codex, /OpenAI · Codex 在这个窗口里没有活动/, 'and says so by name')
    assert.ok(!/CLAUDE-IS-BUSY/.test(codex), 'without showing the other agent work')
    // Where the activity is was a sentence in the empty panel and is now the
    // count in the tab, which was always there and never went stale.
    assert.match(codex, /agent=claude-code"[\s\S]*?class="count">1</,
      'the busy agent carries its count on its own tab')

    // An unknown value is still a fallback, since it names nothing installed.
    const bogus = await get('/?agent=gemini')
    assert.ok(!/\?agent=gemini" /.test(bogus))
    assert.match(bogus, /<a class="atab on" href="\?agent=claude-code"/)
  } finally { stop() }
})

/** A Cursor transcript: role plus content blocks, and no timestamp anywhere. */
function cursorLines(...saids) {
  return saids.flatMap(said => [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: said }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [
      { type: 'text', text: `答 ${said}` },
      { type: 'tool_use', name: 'Read', input: { path: `/tmp/${said}.ts` } },
    ] } }),
  ]).join('\n') + '\n'
}

test('a source without timestamps is trimmed by position, not by clock', async () => {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-cur-c-'))
  const cursor = await mkdtemp(join(tmpdir(), 'agent-ledger-cur-x-'))
  const dir = join(cursor, 'projects', 'Users-silas-demo', 'agent-transcripts', 'sess')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'sess.jsonl')
  await writeFile(file, cursorLines('BEFORE-WATCHING'), 'utf8')

  const server = createLedgerServer({
    port: 0, limit: 40,
    roots: { ...noSources(claude), claude, cursor: join(cursor, 'projects') },
  }, ms(2))
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  const get = async path => (await fetch(`${base}${path}`)).text()
  try {
    assert.ok(!/BEFORE-WATCHING/.test(await get('/?agent=cursor')), 'what was already there stays off')

    await appendFile(file, cursorLines('AFTER-WATCHING'), 'utf8')
    const board = await get('/?agent=cursor')
    assert.match(board, /Anysphere · Cursor/, 'the vendor is named')
    // Every figure this source cannot record must say so rather than show 0.
    assert.match(board, /该来源不记录的项目/)
    assert.match(board, /不为记录写入时间戳/)
    assert.match(board, /不报告用量/)
    assert.match(board, /按调用次数排序/, 'so the ranking falls back to counts')

    const one = await get('/?agent=cursor&s=sess')
    assert.match(one, /AFTER-WATCHING/, 'the new records show')
    // The whole point: with every record at time zero, a timestamp filter
    // would have discarded the session entire.
    assert.ok(!/BEFORE-WATCHING/.test(one), 'and the earlier ones still do not')
  } finally { server.close(); server.closeAllConnections() }
})

test('a fixture that forgets a source reads nothing, not the real machine', async () => {
  // The failure this shape exists to prevent: a test names its own transcript
  // root, forgets the others, and quietly reads whatever the developer has
  // installed. Building on noSources() makes the omission read as absent.
  const anchor = await mkdtemp(join(tmpdir(), 'agent-ledger-src-'))
  const { noSources: base, defaultSources, installedAgents } = await import('../lib/transcript.js')

  const empty = base(anchor)
  assert.deepEqual(Object.keys(empty).sort(), ['claude', 'codex', 'cursor', 'workbuddy'],
    'every source has a slot, so a new one cannot be silently missed')
  assert.deepEqual(installedAgents(empty), [], 'and nothing on the machine is visible through it')

  const real = defaultSources()
  assert.ok(real.claude.endsWith('/projects'), 'production still points at the real install')
  assert.notDeepEqual(real, empty)
})
