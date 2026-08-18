/**
 * The page: a trajectory of what happened, and a dashboard of what it cost.
 *
 * Server-side SVG, no script, no remote asset. The chart grammar is one rule —
 * **one mark is one stated unit** — so any bar here can be counted and checked
 * rather than trusted.
 *
 * @module
 */

import type { LedgerEvent, Session, Timing } from './types.js'
import { agentLabel, AGENT_VENDOR, type AgentKind } from './types.js'
import { summarise, averageStatic, byAgent } from './summary.js'
import { profiles, type AgentProfile } from './profile.js'

const T = {
  card: '#1b1b19', ink: '#f0efeb', muted: '#8f8e88', faint: '#57574f', rule: '#2b2a26',
  paper: '#efeee9', paperInk: '#1c1c1a',
} as const

function esc(v: string): string {
  return v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function jitter(a: number, b: number): number {
  return Math.abs(((a * 73856093) ^ (b * 19349663)) % 1000) / 1000
}

/** Round unit that keeps the largest row near 40 countable marks. */
export function chooseUnit(max: number): number {
  const raw = Math.max(1, max / 40)
  return [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000]
    .find(s => s >= raw) ?? 100000
}

/**
 * Horizontal countable rows — the house chart.
 *
 * Every row keeps at least one mark, so a row worth a thousandth of the
 * largest still reads as present rather than absent. The value label takes a
 * formatter because the quantity is not always a plain count: rounding
 * milliseconds into seconds to fit a "seconds" unit is what turned 230 ms
 * into a printed zero once.
 */
function tickChart(
  rows: readonly { label: string; value: number }[],
  noun: string,
  format: (v: number) => string = v => v.toLocaleString('en-US'),
  width = 800,
): string {
  if (rows.length === 0) return '<p class="empty">Nothing recorded.</p>'
  const max = Math.max(...rows.map(r => r.value), 1)
  const unit = chooseUnit(max)
  const maxTicks = Math.max(1, Math.round(max / unit))
  const gutter = Math.min(190, 40 + Math.max(...rows.map(r => r.label.length)) * 4.6)
  const px = Math.min(11, (width - gutter - 70) / maxTicks)
  const rowH = 30
  const height = rows.length * rowH + 46
  const parts: string[] = []
  rows.forEach((row, i) => {
    const y = 22 + i * rowH
    const marks = Math.max(1, Math.round(row.value / unit))
    parts.push(`<text x="${gutter - 10}" y="${y + 3}" class="lbl" text-anchor="end">${esc(row.label)}</text>`)
    parts.push(`<line x1="${gutter}" y1="${y + 8}" x2="${(gutter + maxTicks * px).toFixed(1)}" y2="${y + 8}" class="rule"/>`)
    for (let k = 0; k < marks; k += 1) {
      const x = (gutter + k * px + px / 2).toFixed(1)
      const h = 9 + jitter(k + 1, i + 2) * 6
      parts.push(`<line x1="${x}" y1="${y + 8}" x2="${x}" y2="${(y + 8 - h).toFixed(1)}" class="tick fade"`
        + ` opacity="${(0.5 + jitter(k + 3, i + 5) * 0.5).toFixed(2)}"`
        + ` style="animation-delay:${(i * 0.1 + k * 0.012).toFixed(3)}s"/>`)
      if (k % 5 === 4) {
        parts.push(`<circle cx="${x}" cy="${y + 12}" r="0.85" class="fifth fade"`
          + ` style="animation-delay:${(i * 0.1 + k * 0.012).toFixed(3)}s"/>`)
      }
    }
    parts.push(`<text x="${(gutter + marks * px + 9).toFixed(1)}" y="${y + 3.5}" class="val fade"`
      + ` style="animation-delay:${(0.25 + i * 0.1).toFixed(3)}s">${esc(format(row.value))}</text>`)
  })
  // A row worth less than one mark still gets one, so two values three orders
  // apart can draw the same length. The label is exact; the bar is not, and
  // the chart has to say which.
  const floored = rows.filter(r => r.value > 0 && Math.round(r.value / unit) < 1).length
  parts.push(`<text x="${width / 2}" y="${height - 8}" class="unit" text-anchor="middle">一格 = ${
    esc(format(unit))}${noun === '' ? '' : ` ${noun}`} · 每五格一个点${
    floored === 0 ? '' : ` · ${floored} 行不足一格，按一格画，长度不可比，读数字`}</text>`)
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${parts.join('')}</svg>`
}

/** Chinese labels for the five event kinds. */
const KIND_LABEL: Readonly<Record<LedgerEvent['kind'], string>> = {
  user: '你', assistant: '模型', tool: '工具', system: '系统', context: '上下文',
}


/** `1,204 ms` / `2.4 s`, or a dash when nothing was recorded. */
function ms(value: number | undefined): string {
  if (value === undefined) return '—'
  return value >= 10000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value).toLocaleString('en-US')} ms`
}

/**
 * A row's own text, expandable to the untruncated original when there is one.
 *
 * The originals dominate the page weight — one export of forty sessions runs
 * to megabytes with them and a fraction of that without. A server can afford
 * them because it renders one session at a time; a file that holds every
 * session cannot, so the export leaves them out unless asked.
 */
function cell(summary: string, full: string | undefined, details: boolean, prefix = ''): string {
  const head = `${prefix}${esc(summary)}`
  if (!details || full === undefined || full.trim() === summary.trim()) return head
  return `<details><summary>${head}</summary><pre>${esc(full)}</pre></details>`
}

/**
 * The trajectory: one row per operation, with what it did on the left and
 * when it happened on the right.
 *
 * This is the view neither product offers. A transcript can be scrolled but
 * not scanned: you cannot see that one tool call took four minutes, or that a
 * turn spent nine steps talking before it touched anything.
 * @param session - the session to lay out.
 * @param cap - most rows to draw.
 * @param zoom - one of {@link ZOOMS}; how many pixels one second is worth.
 * @param compress - drop the stretches where nothing ran; see {@link project}.
 * @param details - whether rows expand to the untruncated original.
 * @returns the table, or a note when the source recorded no events.
 */

/** The badge in the leftmost column, the way a log marks its lines. */
const BADGE: Readonly<Record<LedgerEvent['kind'], string>> = {
  user: 'USER', assistant: 'MODEL', tool: 'TOOL', system: 'SYS', context: 'CTX',
}

/**
 * How many pixels one second of real time is worth.
 *
 * Naming the scale is what makes the timeline readable at all. Every earlier
 * attempt normalised each turn to the full width, which meant a bar's length
 * only meant something next to its own neighbours — the note under the chart
 * had to say "条只在同一轮内可比", which is close to saying it means nothing.
 * A fixed number of pixels per second makes every bar on the page, in every
 * turn and every session, the same kind of thing.
 *
 * The axis then gets as wide as the work actually took, and the page scrolls
 * sideways. That is the honest shape: an hour of work is an hour wide.
 */
export const ZOOMS: Readonly<Record<string, { px: number; label: string }>> = {
  // `fit` is the one scale that is not a scale: it stretches whatever this
  // session took to the width of the page. Bars stay comparable to each other
  // inside the view and stop being comparable to anything outside it, which
  // is why it says so on the chart rather than quietly reading like the rest.
  fit: { px: 0, label: '铺满' },
  wide: { px: 4, label: '疏' },
  mid: { px: 24, label: '中' },
  close: { px: 120, label: '密' },
}

/** Viewbox width a `fit` axis is stretched to. */
const FIT_WIDTH = 1200

/** A round tick interval that lands the labels roughly 90px apart. */
function tickSeconds(px: number): number {
  const raw = 90 / px
  return [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
    .find(step => step >= raw) ?? 7200
}

/** `1.5s` / `2m30s` / `1h04m`, for an axis label. */
function axisLabel(seconds: number): string {
  if (seconds < 1) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${String(Math.round(seconds))}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const r = Math.round(seconds % 60)
    return r === 0 ? `${String(m)}m` : `${String(m)}m${String(r).padStart(2, '0')}`
  }
  const h = Math.floor(seconds / 3600)
  return `${String(h)}h${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/** One record projected onto the timeline, in milliseconds from the origin. */
interface Span { start: number; end: number; index: number; lane: number; event: LedgerEvent }

/**
 * Remove the stretches where nothing was running, keep every operation's real
 * length.
 *
 * This is the projection DeepSeek Harness uses, and the distinction is the
 * whole point. Laying operations end to end — which is what an earlier version
 * here did — destroys the one thing a bar length is for: a two-second tool
 * call must be twice the bar of a one-second one. Deleting only the idle
 * between operations keeps that intact while collapsing the ten minutes of
 * nobody-typing that would otherwise squash every bar to a hairline.
 *
 * The cost is that the axis is no longer continuous, so no ruler is drawn in
 * this projection; turn boundaries mark position instead.
 */
function project(events: readonly LedgerEvent[], compress: boolean): Span[] {
  const raw: Span[] = events.map((event, index) => {
    const own = event.timing === 'measured' ? event.durationMs ?? 0 : 0
    return {
      start: event.at,
      end: event.at + own,
      index,
      lane: event.kind === 'user' ? 0 : event.kind === 'tool' ? 2 : 1,
      event,
    }
  })
  if (!compress) return raw

  const removed = new Map<Span, number>()
  let idle = 0
  let covered: number | undefined
  for (const span of [...raw].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (covered !== undefined && span.start > covered) idle += span.start - covered
    removed.set(span, idle)
    covered = covered === undefined ? span.end : Math.max(covered, span.end)
  }
  return raw.map(span => {
    const offset = removed.get(span) ?? 0
    return { ...span, start: span.start - offset, end: span.end - offset }
  })
}

/**
 * The timeline: three lanes at a stated scale, every block a link to its row.
 *
 * Clicking a block jumps to the record it stands for. DeepSeek Harness does
 * this with a select callback; the same thing without script is an anchor,
 * and the row it lands on highlights itself through `:target`.
 */
function timeline(events: readonly LedgerEvent[], px: number, compress: boolean): string {
  const spans = project(events, compress)
  const t0 = Math.min(...spans.map(s => s.start))
  const end = Math.max(...spans.map(s => s.end))
  const seconds = Math.max((end - t0) / 1000, 0.5)
  const X0 = 40
  const fit = px === 0
  const scale = fit ? (FIT_WIDTH - X0 - 24) / seconds : px
  const width = X0 + seconds * scale + 24
  const LANE_H = 11, GAP = 3, TOP = 15
  const names = ['输入', '模型', '工具']
  const bottom = TOP + names.length * (LANE_H + GAP)
  const at = (value: number): number => X0 + ((value - t0) / 1000) * scale

  const parts: string[] = []
  if (compress) {
    // Time is not continuous here, so a ruler would lie. Turn boundaries are
    // the honest landmark.
    let turn = 0
    for (const span of spans) {
      if (span.event.turn === turn) continue
      turn = span.event.turn
      const x = at(span.start)
      parts.push(`<line x1="${x.toFixed(1)}" y1="10" x2="${x.toFixed(1)}" y2="${bottom}" class="bound"/>`)
      parts.push(`<text x="${(x + 3).toFixed(1)}" y="7" class="tick">第${turn}轮</text>`)
    }
  } else {
    const step = tickSeconds(scale)
    for (let t = 0; t <= seconds + step; t += step) {
      const x = X0 + t * scale
      parts.push(`<line x1="${x.toFixed(1)}" y1="10" x2="${x.toFixed(1)}" y2="${bottom}" class="grid"/>`)
      parts.push(`<text x="${(x + 3).toFixed(1)}" y="7" class="tick">${axisLabel(t)}</text>`)
    }
  }
  names.forEach((name, i) => {
    const y = TOP + i * (LANE_H + GAP)
    parts.push(`<rect x="${X0}" y="${y}" width="${(seconds * scale).toFixed(1)}" height="${LANE_H}" class="lane"/>`)
    parts.push(`<text x="${X0 - 7}" y="${y + LANE_H - 2.5}" class="lname" text-anchor="end">${name}</text>`)
  })
  for (const span of spans) {
    const y = TOP + span.lane * (LANE_H + GAP)
    const x = at(span.start)
    const measured = span.event.timing === 'measured'
    const w = measured ? Math.max(((span.end - span.start) / 1000) * scale, 1.5) : 1.6
    const cls = span.event.isError === true ? 'op err' : measured ? 'op real' : 'op mark'
    const what = span.event.kind === 'tool' ? span.event.tool ?? '' : KIND_LABEL[span.event.kind]
    parts.push(`<a href="#r${String(span.index + 1)}"><rect x="${x.toFixed(2)}" y="${y}"`
      + ` width="${w.toFixed(2)}" height="${LANE_H}" class="${cls}">`
      + `<title>#${String(span.index + 1)} ${esc(what)} · ${ms(span.event.durationMs)}</title>`
      + `</rect></a>`)
  }
  const height = bottom + 2
  return `<div class="tlwrap"><svg viewBox="0 0 ${width.toFixed(0)} ${height}"`
    + `${fit ? '' : ` width="${width.toFixed(0)}" height="${height}"`}`
    + ` class="tl${fit ? ' fit' : ''}" role="img">${parts.join('')}</svg></div>`
}

