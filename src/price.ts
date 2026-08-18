/**
 * What a request cost, when that can be answered honestly.
 *
 * The table below is a copy, taken by hand from the community-maintained
 * price list that LiteLLM publishes. It is vendored rather than fetched
 * because the two promises this product makes — reads only local files, and
 * an exported page opens with no network — both die the moment a rendered
 * figure depends on reaching a server. `npm run prices:check` is the other
 * half of that bargain: it goes and looks at the upstream table, and says
 * what has moved since {@link PRICED_AT}. Nothing here updates itself.
 *
 * Only models this machine has actually produced are listed. A table of three
 * thousand entries would be mostly a list of models nobody here runs, and
 * every one of them is a number that can silently go wrong.
 *
 * Rates are per million tokens in the vendor's own currency, and the four
 * buckets line up exactly with {@link Usage}: fresh input, output, tokens
 * served from cache, tokens written into it. Note that `input` is fresh-only —
 * the adapters already moved OpenAI's cached tokens out of it — so the four
 * can simply be added. Amounts in different currencies never are.
 *
 * The first-class answer here is "no price". Aliases, synthetic records and
 * models newer than this table all produce one, and the caller is expected to
 * print {@link priceNote} rather than a zero.
 *
 * @module
 */

import type { LedgerEvent, Usage } from './types.js'

/**
 * What money a vendor bills in.
 *
 * Kept per model rather than normalised, because normalising means shipping an
 * exchange rate — a number that moves daily, that this product cannot fetch
 * without breaking its offline promise, and that would silently restate every
 * historical figure the day it was updated. DeepSeek publishes in RMB and
 * Anthropic in USD; the honest total is two totals.
 *
 * The community table normalises everything to USD with no currency field and
 * no rate, which is exactly the hidden conversion this avoids: rates for a
 * vendor that bills in RMB are taken from that vendor's own price list.
 */
export type Currency = 'USD' | 'CNY'

/** An amount, and the money it is denominated in. Never added across currencies. */
export interface Money {
  amount: number
  currency: Currency
}

/** What one million tokens costs, in {@link Price.currency}, in each of the four buckets. */
export interface Price {
  /** The money the vendor bills in. */
  currency: Currency
  /** Fresh input, excluding anything served from cache. */
  input: number
  output: number
  cacheRead: number
  /**
   * Tokens written into the cache.
   *
   * Zero where the vendor does not bill one — that is a rate, not a gap.
   * Leaving it absent would make a whole request unpriceable over a charge
   * that does not exist.
   */
  cacheWrite: number
  /**
   * Hours (UTC) during which the rates above apply, when a vendor charges by
   * the clock. Outside them the bill is half.
   *
   * DeepSeek is the reason this exists: its off-peak rate is half its peak
   * rate, so a figure worked out without consulting the timestamp is wrong by
   * up to 100%. Every record carries `at`, so this is knowable — but only if
   * it is asked, which is why {@link costOf} refuses to price a scheduled
   * model without one.
   */
  peakHoursUtc?: readonly (readonly [number, number])[]
}

/**
 * When this table was copied from upstream.
 *
 * Shown on the page, because a reader deserves to know how old a price is,
 * and compared by the guard script against the upstream list.
 */
export const PRICED_AT = '2026-08-18'

/**
 * Names that identify no particular model.
 *
 * `sonnet`, `opus` and `haiku` are aliases the harness resolves at request
 * time; what they meant depends on when the record was written, and there are
 * 1,221 of them on this machine. `<synthetic>` is not a request at all —
 * Claude Code writes it for messages it generated itself. Pricing either one
 * means inventing a figure, so both are refused by name rather than falling
 * through to "unknown model", which would misdescribe why.
 */
const UNNAMED: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku', '<synthetic>'])

