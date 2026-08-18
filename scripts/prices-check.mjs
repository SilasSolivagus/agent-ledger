#!/usr/bin/env node
/**
 * Ask upstream whether the vendored price table has gone stale.
 *
 * The table in `src/price.ts` is a hand-kept copy, which is the only way an
 * exported page can carry a cost figure and still open with no network. The
 * price of a copy is that it drifts, so this script goes and looks: it fetches
 * the community list, compares every rate this project claims, and prints what
 * moved. It never edits anything — a price change is a decision, and someone
 * should see the number before it lands in a bill.
 *
 * Deliberately not part of `npm test`. The test suite is offline by
 * construction, and a network call in it would fail on a plane and, worse,
 * would sometimes pass for the wrong reason.
 *
 * Usage: npm run prices:check
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { PRICES, PRICED_AT } from '../lib/price.js'

const run = promisify(execFile)

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** Upstream's field names for our four buckets. */
const FIELDS = {
  input: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cacheRead: 'cache_read_input_token_cost',
  cacheWrite: 'cache_creation_input_token_cost',
}

const MILLION = 1e6

/** Per-million, rounded past the float noise a per-token rate carries. */
function perMillion(value) {
  return value === undefined ? 0 : Math.round(value * MILLION * 1e6) / 1e6
}

/**
 * Fetch the table, through whatever the machine uses to reach the internet.
 *
 * Node's built-in fetch ignores `HTTP_PROXY` and friends, so on a machine
 * behind a proxy it does not fail fast — it hangs until it times out. curl
 * reads those variables, so it is the fallback rather than the first choice:
 * plain fetch keeps the common case dependency-free.
 */
async function download() {
  try {
    const response = await fetch(SOURCE)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (direct) {
    try {
      const { stdout } = await run('curl', ['-sSL', '--fail', SOURCE], { maxBuffer: 64 * 1024 * 1024 })
      return JSON.parse(stdout)
    } catch (viaCurl) {
      throw new Error(`${direct.message}; curl: ${viaCurl.message.split('\n')[0]}`)
    }
  }
}

let upstream
try {
  upstream = await download()
} catch (error) {
  console.error(`prices:check — could not reach the upstream table: ${error.message}`)
  console.error(`  ${SOURCE}`)
  process.exit(2)
}

const moved = []
const gone = []
const unchecked = []

for (const [model, ours] of Object.entries(PRICES)) {
  // The upstream table carries no currency field and normalises everything to
  // USD, so it cannot confirm a rate this project holds in another currency.
  // Reporting those as "changed" every single run would train the reader to
  // ignore this script, which is the one thing it must not do.
  if (ours.currency !== 'USD') { unchecked.push(model); continue }
  const theirs = upstream[model]
  if (theirs === undefined) { gone.push(model); continue }
  for (const [bucket, field] of Object.entries(FIELDS)) {
    const now = perMillion(theirs[field])
    if (now !== ours[bucket]) moved.push({ model, bucket, was: ours[bucket], now })
  }
}

console.error(`prices:check — ${String(Object.keys(PRICES).length)} models, table taken ${PRICED_AT}`)
console.error(`  upstream: ${SOURCE}`)
if (unchecked.length > 0) {
  console.error(`  NOT CHECKED  ${unchecked.join(', ')} — priced in their vendor's own`)
  console.error('               currency; upstream publishes only a converted USD figure.')
  console.error("               Verify these against the vendor's price list by hand.")
}

if (moved.length === 0 && gone.length === 0) {
  console.error('  no change in the USD rates. Per million tokens, all four buckets.')
  process.exit(0)
}

for (const { model, bucket, was, now } of moved) {
  console.error(`  CHANGED  ${model}.${bucket}: ${String(was)} → ${String(now)}`)
}
for (const model of gone) {
  // Upstream dropping a name does not make our figure wrong for records
  // already written under it, so this is reported, never auto-removed.
  console.error(`  DROPPED  ${model} — upstream no longer lists it`)
}

console.error('')
console.error('Edit src/price.ts by hand and move PRICED_AT to today. Nothing here writes.')
process.exit(1)
