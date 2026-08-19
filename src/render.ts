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
import { digest, type Digest, type Ranked } from './digest.js'
import type { WorkbuddyDetail } from './workbuddy.js'
import { summarise, averageStatic, byAgent } from './summary.js'
import { profiles, type AgentProfile } from './profile.js'
import { T, esc, jitter, ms, money, moneyAll, span } from './html.js'
import { costOf, priceNote, spendOf, PRICED_AT } from './price.js'
import { RANGES } from './live.js'
import { laddersFor, hueFor, MONO } from './palette.js'

/**
 * Where this came from, for the page that travels.
 *
 * An exported file gets mailed, and whoever opens it has no way to find out
 * what made it. One line at the foot costs nothing and leaks nothing — it
 * names the tool, not the machine, and the promise above it stays true.
 */
const HOME = 'https://github.com/SilasSolivagus/agent-ledger'
import { hairlineArea, hundredField, jitterStrip, tickDonut } from './charts.js'


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

/**
 * The money cell for one record.
 *
 * Empty when the record was not a request at all — your own messages and tool
 * calls buy nothing. A dash when it was a request whose model has no price:
 * that record did cost something, and printing a zero would say it did not.
 */
function cell2(event: LedgerEvent): string {
  if (event.usage === undefined) return ''
  const cost = costOf(event.usage, event.model, event.at)
  return cost === undefined ? '<span class="dim">—</span>' : money(cost)
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
      mark.push(`<tr class="turnmark"><td></td><td colspan="5">第 ${turn} 轮</td></tr>`)
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
      // A record that carried tokens but no usable model name gets a dash,
      // never a zero: it cost something, and what it cost is not knowable.
      + `<td class="num cost">${cell2(event)}</td>`
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
    + `${compress ? ' · 已压缩无操作运行的空档，操作本身的长度未改' : ' · 真实时间轴'}`
    + ` · 点轴上的块跳到那一行 · 实测 ${measured.length} 条，最长 ${ms(longest)}`
    + ` · 模型与用户发言只标刻度，该时段已由其下方的工具条表示`
  const dropped = all.length - events.length
  const more = dropped === 0 ? ''
    : ` · <a href="/s/${encodeURIComponent(session.id)}">更早的 ${dropped} 条</a>`
  return `<div class="tlhead"><span class="tlunit">${
    px === 0 ? `铺满 · 1 秒 ≈ ${effective.toFixed(1)} px` : `1 秒 = ${px} px`}</span>
  <span class="zooms">${idle}${scale}</span></div>
${timeline(events, px, compress)}
<table class="log"><colgroup><col style="width:38px"/><col style="width:64px"/><col/>`
    + `<col style="width:72px"/><col style="width:56px"/><col style="width:66px"/></colgroup>`
    + `<tbody>${rows.join('')}</tbody></table>`
    + `<div class="src">${esc(note)}${more}</div>`
}


/**
 * The only script in the product, and only on the live board.
 *
 * It buys three things a self-reloading page cannot have. Charts play when
 * scrolled into view and replay on click, which is the reveal behaviour
 * mono-tokens.js specifies. The refresh swaps the parts that changed instead
 * of reloading, so the animation does not restart every few seconds and the
 * scroll position survives. And with script off, the noscript meta refresh
 * takes over, so the board still updates.
 *
 * The export and the session page carry no script at all: a file on disk has
 * to open with no network and nothing running.
 */
const BOARD_SCRIPT = `(()=>{
var D=document;D.documentElement.classList.add('js');
var reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
var io=reduce?null:new IntersectionObserver(function(es){
  es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})
},{threshold:.12});
function arm(scope){
  if(!io){scope.querySelectorAll('.card').forEach(function(c){c.classList.add('in')});return}
  scope.querySelectorAll('.card:not(.in)').forEach(function(c){io.observe(c)})
}
arm(D);
D.addEventListener('click',function(ev){
  var t=ev.target,card=t.closest&&t.closest('.card');
  if(!card||reduce||(t.closest&&t.closest('a,summary')))return;
  card.classList.remove('in');void card.offsetWidth;card.classList.add('in')
});
var every=Number(D.body.dataset.refresh||0),pulse=D.body.dataset.pulse||'',timer=0,busy=0;
function swap(fresh,sel){
  var a=D.querySelector(sel),b=fresh.querySelector(sel);
  if(!a||!b)return;
  a.innerHTML=b.innerHTML
}
function plan(){if(every>0)timer=setTimeout(tick,every*1000)}
function tick(){
  if(busy)return;
  busy=1;
  fetch('/pulse',{cache:'no-store'}).then(function(r){return r.text()}).then(function(v){
    if(v===pulse)return;
    pulse=v;
    return fetch(location.href,{cache:'no-store'}).then(function(r){return r.text()}).then(function(t){
      var fresh=new DOMParser().parseFromString(t,'text/html');
      if(io)io.disconnect();
      swap(fresh,'.entries');swap(fresh,'.atabs');swap(fresh,'main.main');
      arm(D)
    })
  }).catch(function(){}).then(function(){busy=0;plan()})
}
plan();
addEventListener('pagehide',function(){clearTimeout(timer);timer=0});
D.addEventListener('visibilitychange',function(){
  if(D.hidden){clearTimeout(timer);timer=0}
  else if(!timer){tick()}
})
})()`

/** `14:32:07`, in the reader's own clock. */
function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

/**
 * One session's heading, and the one line of aggregate under its log.
 *
 * The figures live in a status bar rather than a card. A card the height of
 * half the screen buys eight numbers you already knew and pushes the thing
 * you came to read below the fold.
 */
function boardHeading(session: Session): string {
  const where = session.cwd === undefined ? '' : ` · ${esc(session.cwd.split('/').slice(-2).join('/'))}`
  const branch = session.gitBranch === undefined ? '' : ` · ${esc(session.gitBranch)}`
  const turns = session.events === undefined ? 0 : Math.max(0, ...session.events.map(e => e.turn))
  return `<div class="boardhead">
  <span class="who">${esc(agentLabel(session.agent))}</span>
  <span class="sid">${esc(session.id.slice(0, 12))}</span>
  <span class="dim">起于 ${clock(session.startedAt)} · 第 ${turns} 轮${where}${branch}</span>
</div>`
}

