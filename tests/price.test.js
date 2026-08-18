/**
 * What a request cost, and — more often than you would like — why that
 * question has no answer.
 *
 * The rule the rest of this product lives by applies here hardest: a figure
 * that was never recorded must read as "not recorded", never as zero. A
 * spend board that quietly prints ¥0 for a thousand records it could not
 * price is worse than one that prints nothing, because it looks answered.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { costOf, priceNote, priceOf, spendOf, PRICES, PRICED_AT } from '../lib/price.js'

test('a priced model turns usage into money', () => {
  const usage = { input: 1000, output: 500, cacheRead: 200000, cacheWrite: 10000 }
  // opus-5 at 5 / 25 / 0.5 / 6.25 USD per million:
  //   0.005 + 0.0125 + 0.1 + 0.0625
  assert.deepEqual(costOf(usage, 'claude-opus-5'), { amount: 0.18, currency: 'USD' })
})

test('cache read is the reason the bill is not the token count', () => {
  // The same million tokens, fresh versus served from cache, differ tenfold.
  const fresh = costOf({ input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5')
  const cached = costOf({ input: 0, output: 0, cacheRead: 1000000, cacheWrite: 0 }, 'claude-opus-5')
  assert.equal(fresh.amount, 5)
  assert.equal(cached.amount, 0.5)
})

test('a vendor that does not charge for cache writes is charged zero, not skipped', () => {
  // OpenAI publishes no cache-write price because it does not bill one. That
  // is a fact worth encoding as zero; leaving it undefined would make the
  // whole request unpriceable over a charge that does not exist.
  const price = priceOf('gpt-5.4')
  assert.equal(price.cacheWrite, 0)
  assert.equal(costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 999999 }, 'gpt-5.4').amount, 0)
})

test('an alias is not a model, and is never guessed at', () => {
  // 1,221 records on this machine say `sonnet`, `opus` or `haiku`. Which
  // model that meant depends on when it was written — `sonnet` is sonnet-5
  // today and was sonnet-4 last year — so pricing it is inventing a number.
  for (const alias of ['sonnet', 'opus', 'haiku']) {
    assert.equal(costOf({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, alias), undefined)
    assert.equal(priceNote(alias), '型号未标明')
  }
})

test('a synthetic record is not a request at all', () => {
  assert.equal(costOf({ input: 9, output: 9, cacheRead: 0, cacheWrite: 0 }, '<synthetic>'), undefined)
  assert.equal(priceNote('<synthetic>'), '型号未标明')
})

test('a model the table has never heard of says so, rather than costing nothing', () => {
  assert.equal(costOf({ input: 5000, output: 5000, cacheRead: 0, cacheWrite: 0 }, 'gpt-5.3'), undefined)
  assert.equal(priceNote('gpt-5.3'), '无此型号价格')
})

test('no model and no usage are both answered with nothing, not with zero', () => {
  assert.equal(costOf({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, undefined), undefined)
  assert.equal(costOf(undefined, 'claude-opus-5'), undefined)
  assert.equal(priceNote(undefined), '型号未标明')
})

test('the table says when it was taken, because it goes stale on its own', () => {
  // Prices change without warning and this table is a copy. The date is what
  // `npm run prices:check` compares against upstream, and what the page shows
  // so a reader knows how old the figure is.
  assert.match(PRICED_AT, /^\d{4}-\d{2}-\d{2}$/)
})

test('every priced model carries all four rates and says what money they are in', () => {
  for (const [model, price] of Object.entries(PRICES)) {
    assert.ok(['USD', 'CNY'].includes(price.currency), `${model}.currency`)
    for (const rate of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      assert.equal(typeof price[rate], 'number', `${model}.${rate}`)
      assert.ok(price[rate] >= 0, `${model}.${rate} is not negative`)
    }
  }
})

test('a spend total carries what it could not price, not a quiet subtotal', () => {
  const spend = spendOf([
    { kind: 'assistant', at: 1, turn: 1, text: 'a', model: 'claude-opus-5',
      usage: { input: 1000, output: 500, cacheRead: 200000, cacheWrite: 10000 } },
    { kind: 'assistant', at: 2, turn: 1, text: 'b', model: 'sonnet',
      usage: { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0 } },
    { kind: 'assistant', at: 3, turn: 1, text: 'c', model: 'gpt-5.3',
      usage: { input: 5000, output: 5000, cacheRead: 0, cacheWrite: 0 } },
    // No usage at all: a tool call is not a request and is not a gap either.
    { kind: 'tool', at: 4, turn: 1, text: 'ls', tool: 'Bash' },
  ])
  assert.deepEqual(spend.totals, [{ amount: 0.18, currency: 'USD' }], 'only the priced record is counted')
  assert.equal(spend.priced, 1)
  assert.equal(spend.unpriced, 2, 'both the alias and the unlisted model are counted as unpriced')
  assert.deepEqual(spend.unpricedModels.sort(), ['gpt-5.3', 'sonnet'])
})

test('a source that reports no tokens has no spend, and says so by holding zero records', () => {
  // Cursor records no usage anywhere. The answer is not "$0 spent" — it is
  // that nothing here can be priced, which `priced === 0` states.
  const spend = spendOf([
    { kind: 'user', at: 0, turn: 1, text: 'go', seq: 1 },
    { kind: 'assistant', at: 0, turn: 1, text: 'ok', seq: 2 },
  ])
  assert.equal(spend.priced, 0)
  assert.equal(spend.unpriced, 0)
  assert.deepEqual(spend.totals, [], 'no currency appears at all, rather than a zero in one')
})

test('two currencies are two totals, never one', () => {
  // 09:30 Beijing is peak; the hour matters, see the next test.
  const at = Date.UTC(2026, 7, 18, 2, 0, 0)
  const spend = spendOf([
    { kind: 'assistant', at, turn: 1, text: 'a', model: 'claude-opus-5',
      usage: { input: 1000, output: 500, cacheRead: 200000, cacheWrite: 10000 } },
    { kind: 'assistant', at, turn: 1, text: 'b', model: 'deepseek-v4-flash',
      usage: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ])
  assert.equal(spend.priced, 2)
  assert.deepEqual(spend.totals, [
    { amount: 3, currency: 'CNY' },
    { amount: 0.18, currency: 'USD' },
  ], 'held apart, and no exchange rate is applied to merge them')
})

test('a vendor that bills by the clock is charged by the clock', () => {
  const tokens = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }
  // Peak is 09:00–12:00 and 14:00–18:00 Beijing, i.e. 01–04 and 06–10 UTC.
  const peak = costOf(tokens, 'deepseek-v4-flash', Date.UTC(2026, 7, 18, 2, 30))
  const quiet = costOf(tokens, 'deepseek-v4-flash', Date.UTC(2026, 7, 18, 20, 30))
  assert.equal(peak.amount, 3, '高峰 3.0 元 per million input')
  assert.equal(quiet.amount, 1.5, 'off-peak is half, not a rounding')
  assert.equal(peak.currency, 'CNY')
})

test('a clock-billed model with no timestamp is refused, not rounded', () => {
  // Guessing peak overstates by 100%; guessing off-peak understates by the
  // same. Neither is a figure anyone should put in front of a reader.
  const tokens = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }
  assert.equal(costOf(tokens, 'deepseek-v4-flash'), undefined)
  assert.equal(costOf(tokens, 'deepseek-v4-flash', 0), undefined)
})
