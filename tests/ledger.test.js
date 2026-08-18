/**
 * The tests that matter here are the proxy's: it stands between a person and
 * the model they are paying for, so "bytes through unchanged" and "our bug
 * never becomes their error" have to be verified, not asserted in a comment.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createServer } from 'node:http'

import { startProxy } from '../lib/proxy.js'
import { parseStep, sseEvents, estimateTokens } from '../lib/parse.js'
import { summarise, median, averageStatic } from '../lib/summary.js'
import { renderDashboard, chooseUnit } from '../lib/render.js'

/** A stand-in upstream that streams a known Anthropic-shaped response. */
function fakeUpstream(body, { status = 200, headers = {} } = {}) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'text/event-stream', ...headers })
      res.end(body)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function freePort() {
  return new Promise(resolve => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

const ANTHROPIC_STREAM = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":1,"cache_read_input_tokens":9000,"cache_creation_input_tokens":300}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Bash","input":{"command":"ls"}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":88}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

test('sseEvents keeps JSON payloads and drops the rest', () => {
  const events = sseEvents('data: {"a":1}\ndata: [DONE]\n: keep-alive\ndata: not json\n')
  assert.equal(events.length, 1)
  assert.equal(events[0].a, 1)
})

test('estimateTokens uses the four-character heuristic', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
})

test('an Anthropic step reports static payload, usage and tool calls', () => {
  const step = parseStep({
    wire: 'anthropic-messages',
    requestBody: {
      model: 'claude-opus-5',
      system: [{ text: 'x'.repeat(400) }, { text: 'y'.repeat(800) }],
      tools: [{ name: 'Bash', description: 'z'.repeat(600) }],
      messages: [{ role: 'user' }, { role: 'assistant' }],
    },
    startedAt: 1000, firstByteAt: 1350, endedAt: 3000,
    responseText: ANTHROPIC_STREAM, status: 200, index: 0,
  })
  assert.equal(step.staticTokens.prompt, 300)
  assert.ok(step.staticTokens.tools > 100)
  assert.equal(step.toolCount, 1)
  assert.equal(step.historyLength, 2)
  assert.equal(step.ttftMs, 350)
  assert.equal(step.durationMs, 2000)
  assert.deepEqual(step.usage, { input: 1200, output: 88, cacheRead: 9000, cacheWrite: 300 })
  assert.deepEqual(step.calls.map(c => c.name), ['Bash'])
})

test('a Codex step counts the leading developer message as static payload', () => {
  // Codex reissues a developer preamble on every request; counting it as
  // conversation would understate what each turn actually carries.
  const step = parseStep({
    wire: 'openai-responses',
    requestBody: {
      model: 'gpt-5.4',
      instructions: 'i'.repeat(400),
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'd'.repeat(2000) }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
      tools: [{ name: 'exec_command' }, { name: 'apply_patch' }],
    },
    startedAt: 0, endedAt: 100,
    responseText: 'data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":7}}}\n',
    status: 200, index: 3,
  })
  assert.ok(step.staticTokens.prompt > 500, 'developer preamble must be in the static payload')
  assert.equal(step.historyLength, 1, 'only the real user turn counts as history')
  assert.equal(step.toolCount, 2)
  assert.deepEqual(step.usage, { input: 50, output: 7, cacheRead: 0, cacheWrite: 0 })
})

test('a truncated stream still yields a step', () => {
  const step = parseStep({
    wire: 'anthropic-messages', requestBody: { model: 'm' },
    startedAt: 0, endedAt: 10, responseText: 'event: message_start\ndata: {"type":"mes',
    status: 200, index: 0,
  })
  assert.equal(step.model, 'm')
  assert.equal(step.usage, undefined)
  assert.deepEqual(step.calls, [])
})

test('an HTTP error is recorded rather than dropped', () => {
  const step = parseStep({
    wire: 'anthropic-messages', requestBody: {}, startedAt: 0, endedAt: 5,
    responseText: '', status: 529, index: 0,
  })
  assert.equal(step.error, 'HTTP 529')
})

test('the proxy passes bytes through unchanged', async () => {
  const { server: up, port: upPort } = await fakeUpstream(ANTHROPIC_STREAM)
  const port = await freePort()
  const steps = []
  const proxy = startProxy({
    port, upstream: `http://127.0.0.1:${upPort}`, onStep: s => steps.push(s),
  }, parseStep)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', system: 'hi', tools: [], messages: [] }),
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.equal(text, ANTHROPIC_STREAM, 'the client must receive the upstream body byte for byte')
    // The sink runs after the stream closes; give the tee a turn to finish.
    await new Promise(r => setTimeout(r, 60))
    assert.equal(steps.length, 1)
    assert.equal(steps[0].usage.cacheRead, 9000)
  } finally {
    proxy.close(); up.close()
  }
})

