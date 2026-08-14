/**
 * Codex writes the same five facts as Claude Code in a different envelope, and
 * the differences are exactly where a reader gets silently short-changed:
 * `session_meta` and `turn_context` carry no inner `type`, the harness injects
 * `<environment_context>` blocks that are not turns, `apply_patch` sends a raw
 * body instead of JSON arguments, and text blocks are `output_text` rather
 * than `text`. Each of those is one assertion below.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readCodexSessions } from '../lib/transcript.js'

const at = n => `2026-08-14T10:0${n}:00.000Z`

const ROLLOUT = [
  { timestamp: at(0), type: 'session_meta', payload: {
    id: 'roll-1', cwd: '/tmp/proj-beta', cli_version: '0.137.0', originator: 'Codex Desktop',
    git: { branch: 'feat/ledger', commit_hash: 'abc' },
  } },
  { timestamp: at(0), type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.4', cwd: '/tmp/proj-beta' } },
  // Injected by the harness on every turn — not something a person typed.
  { timestamp: at(0), type: 'response_item', payload: {
    type: 'message', role: 'developer',
    content: [{ type: 'input_text', text: '<permissions instructions> ...' }],
  } },
  { timestamp: at(1), type: 'response_item', payload: {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '<environment_context><cwd>/tmp/proj-beta</cwd></environment_context>' }],
  } },
  // Written by the harness, sent as role:user. Untagged, so only the event
  // stream can tell it apart from a person typing.
  { timestamp: at(1), type: 'response_item', payload: {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/proj-beta' }],
  } },
  { timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'FIX-THE-FLAKY-TEST', images: [] } },
  { timestamp: at(1), type: 'response_item', payload: {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'FIX-THE-FLAKY-TEST' }],
  } },
  { timestamp: at(2), type: 'response_item', payload: {
    type: 'reasoning', summary: [], encrypted_content: 'gAAAA...',
  } },
  { timestamp: at(2), type: 'response_item', payload: {
    type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: '我先看一眼那个测试' }],
  } },
  { timestamp: at(3), type: 'response_item', payload: {
    type: 'function_call', name: 'exec_command', call_id: 'c1',
    arguments: JSON.stringify({ cmd: 'pytest -k flaky', workdir: '/tmp/proj-beta', yield_time_ms: 1000 }),
  } },
  { timestamp: at(3), type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'c1',
    output: 'Process exited with code 1\nOutput:\n1 failed, 12 passed',
  } },
  { timestamp: at(4), type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', status: 'completed',
    input: '*** Begin Patch\n*** Update File: tests/test_flaky.py\n+    time.sleep(0.1)\n',
  } },
  { timestamp: at(4), type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'c2',
    output: JSON.stringify({ output: 'Success. Updated the following files:\nM tests/test_flaky.py\n', metadata: { exit_code: 0 } }),
  } },
  // OpenAI's input_tokens INCLUDES cached_input_tokens; 8640 total, 8000 of it
  // served from cache, so only 640 was charged fresh.
  { timestamp: at(5), type: 'event_msg', payload: {
    type: 'token_count',
    info: { last_token_usage: { input_tokens: 8640, output_tokens: 210, cached_input_tokens: 8000, total_tokens: 8850 } },
  } },
  // A session-start frame carries no usage; it must not become a step.
  { timestamp: at(5), type: 'event_msg', payload: { type: 'token_count', info: null } },
].map(r => JSON.stringify(r)).join('\n')

async function readOne() {
  const root = await mkdtemp(join(tmpdir(), 'agent-ledger-codex-'))
  await writeFile(join(root, 'rollout-2026-08-14T10-00-00-roll-1.jsonl'), `${ROLLOUT}\n`, 'utf8')
  const sessions = await readCodexSessions(40, root)
  assert.equal(sessions.length, 1)
  return sessions[0]
}

test('a rollout yields one step with its usage, and no step for the empty frame', async () => {
  const session = await readOne()
  assert.equal(session.steps.length, 1, 'the info:null frame must not become a step')
  // 8640 reported, 8000 of it cached → 640 fresh. Reporting the raw 8640 would
  // count the cached context twice once cacheRead is added beside it, and put
  // Codex's cache hit rate on a different scale from Claude Code's.
  assert.deepEqual(session.steps[0].usage, { input: 640, output: 210, cacheRead: 8000, cacheWrite: 0 })
  assert.equal(session.steps[0].calls.length, 2, 'apply_patch counts as a call, not just exec_command')
})

test('session_meta and turn_context are read despite carrying no inner type', async () => {
  const session = await readOne()
  assert.equal(session.steps[0].model, 'gpt-5.4', 'the model lives on turn_context')
  assert.equal(session.cwd, '/tmp/proj-beta')
  assert.equal(session.agentVersion, '0.137.0')
  assert.equal(session.gitBranch, 'feat/ledger')
})

test('the ledger reads as one turn: what was asked, done, and returned', async () => {
  const { events } = await readOne()
  assert.deepEqual(
    events.map(e => e.kind),
    ['user', 'assistant', 'tool', 'tool'],
    'reasoning is encrypted and always summary-less, so it earns no row',
  )
  assert.equal(events[0].text, 'FIX-THE-FLAKY-TEST')
  assert.ok(events.every(e => e.turn === 1), 'injected blocks must not open extra turns')
  assert.equal(events[1].text, '我先看一眼那个测试', 'output_text is text under another name')
})

test('both tool dialects are summarised and matched to their output', async () => {
  const { events } = await readOne()
  const [exec, patch] = events.filter(e => e.kind === 'tool')
  assert.equal(exec.tool, 'exec_command')
  assert.match(exec.text, /cmd: pytest -k flaky/, 'Codex calls it cmd, not command')
  assert.match(exec.result, /1 failed, 12 passed/)
  assert.equal(patch.tool, 'apply_patch')
  assert.match(patch.text, /\*\*\* Begin Patch/, 'a raw body is summarised by its first line')
  assert.match(patch.result, /Success\. Updated/, 'a JSON-wrapped result is unwrapped')
})

test('only what a person typed opens a turn', async () => {
  const { events } = await readOne()
  // Three role:user records reach the model here — an environment block, an
  // AGENTS.md preamble, and the real question — and exactly one is a turn.
  assert.equal(events.filter(e => e.kind === 'user').length, 1)
  assert.ok(!events.some(e => /environment_context|permissions instructions|AGENTS\.md/.test(e.text)))
})