/** The aggregate for one session, on one line. */
function statusBar(session: Session): string {
  const t = summarise([session])
  const events = session.events ?? []
  const spend = spendOf(events)
  const measured = events.filter(e => e.timing === 'measured')
  const toolMs = measured.reduce((sum, e) => sum + (e.durationMs ?? 0), 0)
  const turns = Math.max(0, ...events.map(e => e.turn), 0)
  const cache = t.input + t.cacheRead === 0 ? '—' : `${(t.cacheHitRate * 100).toFixed(0)}%`
  return `<div class="statusbar">
  <span><b>${turns}</b> 轮 · <b>${t.steps}</b> 步 · <b>${t.toolCalls}</b> 次工具调用</span>
  <span>工具实测 <b>${ms(toolMs)}</b>（${measured.length} 条）</span>
  <span>缓存命中 <b>${cache}</b></span>
  <span>输入 <b>${t.input.toLocaleString('en-US')}</b> · 输出 <b>${t.output.toLocaleString('en-US')}</b> token</span>
  <span>${spend.priced === 0
    ? '花费 <b>—</b>（这个来源不报告用量）'
    : `花费 <b>${moneyAll(spend.totals)}</b>${spend.unpriced === 0 ? '' : ` · ${String(spend.unpriced)} 条无价`}`}</span>
</div>`
}

/** One row in the sidebar's session list. */
function sideEntry(session: Session, agent: string, active: boolean, range = 'watch'): string {
  const events = session.events ?? []
  const turns = Math.max(0, ...events.map(e => e.turn), 0)
  const where = session.cwd === undefined ? '' : session.cwd.split('/').pop() ?? ''
  const t = summarise([session])
  return `<a class="entry${active ? ' on' : ''}"
  href="?agent=${encodeURIComponent(agent)}&amp;s=${encodeURIComponent(session.id)}${
    range === 'watch' ? '' : `&amp;range=${range}`}">
  <span class="etop"><span class="ewhere">${esc(where || session.id.slice(0, 12))}</span>
  <span class="ewhen">${clock(session.startedAt)}</span></span>
  <span class="emeta">第 ${turns} 轮 · ${t.steps} 步 · ${t.toolCalls} 次工具</span>
</a>`
}

/**
 * The live board: what your agents are doing right now.
 *
 * Laid out the way DeepSeek Harness lays it out — vendors and their sessions
 * down the left, one trajectory filling the right. Everything already on disk
 * when watching began is excluded, so an empty board is the correct answer
 * until you say something to an agent, not a failure to find anything.
 * @param boards - live sessions per agent, newest first.
 * @param watching - agents whose transcript directory exists on this machine.
 * @param since - when watching began.
 * @param active - the agent whose sessions are listed.
 * @param chosen - the session shown on the right, newest when unset.
 * @param refreshSeconds - how often the page reloads itself.
 * @returns a complete, self-contained HTML document.
 */
/**
 * What stretch of time this board is answering for.
 *
 * `clock` alone was wrong here, and quietly: it prints a time of day and
 * nothing else, so 近 7 天 and 近 30 天 both rendered as the same
 * `自 16:55:25 起` despite starting 23 days apart, and 全部 rendered its
 * epoch-zero start as `自 08:00:00 起` — 1970 read as this morning. A reader
 * had no way to tell which window they were looking at from the label meant
 * to tell them.
 *
 * A start inside today needs no date; anything older is useless without one.
 * @param since - the instant the window opens.
 * @param range - which window, since `all` has no meaningful start.
 * @param now - the current instant.
 */
function windowNote(since: number, range: string, now = Date.now()): string {
  if (range === 'all') return '全部记录'
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  if (since >= midnight.getTime()) return `自 ${clock(since)} 起`
  const d = new Date(since)
  return `自 ${String(d.getMonth() + 1)} 月 ${String(d.getDate())} 日 ${
    String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 起`
}

/**
 * Every token the request moved, the way a vendor's own counter reports it.
 *
 * The four buckets are kept apart everywhere else because they are billed
 * apart — a cache read costs a tenth of fresh input, so a spend figure that
 * added them would be wrong by an order of magnitude. But nobody's usage page
 * splits them, and a reader comparing this board against their bill was
 * handed 「输入 TOKEN」 — the fresh slice alone, which on a cache-heavy
 * machine is two percent of the truth. So the sum gets its own figure, named
 * for what it is.
 */
function grossTokens(t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/**
 * The one view the per-vendor board cannot give you.
 *
 * Every other tab answers "what is this agent doing". This one answers "how do
 * these two differ", which needs them side by side and therefore needs a place
 * that is not any one of them. It used to live behind `serve --history`, which
 * meant the most distinctive thing this product knows how to say was reachable
 * only by restarting with a flag nobody would guess at.
 *
 * It inherits the window like everything else here, so "今天这两家各自什么样"
 * is now a question that can be asked at all.
 * @param sessions - every session in the window, across vendors.
 * @param since - when the window opens.
 * @param range - which window, for the label that names it.
 * @returns the comparison panels, or an invitation when only one vendor ran.
 */
function crossVendor(
  sessions: readonly Session[], since: number, range: string, colour: boolean,
): string {
  const kinds = new Set(sessions.map(one => one.agent))
  // Two vendor names is not two comparable things. Every figure in this panel
  // is per step, and a source that records no steps — WorkBuddy keeps only
  // session-level rows, Cursor reports no usage at all — cannot supply one.
  // Counting it would put a tab on screen whose contents are then blank.
  const comparable = profiles(sessions).map(one => one.agent)
  if (comparable.length < 2) {
    const mute = [...kinds].filter(one => !comparable.includes(one))
    return `<div class="waiting">
  <h1>暂无可比较的两个来源</h1>
  <p>这一栏把两个 agent 放在同一把尺子上量，量的都是「每一步」——一步几个工具、每步多少上下文。
     ${comparable.length === 0 ? '这个窗口里还没有一家' : `目前只有 ${
       comparable.map(a => esc(agentLabel(a))).join('、')} 一家`}报告了步。</p>
  ${mute.length === 0 ? '' : `<p class="dimp">${mute.map(a => esc(agentLabel(a))).join('、')
    } 在这个窗口里有会话，但不记录步 —— 不是零，是该来源没有这一字段。</p>`}
  <p class="dimp">运行另一个 agent，或将窗口放宽至「今天」「全部」。</p>
</div>`
  }
  const totals = summarise(sessions)
  const agentRows = [...byAgent(sessions).entries()]
    .map(([agent, list]) => ({ label: agent.toUpperCase(), value: averageStatic(list).total }))
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value)
  const toolRows = totals.topTools.slice(0, 12).map(t => ({ label: t.name.toUpperCase(), value: t.calls }))

  const payload = agentRows.length === 0 ? '' : `<div class="card wide">
  <h2>每次请求的固定负载</h2>
  <div class="sub">每次请求的固定负载均值 · 系统提示词 + 工具 schema</div>
  ${tickChart(agentRows, 'TOKEN')}
</div>`
  const tools = toolRows.length === 0 ? '' : `<div class="card wide">
  <h2>工具调用次数</h2>
  <div class="sub">本窗口内的调用次数</div>
  ${tickChart(toolRows, '次调用')}
</div>`

  return `<div class="digesthead"><span class="who">跨厂商对比</span>
  <span class="dim">${[...kinds].map(a => esc(agentLabel(a))).join(' · ')} · ${windowNote(since, range)}</span></div>
<div class="digest">${headlineCard(sessions, `${sessions.length} 个会话 · ${[...kinds].length} 家`)}
${comparison(sessions, colour)}
${payload}
${tools}</div>`
}