test('a throwing sink cannot break the response', async () => {
  const { server: up, port: upPort } = await fakeUpstream(ANTHROPIC_STREAM)
  const port = await freePort()
  const proxy = startProxy({
    port, upstream: `http://127.0.0.1:${upPort}`,
    onStep: () => { throw new Error('sink exploded') },
  }, parseStep)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'm' }),
    })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), ANTHROPIC_STREAM)
  } finally {
    proxy.close(); up.close()
  }
})

test('an unreachable upstream reports a gateway error, not a hang', async () => {
  const port = await freePort()
  const dead = await freePort()
  const proxy = startProxy({ port, upstream: `http://127.0.0.1:${dead}`, onStep: () => {} }, parseStep)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 502)
  } finally {
    proxy.close()
  }
})

test('summarise folds usage, cache rate and tool counts', () => {
  const step = (over = {}) => ({
    index: 0, startedAt: 0, durationMs: 1000, ttftMs: 300, model: 'm', wire: 'anthropic-messages',
    staticTokens: { prompt: 100, tools: 900 }, toolCount: 3, historyLength: 1,
    usage: { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0 },
    calls: [{ name: 'Bash', argBytes: 5 }], ...over,
  })
  const totals = summarise([{ id: 'a', agent: 'claude-code', startedAt: 0, steps: [step(), step()] }])
  assert.equal(totals.steps, 2)
  assert.equal(totals.toolCalls, 2)
  assert.equal(totals.input, 2000)
  assert.ok(Math.abs(totals.cacheHitRate - 0.9) < 1e-9, 'cache rate is reads over reads+input')
  assert.equal(totals.medianTtftMs, 300)
  assert.deepEqual(totals.topTools, [{ name: 'Bash', calls: 2 }])
})

test('empty input summarises to zeroes, never NaN', () => {
  const totals = summarise([])
  assert.equal(totals.cacheHitRate, 0)
  assert.equal(totals.medianTtftMs, 0)
  assert.equal(averageStatic([]).total, 0)
})

test('median handles even and odd samples', () => {
  assert.equal(median([]), 0)
  assert.equal(median([5]), 5)
  assert.equal(median([1, 3]), 2)
  assert.equal(median([5, 1, 3]), 3)
})

test('chooseUnit stays round and bounded', () => {
  for (const max of [1, 90, 997, 48571, 1_100_000]) {
    const unit = chooseUnit(max)
    assert.ok(max / unit <= 60)
  }
})

const ONE_SESSION = {
  id: 'abcdef12', agent: 'claude-code', startedAt: 0,
  steps: [{
    index: 0, startedAt: 0, durationMs: 900, ttftMs: 200, model: 'm', wire: 'anthropic-messages',
    staticTokens: { prompt: 2893, tools: 45678 }, toolCount: 80, historyLength: 2,
    usage: { input: 1200, output: 88, cacheRead: 9000, cacheWrite: 0 },
    calls: [{ name: 'Bash', argBytes: 5 }],
  }],
  events: [
    { kind: 'user', at: 1000, turn: 1, text: 'GO', full: 'GO, and here is the long version' },
    {
      kind: 'tool', at: 1000, turn: 1, tool: 'Bash', text: 'command: ls',
      full: '{"command":"ls -la"}', result: 'a b c', resultFull: 'a\nb\nc',
      durationMs: 250, timing: 'measured',
    },
  ],
}

test('the dashboard is self-contained', () => {
  const html = renderDashboard([ONE_SESSION])
  assert.ok(!/<script/i.test(html), 'no script')
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), 'no remote assets')
  assert.match(html, /48,571|45,678/)
  assert.match(html, /250 ms/, 'the log carries each row own time')
  assert.match(html, /class="op real"/, 'and the overview strip marks the measured ones')
})

test('the export leaves out the expandable originals unless asked', () => {
  // They are most of the file: an export of every session runs to megabytes
  // with them. A server renders one session at a time and can afford them.
  // Turns are collapsible too, so the check has to name the row-level panel
  // rather than any <details> at all.
  const lean = renderDashboard([ONE_SESSION])
  assert.ok(!/<details>/.test(lean), 'no row expands by default')
  assert.ok(!/ls -la/.test(lean), 'and the originals really are absent')
  assert.match(lean, /class="turnmark"/, 'turn boundaries are still marked')

  const full = renderDashboard([ONE_SESSION], 200, true)
  assert.match(full, /<details><summary class="line">/)
  assert.match(full, /ls -la/, 'the original command is there when asked for')
  assert.ok(full.length > lean.length)
})