export function trajectoryTable(
  session: Session,
  cap = 600,
  details = true,
  tail = false,
  zoom = 'mid',
  compress = true,
): string {
  const all = session.events ?? []
  // A live board reads from the end: the interesting row is the one that just
  // landed. Taking the first `cap` rows would freeze the board on the opening
  // of the session and never show what is happening now.
  const events = tail ? all.slice(Math.max(0, all.length - cap)) : all.slice(0, cap)
  if (events.length === 0) return '<p class="empty">这份记录还没有可显示的事件。</p>'

  const measured = events.filter(e => e.timing === 'measured')
  const longest = Math.max(...measured.map(e => e.durationMs ?? 0), 0)

  // A turn boundary is one thin line, the way DeepSeek Harness marks it —
  // not a header. Collapsing turns would mean one table per turn, and that
  // fights the density this view exists for.
  let turn = 0
  const rows = events.flatMap((event, i) => {
    const mark: string[] = []
    if (event.turn !== turn) {
      turn = event.turn
      mark.push(`<tr class="turnmark"><td></td><td colspan="4">第 ${turn} 轮</td></tr>`)
    }
    // Call and result share one line, the way a log does. Two wrapping columns
    // turn one record into four lines of screen and put a quarter as much of
    // the session in front of you.
    const head = event.kind === 'tool'
      ? `<b>${esc(event.tool ?? '')}</b> ${esc(event.text)}`
      : esc(event.text)
    const tail2 = event.result === undefined ? ''
      : `<span class="arrow"> → </span><span class="ret">${esc(event.result)}</span>`
    const line = `${head}${tail2}`
    const full = [event.full, event.resultFull].filter(v => v !== undefined).join('\n\n→\n\n')
    const body = details && full !== ''
      ? `<details><summary class="line">${line}</summary><pre>${esc(full)}</pre></details>`
      : `<div class="line">${line}</div>`
    // The id is what the timeline block above links to.
    mark.push(`<tr id="r${String(i + 1)}" class="k-${event.kind}${event.isError === true ? ' err' : ''}">`
      + `<td class="n">${String(i + 1).padStart(3, '0')}</td>`
      + `<td class="badge">${BADGE[event.kind]}</td>`
      + `<td class="say">${body}</td>`
      + `<td class="num t-${event.timing ?? 'none'}">${ms(event.durationMs)}</td>`
      + `<td class="num tok">${event.usage === undefined ? '' : event.usage.output.toLocaleString('en-US')}</td>`
      + `</tr>`)
    return mark
  })

  const px = (ZOOMS[zoom] ?? ZOOMS['mid'] as { px: number }).px
  // A `fit` axis has no fixed scale, so the note reports what it worked out to
  // and says plainly that the number does not travel to another session.
  const spanSeconds = Math.max((Math.max(...events.map(e =>
    e.at + (e.timing === 'measured' ? e.durationMs ?? 0 : 0)))
    - Math.min(...events.map(e => e.at))) / 1000, 0.5)
  const effective = px === 0 ? (FIT_WIDTH - 64) / spanSeconds : px
  const keep = (extra: string): string => `?zoom=${zoom}&amp;idle=${compress ? 'off' : 'on'}${extra}`
  const scale = (Object.keys(ZOOMS)).map(key => `<a href="?zoom=${key}&amp;idle=${
    compress ? 'off' : 'on'}"${key === zoom ? ' class="on"' : ''}>${
    esc((ZOOMS[key] as { label: string }).label)}</a>`).join('')
  const idle = `<a href="${keep('')}">${compress ? '看真实间隔' : '压缩空闲'}</a>`
  const note = (px === 0
    ? `铺满本页 · 1 秒 ≈ ${effective.toFixed(1)} px —— 这一档随会话长短伸缩，条长只在本页内可比，换个会话就不能比`
    : `1 秒 = ${px} px`)
    + `${compress ? ' · 已删掉没有任何操作在跑的空档，操作本身的长度是真的' : ' · 真实时间轴'}`
    + ` · 点轴上的块跳到那一行 · 实测 ${measured.length} 条，最长 ${ms(longest)}`
    + ` · 模型与你的发言只打刻度，因为那段时间已经由它下面的工具条画过了`
  const dropped = all.length - events.length
  const more = dropped === 0 ? ''
    : ` · <a href="/s/${encodeURIComponent(session.id)}">更早的 ${dropped} 条</a>`
  return `<div class="tlhead"><span class="tlunit">${
    px === 0 ? `铺满 · 1 秒 ≈ ${effective.toFixed(1)} px` : `1 秒 = ${px} px`}</span>
  <span class="zooms">${idle}${scale}</span></div>
${timeline(events, px, compress)}
<table class="log"><colgroup><col style="width:38px"/><col style="width:64px"/><col/>`
    + `<col style="width:72px"/><col style="width:56px"/></colgroup>`
    + `<tbody>${rows.join('')}</tbody></table>`
    + `<div class="src">${esc(note)}${more}</div>`
}

