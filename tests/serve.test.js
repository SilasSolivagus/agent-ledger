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
    roots: { claude: root, codex: join(root, 'no-codex-here') },
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

test('the index lists every session and links to it', async () => {
  const { base, stop } = await fixture()
  try {
    const { status, body } = await get(base, '/')
    assert.equal(status, 200)
    assert.match(body, /href="\/s\/session-abc123"/, 'the session must be openable')
    assert.match(body, /proj-alpha/, 'where it ran is part of finding it again')
    assert.match(body, /本机共 1 个会话记录/)
    assert.ok(!/<script/i.test(body), 'no script')
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(body), 'no remote assets')
  } finally { stop() }
})

test('a session page carries the trajectory and the line-by-line ledger', async () => {
  const { base, stop } = await fixture()
  try {
    const { status, body } = await get(base, '/s/session-abc123')
    assert.equal(status, 200)
    assert.match(body, /ONE HAIRLINE = ONE STEP/, 'the trajectory')
    assert.match(body, /DELETE-THE-DEAD-LOOP/, 'what the person said')
    assert.match(body, /grep -rn while src/, 'what the tool was asked to do')
    assert.match(body, /src\/loop\.ts:42/, 'what came back')
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

test('listTranscripts stats without reading, and keeps the newest first', async () => {
  const { root, stop } = await fixture()
  stop()
  await writeFile(join(root, 'session-newer.jsonl'), transcript('later'), 'utf8')
  const files = await listTranscripts(40, { claude: root, codex: join(root, 'none') })
  assert.equal(files.length, 2)
  assert.equal(files[0].id, 'session-newer', 'newest first')
  assert.ok(files.every(f => f.agent === 'claude-code' && f.mtimeMs > 0))
})
