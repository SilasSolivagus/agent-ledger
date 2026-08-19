/**
 * `--color` is an addition, not a repaint.
 *
 * Hue takes over "which vendor" so that lightness can go back to meaning only
 * "how much" — mono had one channel carrying both. The rules that keep it from
 * being decoration are refusals, and refusals are what these tests check: the
 * charts that already say which matters most by sorting do not also get hue,
 * and the single-series one gets none at all.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { renderDashboard, renderDigest } from '../lib/render.js'
import { digest } from '../lib/digest.js'
import { hueFor, HUES, MONO } from '../lib/palette.js'

function sessions() {
  const step = (agent, i) => ({
    index: i, startedAt: 1000 + i * 900, durationMs: 500, ttftMs: 0,
    model: agent === 'claude-code' ? 'claude-opus-5' : 'gpt-5.4',
    wire: 'anthropic-messages', staticTokens: { prompt: 100, tools: 900 },
    toolCount: 1, historyLength: 1,
    usage: { input: 900, output: 400, cacheRead: 30000, cacheWrite: 800 },
    calls: [{ name: 'Bash', argBytes: 4 }],
  })
  const events = (agent, at, model) => [
    { kind: 'user', at, turn: 1, text: 'go' },
    { kind: 'assistant', at: at + 50, turn: 1, text: 'ok', model,
      usage: { input: 900, output: 400, cacheRead: 30000, cacheWrite: 800 },
      durationMs: 50, timing: 'gap' },
    { kind: 'tool', at: at + 120, turn: 1, tool: 'Bash', text: 'ls',
      result: 'ok', durationMs: 90, timing: 'measured' },
  ]
  return [
    { id: 'cc1', agent: 'claude-code', startedAt: 1000,
      steps: [step('claude-code', 0)], events: events('claude-code', 1000, 'claude-opus-5') },
    { id: 'cx1', agent: 'codex', startedAt: 2000,
      steps: [step('codex', 0)], events: events('codex', 2000, 'gpt-5.4') },
  ]
}

test('mono is what you get unless you ask', () => {
  const html = renderDashboard(sessions())
  for (const family of Object.values(HUES)) {
    for (const shade of family) {
      assert.ok(!html.includes(shade), `${shade} appeared without --color`)
    }
  }
})

test('with colour on, the vendors stop being the same grey', () => {
  const html = renderDashboard(sessions(), 200, false, true)
  const names = ['claude-code', 'codex']
  assert.ok(html.includes(hueFor('claude-code', names)[0]))
  assert.ok(html.includes(hueFor('codex', names)[0]))
})

test('a category keeps its hue wherever it appears', () => {
  // The tab, the comparison row and the chart are read against each other.
  // A vendor that changed colour between them would be worse than grey.
  const names = ['claude-code', 'codex']
  assert.deepEqual(hueFor('claude-code', names), hueFor('claude-code', names))
  assert.notDeepEqual(hueFor('claude-code', names), hueFor('codex', names))
})

test('every family is as dark at the top and as light at the bottom', () => {
  // A family that ran darker than its neighbours would read as more
  // important, and importance is lightness's to state, not hue's.
  const L = hex => {
    const v = [0, 2, 4].map(i => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
      .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    const y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
    return 116 * (y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116) - 16
  }
  const families = Object.values(HUES)
  for (let step = 0; step < 5; step += 1) {
    const ls = families.map(f => L(f[step]))
    assert.ok(Math.max(...ls) - Math.min(...ls) < 2,
      `step ${step} spans ${(Math.max(...ls) - Math.min(...ls)).toFixed(1)} L*`)
  }
  // And each family really does run dark to light.
  for (const f of families) {
    for (let i = 1; i < f.length; i += 1) assert.ok(L(f[i]) > L(f[i - 1]))
  }
})

test('the single-series chart is left alone', () => {
  // Concurrency has no categories. Hue there would encode nothing, which is
  // the definition of decoration.
  const html = renderDigest(digest('claude-code', sessions().slice(0, 1)), true)
  const area = html.slice(html.indexOf('会话并发'))
  for (const family of Object.values(HUES)) {
    for (const shade of family) assert.ok(!area.includes(shade), `${shade} in the area chart`)
  }
  assert.ok(MONO.length === 5)
})