/**
 * Nothing to show, said in as few words as the sidebar leaves room for.
 *
 * This used to be a paragraph: which instant the board started at, how to make
 * something appear, that history was excluded, and a roll-call of what was
 * being watched with per-agent counts. Every one of those is already on
 * screen — the window picker names the window, the footer names the instant,
 * and the tabs are the roll-call, with the counts in them. Restating it made
 * the emptiest screen in the product the wordiest.
 *
 * What is left is the one thing not visible elsewhere: the next click.
 * @param active - the selected agent, or '' when this machine has none.
 * @param watching - every installed source.
 * @param looked - where it looked, shown only when it found nothing at all.
 * @param range - the current window, so the advice does not suggest itself.
 */
function emptyBoard(
  active: string, watching: readonly string[], looked: readonly string[], range: string,
): string {
  if (watching.length === 0) {
    return `<div class="waiting">
  <h1>未检测到 agent</h1>
  <p>未检测到任何来源的记录目录。安装 Claude Code、Codex 或 Cursor 其中之一，或等待 WorkBuddy 建立数据库后，重新运行本命令。</p>
  <p class="dimp">找过这些位置：<br/>${looked.map(one => esc(one)).join('<br/>')}</p>
</div>`
  }
  return `<div class="waiting">
  <h1>${active === '' ? '这个窗口里还没有活动' : `${esc(agentLabel(active))} 在这个窗口里没有活动`}</h1>
  ${range === 'all' ? '' : '<p>把窗口拉宽到「今天」或「全部」，看它之前干了什么。</p>'}
</div>`
}

export function renderLive(
  boards: ReadonlyMap<string, Session[]>,
  watching: readonly string[],
  since: number,
  active: string,
  chosen?: string,
  refreshSeconds: number | null = 5,
  zoom = 'mid',
  compress = true,
  sourceDetails: readonly WorkbuddyDetail[] = [],
  range = 'watch',
  /** How many sessions the per-agent budget kept off this board, if any. */
  capped?: { dropped: number; limit: number },
  /** Every path this machine was searched at, for the found-nothing case. */
  looked: readonly string[] = [],
  /** Fingerprint of what is on disk, so a refresh can ask before it fetches. */
  pulse = '',
  /** `--color`: hue encodes which vendor, lightness still encodes how much. */
  colour = false,
): string {
  const agents = [...boards.keys()]
  // Every link on this page has to carry the window, or clicking a vendor
  // silently drops you back to "since I started" — which looks like the data
  // vanished rather than like the filter reset.
  const keepRange = range === 'watch' ? '' : `&amp;range=${range}`
  // The comparison needs two vendors to be a comparison at all, so its tab
  // appears only when two have run. One agent alone gets no switcher, which is
  // the rule the old index followed for the same reason.
  const everySession = [...boards.values()].flat().sort((a, b) => b.startedAt - a.startedAt)
  // The same test the panel itself uses, so a tab never opens onto a blank.
  const crossable = profiles(everySession).length >= 2
  const list = active === 'all' ? everySession : boards.get(active) ?? []
  // No session picked means the vendor tab itself, and that is the summary.
  const session = chosen === undefined ? undefined : list.find(one => one.id === chosen)
  const total = [...boards.values()].reduce((t, one) => t + one.length, 0)

  // Every installed source gets a tab, whether or not it has been busy. Listing
  // only the ones with activity meant that as soon as one agent moved, the others
  // vanished from the switcher — so there was no way to switch, and no way to
  // tell they were supported. The count column exists for exactly this: an
  // agent with nothing yet reads as a dash, not as absent.
  const vendorTabs = [...new Set([...watching, ...agents])].sort()
  const shownTabs = crossable ? ['all', ...vendorTabs] : vendorTabs
  const tabs = shownTabs.map(key => {
    const count = key === 'all' ? everySession.length : (boards.get(key) ?? []).length
    // The one place "Anthropic is rust" has to be true, because every other
    // mark that carries a vendor's hue is read against this tab.
    const bar = colour && key !== 'all'
      ? ` style="box-shadow:inset 3px 0 0 ${hueFor(key, vendorTabs)[0]}"` : ''
    return `<a class="atab${key === active ? ' on' : ''}${key === 'all' ? ' cross' : ''}"${bar} href="?agent=${encodeURIComponent(key)}${keepRange}">
    <span class="vendor">${key === 'all' ? '跨厂商' : esc(AGENT_VENDOR[key as AgentKind]?.vendor ?? key)}</span>
    <span class="product">${key === 'all' ? '放在一把尺子上' : esc(AGENT_VENDOR[key as AgentKind]?.product ?? '')}</span>
    <span class="count">${count === 0 ? '—' : String(count)}</span></a>`
  }).join('')

  // With nothing installed there is no summary to open, no window worth
  // changing and no agent for "this agent" to refer to. The sidebar goes
  // quiet rather than offering three controls that all lead nowhere.
  const bare = watching.length === 0

  // The window picker sits under the vendor tabs because it is the same kind
  // of control: which slice of the world this board is about. `watch` is the
  // default and the reason the product exists, so it leads.
  const windows = bare ? '' : `<div class="ranges">${Object.entries(RANGES).map(([key, label]) =>
    `<a href="?agent=${encodeURIComponent(active)}${key === 'watch' ? '' : `&amp;range=${key}`}"${
      key === range ? ' class="on"' : ''}>${esc(label)}</a>`).join('')}</div>`

  const entries = bare ? '' : `<a class="entry summary${session === undefined ? ' on' : ''}"
    href="?agent=${encodeURIComponent(active)}${keepRange}"><span class="etop">
    <span class="ewhere">总览</span></span>
    <span class="emeta">${list.length} 个会话加起来</span></a>`
    + (list.length === 0
      ? '<div class="empty side-empty">这个 agent 还没有新活动</div>'
      : list.map(one => sideEntry(one, active === 'all' ? one.agent : active,
        one.id === session?.id, range)).join(''))

  const noRecords = list.length > 0 && list.every(one => one.steps.length === 0 && (one.events ?? []).length === 0)
  const main = active === 'all' && session === undefined
    ? crossVendor(everySession, since, range, colour)
    : session === undefined && list.length > 0
    ? `<div class="digesthead"><span class="who">${esc(agentLabel(active))}</span>
  <span class="dim">总览 · ${list.length} 个活跃会话 · ${windowNote(since, range)}</span></div>
<div class="digest">${noRecords
    ? renderSourceBoard(sourceDetails.filter(d => list.some(one => one.id === d.id)))
    : renderDigest(digest(active, list), colour)}</div>`
    : session === undefined
    ? emptyBoard(active, watching, looked, range)
    : `${boardHeading(session)}
${trajectoryTable(session, 200, true, true, zoom, compress)}
${statusBar(session)}`

  return page('Agent Ledger — 实时轨迹', `<aside class="side">
  <div class="brand">Agent Ledger<span class="live"><span class="dot${refreshSeconds === null ? ' paused' : ''}"></span>${
    total === 0 ? (refreshSeconds === null ? '已暂停' : '监听中') : `${total} 个活跃会话`}</span></div>
  <nav class="atabs">${tabs}</nav>
  ${windows}
  <div class="entries">${entries}</div>
  <a class="home" href="${HOME}" target="_blank" rel="noreferrer">
    <span class="hlabel">开源项目 · runledger</span>
    <span class="hgo">GitHub ↗</span></a>
  <div class="sidefoot">${capped === undefined ? '' : `另有 ${capped.dropped} 个会话没读进来（每来源上限 ${capped.limit}，用 --limit 调）<br/>`}<span class="wnote">${windowNote(since, range)}</span> · ${refreshSeconds === null ? `<b>已暂停</b> · <a href="?agent=${encodeURIComponent(active)}${keepRange}">继续自刷</a>` : `每 ${refreshSeconds} 秒自刷 · <a href="?agent=${encodeURIComponent(active)}${keepRange}&amp;live=off">暂停</a>`} · 只读本地文件</div>
</aside>
<main class="main">${main}</main>`, refreshSeconds ?? undefined, 'app', true, pulse)
}

