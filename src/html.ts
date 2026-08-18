/**
 * The vocabulary every page is written in: colours, escaping, and the two
 * ways a duration is spoken.
 *
 * These sit apart from the page and the charts because both need them and
 * neither owns them. `jitter` in particular is load-bearing rather than
 * decorative — the galleries call for scattered marks, and a scatter drawn
 * from `Math.random()` would rearrange itself on every reload, so a reader
 * could never tell a redraw from a change in the data.
 *
 * @module
 */

export const T = {
  card: '#1b1b19', ink: '#f0efeb', muted: '#8f8e88', faint: '#57574f', rule: '#2b2a26',
  paper: '#efeee9', paperInk: '#1c1c1a',
} as const

export function esc(v: string): string {
  return v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function jitter(a: number, b: number): number {
  return Math.abs(((a * 73856093) ^ (b * 19349663)) % 1000) / 1000
}

/** `1,204 ms` / `2.4 s`, or a dash when nothing was recorded. */
export function ms(value: number | undefined): string {
  if (value === undefined) return '—'
  return value >= 10000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value).toLocaleString('en-US')} ms`
}

/** `5.4 小时` / `19 分钟` / `2,010 ms`, whichever reads. */
export function span(value: number): string {
  if (value >= 3600_000) return `${(value / 3600_000).toFixed(1)} 小时`
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} 分钟`
  return ms(value)
}
/** The sign each currency is written with. */
const SIGN: Readonly<Record<string, string>> = { USD: '$', CNY: '¥' }

/**
 * `$0.18` / `¥1.20` / `$0.0031` / `$1,204`, whichever the amount deserves.
 *
 * One request costs fractions of a cent, and a month of them costs hundreds,
 * so a fixed precision either buries the small figures in zeroes or pads the
 * large ones with digits nobody reads. The sign is carried rather than assumed
 * because two vendors bill in two currencies and the totals are never merged.
 */
export function money(m: { amount: number; currency: string }): string {
  const sign = SIGN[m.currency] ?? `${m.currency} `
  if (m.amount >= 1000) return `${sign}${Math.round(m.amount).toLocaleString('en-US')}`
  return `${sign}${m.amount.toFixed(m.amount >= 0.01 ? 2 : 4)}`
}

/** Every currency's total, side by side. Never a sum. */
export function moneyAll(totals: readonly { amount: number; currency: string }[]): string {
  return totals.map(money).join(' · ')
}
