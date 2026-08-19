/**
 * The chart family, lifted from the lieflat-charts galleries.
 *
 * Kept apart from the page so that a chart knows nothing about a session, a
 * digest or a cost — it is handed labels and numbers and returns SVG. That
 * boundary is what makes these rules checkable in one place instead of
 * drifting as callers multiply.
 *
 * Every chart keeps a countable unit and prints it. The rest, from the
 * galleries: light cards by default with at most one dark card per screen,
 * hairlines at 0.5–0.7px, jittered rung length and opacity from a
 * deterministic pseudo-random so a reload looks identical, a marker every
 * fifth unit, and no colour — lightness carries importance.
 *
 * @see the lieflat-charts galleries — Lupi Editorial (L1–L15), Lupi Basics (F1–F12)
 * @module
 */

import { esc, jitter } from './html.js'
import type { Ladder } from './palette.js'

/** Grey ladder, darkest first. Lightness is the encoding, not hue. */
const LADDER = ['#1C1C1A', '#6A6963', '#8F8E88', '#B0AFA9', '#C6C5BF'] as const

/**
 * Shade by rank, not by position.
 *
 * The rule is that the most important value is the darkest. Rows arrive in
 * whatever order their meaning dictates — fresh input before cache read, say —
 * so handing out the ladder by array index paints a 0.0% row black and a 94%
 * row nearly white.
 * @param values - the series, in display order.
 * @returns one shade per row, assigned by size.
 */
function shadesByRank(values: readonly number[]): string[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
  const out = values.map(() => LADDER[LADDER.length - 1] as string)
  const last = LADDER.length - 1
  order.forEach((entry, rank) => {
    // Spread across the whole ladder rather than taking the top steps in
    // sequence. Two categories used to get steps 0 and 1, which are one notch
    // apart and read as the same dark once the dots are small; they now get
    // the ends of the ladder.
    const at = order.length <= 1 ? 0
      : Math.round((rank / (order.length - 1)) * Math.min(last, order.length - 1))
    out[entry.i] = LADDER[Math.min(at, last)] as string
  })
  return out
}