/** A ranked breakdown: proportion above, exact figures below. */
function rankedCard(
  title: string, sub: string, rows: readonly Ranked[],
  format: (v: number) => string, unit: string,
): string {
  if (rows.length === 0) return ''
  const byCalls = rows.every(r => r.totalMs === 0)
  const top = (byCalls ? [...rows].sort((a, b) => b.calls - a.calls) : rows).slice(0, 12)
  const table = `<table class="mini"><thead><tr><th></th><th class="num">调用</th>`
    + `<th class="num">合计</th><th class="num">中位</th></tr></thead>`
    + `<tbody>${top.map(r => `<tr><td>${esc(r.name)}</td>`
      + `<td class="num">${r.calls.toLocaleString('en-US')}</td>`
      + `<td class="num">${byCalls ? '' : esc(unit === '' ? span(r.totalMs) : format(r.totalMs))}</td>`
      + `<td class="num dim">${r.medianMs > 0 ? ms(r.medianMs) : ''}</td></tr>`).join('')}</tbody></table>`
  return `<div class="card">
  <h2>${esc(title)}</h2>
  <div class="sub">${esc(sub)}</div>
  ${tickChart(top.map(r => ({
    label: r.name.toUpperCase(), value: byCalls ? r.calls : r.totalMs,
  })), unit, format, 520)}
  ${table}
</div>`
}

/**
 * Every measured call as one countable mark, bucketed by duration.
 *
 * One dot is one call and the bucket edges are printed, so the shape can be
 * verified by counting. Buckets step by roughly powers of ten because the
 * durations do.
 */
function durationField(d: Digest): string {
  if (d.durations.length === 0) return ''
  const edges = [0, 10, 50, 200, 1000, 5000, 30_000, 120_000, Infinity]
  const names = ['< 10 ms', '10–50 ms', '50–200 ms', '0.2–1 s', '1–5 s', '5–30 s', '30 s–2 min', '> 2 min']
  const buckets = names.map(() => 0)
  for (const value of d.durations) {
    const seat = edges.findIndex((edge, i) => value >= edge && value < (edges[i + 1] ?? Infinity))
    if (seat >= 0) buckets[seat] = (buckets[seat] ?? 0) + 1
  }
  // A bucket that nothing fell into still belongs on the axis: an absent row
  // reads as a missing bucket rather than as an empty one.
  const rows = names.map((name, i) => ({ label: name, value: buckets[i] ?? 0 }))
  return `<div class="card wide">
  <h2>调用耗时分布</h2>
  <div class="sub">${d.durations.length.toLocaleString('en-US')} 次实测调用 · 每个点是一次调用</div>
  ${jitterStrip(
    d.tools.slice(0, 6).map(t => ({ label: t.name, values: t.durations })),
    '横轴按平方根压缩，长尾不吞掉短调用 · 一个点 = 一次调用 · 右端数字为该工具调用次数')}
  <div class="src">仅含配对到返回值的调用；推算时长不计入</div>
</div>`
}

