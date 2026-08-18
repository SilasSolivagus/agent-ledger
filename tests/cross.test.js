/**
 * The one view a per-vendor board cannot give you.
 *
 * Every tab on the board answers "what is this agent doing". Putting two
 * agents on one scale needs a place that is not either of them, and that view
 * used to be reachable only by restarting the server with `--history` — which
 * hid the most distinctive thing this product knows how to say behind a flag
 * nobody would guess at.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLedgerServer } from '../lib/serve.js'
import { noSources } from '../lib/transcript.js'

const T = n => `2026-08-17T10:0${n}:00.000Z`
const ms = n => Date.parse(T(n))

function claudeTurn(said, minute) {
  return [
    JSON.stringify({
      type: 'user', timestamp: T(minute), cwd: '/tmp/x-proj', message: { content: said },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: T(minute), message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [
          { type: 'text', text: `answering ${said}` },
          { type: 'tool_use', id: `t${minute}`, name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user', timestamp: T(minute + 1),
      message: { content: [{ type: 'tool_result', tool_use_id: `t${minute}`, content: 'ok' }] },
    }),
    '',
  ].join('\n')
}

const CODEX = [
  { timestamp: T(4), type: 'session_meta', payload: { id: 'cx', cwd: '/tmp/x-cx', cli_version: '0.1' } },
  { timestamp: T(4), type: 'turn_context', payload: { model: 'gpt-5.4' } },
  { timestamp: T(4), type: 'event_msg', payload: { type: 'user_message', message: 'CODEX-WORK' } },
  { timestamp: T(4), type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CODEX-ANSWERS' }] } },
  { timestamp: T(5), type: 'event_msg', payload: {
    type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 8, cached_input_tokens: 0 } } } },
].map(r => JSON.stringify(r)).join('\n')

/** A board watching from before both agents did their work. */
async function watching({ both = true } = {}) {
  const claude = await mkdtemp(join(tmpdir(), 'agent-ledger-x-c-'))
  const codex = await mkdtemp(join(tmpdir(), 'agent-ledger-x-x-'))
  const server = createLedgerServer({
    port: 0, limit: 40, roots: { ...noSources(codex), claude, codex },
  }, ms(1))
  const base = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  await writeFile(join(claude, 'session-cc.jsonl'), claudeTurn('CLAUDE-WORK', 2), 'utf8')
  if (both) await writeFile(join(codex, 'rollout-2026-08-17T10-04-00-cx.jsonl'), `${CODEX}\n`, 'utf8')
  const get = async path => (await fetch(`${base}${path}`)).text()
  const stop = () => { server.close(); server.closeAllConnections() }
  return { get, stop }
}

test('two vendors on the board earn a tab that puts them on one scale', async () => {
  const { get, stop } = await watching()
  try {
    const board = await get('/?agent=claude-code')
    assert.match(board, /href="\?agent=all"/, 'the tab is one click from any vendor')
    assert.match(board, /跨厂商/)

    const cross = await get('/?agent=all')
    assert.match(cross, /两家各自长什么样/, 'and it lands on the comparison')
    assert.match(cross, /不是排名/, 'which still says out loud what it refuses to claim')
  } finally { stop() }
})

test('one vendor alone gets no comparison tab, because there is nothing to compare', async () => {
  const { get, stop } = await watching({ both: false })
  try {
    assert.ok(!/href="\?agent=all"/.test(await get('/?agent=claude-code')))
  } finally { stop() }
})

test('asking for the comparison with only one vendor says what is missing', async () => {
  // Reaching it by URL rather than by tab must not produce an empty panel.
  const { get, stop } = await watching({ both: false })
  try {
    assert.match(await get('/?agent=all'), /还没有两家可比/)
  } finally { stop() }
})

test('the comparison inherits the window, so it can be asked about today', async () => {
  const { get, stop } = await watching()
  try {
    const cross = await get('/?agent=all&range=all')
    assert.match(cross, /两家各自长什么样/)
    assert.match(cross, /class="ranges"[\s\S]*range=all[^>]*class="on"|class="on">全部/,
      'and the picker shows which window it is answering for')
  } finally { stop() }
})

test('the cross tab lists both vendors sessions, each opening under its own tab', async () => {
  const { get, stop } = await watching()
  try {
    const cross = await get('/?agent=all')
    assert.match(cross, /\?agent=claude-code&amp;s=session-cc/, 'the Claude session opens under Claude')
    assert.match(cross, /\?agent=codex&amp;s=/, 'and the Codex one under Codex')
  } finally { stop() }
})

test('the bare board still lands on whichever vendor is busy, not on the comparison', async () => {
  // `?agent=all` has to be something you chose. Making it the default meant
  // opening the board and being shown a comparison instead of the work.
  const { get, stop } = await watching()
  try {
    const body = await get('/')
    assert.ok(!/class="atab on cross"/.test(body), 'the cross tab is not selected by default')
    assert.match(body, /class="atab on"[\s\S]*?Anthropic/, 'the busiest vendor is')
  } finally { stop() }
})

test('the comparison keeps every disclaimer it was written with', async () => {
  // The numbers without the caveats read as a scoreboard, which the data
  // cannot support: a transcript records what was done, never how well.
  const { get, stop } = await watching()
  try {
    const body = await get('/?agent=all')
    assert.match(body, /不是排名/)
    assert.match(body, /答得好不好/, 'it must say out loud what is unmeasurable')
    assert.match(body, /只看，别当结论/, 'the task-bound group must be marked as such')
  } finally { stop() }
})

test('a source that records no steps does not count as one of the two', async () => {
  // Two vendor names is not two comparable things. Every figure in the panel
  // is per step, and WorkBuddy keeps only session-level rows. Counting it
  // would put a tab on screen whose contents are then blank — which is the
  // exact failure this product refuses everywhere else.
  const { get, stop } = await watching({ both: false })
  try {
    const board = await get('/?agent=claude-code')
    assert.ok(!/href="\?agent=all"/.test(board), 'no tab when only one source has steps')
    const cross = await get('/?agent=all')
    assert.match(cross, /还没有两家可比/)
    assert.match(cross, /报告了步/, 'and it names what the bar actually is')
  } finally { stop() }
})