/** L14 Hundred Field — one dot per percentage point, grouped by segment. */
export function hundredField(
  segments: readonly { label: string; pct: number }[],
  ladders?: readonly Ladder[],
): string {
  const W = 1000, COLS = 25, R = 3.6, SX = 38, SY = 16
  // Without ladders this is the grey ranking it always was. With them each
  // segment gets its own hue and keeps its rank inside it — the chart never
  // learns what the categories are, only that they differ.
  const shades = ladders === undefined
    ? shadesByRank(segments.map(s2 => s2.pct))
    : segments.map((_, i) => (ladders[i] ?? [])[0] ?? '#1C1C1A')
  const parts: string[] = []
  let index = 0
  segments.forEach((seg, si) => {
    const n = Math.max(0, Math.round(seg.pct))
    const shade = shades[si] ?? '#1C1C1A'
    for (let k = 0; k < n && index < 100; k += 1, index += 1) {
      const cx = 26 + (index % COLS) * SX
      const cy = 24 + Math.floor(index / COLS) * SY
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${R}" fill="${shade}"`
        + ` class="pop" style="animation-delay:${(index * 0.011).toFixed(3)}s"`
        // Texture, not noise. The old range reached 0.72, which let a dark
        // dot from one category render lighter than a pale dot from another —
        // the jitter was overwriting the thing the chart exists to show.
        + ` opacity="${(0.9 + jitter(index + 1, si + 3) * 0.1).toFixed(2)}"/>`)
    }
  })
  // Two legend columns: four labels on one line ran off the edge.
  const legend = segments.map((seg, si) => {
    const shade = shades[si] ?? '#1C1C1A'
    const col = si % 2, row = Math.floor(si / 2)
    return `<g transform="translate(${26 + col * 480} ${104 + row * 16})">`
      + `<circle cx="0" cy="-3" r="3.1" fill="${shade}"/>`
      + `<text x="9" y="0" class="cap">${esc(seg.label)} · ${seg.pct.toFixed(1)}%</text></g>`
  }).join('')
  const H = 108 + Math.ceil(segments.length / 2) * 16 + 16
  parts.push(`<text x="26" y="${H - 5}" class="unit">一个点 = 一个百分点 · 共 100 点 · 越黑占比越大</text>`)
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${parts.join('')}${legend}</svg>`
}

/** F4 Tick Donut — a ring of ticks, one tick per percentage point. */
export function tickDonut(
  segments: readonly { label: string; pct: number }[],
  ladders?: readonly Ladder[],
): string {
  const W = 560, cx = W / 2, cy = 116, R0 = 62
  const pol = (r: number, deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  }
  const shades = ladders === undefined
    ? shadesByRank(segments.map(s2 => s2.pct))
    : segments.map((_, k) => (ladders[k] ?? [])[0] ?? '#1C1C1A')
  const parts: string[] = []
  let idx = 0
  segments.forEach((seg, si) => {
    const shade = shades[si] ?? '#1C1C1A'
    const n = Math.max(1, Math.round(seg.pct))
    for (let k = 0; k < n && idx < 100; k += 1, idx += 1) {
      const a = idx * 3.6 - 90
      const len = 10 + jitter(idx + 1, si + 2) * 6
      const [x1, y1] = pol(R0, a)
      const [x2, y2] = pol(R0 + len, a)
      parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}"`
        + ` y2="${y2.toFixed(1)}" stroke="${shade}" stroke-width="1" class="fade"`
        + ` style="animation-delay:${(idx * 0.012).toFixed(3)}s"/>`)
      if (idx % 10 === 0) {
        const [dx, dy] = pol(R0 - 5, a)
        parts.push(`<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="0.8" class="fifth"/>`)
      }
    }
  })
  const legend = segments.map((seg, si) => {
    const shade = shades[si] ?? '#1C1C1A'
    return `<g transform="translate(28 ${216 + si * 19})"><rect x="0" y="-6" width="9" height="9" fill="${shade}"/>`
      + `<text x="15" y="2" class="cap">${esc(seg.label.toUpperCase())} · ${seg.pct.toFixed(1)}%</text></g>`
  }).join('')
  parts.push(`<text x="${cx}" y="${cy + 3}" class="bignum" text-anchor="middle">100</text>`)
  parts.push(`<text x="${cx}" y="${cy + 15}" class="unit" text-anchor="middle">TICKS</text>`)
  const H = 228 + segments.length * 19
  parts.push(`<text x="28" y="204" class="unit">一格 = 一个百分点 · 每十格内圈一个点</text>`)
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${parts.join('')}${legend}</svg>`
}

/** F3 Hairline Area — one hairline per sample, standing to its own value. */
export function hairlineArea(points: readonly { at: number; value: number }[], unitNote: string): string {
  if (points.length < 2) return ''
  const W = 1160, H = 126, base = H - 26, top = 16
  const peak = Math.max(...points.map(p => p.value), 1)
  const t0 = points[0]?.at ?? 0
  const t1 = points.at(-1)?.at ?? t0 + 1
  const x = (at: number): number => 26 + ((at - t0) / Math.max(1, t1 - t0)) * (W - 52)
  const y = (v: number): number => base - (v / peak) * (base - top)
  const parts: string[] = []
  for (let n = 1; n <= peak; n += 1) {
    parts.push(`<line x1="20" y1="${y(n).toFixed(1)}" x2="${W - 20}" y2="${y(n).toFixed(1)}" class="grid"/>`)
    parts.push(`<text x="14" y="${(y(n) + 2.5).toFixed(1)}" class="cap" text-anchor="end">${n}</text>`)
  }
  // The fill is not a block of ink: it is one hairline per sample standing up
  // to its own reading, so the area is made of the samples it claims to sum.
  const STEP = Math.max(1.6, (W - 52) / 260)
  let prev = points[0]
  for (const point of points.slice(1)) {
    if (prev === undefined) break
    for (let px = x(prev.at); px < x(point.at); px += STEP) {
      parts.push(`<line x1="${px.toFixed(1)}" y1="${base}" x2="${px.toFixed(1)}"`
        + ` y2="${y(prev.value).toFixed(1)}" class="hair"/>`)
    }
    prev = point
  }
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)} ${y(p.value).toFixed(1)}`).join('')
  parts.push(`<path d="${path}" class="edge draw" pathLength="1"`
    + ` style="--len:1;stroke-dasharray:1"/>`)
  parts.push(`<line x1="20" y1="${base}" x2="${W - 20}" y2="${base}" class="grid"/>`)
  parts.push(`<text x="26" y="${H - 5}" class="unit">${esc(unitNote)}</text>`)
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${parts.join('')}</svg>`
}

/** G15 Jitter Strip — every record as one dot, scattered inside its band. */
export function jitterStrip(
  groups: readonly { label: string; values: readonly number[] }[],
  unitNote: string,
): string {
  const W = 1160, ROW = 44, PAD = 96
  const all = groups.flatMap(g => g.values)
  if (all.length === 0) return ''
  const peak = Math.max(...all, 1)
  const x = (v: number): number => PAD + (Math.sqrt(v / peak)) * (W - PAD - 40)
  const parts: string[] = []
  groups.forEach((group, i) => {
    const cy = 26 + i * ROW
    parts.push(`<line x1="${PAD}" y1="${cy}" x2="${W - 40}" y2="${cy}" class="grid"/>`)
    parts.push(`<text x="${PAD - 10}" y="${cy + 3}" class="cap" text-anchor="end">${esc(group.label.toUpperCase())}</text>`)
    parts.push(`<text x="${W - 34}" y="${cy + 3}" class="cap">${group.values.length}</text>`)
    group.values.forEach((value, k) => {
      const off = (jitter(k + 1, i + 5) - 0.5) * 22
      parts.push(`<circle cx="${x(value).toFixed(1)}" cy="${(cy + off).toFixed(1)}" r="1.7"`
        + ` class="jit pop" style="animation-delay:${(i * 0.08 + Math.min(k, 120) * 0.009).toFixed(3)}s"/>`)
    })
  })
  const H = 26 + groups.length * ROW + 22
  parts.push(`<text x="${PAD}" y="${H - 5}" class="unit">${esc(unitNote)}</text>`)
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${parts.join('')}</svg>`
}