/** Per million tokens, in each vendor's own currency. */
export const PRICES: Readonly<Record<string, Price>> = {
  // Anthropic bills cache writes; these are the standard rates, below the
  // 200k-context threshold and at the five-minute cache lifetime.
  'claude-opus-5': { currency: 'USD', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { currency: 'USD', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-fable-5': { currency: 'USD', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-4-8': { currency: 'USD', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { currency: 'USD', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { currency: 'USD', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },

  // OpenAI does not bill for cache writes, hence the zeroes.
  'gpt-5.5': { currency: 'USD', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  'gpt-5.4': { currency: 'USD', input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  'gpt-5.2': { currency: 'USD', input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.1': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5-codex': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.1-codex': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.1-codex-max': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.1-codex-mini': { currency: 'USD', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  'codex-mini-latest': { currency: 'USD', input: 1.5, output: 6, cacheRead: 0.375, cacheWrite: 0 },
  'o3': { currency: 'USD', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },

  // DeepSeek, from its own price list rather than the community table's
  // conversion of it. Two lists exist — 元 on the Chinese page, USD on the
  // English one — and they are separately rounded rather than one converted
  // into the other: 1.5元/$0.22 implies 6.82, 0.05元/$0.007 implies 7.14. The
  // 元 list is the one used here; an account billed in USD would need the
  // other, which is a switch nobody has asked for yet.
  //
  // Rates below are the peak ones. DeepSeek bills no cache write.
  'deepseek-v4-flash': {
    currency: 'CNY', input: 3, output: 9, cacheRead: 0.1, cacheWrite: 0,
    peakHoursUtc: [[1, 4], [6, 10]],
  },
  'deepseek-v4-pro': {
    currency: 'CNY', input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0,
    peakHoursUtc: [[1, 4], [6, 10]],
  },
}

/**
 * The rates for a model, if this table knows it.
 *
 * A dated snapshot falls back to its base name — Claude Code records
 * `claude-haiku-4-5-20251001`, and a snapshot is the same model at the same
 * price, so listing every date would be a maintenance tax for no information.
 * @param model - the name as the transcript recorded it.
 * @returns the rates, or undefined when there is no honest answer.
 */
export function priceOf(model: string | undefined): Price | undefined {
  if (model === undefined || UNNAMED.has(model)) return undefined
  const known = PRICES[model]
  if (known !== undefined) return known
  return PRICES[model.replace(/-\d{8}$/, '')]
}

/**
 * What a request cost.
 * @param usage - the four token buckets for that request.
 * @param model - the model that served it.
 * @param at - when it happened, for vendors that bill by the clock.
 * @returns the cost in the vendor's own currency, or undefined when unknowable.
 */
export function costOf(
  usage: Usage | undefined, model: string | undefined, at = 0,
): Money | undefined {
  const price = priceOf(model)
  if (price === undefined || usage === undefined) return undefined
  let rate = 1
  if (price.peakHoursUtc !== undefined) {
    // A model billed by the clock cannot be priced without one. Guessing peak
    // overstates by 100% half the day and guessing off-peak understates by the
    // same, so an unstamped record is refused rather than rounded.
    if (at <= 0) return undefined
    const hour = new Date(at).getUTCHours()
    const peak = price.peakHoursUtc.some(([from, to]) => hour >= from && hour < to)
    rate = peak ? 1 : 0.5
  }
  const amount = rate * (usage.input * price.input
    + usage.output * price.output
    + usage.cacheRead * price.cacheRead
    + usage.cacheWrite * price.cacheWrite) / 1e6
  return { amount, currency: price.currency }
}

/**
 * Why there is no price, in the words the page should print.
 *
 * The two reasons are different facts and a reader can act on the difference:
 * an unnamed model is a gap in what the harness recorded, while an unlisted
 * one means this table needs a pass.
 * @param model - the name as the transcript recorded it.
 * @returns the phrase, or undefined when the model is priced.
 */
export function priceNote(model: string | undefined): string | undefined {
  if (model === undefined || UNNAMED.has(model)) return '型号未标明'
  return priceOf(model) === undefined ? '无此型号价格' : undefined
}

/**
 * What a stretch of work cost, and how much of it could not be answered.
 *
 * Totals are held per currency and never summed across them. Converting would
 * mean shipping an exchange rate: a figure that moves daily, that this product
 * cannot refresh without giving up its offline promise, and that would quietly
 * restate every past number the day it changed. Two totals side by side are
 * the truthful answer to "what did this cost" when two vendors bill in two
 * currencies.
 *
 * The unpriced count travels with them for the same reason. A total on its own
 * invites the reading that it is the total, and on this machine it would be
 * short by 1,221 records — the ones written under an alias.
 */
export interface Spend {
  /** One total per currency seen, largest first. Never added together. */
  totals: Money[]
  /** How many records were priced. */
  priced: number
  /** Records that carried usage but no usable price. */
  unpriced: number
  /** The distinct names behind {@link unpriced}, for the note. */
  unpricedModels: string[]
}

/**
 * Add up what a set of records cost.
 *
 * A record with no usage is neither priced nor unpriced — it is not a request.
 * Tool calls and your own messages fall here, and so does every record from a
 * source that reports no tokens: `priced === 0` then says the honest thing,
 * which is that nothing here can be costed, not that nothing was spent.
 * @param events - the ledger to total.
 * @returns the money, by currency, and the size of the hole beside it.
 */
export function spendOf(events: readonly LedgerEvent[]): Spend {
  const byCurrency = new Map<Currency, number>()
  let priced = 0
  let unpriced = 0
  const unnamed = new Set<string>()
  for (const event of events) {
    if (event.usage === undefined) continue
    const cost = costOf(event.usage, event.model, event.at)
    if (cost === undefined) { unpriced += 1; unnamed.add(event.model ?? '未标明'); continue }
    byCurrency.set(cost.currency, (byCurrency.get(cost.currency) ?? 0) + cost.amount)
    priced += 1
  }
  const totals = [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount)
  return { totals, priced, unpriced, unpricedModels: [...unnamed] }
}