const STYLE = `*{box-sizing:border-box}
body{margin:0;padding:38px 30px 52px;background:${T.paper};color:${T.paperInk};
 font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1400px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:22px}
.lede{grid-column:1/-1;max-width:70ch}
.lede h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0 0 10px}
.lede p{font-size:13px;line-height:1.65;color:#55554f;margin:0 0 8px}
.meta{font-size:9.5px;font-weight:500;letter-spacing:.08em;color:${T.muted};text-transform:uppercase;margin-top:12px}
.card{background:${T.card};color:${T.ink};border-radius:16px;padding:24px 26px 20px}
.card.wide{grid-column:1/-1}
.card h2{font-size:16.5px;font-weight:700;letter-spacing:-.02em;margin:0 0 3px}
.card .sub{font-size:11.5px;color:${T.muted};margin-bottom:16px}
.src{font-size:9.5px;color:${T.muted};letter-spacing:.08em;margin-top:10px;font-weight:500;line-height:1.6}
.card .src{color:${T.faint}}
svg{width:100%;height:auto;display:block}
text{font-family:Inter,-apple-system,sans-serif}
.lbl{font-size:7px;font-weight:700;fill:${T.muted};letter-spacing:.06em}
.val{font-size:10px;font-weight:800;fill:${T.ink}}
.note{font-size:8.5px;font-weight:600;fill:${T.muted}}
.tick{stroke:${T.ink};stroke-width:.95}
.hair{stroke:${T.rule};stroke-width:.6}
.rule{stroke:${T.rule};stroke-width:.7}
.dot{fill:${T.ink};opacity:.85}
.sq{fill:${T.ink}}
.err{stroke:${T.ink};stroke-width:1.4;opacity:.9}
.fifth{fill:${T.faint}}
.unit{font-size:7px;font-weight:600;fill:${T.faint};letter-spacing:.12em}
.empty{font-size:12px;color:${T.muted}}
.figs{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin-top:6px}
.fig .n{font-size:23px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.fig .k{font-size:9px;font-weight:600;letter-spacing:.09em;color:${T.muted};text-transform:uppercase;margin-top:3px}
.ledger{grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}
th{text-align:left;font-size:9px;font-weight:600;letter-spacing:.08em;color:${T.muted};
 padding:0 10px 8px 0;border-bottom:1px solid #dedcd4}
td{padding:7px 10px 7px 0;border-bottom:1px solid #eae9e3;color:${T.paperInk};
 vertical-align:top;line-height:1.5}
td.n{font-variant-numeric:tabular-nums;color:#8f8e88;white-space:nowrap}
td.kind{font-size:10px;font-weight:700;white-space:nowrap;letter-spacing:.04em}
/* Colour marks CATEGORY, never quantity — that stays the charts' job, in
   monochrome. Three bands, not five: the eye needs somewhere to land, and the
   only lines a reader actually hunts for are "what I said" and "what it did".
   The bar carries it, not the label text: at a glance you see position and
   block, not the colour of eight-point type. */
tbody tr td:first-child{border-left:3px solid transparent}
tr.r-user td:first-child{border-left-color:#1c1c1a}
tr.r-tool td:first-child{border-left-color:#b07d2b}
tr.r-user td{background:#e7e5dd}
tr.r-user td:nth-child(3){font-weight:600}
.k-user{color:#1c1c1a}.k-assistant{color:#6b6a63}.k-tool{color:#8a6a2f}
.k-system,.k-context{color:#a3a29a}
td.res{color:#6b6a63;font-size:11px}
/* The waterfall. A bar's length is the operation's own time — measured bars
   are filled, inferred ones are outlined, because the two are not the same
   kind of fact and must not average into one another by looking alike. */
/* The log. One record is one line and it does not wrap: two wrapping columns
   turn a record into four lines of screen and put a quarter as much of the
   session in front of you. Overflow is clipped, and the full text is one
   click away rather than always occupying room. */
table.log{table-layout:fixed;width:100%;border-collapse:collapse;margin-top:10px}
table.log td{padding:1.5px 8px 1.5px 0;border:0;vertical-align:top;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.65}
table.log td.n{color:#b4b1a6;text-align:right;padding-right:10px;font-variant-numeric:tabular-nums}
table.log td.badge{font-size:9px;font-weight:700;letter-spacing:.08em;color:${T.muted};
 padding-top:3px}
table.log td.say{overflow:hidden}
table.log .line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
table.log td.num{text-align:right;font-variant-numeric:tabular-nums;font-size:10.5px;padding-top:1px}
table.log td.tok{color:#8f8e88}
table.log tr.turnmark td{padding:9px 0 3px;font-family:Inter,-apple-system,sans-serif;
 font-size:9px;font-weight:700;letter-spacing:.12em;color:${T.paperInk};
 border-bottom:1px solid #d6d3c8}
table.log .arrow{color:#b4b1a6}
table.log .ret{color:#7d7b72}
table.log tr.k-user td.badge{color:#1c1c1a}
table.log tr.k-user td.say{font-weight:600}
table.log tr.k-user{background:#e7e5dd}
table.log tr.k-tool td.badge{color:#8a6a2f}
table.log tr.k-tool b{color:#7a5c25;font-weight:700}
table.log tr.k-assistant td.say{color:#4a493f}
table.log tr.err td.say{color:#a33}
/* Landing here from a timeline block. */
table.log tr:target td{background:#ded9c6}
table.log tr:target td.say{font-weight:700}
table.log details summary.line{cursor:pointer;list-style:none}
table.log details summary::-webkit-details-marker{display:none}
table.log details[open] summary.line{white-space:normal;font-weight:600}
table.log pre{margin:4px 0 6px;padding:8px 10px;background:#e7e5dd;border-radius:5px;
 font-size:10.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;
 max-height:300px;overflow:auto;color:#3a3a34}
/* Three lanes across the full width — the shape of the whole stretch of work. */
/* Real elapsed time at a stated scale. The axis is as wide as the work took,
   so the strip scrolls sideways rather than squeezing an hour into 900px. */
.tlhead{display:flex;align-items:baseline;gap:14px;padding:2px 0 5px}
.tlunit{font-size:9.5px;font-weight:600;letter-spacing:.06em;color:#6b6a63}
.zooms{display:flex;gap:8px;margin-left:auto}
.zooms a{font-family:inherit;font-size:10px;font-weight:700;color:${T.muted};
 border-bottom:none;padding:0 4px}
.zooms a.on{color:${T.paperInk};border-bottom:2px solid ${T.paperInk}}
.tlwrap{overflow-x:auto;overflow-y:hidden;background:#f3f2ed;border-radius:5px;
 padding:2px 0 4px;border:1px solid #e2e0d7}
/* Entrance animation, per mono-tokens.js: quick in, quick stop, no bounce.
   Pure CSS — the delays are inline per mark, so the stagger needs no script.

   With script running (html.js) the marks hold still until their card scrolls
   into view, and a click replays that card — the reveal behaviour the token
   file specifies. Without script they play on load, which is right for a file
   that is opened once. */
.js .pop,.js .fade,.js .draw{animation:none}
.js .in .pop{animation:pop .5s cubic-bezier(.2,.7,.3,1.3) both}
.js .in .fade{animation:fade .9s ease both}
.js .in .draw{animation:draw 1s cubic-bezier(.4,0,.2,1) both}
.pop{transform-box:fill-box;transform-origin:center;
 animation:pop .5s cubic-bezier(.2,.7,.3,1.3) both}
@keyframes pop{from{transform:scale(0)}to{transform:none}}
.fade{animation:fade .9s ease both}
@keyframes fade{from{opacity:0}}
.draw{animation:draw 1s cubic-bezier(.4,0,.2,1) both}
@keyframes draw{from{stroke-dashoffset:var(--len)}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){
  .pop,.fade{animation:none}
  .draw{animation:none;stroke-dashoffset:0}
}
svg.tl{display:block;width:auto;height:auto;max-width:none;flex:none}
svg.tl.fit{width:100%;height:auto}
/* The summary. Same card vocabulary as everything else; the only new shapes
   are a split bar and a field of countable dots. */
.digesthead{display:flex;align-items:baseline;gap:12px;padding-bottom:8px;
 border-bottom:2px solid ${T.paperInk};margin-bottom:16px}
.digesthead .who{font-size:15px;font-weight:800;letter-spacing:-.01em}
.digesthead .dim{font-size:10.5px;color:#6b6a63;margin-left:auto}
.main .card{margin-bottom:16px}
.split{display:flex;height:34px;border-radius:5px;overflow:hidden;margin:4px 0 2px}
.seg{display:flex;align-items:center;padding:0 10px;font-size:10px;white-space:nowrap;
 overflow:hidden;min-width:0}
.seg b{font-weight:700;margin-right:5px}
.seg.s0{background:${T.ink};color:${T.card}}
.seg.s1{background:#b8b5aa;color:#1c1c1a}
.seg.s2{background:#7d7a70;color:#f0efeb}
.seg.s3{background:#56534b;color:#e4e2da}
.seg.rest{background:#332f2a;color:#8f8e88}
table.mini{width:100%;border-collapse:collapse;margin-top:12px;font-size:10.5px}
table.mini th{text-align:left;font-size:8.5px;font-weight:600;letter-spacing:.08em;
 color:${T.faint};padding:0 8px 5px 0;border-bottom:1px solid #2b2a26;
 font-family:Inter,-apple-system,sans-serif}
table.mini th.num{text-align:right}
table.mini td{padding:2.5px 8px 2.5px 0;border-bottom:1px solid #2b2a26;color:${T.ink};
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
table.mini td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.mini td.dim{color:${T.faint}}
.field{display:flex;flex-direction:column;gap:5px;margin-top:6px}
.bucket{display:flex;align-items:flex-start;gap:10px}
.blabel{width:92px;flex:none;font-size:8.5px;font-weight:700;letter-spacing:.04em;
 color:${T.muted};padding-top:1px;display:flex;justify-content:space-between}
.blabel .bn{color:${T.ink};font-weight:800}
svg.dots{flex:1;min-width:0;height:auto;max-width:100%}
svg.dots .dot{fill:${T.ink};opacity:.82}
svg .conc{fill:${T.ink};opacity:.8}
.entry.summary .ewhere{font-weight:800}
.entry.summary{border-bottom:1px solid #dcd9cf}
svg.tl .lane{fill:#e4e2da}
svg.tl .grid{stroke:#dbd8ce;stroke-width:1}
svg.tl .bound{stroke:#c0bcb0;stroke-width:1;stroke-dasharray:2 2}
svg.tl a{cursor:pointer}
svg.tl a:hover .op{fill:#8a6a2f}
svg.tl .tick{font-size:6.5px;font-weight:600;fill:#9c998f;letter-spacing:.04em;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
svg.tl .lname{font-size:6.5px;font-weight:700;fill:${T.muted};letter-spacing:.06em;
 font-family:Inter,-apple-system,sans-serif}
svg.tl .op.real{fill:#1c1c1a}
svg.tl .op.mark{fill:#a8a498}
svg.tl .op.err{fill:#a33}
/* The aggregate belongs on one line under the log, not in a half-screen card. */
.statusbar{display:flex;flex-wrap:wrap;gap:0 18px;padding:9px 0 0;margin-top:8px;
 border-top:1px solid #dedcd4;font-size:10.5px;color:#6b6a63;
 font-variant-numeric:tabular-nums}
.statusbar b{color:${T.paperInk};font-weight:700}
/* The app shell: vendors and their sessions down the left, one trajectory
   filling the right. A board you watch while working needs the list and the
   detail on screen at once, not one scrolled past the other. */
.app{display:grid;grid-template-columns:236px 1fr;min-height:100vh;gap:0}
body:has(.app){padding:0}
.side{border-right:1px solid #dcd9cf;background:#e9e7e0;padding:16px 0 0;
 display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.brand{padding:0 16px 12px;font-size:12.5px;font-weight:800;letter-spacing:-.01em;
 display:flex;align-items:center;justify-content:space-between}
.brand .live{font-size:9px;font-weight:600;letter-spacing:.06em;color:#6b6a63;
 text-transform:uppercase}
.atabs{display:flex;flex-direction:column;border-top:1px solid #dcd9cf}
.atab{display:flex;align-items:baseline;gap:7px;padding:8px 16px;border-bottom:1px solid #dcd9cf;
 border-left:3px solid transparent;font-family:inherit;font-size:11px;font-weight:600;
 color:#6b6a63;text-decoration:none}
.atab .vendor{font-weight:800;color:${T.paperInk}}
.atab .product{font-size:10px;color:#8f8e88;font-weight:500}
.atab .count{margin-left:auto;font-size:9.5px;color:#8f8e88;font-variant-numeric:tabular-nums}
.atab.on{background:${T.paper};border-left-color:${T.paperInk}}
.atab.on .product{color:#6b6a63}
.entries{flex:1;overflow-y:auto;padding:4px 0}
.entry{display:flex;flex-direction:column;gap:2px;padding:7px 16px 8px;
 border-left:3px solid transparent;font-family:inherit;text-decoration:none;border-bottom:none}
.entry:hover{background:#e3e0d8}
.entry.on{background:${T.paper};border-left-color:${T.paperInk}}
.entry .etop{display:flex;gap:8px;align-items:baseline}
.entry .ewhere{font-size:11.5px;font-weight:700;color:${T.paperInk};
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry .ewhen{margin-left:auto;font-size:9.5px;color:#8f8e88;font-variant-numeric:tabular-nums}
.entry .emeta{font-size:9.5px;color:#8f8e88}
.side-empty{padding:14px 16px;font-size:10.5px}
.sidefoot{padding:9px 16px 12px;border-top:1px solid #dcd9cf;font-size:9px;
 color:#8f8e88;line-height:1.6}
.main{padding:20px 26px 40px;min-width:0}
/* lieflat-charts: light cards by default, at most one dark card per screen.
   Lightness carries importance; there is no colour anywhere. */
.digest{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
.digest .card{background:#f4f3ee;color:${T.paperInk};border-radius:24px;padding:18px 22px 14px}
.digest .card h2{font-size:15px;font-weight:700;color:${T.paperInk}}
.digest .card .sub{font-size:11px;color:#6b6a63;margin-bottom:10px}
.digest .card .src{color:#9c998f;letter-spacing:.1em;text-transform:uppercase;font-size:8.5px}
.digest .card.dark{background:${T.card};color:${T.ink}}
.digest .card.dark h2{color:${T.ink}}
.digest .card.dark .sub{color:${T.muted}}
/* The chart classes were written when every card was dark. On paper the ink
   has to invert, or the marks are white on white. */
.digest svg{width:auto;height:auto;max-width:100%}
.digest .card .tick{stroke:${T.paperInk}}
.digest .card .val{fill:${T.paperInk}}
.digest .card .lbl{fill:#8f8e88}
.digest .card .rule{stroke:#dedcd4}
.digest .card .unit{fill:#9c998f}
.digest .card .note{fill:#6b6a63}
.digest .card .fifth{fill:#c6c5bf}
.digest .card .dot,.digest .card .sq{fill:${T.paperInk}}
.digest .card.dark .tick{stroke:${T.ink}}
.digest .card.dark .val{fill:${T.ink}}
.digest .card.dark .rule{stroke:${T.rule}}
.digest .card.dark .unit{fill:${T.faint}}
.digest .card.dark .fifth{fill:${T.faint}}
.digest .card .fig .n{color:${T.paperInk}}
.digest .card .fig .k{color:#8f8e88}
/* the marks */
.rung{stroke:${T.paperInk};stroke-width:1}
.grid{stroke:#dedcd4;stroke-width:.8}
.hair{stroke:#c2bfb4;stroke-width:.7}
.edge{fill:none;stroke:${T.paperInk};stroke-width:1}
.jit{fill:${T.paperInk};opacity:.55}
.diag{stroke:#4a4944;stroke-width:1;stroke-dasharray:2 4}
.stack{fill:#b3b0a4;opacity:.9}
.crown{fill:${T.ink}}
.bignum{font-size:11px;font-weight:800;fill:${T.paperInk};font-family:Inter,-apple-system,sans-serif}
.dnum{font-size:8.5px;font-weight:700;fill:${T.ink};font-family:Inter,-apple-system,sans-serif}
.cap{font-size:7.5px;font-weight:700;fill:#8f8e88;letter-spacing:.08em;
 font-family:Inter,-apple-system,sans-serif}
.dcap{font-size:6.5px;font-weight:600;fill:#6a6963;letter-spacing:.06em;
 font-family:Inter,-apple-system,sans-serif}
.dunit{font-size:7px;font-weight:600;fill:#57574f;letter-spacing:.12em;
 font-family:Inter,-apple-system,sans-serif}
.digest .card.wide{grid-column:1/-1}
.digest table.mini td{border-bottom-color:#e2e0d7;color:${T.paperInk}}
.digest table.mini th{color:#9c998f;border-bottom-color:#e2e0d7}
.digest table.mini td.dim{color:#9c998f}
table.mini td.one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}
table.mini.fail td{padding-top:3px;padding-bottom:3px}
.digest .card .src+table.mini{margin-top:4px}
.digest .card .src{margin-top:14px}
.digest .card.dark table.mini td{border-bottom-color:#2b2a26;color:${T.ink}}
.digest .card.dark table.mini th{color:${T.faint};border-bottom-color:#2b2a26}
.digest .ledger{grid-column:1/-1}
@media (max-width:1180px){.digest{grid-template-columns:1fr}}
.waiting{max-width:60ch;padding-top:40px}
.waiting h1{font-size:20px;font-weight:700;margin:0 0 10px}
.waiting p{font-size:13px;line-height:1.7;color:#55554f;margin:0 0 10px}
.waiting .dimp{font-size:11px;color:#8f8e88}
@media (max-width:820px){.app{grid-template-columns:1fr}.side{position:static;height:auto}}
.modes{display:flex;gap:14px;margin:2px 0 14px;font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.modes a{border-bottom:none;font-family:inherit;font-weight:600;color:${T.muted}}
.modes a.on{color:${T.paperInk};border-bottom:2px solid ${T.paperInk}}
.board{grid-column:1/-1;padding:0 0 26px}
.boardhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;
 padding-bottom:6px;border-bottom:2px solid ${T.paperInk}}
.boardhead .who{font-size:14px;font-weight:700;letter-spacing:-.01em}
.boardhead .sid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
 color:${T.muted}}
.boardhead .dim{font-size:10.5px;color:#6b6a63;margin-left:auto}
.dot.paused{background:#a8a498}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#3f7d3f;
 margin-right:7px;vertical-align:middle}
td.num{font-variant-numeric:tabular-nums;text-align:right;padding-right:14px}
th.num{text-align:right;padding-right:14px}
.dim{color:#8f8e88}
a{color:${T.paperInk};text-decoration:none;border-bottom:1px solid #c9c7bd;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:600}
a:hover{border-bottom-color:${T.paperInk}}
.lede a{font-family:inherit;font-size:inherit;font-weight:500;border-bottom:none;color:${T.muted}}
.lede a:hover{color:${T.paperInk}}
.tool{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:600}
.turnrow td{border-bottom:1.5px solid ${T.paperInk};padding-top:15px;
 font-size:10px;font-weight:700;letter-spacing:.1em;color:${T.paperInk}}
@media (max-width:1000px){.wrap{grid-template-columns:1fr}.figs{grid-template-columns:repeat(2,1fr)}}`

