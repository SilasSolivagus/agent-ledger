/**
 * The optional colour palette, and the rule that keeps it from being paint.
 *
 * Mono has one channel, and a chart with four series makes it carry two
 * things at once: lightness has to say which series a mark belongs to *and*
 * how large it is. Hue takes over the first, so lightness goes back to meaning
 * only the second.
 *
 *     色相 = 谁      which vendor, which bucket, which model
 *     明度 = 多少    inside one hue, darker is larger
 *
 * Two refusals keep it honest, and both are enforced by where this is called
 * rather than by anything in here:
 *
 *   1. A single-series chart gets no hue. With nothing to tell apart there is
 *      nothing for hue to encode, so the concurrency area stays mono.
 *   2. One categorical channel per chart. Rows already sorted by size are
 *      already saying which matters most, so the tool and duration rankings
 *      keep their grey ladder.
 *
 * The ladders are generated, not picked: lightness is pinned to a fixed
 * staircase (L* 24 / 42 / 60 / 76 / 90) and chroma pushed to the sRGB gamut
 * edge at each. Measured spread across families is under 0.3 L* at every
 * step — which matters, because a family that ran darker than its neighbours
 * would read as more important, and importance is lightness's to state.
 * The top two steps hold 80% of maximum chroma: glare is only a problem over
 * area, and area is where the light steps get used.
 *
 * Ported from the `color-category` branch of lieflat-charts. Regenerate there
 * rather than hand-editing a value here.
 *
 * @module
 */

/** Darkest to lightest. Same shape as the mono ladder, so callers do not care. */
export type Ladder = readonly [string, string, string, string, string]

/** Six families is the ceiling — beyond it they stop being distinguishable. */
export const HUES: Readonly<Record<string, Ladder>> = {
  rust: ['#790201', '#C9010C', '#FF553D', '#F2AA99', '#F9DCD6'],
  pine: ['#034229', '#057249', '#07A56B', '#55D196', '#7BFABA'],
  indigo: ['#043875', '#0661C4', '#528DFE', '#ACB9F1', '#DEE1F8'],
  clay: ['#720349', '#BE027E', '#FF41B0', '#F2A5C9', '#F9DBE8'],
  moss: ['#333D00', '#5A6A03', '#839B05', '#B1C642', '#D6EE53'],
  azure: ['#023E54', '#086B8E', '#109CCD', '#70C5F1', '#CBE6F8'],
}

/** The grey ladder, unchanged. Still the default everywhere. */
export const MONO: Ladder = ['#1C1C1A', '#6A6963', '#8F8E88', '#B0AFA9', '#C6C5BF']

const ORDER = ['rust', 'pine', 'indigo', 'clay', 'moss', 'azure'] as const

/**
 * Which family a category gets.
 *
 * Passing the full list keeps the assignment positional, so the same set of
 * vendors lands on the same colours on every page. Without it the name is
 * hashed, which is stable across renders but not across pages that happen to
 * hold different subsets — good enough for a legend, not for "Anthropic is
 * always rust".
 * @param name - the category.
 * @param all - every category in this chart, when the caller knows them.
 * @returns the family, darkest first.
 */
export function hueFor(name: string, all?: readonly string[]): Ladder {
  if (all !== undefined) {
    const i = all.indexOf(name)
    if (i >= 0) return HUES[ORDER[i % ORDER.length] as string] as Ladder
  }
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 997
  return HUES[ORDER[h % ORDER.length] as string] as Ladder
}

/**
 * One ladder per category, or the grey one repeated when colour is off.
 *
 * Callers hand the result straight to a chart, which never learns whether it
 * is drawing vendors or grey — the boundary that lets the chart family stay
 * ignorant of sessions, digests and costs holds for colour too.
 * @param names - the categories, in the order the chart will draw them.
 * @param colour - whether `--color` is on.
 */
export function laddersFor(names: readonly string[], colour: boolean): Ladder[] {
  return names.map(name => (colour ? hueFor(name, names) : MONO))
}