/** Sessions running at the same time, stepping as the count changed. */
function concurrencyCard(d: Digest): string {
  if (d.concurrency.length < 2) return ''
  const peak = Math.max(...d.concurrency.map(c => c.live), 1)
  const t0 = d.concurrency[0]?.at ?? 0
  const t1 = d.concurrency.at(-1)?.at ?? t0 + 1
  const W = 900, H = 74, X0 = 26
  const x = (at: number): number => X0 + ((at - t0) / Math.max(1, t1 - t0)) * (W - X0 - 10)
  const y = (n: number): number => H - 14 - (n / peak) * (H - 26)
  const parts: string[] = []
  for (let n = 1; n <= peak; n += 1) {
    parts.push(`<line x1="${X0}" y1="${y(n)}" x2="${W - 10}" y2="${y(n)}" class="rule"/>`)
    parts.push(`<text x="${X0 - 5}" y="${y(n) + 2.5}" class="lbl" text-anchor="end">${n}</text>`)
  }
  let prev = d.concurrency[0]
  for (const point of d.concurrency.slice(1)) {
    if (prev === undefined) break
    parts.push(`<rect x="${x(prev.at).toFixed(1)}" y="${y(prev.live).toFixed(1)}"`
      + ` width="${Math.max(x(point.at) - x(prev.at), 0.8).toFixed(1)}"`
      + ` height="${(H - 14 - y(prev.live)).toFixed(1)}" class="conc"/>`)
    prev = point
  }
  parts.push(`<text x="${X0}" y="${H - 3}" class="unit">${clock(t0)}</text>`)
  parts.push(`<text x="${W - 10}" y="${H - 3}" class="unit" text-anchor="end">${clock(t1)}</text>`)
  return `<div class="card wide">
  <h2>会话并发</h2>
  <div class="sub">峰值 ${peak} 个 · ${d.concurrency.length} 次变化</div>
  ${hairlineArea(d.concurrency.map(c => ({ at: c.at, value: c.live })),
    '一根发丝 = 一个采样时刻 · 纵轴一格 = 1 个会话')}
  <div class="src">并发是工具占用时间高于墙钟时间的原因</div>
</div>`
}

/** Token accounting for the window. */
function tokenCard(d: Digest, colour: boolean): string {
  const rows = [
    { label: '新鲜输入', value: d.input },
    { label: '缓存读', value: d.cacheRead },
    { label: '缓存写', value: d.cacheWrite },
    { label: '输出', value: d.output },
  ].filter(r => r.value > 0)
  if (rows.length === 0) return ''
  const n = (v: number): string => v.toLocaleString('en-US')
  const sum = rows.reduce((t, r) => t + r.value, 0)
  return `<div class="card wide">
  <h2>token 消耗</h2>
  <div class="sub">共 ${n(sum)} token 经手 · 缓存命中 ${(d.cacheHitRate * 100).toFixed(0)}%</div>
  ${hundredField(
    rows.map(r => ({ label: `${r.label} ${n(r.value)}`, pct: (r.value / sum) * 100 })),
    colour ? laddersFor(rows.map(r => r.label), true) : undefined)}
  <table class="mini"><tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td>`
    + `<td class="num">${n(r.value)}</td>`
    + `<td class="num dim">${((r.value / sum) * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>
  <div class="src">输入口径已统一为仅含新鲜输入，缓存读单列 —— OpenAI 将缓存计入 input，Anthropic 计在其外</div>
</div>`
}

/** Calls that reported failure, most recent first. */
function failureCard(d: Digest): string {
  if (d.failures.length === 0) {
    return `<div class="card wide"><h2>调用失败</h2>
  <div class="sub">窗口内无失败记录</div></div>`
  }
  return `<div class="card wide">
  <h2>调用失败</h2>
  <div class="sub">共 ${d.errors} 条 · 列出最近 ${d.failures.length} 条</div>
  <table class="mini fail"><colgroup><col style="width:74px"/><col style="width:110px"/><col/></colgroup>
  <tbody>${d.failures.map(f => `<tr>`
    + `<td class="num dim">${esc(clock(f.at))}</td>`
    + `<td>${esc(f.tool)}</td>`
    + `<td class="one">${esc(f.text)}<span class="arrow"> → </span>`
    + `<span class="ret">${esc(f.result)}</span></td></tr>`).join('')}</tbody></table>`
}

/**
 * The summary a vendor tab opens onto.
 * @param d - that vendor's live sessions, added up.
 * @returns the panels, in reading order.
 */
/**
 * What the window cost, with the size of what it could not cost beside it.
 *
 * Absent entirely when nothing here reports tokens — Cursor and WorkBuddy
 * never do — because an empty card claims a measurement was taken and came
 * back zero. The "什么没有" card already names that gap in the source's own
 * words, and one honest statement beats two.
 */
function spendCard(d: Digest): string {
  const { spend } = d
  if (spend.priced === 0 && spend.unpriced === 0) return ''
  const rows = spend.unpricedModels.map(name =>
    `<tr><td>${esc(name)}</td><td class="dim">${esc(priceNote(name) ?? '')}</td></tr>`).join('')
  return `<div class="card">
  <h2>花费</h2>
  <div class="sub">按每条请求的四档 token 与该型号单价相乘 —— 新鲜输入、输出、缓存读、缓存写</div>
  <div class="figs">
    ${spend.priced === 0 ? fig('—', '已计价') : fig(moneyAll(spend.totals), '已计价')}
    ${fig(String(spend.priced), '计价记录')}
    ${fig(String(spend.unpriced), '无价记录')}
  </div>
  ${rows === '' ? '' : `<div class="src">以下记录消耗了 token，但无法计价 —— 不是零</div>
  <table class="mini"><tbody>${rows}</tbody></table>`}
  <div class="src">基础档价格，未区分长上下文档与 flex / priority 档 · 价目表取自 ${PRICED_AT}，由 \`npm run prices:check\` 比对上游</div>
</div>`
}

