/**
 * The page: a trajectory of what happened, and a dashboard of what it cost.
 *
 * Server-side SVG, no script, no remote asset. The chart grammar is one rule —
 * **one mark is one stated unit** — so any bar here can be counted and checked
 * rather than trusted.
 *
 * @module
 */

import type { LedgerEvent, Session } from './types.js'
import { summarise, averageStatic, byAgent } from './summary.js'

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

/** Horizontal countable rows. */
function tickChart(rows: readonly { label: string; value: number }[], noun: string, width = 800): string {
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
      parts.push(`<line x1="${x}" y1="${y + 8}" x2="${x}" y2="${(y + 8 - h).toFixed(1)}" class="tick" opacity="${(0.5 + jitter(k + 3, i + 5) * 0.5).toFixed(2)}"/>`)
      if (k % 5 === 4) parts.push(`<circle cx="${x}" cy="${y + 12}" r="0.85" class="fifth"/>`)
    }
    parts.push(`<text x="${(gutter + marks * px + 9).toFixed(1)}" y="${y + 3.5}" class="val">${row.value.toLocaleString('en-US')}</text>`)
  })
  parts.push(`<text x="${width / 2}" y="${height - 8}" class="unit" text-anchor="middle">一格 = ${unit.toLocaleString('en-US')} ${noun} · 每五格一个点</text>`)
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${parts.join('')}</svg>`
}

/**
 * The trajectory: one hairline per step, marks in the lane of what it produced.
 *
 * This is the view neither Claude Code nor Codex offers — you can see the
 * shape of a session before reading a single number.
 */
function trajectory(session: Session): string {
  const steps = session.steps
  if (steps.length === 0) return '<p class="empty">No steps.</p>'
  const width = 900, X0 = 92, W = width - X0 - 24
  const px = W / steps.length
  const x = (i: number): number => X0 + i * px + px / 2
  const LANE = { model: 92, tools: 168 }
  const parts: string[] = []

  for (const [name, y] of [['MODEL', LANE.model], ['TOOLS', LANE.tools]] as const) {
    parts.push(`<line x1="${X0}" y1="${y}" x2="${X0 + W}" y2="${y}" class="rule"/>`)
    parts.push(`<text x="${X0 - 12}" y="${y + 3}" class="lbl" text-anchor="end">${name}</text>`)
  }

  const maxDur = Math.max(...steps.map(s => s.durationMs ?? 0), 1)
  steps.forEach((step, i) => {
    const cx = x(i)
    parts.push(`<line x1="${cx.toFixed(1)}" y1="64" x2="${cx.toFixed(1)}" y2="196" class="hair"/>`)
    // Model mark: radius carries how long the request took.
    const r = 2 + 3.4 * Math.sqrt((step.durationMs ?? 0) / maxDur)
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${LANE.model}" r="${r.toFixed(2)}" class="dot"/>`)
    if (step.error !== undefined) {
      parts.push(`<line x1="${(cx - 3.4).toFixed(1)}" y1="${LANE.model - 3.4}" x2="${(cx + 3.4).toFixed(1)}" y2="${LANE.model + 3.4}" class="err"/>`)
    }
    step.calls.forEach((_, k) => {
      const ty = LANE.tools - 2.6 + k * 7.6
      parts.push(`<rect x="${(cx - 2.6).toFixed(1)}" y="${ty.toFixed(1)}" width="5.2" height="5.2" class="sq" opacity="${(0.5 + jitter(i + k + 2, 7) * 0.5).toFixed(2)}"/>`)
    })
  })

  const calls = steps.reduce((t, s) => t + s.calls.length, 0)
  parts.push(`<text x="${X0}" y="228" class="note">${steps.length} 步 · ${calls} 次工具调用 · 圆点大小 = 该步耗时</text>`)
  parts.push(`<text x="${X0 + W}" y="244" class="unit" text-anchor="end">ONE HAIRLINE = ONE STEP · ONE SQUARE = ONE TOOL CALL</text>`)
  return `<svg viewBox="0 0 ${width} 256" role="img">${parts.join('')}</svg>`
}

/** Chinese labels for the five event kinds. */
const KIND_LABEL: Readonly<Record<LedgerEvent['kind'], string>> = {
  user: '你', assistant: '模型', tool: '工具', system: '系统', context: '上下文',
}