/** One big number with a label. */
function fig(n: string, k: string): string {
  return `<div class="fig"><div class="n">${esc(n)}</div><div class="k">${esc(k)}</div></div>`
}

/**
 * The shared document shell. One stylesheet, no script, no remote asset.
 *
 * A live board has to update itself, and the page carries no script — so the
 * refresh is a meta directive, which is HTML rather than code and keeps the
 * "no script" promise intact.
 */
function page(
  title: string, body: string,
  refreshSeconds?: number, shell = 'wrap',
): string {
  // Without script the meta refresh is the only way the board updates, so it
  // lives in <noscript>; with script the page swaps in place instead.
  const fallback = refreshSeconds === undefined ? ''
    : `<noscript><meta http-equiv="refresh" content="${String(refreshSeconds)}"/></noscript>\n`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
${fallback}<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body${refreshSeconds === undefined ? '' : ` data-refresh="${String(refreshSeconds)}"`}>
<div class="${shell}">
${body}
</div>
</body>
</html>
`
}

/** `2026-08-14 15:30`, or nothing when the source recorded no time. */
function when(at: number): string {
  return at > 0 ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') : ''
}

/** The one-line description under a session's heading. */
function sessionSub(session: Session): string {
  const t = summarise([session])
  const where = session.cwd === undefined ? '' : ` · ${esc(session.cwd.split('/').slice(-2).join('/'))}`
  const branch = session.gitBranch === undefined ? '' : ` · ${esc(session.gitBranch)}`
  const version = session.agentVersion === undefined ? '' : ` ${esc(session.agentVersion)}`
  return `${esc(session.agent)}${version} · ${when(session.startedAt)} · ${t.steps} 步 · `
    + `${t.toolCalls} 次工具调用 · 跨度 ${(t.spanMs / 1000).toFixed(1)}s${where}${branch}`
}

/** The headline card: what everything on this page cost, in eight numbers. */
function headlineCard(sessions: readonly Session[], scope: string): string {
  const totals = summarise(sessions)
  const stat = averageStatic(sessions)
  return `<div class="card wide">
  <h2>总账</h2>
  <div class="sub">${esc(scope)}</div>
  <div class="figs">
    ${stat.measuredSteps === 0
      ? fig('—', '每次请求固定携带')
      : fig(stat.total.toLocaleString('en-US'), '每次请求固定携带')}
    ${fig(`${(totals.cacheHitRate * 100).toFixed(0)}%`, '缓存命中')}
    ${// Transcripts carry no time-to-first-token, so this is zero for every
      // session read off disk. Printing "0ms" would claim an instant reply;
      // a dash says what is true — nobody measured it.
      totals.medianTtftMs === 0
        ? fig('—', '首 token 中位数')
        : fig(`${String(totals.medianTtftMs)}ms`, '首 token 中位数')}
    ${fig(`${(totals.spanMs / 60000).toFixed(1)}m`, '会话跨度')}
    ${fig(totals.input.toLocaleString('en-US'), '输入 token')}
    ${fig(totals.output.toLocaleString('en-US'), '输出 token')}
    ${fig(String(totals.steps), '步数')}
    ${fig(String(totals.toolCalls), '工具调用')}
  </div>
  <div class="src">RECORDED LOCALLY · NOTHING UPLOADED${
    stat.measuredSteps === 0
      ? ' · STATIC PAYLOAD NEEDS `agent-ledger record`, WHICH TRANSCRIPTS DO NOT CONTAIN'
      : ` · STATIC PAYLOAD FROM ${stat.measuredSteps} PROXIED STEP(S)`}</div>
</div>`
}

/**
 * The session list: every session as one row you can open.
 *
 * A dashboard that inlines every ledger stops working at about twenty
 * sessions; this machine has over a thousand. So the index carries only what
 * is cheap to know, and the reading happens one session at a time.
 */
function sessionList(sessions: readonly Session[]): string {
  if (sessions.length === 0) return '<p class="empty">没有会话。</p>'
  const rows = sessions.map(session => {
    const t = summarise([session])
    const dir = session.cwd === undefined ? '' : (session.cwd.split('/').pop() ?? '')
    const events = session.events === undefined ? '' : String(session.events.length)
    return `<tr>`
      + `<td><a href="/s/${encodeURIComponent(session.id)}">${esc(session.id.slice(0, 12))}</a></td>`
      + `<td class="kind">${esc(session.agent)}</td>`
      + `<td class="n">${esc(when(session.startedAt))}</td>`
      + `<td class="num">${t.steps}</td>`
      + `<td class="num">${t.toolCalls}</td>`
      + `<td class="num">${events}</td>`
      + `<td>${esc(dir)}${session.gitBranch === undefined ? '' : ` <span class="dim">${esc(session.gitBranch)}</span>`}</td>`
      + `</tr>`
  })
  return `<table><thead><tr>`
    + `<th style="width:130px">会话</th><th style="width:92px">AGENT</th>`
    + `<th style="width:130px">开始</th><th style="width:52px">步</th>`
    + `<th style="width:52px">工具</th><th style="width:52px">账本</th><th>位置</th>`
    + `</tr></thead><tbody>${rows.join('')}</tbody></table>`
}

/** One table of per-agent figures: agents down the side, measures across. */
function profileTable(
  rows: readonly AgentProfile[],
  columns: readonly { head: string; of: (p: AgentProfile) => string }[],
): string {
  const head = columns.map(c => `<th class="num">${esc(c.head)}</th>`).join('')
  const body = rows.map(row => `<tr><td class="kind">${esc(row.agent)}</td>`
    + columns.map(c => `<td class="num">${esc(c.of(row))}</td>`).join('')
    + '</tr>').join('')
  return `<table><thead><tr><th style="width:120px">AGENT</th>${head}</tr></thead>`
    + `<tbody>${body}</tbody></table>`
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`
const dec = (v: number): string => v.toFixed(2)
const num = (v: number): string => v.toLocaleString('en-US')

/**
 * Two agents side by side, with the line between what compares and what does
 * not drawn on the page rather than left to the reader.
 */
function comparison(sessions: readonly Session[]): string {
  const rows = profiles(sessions)
  if (rows.length < 2) return ''

  return `<div class="card wide">
  <h2>两家各自长什么样</h2>
  <div class="sub">不是排名。会话记录里没有「答得好不好」「活干完没有」「你有没有重问一遍」，
    所以「谁更强」在这里没有分子——下面只有它们各自怎么干活、各花了多少。</div>
</div>
<div class="ledger">
  ${profileTable(rows, [
    { head: '一步几个工具', of: p => dec(p.callsPerStep) },
    { head: '零工具的步', of: p => pct(p.silentStepShare) },
    { head: '每次调用几步', of: p => dec(p.stepsPerCall) },
    { head: '参数中位', of: p => num(p.argTokens) },
    { head: '缓存命中', of: p => pct(p.cacheHitRate) },
  ])}
  <div class="src">怎么干活 · 这几个数几乎不随任务大小变，是两家 harness 的设计差异，可以直接比</div>
</div>
<div class="ledger">
  ${profileTable(rows, [
    { head: '每步上下文', of: p => num(p.contextPerStep) },
    { head: '每步输出', of: p => num(p.outputPerStep) },
    { head: '每轮步数', of: p => num(p.stepsPerTurn) },
    { head: '每轮输出', of: p => num(p.outputPerTurn) },
    { head: '每轮墙钟', of: p => `${num(p.spanPerTurn)}s` },
    { head: '轮数', of: p => num(p.turns) },
  ])}
  <div class="src">花了多少 · 这几个数几乎全由「你拿它干什么」决定 —— 两家做的活不一样，
    差异就不是它们的差异。只看，别当结论</div>
</div>`
}

/**
 * The index a server hands out: what it all cost, and what there is to open.
 * @param sessions - the sessions that were parsed, newest first.
 * @param scanned - how many transcripts exist on this machine in total.
 * @param agents - which agents this machine has transcripts from.
 * @param active - the agent being shown, or `all`.
 * @returns a complete, self-contained HTML document.
 */
export function renderIndex(
  sessions: readonly Session[],
  scanned: number,
  agents: readonly string[] = [],
  active = 'all',
): string {
  const totals = summarise(sessions)
  const agentRows = [...byAgent(sessions).entries()]
    .map(([agent, list]) => ({ label: agent.toUpperCase(), value: averageStatic(list).total }))
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value)
  const toolRows = totals.topTools.slice(0, 12).map(t => ({ label: t.name.toUpperCase(), value: t.calls }))

  const perAgent = agentRows.length === 0 ? '' : `<div class="card wide">
  <h2>各 agent 开口前先背了多少</h2>
  <div class="sub">每次请求的固定负载均值 · 系统提示词 + 工具 schema</div>
  ${tickChart(agentRows, 'TOKEN')}
  <div class="src">固定负载 · 实测自真实请求</div>
</div>`

  const tools = toolRows.length === 0 ? '' : `<div class="card wide">
  <h2>哪些工具真的跑了</h2>
  <div class="sub">已读会话中的调用次数</div>
  ${tickChart(toolRows, '次调用')}
  <div class="src">工具调用 · 取自会话记录</div>
</div>`

  return page('Agent Ledger', `<div class="lede">
  <h1>你的 agent 到底做了什么</h1>
  <p>数据来自 Claude Code 与 Codex 自己写在本机的会话记录。点开任意一个会话，看它这一趟走了什么路。
     全程只读本地文件，不上传任何内容。</p>
  <div class="meta">本机共 ${scanned} 个会话记录 · 已读最近 ${sessions.length} 个 · ${totals.steps} 步</div>
</div>
${headlineCard(sessions, `最近 ${sessions.length} 个会话 · 本机共 ${scanned} 个`)}
${comparison(sessions)}
${perAgent}
${tools}
<div class="card wide">
  <h2>会话</h2>
  <div class="sub">按最后写入时间排序 · 点会话号打开轨迹</div>
</div>
<div class="ledger">
  ${agents.length < 2 ? '' : `<div class="modes">${
    ['all', ...agents].map(key => `<a href="?agent=${encodeURIComponent(key)}"${
      key === active ? ' class="on"' : ''}>${key === 'all' ? '全部' : esc(key)}</a>`).join('')
  }</div>`}
  ${sessionList(sessions)}
</div>`)
}