export function renderDigest(d: Digest, colour = false): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  // A source can record what happened without recording when or how much.
  // Cursor stamps no record and reports no usage, so every timing and token
  // figure below would be a zero standing in for "not recorded" — which is a
  // different claim, and the one a reader would take away.
  const timed = d.durations.length > 0 || d.spanMs > 0
  const metered = d.input + d.output + d.cacheRead + d.cacheWrite > 0
  const missing = [
    timed ? '' : '耗时：该来源不为记录写入时间戳，无法测量，也无法由相邻记录推算',
    metered ? '' : 'token：这个来源不报告用量，输入、输出与缓存都无从得知',
  ].filter(v => v !== '')
  const gap = missing.length === 0 ? '' : `<div class="card wide">
  <h2>该来源不记录的项目</h2>
  <div class="sub">下列项目在其他 agent 看板上存在，此处没有 —— 不是零，是该来源不记录</div>
  <table class="mini"><tbody>${missing.map(line => {
    const [what, why] = line.split('：')
    return `<tr><td>${esc(what ?? '')}</td><td class="dim">${esc(why ?? '')}</td></tr>`
  }).join('')}</tbody></table>
</div>`
  // The headline row is the house's own figure card, and the summary lost it
  // when it was first built: eight numbers a reader wants before any chart.
  const headline = `<div class="card wide">
  <h2>本窗口</h2>
  <div class="sub">${d.sessions} 个会话 · 工具时间按区间并集计算；各会话直接相加为 ${span(d.toolOccupancyMs)}</div>
  <div class="figs">
    ${fig(span(d.spanMs), '窗口时长')}
    ${fig(`${((d.toolMs / Math.max(1, d.spanMs)) * 100).toFixed(1)}%`, '其中工具执行')}
    ${fig(span(d.toolMs), '工具执行时长')}
    ${fig(n(d.turns), '轮次')}
    ${fig(n(d.steps), '步数')}
    ${fig(n(d.calls), '工具调用')}
    ${fig(n(grossTokens(d)), '总量 token')}
    ${fig(n(d.output), '其中输出')}
    ${fig(`${(d.cacheHitRate * 100).toFixed(0)}%`, '缓存命中')}
    ${fig(n(d.errors), '调用失败')}
    ${// Money leads this row rather than waiting six cards down. It was in the
      // spend card only, and the first question anyone asked of the board was
      // "where is the money" — which is the answer to "did I bury it".
      d.spend.priced === 0 ? fig('—', '花费') : fig(moneyAll(d.spend.totals), '花费')}
  </div>
  <div class="src">总量 = 新鲜输入 + 输出 + 缓存读 + 缓存写，与厂商用量页同口径 —— 缓存读通常占绝大部分，因此总量比「新鲜输入」高一到两个数量级属正常</div>
</div>`
  return `${headline}
${gap}
${timed ? durationField(d) : ''}
${timed ? rankedCard('工具耗时', '按总耗时排序，非按调用次数', d.tools, ms, '') : rankedCard(
    '工具调用', '按调用次数排序 —— 该来源不记录时间，无法按耗时排序', d.tools,
    v => v.toLocaleString('en-US'), '次')}
${metered ? tokenCard(d, colour) : ''}
${(() => {
    const sum = d.models.reduce((t, m) => t + m.totalMs, 0)
    if (sum === 0 && d.skills.length === 0 && d.subagents.length === 0) return ''
    // The ring earns its space only when there is a composition to see. Two
    // values are a sentence, not a chart.
    const ring = d.models.length >= 3
      ? tickDonut(
        d.models.slice(0, 5).map(m => ({ label: m.name, pct: (m.totalMs / sum) * 100 })),
        colour ? laddersFor(d.models.slice(0, 5).map(m => m.name), true) : undefined)
      : ''
    /**
     * One attributed breakdown.
     *
     * Each section is a share of its own attributed set, never of the page
     * total. A subagent's output is a subset of the model output above it, so
     * dividing by the model total made the only subagent read 100.0% — which
     * says "everything came from a subagent" when it means "every record that
     * carries an attribution carries this one". The header names the
     * denominator so the figure cannot be read as the wrong share.
     */
    const part = (title: string, rows: readonly Ranked[], denom: string): string => {
      if (rows.length === 0) return ''
      const total = rows.reduce((t, r) => t + r.totalMs, 0)
      return `<div class="src">${esc(title)}</div><table class="mini">`
        + `<thead><tr><th></th><th class="num">记录</th><th class="num">输出 token</th>`
        + `<th class="num">${esc(denom)}</th></tr></thead><tbody>${rows.slice(0, 8).map(r => `<tr>`
          + `<td>${esc(r.name)}</td><td class="num">${n(r.calls)}</td>`
          + `<td class="num">${n(r.totalMs)}</td>`
          + `<td class="num dim">${total === 0 ? '' : `${((r.totalMs / total) * 100).toFixed(1)}%`}</td>`
          + `</tr>`).join('')}</tbody></table>`
    }
    return `<div class="card wide">
  <h2>产出归因</h2>
  <div class="sub">输出 token 的来源归属 · 按输出量排序</div>
  ${ring}
  ${part('模型', d.models, '占全部输出')}
  ${part('SKILL · 仅统计带归属的记录', d.skills, '占已标注 SKILL 的输出')}
  ${part('子代理 · 仅统计带归属的记录', d.subagents, '占已标注子代理的输出')}
  ${d.hasAttribution ? '' : `<div class="src">${esc(agentLabel(d.agent))} 的会话记录不含 skill / 子代理归属字段，此项无数据 —— 非零值，是该字段不存在</div>`}
</div>`
  })()}
${spendCard(d)}
${concurrencyCard(d)}
${failureCard(d)}`
}

/**
 * A board for a source that keeps sessions but not a transcript.
 *
 * WorkBuddy records what a session is and how much context it occupies; the
 * conversation lives server-side. Rendering the usual panels would show zeros
 * where the answer is "not recorded here", so this board shows what the source
 * does have and names what it does not.
 * @param details - one entry per live session, newest first.
 * @returns the panels for that source.
 */
