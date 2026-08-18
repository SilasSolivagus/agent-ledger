/**
 * The server's job is narrow: turn a transcript on disk into a page, keep a
 * parsed copy only while it is still true, and never let an id from a URL
 * reach the filesystem. Those three are what these tests hold.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLedgerServer } from '../lib/serve.js'
import { listTranscripts } from '../lib/transcript.js'
import { noSources } from '../lib/transcript.js'

/** A Claude-shaped transcript: one turn, one step, one tool call with a result. */
function transcript(said) {
  return [
    JSON.stringify({
      type: 'user', timestamp: '2026-08-14T10:00:00.000Z', cwd: '/tmp/proj-alpha',
      gitBranch: 'main', version: '2.0.0', message: { content: said },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-08-14T10:00:02.000Z',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1200, output_tokens: 88,
          cache_read_input_tokens: 9000, cache_creation_input_tokens: 300,
        },
        content: [
          { type: 'text', text: '我看一下' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -rn while src' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user', timestamp: '2026-08-14T10:00:03.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'src/loop.ts:42' }] },
    }),
    '',
  ].join('\n')
}

/** A fixture root with one session in it, plus a server pointed at it. */
async function fixture(said = 'DELETE-THE-DEAD-LOOP') {
  const root = await mkdtemp(join(tmpdir(), 'agent-ledger-'))
  const file = join(root, 'session-abc123.jsonl')
  await writeFile(file, transcript(said), 'utf8')
  const server = createLedgerServer({
    port: 0, limit: 40,
    roots: { ...noSources(root), claude: root },
  })
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  // fetch keeps its sockets alive, and close() waits on them; without dropping
  // the connections the test process never exits.
  const stop = () => { server.close(); server.closeAllConnections() }
  return { root, file, server, base, stop }
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: await res.text() }
}

test('the board with the window open lists every session and links to it', async () => {
  const { base, stop } = await fixture()
  try {
    const { status, body } = await get(base, '/?agent=claude-code&range=all')
    assert.equal(status, 200)
    assert.match(body, /\?agent=claude-code&amp;s=session-abc123/, 'the session must be openable')
    assert.match(body, /proj-alpha/, 'where it ran is part of finding it again')
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(body), 'no remote assets')
  } finally { stop() }
})

test('a session page is a waterfall: one row per operation, its own time beside it', async () => {
  const { base, stop } = await fixture()
  try {
    const { status, body } = await get(base, '/s/session-abc123')
    assert.equal(status, 200)
    assert.match(body, /DELETE-THE-DEAD-LOOP/, 'what the person said')
    assert.match(body, /grep -rn while src/, 'what the tool was asked to do')
    assert.match(body, /src\/loop\.ts:42/, 'what came back')

    // The tool call and its result are one second apart in the fixture, and
    // that interval is measured rather than inferred — so the row must say
    // 1,000 ms and its bar must be the filled kind.
    assert.match(body, /1,000 ms/, 'the measured tool duration')
    assert.match(body, /class="op real"/, 'a measured operation is filled in the overview')
    assert.match(body, /<details><summary class="line">/, 'rows expand to the untruncated original')
    // The page must distinguish the two kinds of duration out loud. A bar
    // length that silently mixed a measured interval with an inferred one
    // would draw the same seconds twice.
    assert.match(body, /实测/, 'the page names measured durations')
    assert.match(body, /1 秒 = \d+ px/, 'and states the scale, so a bar length means something')
  } finally { stop() }
})

test('the timeline states its scale and offers fixed zoom levels', async () => {
  const { base, stop } = await fixture()
  try {
    for (const [zoom, px] of [['wide', 4], ['mid', 24], ['close', 120]]) {
      const { body } = await get(base, `/s/session-abc123?zoom=${zoom}`)
      // A stated pixels-per-second is what makes a bar comparable to any
      // other bar on the page, in any turn or any session.
      assert.match(body, new RegExp(`1 秒 = ${px} px`), `${zoom} names its scale`)
      assert.match(body, new RegExp(`<a href="\\?zoom=${zoom}&amp;idle=off" class="on">`))
    }
    const bogus = await get(base, '/s/session-abc123?zoom=../../etc')
    assert.match(bogus.body, /1 秒 = 24 px/, 'an unknown zoom falls back')

    // Clicking a block on the axis goes to the row it stands for; without
    // script that is an anchor, and the row it lands on is the target.
    const { body } = await get(base, '/s/session-abc123')
    assert.match(body, /<a href="#r2"><rect/, 'every block links to its record')
    assert.match(body, /<tr id="r2"/, 'and the record is there to land on')
  } finally { stop() }
})

test('a rewritten transcript is re-read, not served from cache', async () => {
  const { file, base, stop } = await fixture('FIRST-THING-SAID')
  try {
    const first = await get(base, '/s/session-abc123')
    assert.match(first.body, /FIRST-THING-SAID/)
    // A live session is appended to constantly; a cache that cannot see that
    // makes the resident view worse than the file it replaced.
    await writeFile(file, transcript('SECOND-THING-SAID'), 'utf8')
    const second = await get(base, '/s/session-abc123')
    assert.match(second.body, /SECOND-THING-SAID/)
    assert.ok(!/FIRST-THING-SAID/.test(second.body), 'the stale copy must be gone')
  } finally { stop() }
})

