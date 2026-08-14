/**
 * `agent-ledger` — record what your agent did, then show it.
 *
 * Two verbs. `record` starts the proxy and prints the one line you paste into
 * the agent's environment. `report` turns what was recorded into a page.
 *
 * @module
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startProxy } from './proxy.js'
import { parseStep } from './parse.js'
import { summarise, averageStatic } from './summary.js'
import { renderDashboard } from './render.js'
import { readAllSessions } from './transcript.js'
import type { Session, Step } from './types.js'

export const USAGE = `agent-ledger — see what your coding agent actually did

Usage:
  agent-ledger report [--out <file>] [--limit <n>]
        read what Claude Code and Codex already wrote down, and render it

  agent-ledger sessions [--limit <n>]
        list what it can see

  agent-ledger record [--port <n>]
        also capture the request envelope (system prompt + tool schemas),
        which transcripts do not contain

Nothing is uploaded. report and sessions only read files the agents already
keep on this machine; record additionally proxies traffic.
`

/** Where sessions are kept. */
export function ledgerDir(): string {
  return join(homedir(), '.agent-ledger')
}

/** Append one step to today's log. */
async function appendStep(sessionId: string, agent: string, step: Step): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true })
  const line = JSON.stringify({ sessionId, agent, ...step })
  await appendFile(join(ledgerDir(), 'steps.jsonl'), `${line}\n`, 'utf8')
}

/** Read every recorded step back into sessions. */
export async function loadSessions(): Promise<Session[]> {
  const file = join(ledgerDir(), 'steps.jsonl')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  const sessions = new Map<string, Session>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const id = typeof row['sessionId'] === 'string' ? row['sessionId'] : 'unknown'
    const agent = (typeof row['agent'] === 'string' ? row['agent'] : 'unknown') as Session['agent']
    const existing = sessions.get(id) ?? {
      id, agent, startedAt: Number(row['startedAt'] ?? 0), steps: [],
    }
    existing.steps.push(row as unknown as Step)
    sessions.set(id, existing)
  }
  return [...sessions.values()]
}

/** Start recording until interrupted. */
async function record(port: number): Promise<number> {
  const sessionId = randomUUID()
  let steps = 0

  startProxy({
    port,
    onStep: step => {
      steps += 1
      void appendStep(sessionId, 'unknown', step).catch(() => {})
      const usage = step.usage
      const bits = [
        `step ${String(step.index + 1)}`,
        `${String(step.toolCount)} tools`,
        `${(step.staticTokens.prompt + step.staticTokens.tools).toLocaleString('en-US')} static`,
        usage === undefined ? '' : `${usage.input.toLocaleString('en-US')} in / ${usage.output.toLocaleString('en-US')} out`,
        step.ttftMs === undefined ? '' : `ttft ${String(step.ttftMs)}ms`,
        step.calls.length === 0 ? '' : `${String(step.calls.length)} calls`,
      ].filter(b => b !== '')
      console.error(`  ${bits.join(' · ')}`)
    },
    onLog: line => console.error(`  ! ${line}`),
  }, parseStep)

  const url = `http://127.0.0.1:${String(port)}`
  console.error(`agent-ledger recording on ${url}`)
  console.error('')
  console.error('Claude Code — run your agent with:')
  console.error(`  ANTHROPIC_BASE_URL=${url} claude`)
  console.error('')
  console.error('Codex — run your agent with:')
  console.error(`  codex -c model_provider=ledger -c model_providers.ledger.name=ledger \\`)
  console.error(`        -c model_providers.ledger.base_url=${url}/v1 \\`)
  console.error(`        -c model_providers.ledger.wire_api=responses`)
  console.error('')
  console.error('Traffic passes through untouched. Ctrl-C to stop.')
  console.error('')

  await new Promise<void>(resolve => {
    process.on('SIGINT', () => {
      console.error(`\nrecorded ${String(steps)} steps to ${ledgerDir()}`)
      resolve()
    })
  })
  return 0
}

/** Render everything recorded. */
async function report(out: string | undefined, limit: number): Promise<number> {
  const sessions = [...await readAllSessions(limit), ...await loadSessions()]
  if (sessions.length === 0) {
    console.error('agent-ledger: no sessions found.')
    console.error('  Looked in ~/.claude/projects and ~/.codex/sessions.')
    return 1
  }
  const html = renderDashboard(sessions)
  if (out === undefined) { console.log(html); return 0 }
  await writeFile(out, html, 'utf8')
  const totals = summarise(sessions)
  const stat = averageStatic(sessions)
  console.error(`agent-ledger: ${String(totals.sessions)} session(s), ${String(totals.steps)} steps → ${out}`)
  console.error(`  ${stat.total.toLocaleString('en-US')} static tokens per request · ${(totals.cacheHitRate * 100).toFixed(0)}% cache hit`)
  return 0
}

/** List what has been recorded. */
async function list(limit: number): Promise<number> {
  const sessions = [...await readAllSessions(limit), ...await loadSessions()]
  if (sessions.length === 0) { console.error('agent-ledger: no sessions found.'); return 1 }
  for (const session of sessions) {
    const totals = summarise([session])
    console.log(`${session.id.slice(0, 8)}  ${session.agent.padEnd(12)} ${String(totals.steps).padStart(4)} steps  ${String(totals.toolCalls).padStart(4)} calls`)
  }
  return 0
}

/**
 * Entry point.
 * @param argv - arguments after the executable and script.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv
  const flag = (name: string): string | undefined => {
    const at = rest.indexOf(name)
    return at >= 0 ? rest[at + 1] : undefined
  }
  switch (verb) {
    case 'record': return await record(Number(flag('--port') ?? 4488))
    case 'report': return await report(flag('--out'), Number(flag('--limit') ?? 40))
    case 'sessions': return await list(Number(flag('--limit') ?? 40))
    case undefined: case '-h': case '--help': console.log(USAGE); return 0
    default: console.error(`agent-ledger: unknown command "${verb}"\n\n${USAGE}`); return 2
  }
}
