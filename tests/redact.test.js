/**
 * Redaction is the one feature here where being almost right is worse than
 * being absent: it tells you the page is safe, and then you send it. So it is
 * not tested by checking that a few fields were blanked. Every field in both
 * dialects that can carry a word of yours gets a unique marker planted in it,
 * the whole thing is rendered through the real server, and the assertion is
 * that not one marker survives anywhere in the bytes.
 *
 * When a new content field appears in either transcript format, add a marker
 * here first. The test failing is the point.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLedgerServer } from '../lib/serve.js'
import { redactSession } from '../lib/redact.js'
import { readClaudeSessions } from '../lib/transcript.js'
import { noSources } from '../lib/transcript.js'

/** Every marker planted below. None may appear in a redacted page. */
const MARKERS = [
  'LEAK-user-said', 'LEAK-model-said', 'LEAK-the-command', 'LEAK-the-result',
  'LEAK-working-dir', 'LEAK-branch-name',
  'LEAK-codex-user', 'LEAK-codex-model', 'LEAK-codex-cmd', 'LEAK-codex-output',
  'LEAK-codex-cwd', 'LEAK-codex-branch', 'LEAK-codex-patch',
]

const CLAUDE = [
  { type: 'user', timestamp: '2026-08-14T10:00:00.000Z', cwd: '/Users/LEAK-working-dir/x',
    gitBranch: 'LEAK-branch-name', version: '2.0.0', message: { content: 'LEAK-user-said' } },
  { type: 'assistant', timestamp: '2026-08-14T10:00:02.000Z', message: {
    model: 'claude-opus-5',
    usage: { input_tokens: 1200, output_tokens: 88, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 },
    content: [
      { type: 'text', text: 'LEAK-model-said' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'LEAK-the-command' } },
    ],
  } },
  { type: 'user', timestamp: '2026-08-14T10:00:03.000Z', message: {
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'LEAK-the-result' }],
  } },
].map(r => JSON.stringify(r)).join('\n')

const CODEX = [
  { timestamp: '2026-08-14T11:00:00.000Z', type: 'session_meta', payload: {
    id: 'r1', cwd: '/Users/LEAK-codex-cwd/y', cli_version: '0.137.0',
    git: { branch: 'LEAK-codex-branch' },
  } },
  { timestamp: '2026-08-14T11:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } },
  { timestamp: '2026-08-14T11:00:01.000Z', type: 'event_msg', payload: {
    type: 'user_message', message: 'LEAK-codex-user',
  } },
  { timestamp: '2026-08-14T11:00:02.000Z', type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'LEAK-codex-model' }],
  } },
  { timestamp: '2026-08-14T11:00:03.000Z', type: 'response_item', payload: {
    type: 'function_call', name: 'exec_command', call_id: 'c1',
    arguments: JSON.stringify({ cmd: 'LEAK-codex-cmd' }),
  } },
  { timestamp: '2026-08-14T11:00:03.000Z', type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'c1', output: 'LEAK-codex-output',
  } },
  { timestamp: '2026-08-14T11:00:04.000Z', type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: 'LEAK-codex-patch\n+x\n',
  } },
  { timestamp: '2026-08-14T11:00:05.000Z', type: 'event_msg', payload: {
    type: 'token_count',
    info: { last_token_usage: { input_tokens: 900, output_tokens: 40, cached_input_tokens: 400 } },
  } },
].map(r => JSON.stringify(r)).join('\n')

async function planted() {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-r1-'))
  const codex = await mkdtemp(join(tmpdir(), 'agent-ledger-r2-'))
  await writeFile(join(claude, 'session-leak.jsonl'), `${CLAUDE}\n`, 'utf8')
  await writeFile(join(codex, 'rollout-2026-08-14T11-00-00-leak.jsonl'), `${CODEX}\n`, 'utf8')
  return { claude, codex }
}

async function pages(roots, redact) {
  const server = createLedgerServer({
    port: 0, limit: 40, redact, roots: { ...noSources(roots.codex), ...roots },
  })
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  try {
    const out = {}
    // The board's default window starts when the server does, and this
    // fixture was planted before that — so the widest window is what puts the
    // planted markers in front of the redactor at all.
    const paths = { '/': '/?agent=claude-code&range=all',
      '/s/session-leak': '/s/session-leak',
      '/s/2026-08-14T11-00-00-leak': '/s/2026-08-14T11-00-00-leak' }
    for (const [key, path] of Object.entries(paths)) {
      out[key] = await (await fetch(`${base}${path}`)).text()
    }
    return out
  } finally { server.close(); server.closeAllConnections() }
}

test('without --redact the markers are all there — the fixture really does carry them', async () => {
  const roots = await planted()
  const out = await pages(roots, false)
  const all = Object.values(out).join('')
  for (const marker of MARKERS) {
    assert.ok(all.includes(marker), `${marker} should be present unredacted — otherwise the leak test proves nothing`)
  }
})

test('with --redact not one marker survives, on any page', async () => {
  const roots = await planted()
  const out = await pages(roots, true)
  for (const [path, body] of Object.entries(out)) {
    for (const marker of MARKERS) {
      assert.ok(!body.includes(marker), `${marker} leaked into ${path}`)
    }
  }
})

test('redaction keeps the shape: turns, tools, counts, timings', async () => {
  const roots = await planted()
  const out = await pages(roots, true)
  const session = out['/s/session-leak']
  assert.match(session, /class="op real"/, 'the overview strip survives, bars and all')
  assert.match(session, /1,000 ms/, 'measured durations are facts, not content')
  assert.match(session, /Bash/, 'tool names are kept on purpose — they are the substance')
  assert.match(session, /第 1 轮/, 'turn structure survives')
  assert.ok(!/<pre>/.test(session), 'no details panel, because there is nothing left to reveal')
  assert.match(session, /··· \d+ 字/, 'how much was said is kept, what was said is not')

  // Every figure must be identical with and without redaction. If hiding the
  // words moved a number, the number was reading the words.
  const open = await pages(roots, false)
  const figures = html => [...html.matchAll(/<div class="n">([^<]*)<\/div>/g)].map(m => m[1])
  assert.deepEqual(figures(out['/']), figures(open['/']), 'redaction must not move a single figure')
  assert.ok(figures(out['/']).length > 0, 'and there must be figures to compare')
})

test('redactSession drops the fields that identify you', async () => {
  const { claude } = await planted()
  const [raw] = await readClaudeSessions(40, claude)
  assert.equal(raw.cwd, '/Users/LEAK-working-dir/x')
  assert.equal(raw.gitBranch, 'LEAK-branch-name')

  const safe = redactSession(raw)
  assert.equal(safe.cwd, undefined, 'a path carries your account name and your projects')
  assert.equal(safe.gitBranch, undefined, 'a branch name is often a ticket title')
  assert.equal(safe.steps.length, raw.steps.length, 'steps are counts and timings, kept whole')
  assert.equal(safe.events.length, raw.events.length, 'every row still exists; only its words are gone')
  assert.equal(safe.agentVersion, '2.0.0')
})