test('an unknown session is a 404, not a crash', async () => {
  const { base, stop } = await fixture()
  try {
    assert.equal((await get(base, '/s/nope')).status, 404)
    assert.equal((await get(base, '/whatever')).status, 404)
  } finally { stop() }
})

test('an id from a URL never becomes a path', async () => {
  const { base, stop } = await fixture()
  try {
    for (const attempt of ['/s/..%2F..%2F..%2Fetc%2Fpasswd', '/s/%2Fetc%2Fpasswd', '/s/../../../etc/passwd']) {
      const { status, body } = await get(base, attempt)
      assert.equal(status, 404, `${attempt} must not resolve`)
      assert.ok(!/root:/.test(body), 'nothing off-list may be read')
    }
  } finally { stop() }
})

test('a quiet agent keeps its own board when a busy one floods the machine', async () => {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-c-'))
  const codex = await mkdtemp(join(tmpdir(), 'agent-ledger-x-'))
  // One old Codex rollout against three newer Claude sessions, with room for
  // two per agent: by mtime alone the Codex one would be pushed off.
  await writeFile(join(codex, 'rollout-2026-01-01T00-00-00-old.jsonl'), [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } },
    } }),
  ].join('\n'), 'utf8')
  for (const n of ['a', 'b', 'c']) {
    await writeFile(join(claude, `session-${n}.jsonl`), transcript(`CLAUDE-${n}`), 'utf8')
  }
  const server = createLedgerServer({
    port: 0, limit: 2, roots: { ...noSources(codex), claude, codex },
  })
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  try {
    // Per-vendor boards are what make this structural rather than a budget
    // fight: the quiet agent cannot be pushed off, because it has its own page.
    const quiet = await get(base, '/?agent=codex&range=all')
    assert.match(quiet.body, /2026-01-01T00-00-00-old/, 'the quiet agent must survive')
    const busy = await get(base, '/?agent=claude-code&range=all')
    assert.equal(
      (busy.body.match(/&amp;s=session-/g) ?? []).length, 2,
      'the busy one is capped at the per-agent limit, not unbounded',
    )
    assert.match(busy.body, /另有 1 个会话没读进来/, 'and the cap is not silent')
  } finally { server.close(); server.closeAllConnections() }
})

test('listTranscripts stats without reading, and keeps the newest first', async () => {
  const { root, stop } = await fixture()
  stop()
  await writeFile(join(root, 'session-newer.jsonl'), transcript('later'), 'utf8')
  const files = await listTranscripts(40, { ...noSources(root), claude: root })
  assert.equal(files.length, 2)
  assert.equal(files[0].id, 'session-newer', 'newest first')
  assert.ok(files.every(f => f.agent === 'claude-code' && f.mtimeMs > 0))
})

test('the board switches between the agents this machine actually has', async () => {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-s1-'))
  const codex = await mkdtemp(join(tmpdir(), 'agent-ledger-s2-'))
  await writeFile(join(claude, 'session-only-claude.jsonl'), transcript('CLAUDE-SIDE'), 'utf8')
  await writeFile(join(codex, 'rollout-2026-01-01T00-00-00-only-codex.jsonl'), [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } },
    } }),
  ].join('\n'), 'utf8')
  const server = createLedgerServer({
    port: 0, limit: 40, roots: { ...noSources(codex), claude, codex },
  })
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  try {
    const both = await get(base, '/?range=all')
    assert.match(both.body, /href="\?agent=claude-code&amp;range=all"/, 'a tab per agent present')
    assert.match(both.body, /href="\?agent=codex&amp;range=all"/)

    const only = await get(base, '/?agent=codex&range=all')
    assert.match(only.body, /only-codex/, 'the chosen agent is listed')
    assert.ok(!/only-claude/.test(only.body), 'and the other one is not')

    // An agent this machine has no transcripts from is not a board.
    const bogus = await get(base, '/?agent=gemini&range=all')
    assert.ok(!/agent=gemini" class/.test(bogus.body), 'an unknown agent gets no tab of its own')
  } finally { server.close(); server.closeAllConnections() }
})

test('the fit scale says out loud that its lengths do not travel', async () => {
  const { base, stop } = await fixture()
  try {
    const fitted = await get(base, '/s/session-abc123?zoom=fit')
    assert.match(fitted.body, /铺满/, 'the scale names itself')
    assert.match(fitted.body, /1 秒 ≈ [\d.]+ px/, 'and reports what it worked out to')
    // Every other scale is a promise that a bar means the same thing anywhere
    // on the page. This one is not, and a reader has to be told.
    assert.match(fitted.body, /换个会话就不能比/, 'and states the limit it carries')
    assert.match(fitted.body, /class="tl fit"/)

    const fixed = await get(base, '/s/session-abc123?zoom=mid')
    assert.match(fixed.body, /1 秒 = 24 px/)
    assert.ok(!/换个会话就不能比/.test(fixed.body), 'a fixed scale carries no such caveat')
  } finally { stop() }
})