/**
 * One session, in full: the shape of it, then the line-by-line of it.
 * @param session - the session to show.
 * @returns a complete, self-contained HTML document.
 */
export function renderSession(session: Session, zoom = 'mid', compress = true): string {
  const body = `<div class="lede">
  <div class="meta"><a href="/">← 全部会话</a></div>
  <h1>会话 ${esc(session.id.slice(0, 12))}</h1>
  <p>${sessionSub(session)}</p>
</div>
${headlineCard([session], '本次会话')}
<div class="card wide">
  <h2>轨迹</h2>
  <div class="sub">一行一个操作 · 条的长度是它自己花的时间 · 点开任意一行看全文</div>
</div>
<div class="ledger">${trajectoryTable(session, 600, true, false, zoom, compress)}</div>`
  return page(`会话 ${session.id.slice(0, 12)} — Agent Ledger`, body)
}

/**
 * Render the whole ledger: headline figures, per-agent cost, trajectories.
 *
 * One file holds every session, so the per-session row cap matters here in a
 * way it does not on a server: the page has no virtualisation and a reader
 * has no way to ask for more.
 * @param sessions - everything recorded.
 * @param cap - most trajectory rows per session.
 * @param details - whether rows expand to the untruncated original.
 * @returns a complete, self-contained HTML document.
 */