/**
 * The ledger: one row per thing that happened, turns kept apart.
 *
 * This is the half a timeline cannot give you. The shape of a session is
 * visible in the trajectory above; what it was actually doing is only legible
 * line by line.
 */
function ledger(events: readonly LedgerEvent[], cap = 120): string {
  if (events.length === 0) return ''
  const shown = events.slice(0, cap)
  const rows: string[] = []
  let turn = 0
  let n = 0
  for (const event of shown) {
    if (event.turn !== turn) {
      turn = event.turn
      rows.push(`<tr class="turnrow"><td colspan="4">第 ${turn} 轮</td></tr>`)
    }
    n += 1
    const label = KIND_LABEL[event.kind]
    const what = event.kind === 'tool'
      ? `<span class="tool">${esc(event.tool ?? '')}</span>${event.text === '' ? '' : ` · ${esc(event.text)}`}`
      : esc(event.text)
    // Only the two bands that earn a mark get a row class.
    const band = event.kind === 'user' ? ' class="r-user"'
      : event.kind === 'tool' ? ' class="r-tool"' : ''
    rows.push(`<tr${band}><td class="n">${String(n).padStart(2, '0')}</td>`
      + `<td class="kind k-${event.kind}">${label}</td>`
      + `<td>${what}</td>`
      + `<td class="res">${event.result === undefined ? '' : esc(event.result)}</td></tr>`)
  }
  const more = events.length > cap
    ? `<div class="src">共 ${events.length} 条，此处显示前 ${cap} 条</div>`
    : ''
  return `<table><thead><tr><th style="width:44px">#</th><th style="width:58px">类型</th>`
    + `<th>发生了什么</th><th style="width:26%">结果</th></tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table>${more}`
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
td.num{font-variant-numeric:tabular-nums;text-align:right;padding-right:14px}
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

/** The shared document shell. One stylesheet, no script, no remote asset. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
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

/**
 * The index a server hands out: what it all cost, and what there is to open.
 * @param sessions - the sessions that were parsed, newest first.
 * @param scanned - how many transcripts exist on this machine in total.
 * @returns a complete, self-contained HTML document.
 */
export function renderIndex(sessions: readonly Session[], scanned: number): string {
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
${perAgent}
${tools}
<div class="card wide">
  <h2>会话</h2>
  <div class="sub">按最后写入时间排序 · 点会话号打开轨迹与逐条账本</div>
</div>
<div class="ledger">${sessionList(sessions)}</div>`)
}

/**
 * One session, in full: the shape of it, then the line-by-line of it.
 * @param session - the session to show.
 * @returns a complete, self-contained HTML document.
 */
export function renderSession(session: Session): string {
  const body = `<div class="lede">
  <div class="meta"><a href="/">← 全部会话</a></div>
  <h1>会话 ${esc(session.id.slice(0, 12))}</h1>
  <p>${sessionSub(session)}</p>
</div>
${headlineCard([session], '本次会话')}
<div class="card wide">
  <h2>轨迹</h2>
  <div class="sub">一根发丝线是一步 · 圆点大小是这一步的耗时 · 方块是工具调用</div>
  ${trajectory(session)}
</div>
${session.events === undefined
  ? '<div class="card wide"><h2>账本</h2><div class="sub">这份记录没有逐条事件——Codex 的事件流还没做适配。</div></div>'
  : `<div class="ledger">${ledger(session.events, 1000)}</div>`}`
  return page(`会话 ${session.id.slice(0, 12)} — Agent Ledger`, body)
}

/**
 * Render the whole ledger: headline figures, per-agent cost, trajectories.
 * @param sessions - everything recorded.
 * @returns a complete, self-contained HTML document.
 */
export function renderDashboard(sessions: readonly Session[]): string {
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
  <h2>会话 ${esc(session.id.slice(0, 8))}</h2>
  <div class="sub">${sessionSub(session)}</div>
  ${trajectory(session)}
  <div class="src">轨迹 · 一根发丝线 = 一步</div>
</div>
${session.events === undefined ? '' : `<div class="ledger">${ledger(session.events)}</div>`}`).join('\n')

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
