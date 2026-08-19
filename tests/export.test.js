/**
 * The export was the board's poor relation.
 *
 * `report --out` is what you keep, mail, or open on a plane, and it had been
 * left behind: a total, a couple of charts and the trajectories, while the
 * live board grew five charts, a spend breakdown, an attribution panel and a
 * cross-vendor comparison. Same data, same renderer, two very different
 * answers depending on which command you happened to run.
 *
 * The rule the export cannot break to catch up: no script, no network. A file
 * on disk has to open with nothing running.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { renderDashboard } from '../lib/render.js'

/**
 * Anything the browser would go and fetch to render the page.
 *
 * An `<a href>` is not one of them: nothing is retrieved until someone
 * clicks, so a link to the project leaves the offline promise intact. The
 * earlier form of this check caught both and would have failed the moment a
 * page named where it came from.
 */
const REMOTE = /(<img|<script|<link|@import|url\()[^>]*https?:|src\s*=\s*["']https?:/i

/** One Claude session and one Codex session, both with real figures. */
function two() {
  const step = (agent, i) => ({
    index: i, startedAt: 1000 + i * 1000, durationMs: 900, ttftMs: 0,
    model: agent === 'claude-code' ? 'claude-opus-5' : 'gpt-5.4',
    wire: agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses',
    staticTokens: { prompt: 2000, tools: 8000 }, toolCount: 2, historyLength: 2,
    usage: { input: 1000, output: 500, cacheRead: 20000, cacheWrite: 1000 },
    calls: [{ name: 'Bash', argBytes: 10 }],
  })
  const events = (agent, at) => [
    { kind: 'user', at, turn: 1, text: `${agent} GO` },
    {
      kind: 'assistant', at: at + 100, turn: 1, text: 'working',
      model: agent === 'claude-code' ? 'claude-opus-5' : 'gpt-5.4',
      usage: { input: 1000, output: 500, cacheRead: 20000, cacheWrite: 1000 },
      durationMs: 100, timing: 'gap',
      ...(agent === 'claude-code' ? { skill: 'brainstorming' } : {}),
    },
    {
      kind: 'tool', at: at + 200, turn: 1, tool: 'Bash', text: 'ls',
      result: 'ok', durationMs: 250, timing: 'measured',
    },
    {
      kind: 'tool', at: at + 600, turn: 1, tool: 'Edit', text: 'patch',
      result: 'failed', durationMs: 90, timing: 'measured', isError: true,
    },
  ]
  return [
    { id: 'cc000001', agent: 'claude-code', startedAt: 1000, steps: [step('claude-code', 0), step('claude-code', 1)], events: events('claude-code', 1000) },
    { id: 'cx000001', agent: 'codex', startedAt: 2000, steps: [step('codex', 0), step('codex', 1)], events: events('codex', 2000) },
  ]
}

test('the export carries every panel the board grew', () => {
  const html = renderDashboard(two())
  for (const panel of [
    '调用耗时分布', '工具耗时', 'token 消耗', '产出归因', '会话并发', '花费', '调用失败',
  ]) {
    assert.match(html, new RegExp(panel), `the export is missing 「${panel}」`)
  }
})

test('two agents are two summaries, never one merged figure', () => {
  // Adding a Claude duration to a Codex duration produces a number describing
  // neither. The board is per vendor for that reason and the file has to be
  // too — the panels appear once per agent, under a heading that names it.
  const html = renderDashboard(two())
  assert.match(html, /Anthropic · Claude Code/)
  assert.match(html, /OpenAI · Codex/)
  assert.equal((html.match(/调用耗时分布/g) ?? []).length, 2, 'one distribution per agent')
})

test('the cross-vendor comparison is in the file too, disclaimers and all', () => {
  const html = renderDashboard(two())
  assert.match(html, /两家各自长什么样/)
  assert.match(html, /不是排名/)
  assert.match(html, /只看，别当结论/)
})

test('one agent alone gets its summary but no comparison', () => {
  const html = renderDashboard(two().slice(0, 1))
  assert.match(html, /调用耗时分布/, 'the summary is not conditional on having two')
  assert.ok(!/两家各自长什么样/.test(html), 'but a comparison of one is not a comparison')
})

test('catching up cost the export none of its promises', () => {
  const html = renderDashboard(two())
  assert.ok(!/<script/i.test(html), 'no script')
  assert.ok(!REMOTE.test(html), 'no remote assets')
  assert.ok(!/<details>/.test(html), 'and still no expandable originals unless asked')
})

test('the money survives the trip into the file', () => {
  const html = renderDashboard(two())
  assert.match(html, /\$/, 'a priced export shows what it cost')
  assert.match(html, /基础档/, 'and which tier it used')
})

test('an unidentified source is not a third vendor in the comparison', () => {
  // `unknown` means the proxy could not tell who was calling, not a product.
  // Sat in the table it reads as a third agent that did nothing, and its row
  // is all zeros — the exact reading this product refuses everywhere else.
  const sessions = [...two(), {
    id: 'proxied1', agent: 'unknown', startedAt: 500,
    steps: [{
      index: 0, startedAt: 500, durationMs: 10, ttftMs: 0, model: 'm', wire: 'unknown',
      staticTokens: { prompt: 100, tools: 900 }, toolCount: 0, historyLength: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, calls: [],
    }],
  }]
  const html = renderDashboard(sessions)
  const table = html.slice(html.indexOf('两家各自长什么样'), html.indexOf('各 agent 开口前'))
  assert.ok(!/unknown/.test(table), 'it is kept out of the comparison')
  assert.match(html, /未能识别来源/, 'and the page says it was set aside rather than dropping it silently')
})

test('the file that travels says what made it, and nothing about whose machine', () => {
  // An export gets mailed. Whoever opens it has no way to find the tool
  // otherwise — and a link to the project leaks nothing, unlike a link to
  // anything on the machine that produced it.
  const html = renderDashboard(two())
  assert.match(html, /github\.com\/SilasSolivagus\/agent-ledger/)
  assert.ok(!/\/Users\//.test(html), 'and still no local paths ride along')
})