export function renderSourceBoard(details: readonly WorkbuddyDetail[]): string {
  if (details.length === 0) return ''
  const n = (v: number): string => v.toLocaleString('en-US')
  const models = new Map<string, number>()
  for (const d of details) models.set(d.model, (models.get(d.model) ?? 0) + 1)

  const rows = details.map(d => {
    const share = d.size === 0 ? 0 : (d.used / d.size) * 100
    return `<tr><td>${esc(d.title === '' ? d.id.slice(0, 12) : d.title)}</td>`
      + `<td>${esc(d.model)}</td><td>${esc(d.status)}</td>`
      + `<td class="num">${n(d.used)}</td><td class="num dim">${
        d.size === 0 ? '' : `${share.toFixed(0)}% of ${n(d.size)}`}</td></tr>`
  }).join('')

  const occupancy = details.filter(d => d.size > 0)
  const field = occupancy.length === 0 ? '' : hundredField(
    [...models.entries()].map(([model, count]) => ({
      label: `${model} · ${count} 个会话`,
      pct: (count / details.length) * 100,
    })),
  )

  return `<div class="card wide">
  <h2>会话</h2>
  <div class="sub">${details.length} 个 · 按最后活动时间排序</div>
  <table class="mini"><thead><tr><th></th><th>模型</th><th>状态</th>
    <th class="num">上下文占用</th><th class="num">占窗口</th></tr></thead><tbody>${rows}</tbody></table>
</div>
${field === '' ? '' : `<div class="card wide">
  <h2>模型分布</h2>
  <div class="sub">按会话数计 —— 该来源不记录逐步 token，无法按输出量划分</div>
  ${field}
</div>`}
<div class="card wide">
  <h2>该来源不记录的项目</h2>
  <div class="sub">下列项目在其他 agent 看板上存在，此处没有 —— 不是零，是该来源不记录</div>
  <table class="mini"><tbody>
    <tr><td>逐条轨迹</td><td class="dim">对话内容存于服务端，本机数据库仅有会话级元数据</td></tr>
    <tr><td>工具调用与实测耗时</td><td class="dim">无逐条记录，无法配对调用与返回</td></tr>
    <tr><td>输入 / 输出 / 缓存 token</td><td class="dim">仅有上下文占用总量，无逐步用量拆分</td></tr>
    <tr><td>skill / 子代理归因</td><td class="dim">无此字段</td></tr>
  </tbody></table>
</div>`
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
table.log td.cost{color:#57574f;font-variant-numeric:tabular-nums}
table.log td.cost .dim{color:#b0afa9}
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
.atab.cross .vendor{letter-spacing:.06em}
/* Chips wrap as a group rather than stretch to equal widths: with five
   windows in a 235px column, equal widths broke 「本次监视」across two lines
   mid-word. Each chip keeps its own width and the row wraps instead. */
.vdot{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:7px;vertical-align:1px}
.ranges{display:flex;flex-wrap:wrap;gap:3px;padding:7px 8px;border-bottom:1px solid #dcd9cf}
.ranges a{flex:0 1 auto;white-space:nowrap;text-align:center;padding:4px 7px;
 font-size:10px;color:#6a6963;text-decoration:none;border-radius:4px;letter-spacing:.02em}
.ranges a:hover{background:#e7e4da}
.ranges a.on{background:#1c1c1a;color:#f0efeb}
.sidefoot{padding:9px 16px 12px;border-top:1px solid #dcd9cf;font-size:9px;
 color:#8f8e88;line-height:1.6}
.main{padding:20px 26px 40px;min-width:0}
/* lieflat-charts: light cards by default, at most one dark card per screen.
   Lightness carries importance; there is no colour anywhere. */
/* A section break inside the single-file export, so a reader scrolling a
   megabyte can tell whose figures they are looking at. */
/* Not a footnote. The link is how anyone who receives an exported page finds
   the tool at all, so it gets a row of its own rather than a corner of one. */
.home{display:flex;align-items:center;justify-content:space-between;gap:10px;
 margin:auto 10px 8px;padding:9px 12px;border:1px solid #dcd9cf;border-radius:10px;
 color:#4a4944;text-decoration:none;background:#f2f0e9}
.home:hover{background:#eae7dd;border-color:#c9c5b8}
.hlabel{font-size:11px;font-weight:600;letter-spacing:.01em}
.hgo{font-size:10px;color:#8f8e88;white-space:nowrap}
.lede .home{display:inline;margin:0;padding:0;border:0;background:none;
 color:#6b6a63;border-bottom:1px solid #cfccc2}
.lede .home:hover{color:#1c1c1a;background:none}
.sub-lede{margin:46px 0 18px;padding-top:22px;border-top:1px solid #dcd9cf}
.sub-lede h2{font-size:22px;font-weight:700;margin:0}
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
  refreshSeconds?: number, shell = 'wrap', script = false, pulse = '',
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
<body${refreshSeconds === undefined ? '' : ` data-refresh="${String(refreshSeconds)}"`}${
  pulse === '' ? '' : ` data-pulse="${esc(pulse)}"`}>
<div class="${shell}">
${body}
</div>
${script ? `<script>${BOARD_SCRIPT}</script>` : ''}
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
  const spend = spendOf(sessions.flatMap(one => one.events ?? []))
  // Named separately from the figure because the two say different things:
  // the figure is what the priced records cost, and this is how much of the
  // work that figure leaves out.
  const hole = spend.unpriced === 0 ? ''
    : ` · ${String(spend.unpriced)} 条无价（${spend.unpricedModels
      .map(name => `${priceNote(name) ?? '无价'}：${name}`).join(' · ')}）`
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
    ${fig(grossTokens(totals).toLocaleString('en-US'), '总量 token')}
    ${fig(totals.input.toLocaleString('en-US'), '其中新鲜输入')}
    ${fig(totals.output.toLocaleString('en-US'), '其中输出')}
    ${fig(String(totals.steps), '步数')}
    ${fig(String(totals.toolCalls), '工具调用')}
    ${spend.priced === 0 ? fig('—', '花费') : fig(moneyAll(spend.totals), '花费')}
  </div>
  <div class="src">RECORDED LOCALLY · NOTHING UPLOADED${
    stat.measuredSteps === 0
      ? ' · STATIC PAYLOAD NEEDS `agent-ledger record`, WHICH TRANSCRIPTS DO NOT CONTAIN'
      : ` · STATIC PAYLOAD FROM ${stat.measuredSteps} PROXIED STEP(S)`}</div>
  ${spend.priced === 0 && spend.unpriced === 0 ? '' : `<div class="src">花费按每条请求的四档 token 算 · 计价 ${
    String(spend.priced)} 条${hole} · 基础档价格，未区分长上下文与优先级档 · 价目取自 ${PRICED_AT}</div>`}
</div>`
}

function profileTable(
  rows: readonly AgentProfile[],
  columns: readonly { head: string; of: (p: AgentProfile) => string }[],
  colour = false,
): string {
  const head = columns.map(c => `<th class="num">${esc(c.head)}</th>`).join('')
  // The whole point of this table is two agents side by side, and until now
  // both rows were the same grey — the reader had to keep the row order in
  // their head. A dot in the vendor's own hue is the smallest thing that
  // fixes it without turning the numbers into a colour chart.
  const names = rows.map(r => r.agent)
  const body = rows.map(row => `<tr><td class="kind">${
    colour ? `<span class="vdot" style="background:${hueFor(row.agent, names)[0]}"></span>` : ''
  }${esc(row.agent)}</td>`
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
function comparison(sessions: readonly Session[], colour = false): string {
  // `unknown` is what the proxy records when it could not tell who was
  // calling. It is not a product, and a row for it sits beside two real
  // vendors reading as a third one that did nothing — every behavioural
  // figure is zero, because those come from events and a proxied step has
  // none. Set aside rather than dropped: the count is named below the table.
  const all = profiles(sessions)
  const rows = all.filter(one => one.agent !== 'unknown')
  const setAside = all.length - rows.length
  if (rows.length < 2) return ''

  return `<div class="card wide">
  <h2>两者的工作方式对比</h2>
  <div class="sub">不是排名。会话记录不包含回答质量、任务是否完成、是否重新提问，因此「谁更强」缺少分子。下列指标只说明两者各自的工作方式与消耗。</div>
</div>
<div class="ledger">
  ${profileTable(rows, [
    { head: '一步几个工具', of: p => dec(p.callsPerStep) },
    { head: '零工具的步', of: p => pct(p.silentStepShare) },
    { head: '每次调用几步', of: p => dec(p.stepsPerCall) },
    { head: '参数中位', of: p => num(p.argTokens) },
    { head: '缓存命中', of: p => pct(p.cacheHitRate) },
  ], colour)}
  <div class="src">怎么干活 · 这几项基本不随任务规模变化，反映两者 harness 的设计差异，可直接比较</div>
</div>
<div class="ledger">
  ${profileTable(rows, [
    { head: '每步上下文', of: p => num(p.contextPerStep) },
    { head: '每步输出', of: p => num(p.outputPerStep) },
    { head: '每轮步数', of: p => num(p.stepsPerTurn) },
    { head: '每轮输出', of: p => num(p.outputPerTurn) },
    { head: '每轮墙钟', of: p => `${num(p.spanPerTurn)}s` },
    { head: '轮数', of: p => num(p.turns) },
  ], colour)}
  ${setAside === 0 ? '' : `<div class="src">另有 ${String(setAside)} 个<b>未能识别来源</b>的记录没进这张表 —— 代理未能识别调用方，它不是一个厂商；其行为指标为零，是因为代理记录不含逐条事件</div>`}
  <div class="src">花了多少 · 这几项主要由任务本身决定 —— 两者承担的任务不同时，差异不归因于 agent。仅供参考，不作为结论</div>
</div>`
}

/**
 * One session, in full: the shape of it, then the line-by-line of it.
 * @param session - the session to show.
 * @returns a complete, self-contained HTML document.
 */
export function renderSession(
  session: Session, zoom = 'mid', compress = true, colour = false,
): string {
  const body = `<div class="lede">
  <div class="meta"><a href="/">← 全部会话</a></div>
  <h1>会话 ${esc(session.id.slice(0, 12))}</h1>
  <p>${sessionSub(session)}</p>
</div>
${headlineCard([session], '本次会话')}
<div class="card wide">
  <h2>轨迹</h2>
  <div class="sub">点击任意一行查看全文</div>
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
export function renderDashboard(
  sessions: readonly Session[], cap = 200, details = false, colour = false,
): string {
  const totals = summarise(sessions)
  const agents = byAgent(sessions)

  const agentRows = [...agents.entries()]
    .map(([agent, list]) => ({ label: agent.toUpperCase(), value: averageStatic(list).total }))
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value)

  const toolRows = totals.topTools.slice(0, 12).map(t => ({ label: t.name.toUpperCase(), value: t.calls }))

  const headline = headlineCard(sessions, `全部记录 · ${totals.sessions} 个会话`)

  const perAgent = agentRows.length === 0 ? '' : `<div class="card wide">
  <h2>每次请求的固定负载</h2>
  <div class="sub">每次请求的固定负载均值 · 系统提示词 + 工具 schema</div>
  ${tickChart(agentRows, 'TOKEN')}
  <div class="src">固定负载 · 实测自真实请求</div>
</div>`

  const tools = toolRows.length === 0 ? '' : `<div class="card wide">
  <h2>工具调用次数</h2>
  <div class="sub">全部已记录步骤的调用次数</div>
  ${tickChart(toolRows, '次调用')}
  <div class="src">工具调用 · 取自会话记录</div>
</div>`

  // One summary per agent, never one merged one. Adding a Claude duration to
  // a Codex duration produces a figure describing neither, which is why the
  // board is organised per vendor; a file that flattened them would be
  // answering a different question than the page it came from.
  const summaries = [...agents.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([agent, list]) => `<div class="lede sub-lede"><h2>${esc(agentLabel(agent))}</h2>
  <p>${list.length} 个会话 · 下面每个数字只来自这一家</p></div>
<div class="digest">${renderDigest(digest(agent, list), colour)}</div>`)
    .join('\n')

  // Newest first, across agents. Read order is the one thing a single file can
  // offer instead of navigation, so the session you just finished is on top.
  const ordered = [...sessions].sort((a, b) => b.startedAt - a.startedAt)

  const traces = ordered.map(session => `<div class="card wide">
  <h2>会话 ${esc(session.id.slice(0, 12))}</h2>
  <div class="sub">${sessionSub(session)}</div>
</div>
<div class="ledger">${trajectoryTable(session, cap, details)}</div>`).join('\n')

  return page('Agent Ledger — agent 运行记录', `<div class="lede">
  <h1>agent 运行记录</h1>
  <p>数据来自各 agent 写在本机的会话记录，每个数字对应一次真实请求。全程只读本地文件，不上传任何内容。</p>
  <div class="meta">${totals.sessions} 个会话 · ${totals.steps} 步 · 本地读取</div>
  <div class="meta"><a class="home" href="${HOME}" target="_blank" rel="noreferrer">本页由开源工具 runledger 生成 · GitHub ↗</a></div>
</div>
${headline}
${comparison(sessions, colour)}
${perAgent}
${tools}
${summaries}
<div class="lede sub-lede"><h1>逐条轨迹</h1>
  <p>每个会话一段，按最后活动时间倒序。</p></div>
${traces}`)
}