export function renderDashboard(sessions: readonly Session[], cap = 200, details = false): string {
  const totals = summarise(sessions)
  const agents = byAgent(sessions)

  const agentRows = [...agents.entries()]
    .map(([agent, list]) => ({ label: agent.toUpperCase(), value: averageStatic(list).total }))
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value)

  const toolRows = totals.topTools.slice(0, 12).map(t => ({ label: t.name.toUpperCase(), value: t.calls }))

  const headline = headlineCard(sessions, `全部记录 · ${totals.sessions} 个会话`)

  const perAgent = agentRows.length === 0 ? '' : `<div class="card wide">
  <h2>各 agent 开口前先背了多少</h2>
  <div class="sub">每次请求的固定负载均值 · 系统提示词 + 工具 schema</div>
  ${tickChart(agentRows, 'TOKEN')}
  <div class="src">固定负载 · 实测自真实请求</div>
</div>`

  const tools = toolRows.length === 0 ? '' : `<div class="card wide">
  <h2>哪些工具真的跑了</h2>
  <div class="sub">所有已记录步骤的调用次数</div>
  ${tickChart(toolRows, '次调用')}
  <div class="src">工具调用 · 取自会话记录</div>
</div>`

  // Newest first, across agents. Read order is the one thing a single file can
  // offer instead of navigation, so the session you just finished is on top.
  const ordered = [...sessions].sort((a, b) => b.startedAt - a.startedAt)

  const traces = ordered.map(session => `<div class="card wide">
  <h2>会话 ${esc(session.id.slice(0, 12))}</h2>
  <div class="sub">${sessionSub(session)}</div>
</div>
<div class="ledger">${trajectoryTable(session, cap, details)}</div>`).join('\n')

  return page('Agent Ledger — 你的 agent 到底做了什么', `<div class="lede">
  <h1>你的 agent 到底做了什么</h1>
  <p>数据来自 Claude Code 与 Codex 自己写在本机的会话记录。每一个数字都对应一次真实请求：
     开口前先背了什么、回来了什么、花了多久、动用了哪些工具。全程只读本地文件，不上传任何内容。</p>
  <div class="meta">${totals.sessions} 个会话 · ${totals.steps} 步 · 本地读取</div>
</div>
${headline}
${perAgent}
${tools}
${traces}`)
}
