/**
 * Money on the page.
 *
 * Three places show it — the row, the session, the summary — and all three
 * are held to the same rule the rest of the product follows: a figure that
 * could not be worked out reads as "not recorded", never as zero. A spend
 * board is the worst possible place to break that rule, because a quiet ¥0
 * looks like thrift rather than like a hole.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { renderDashboard, renderDigest, renderSession } from '../lib/render.js'
import { digest } from '../lib/digest.js'
import { PRICED_AT } from '../lib/price.js'

/**
 * Anything the browser would go and fetch to render the page.
 *
 * An `<a href>` is not one of them: nothing is retrieved until someone
 * clicks, so a link to the project leaves the offline promise intact. The
 * earlier form of this check caught both and would have failed the moment a
 * page named where it came from.
 */
const REMOTE = /(<img|<script|<link|@import|url\()[^>]*https?:|src\s*=\s*["']https?:/i

/** One priced record and one that cannot be priced, in the same session. */
function mixed() {
  return {
    id: 'cost0001', agent: 'claude-code', startedAt: 1000,
    steps: [{
      index: 0, startedAt: 1000, durationMs: 900, ttftMs: 0, model: 'claude-opus-5',
      wire: 'anthropic-messages', staticTokens: { prompt: 10, tools: 10 },
      toolCount: 1, historyLength: 1,
      usage: { input: 1000, output: 500, cacheRead: 200000, cacheWrite: 10000 },
      calls: [],
    }],
    events: [
      { kind: 'user', at: 1000, turn: 1, text: 'GO' },
      {
        kind: 'assistant', at: 1100, turn: 1, text: '干活', model: 'claude-opus-5',
        usage: { input: 1000, output: 500, cacheRead: 200000, cacheWrite: 10000 },
        durationMs: 100, timing: 'gap',
      },
      {
        kind: 'assistant', at: 1200, turn: 1, text: '别名那条', model: 'sonnet',
        usage: { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0 },
        durationMs: 100, timing: 'gap',
      },
    ],
  }
}

/** A source that records the conversation but never a token. */
function tokenless() {
  return {
    id: 'cursor01', agent: 'cursor', startedAt: 5000, steps: [],
    events: [
      { kind: 'user', at: 0, turn: 1, text: 'GO', seq: 1 },
      { kind: 'assistant', at: 0, turn: 1, text: '好', seq: 2 },
    ],
  }
}

test('a priced record shows its own money on its own row', () => {
  const html = renderSession(mixed())
  assert.match(html, /\$0\.18/, 'the record that can be priced carries its figure')
})

test('an unpriceable record is never given a zero', () => {
  const html = renderSession(mixed())
  // The alias record burns 19,998 tokens. Printing $0.00 beside it would
  // read as "this one was free", which is the opposite of what is known.
  assert.ok(!/\$0\.00\b/.test(html), 'no zero-dollar row')
  assert.match(html, /型号未标明/, 'and the reason is named')
})

test('the session total says how many records it could not price', () => {
  const html = renderSession(mixed())
  assert.match(html, /1 条无价/, 'the hole beside the total is stated, with its size')
})

test('the money is in the headline row, not six cards down', () => {
  // It was in the spend card only. The first thing anyone asked of a running
  // board was "where is the money", which is what burying it looks like.
  const html = renderDigest(digest('claude-code', [mixed()]))
  const headline = html.slice(0, html.indexOf('调用耗时分布'))
  assert.match(headline, /\$0\.18/, 'the figure is above the fold')
  assert.match(headline, /花费/)
})

test('the summary states which price tier it used, and when the table was taken', () => {
  const html = renderDigest(digest('claude-code', [mixed()]))
  assert.match(html, /基础档/, 'long-context and priority tiers are not applied')
  assert.match(html, new RegExp(PRICED_AT), 'and the copy date is on the page')
})

test('a source that reports no tokens gets no spend card, not a zero one', () => {
  const html = renderDigest(digest('cursor', [tokenless()]))
  assert.ok(!/\$0\.00/.test(html), 'no zero total')
  assert.match(html, /该来源不记录|该来源不记录的项目/, 'it says the source does not record it')
})

test('the export carries the money too, and still reaches no network', () => {
  const html = renderDashboard([mixed()])
  assert.match(html, /\$0\.18/)
  assert.ok(!/<script/i.test(html), 'no script')
  assert.ok(!REMOTE.test(html), 'no remote assets')
})

test('the total a vendor would show is on the page, beside the split it bills by', () => {
  // Every usage page reports one number: input + output + cache, all added.
  // This board reported 「输入 TOKEN」, the fresh slice alone, which on a
  // cache-heavy machine is two percent of it — so a reader comparing the two
  // concluded the board was broken. Both figures now appear, each named.
  const html = renderDigest(digest('claude-code', [mixed()]))
  const headline = html.slice(0, html.indexOf('调用耗时分布'))
  // 1,000 fresh + 500 out + 200,000 cache read + 10,000 cache write
  assert.match(headline, /211,500/, 'the gross total is stated')
  assert.match(headline, /总量 token/)
  assert.match(html, /总量 = 新鲜输入 \+ 输出 \+ 缓存读 \+ 缓存写/, 'and what it adds is spelled out')
})

test('the split stays, because the four are billed at different rates', () => {
  // Gross is for comparing against a bill; the split is what the bill is made
  // of. A cache read costs a tenth of fresh input — adding them to compute
  // money would be wrong by an order of magnitude.
  const html = renderDigest(digest('claude-code', [mixed()]))
  assert.match(html, /其中输出/)
  assert.match(html, /缓存读/)
})
