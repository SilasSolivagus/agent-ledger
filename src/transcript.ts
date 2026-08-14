/**
 * Reading what the agents already wrote down.
 *
 * Both products keep a local, append-only record of every session — Claude
 * Code under `~/.claude/projects`, Codex under `~/.codex/sessions`. Reading
 * those is strictly better than proxying: nothing sits in the request path,
 * nothing can break a live session, subscription auth is irrelevant, and the
 * entire back catalogue is available instead of only what happens next.
 *
 * The proxy still earns its place for the one thing transcripts omit — the
 * system prompt and tool schemas a request carried — but it is no longer the
 * way in.
 *
 * @module
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEvent, Session, Step, ToolCall, Usage } from './types.js'
import { estimateTokens } from './parse.js'

/** Walk a directory tree for files with the given extension. */
async function walk(dir: string, ext: string, out: string[] = []): Promise<string[]> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, ext, out)
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out
}

/** Newest files first, so "recent sessions" is cheap to answer. */
async function newestFirst(paths: readonly string[], limit: number): Promise<string[]> {
  const stamped = await Promise.all(paths.map(async path => {
    try { return { path, at: (await stat(path)).mtimeMs } } catch { return { path, at: 0 } }
  }))
  return stamped.sort((a, b) => b.at - a.at).slice(0, limit).map(s => s.path)
}

/** Parse a JSONL file into objects, skipping anything malformed. */
function rows(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) out.push(parsed as Record<string, unknown>)
    } catch { /* a partially written tail line is normal on a live session */ }
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Flatten a message's content blocks into one short readable line. */
function summarise(content: unknown, limit = 160): string {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim().slice(0, limit)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    const type = record['type']
    if (type === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
    else if (type === 'thinking') parts.push('（思考）')
    else if (type === 'tool_result') {
      const inner = record['content']
      parts.push(typeof inner === 'string' ? inner : summarise(inner, limit))
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Condense tool arguments to the one field a reader actually scans for. */
function toolArgSummary(name: string, input: unknown, limit = 120): string {
  const record = asRecord(input)
  if (record === undefined) return ''
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return `${key}: ${value.replace(/\s+/g, ' ').trim().slice(0, limit)}`
    }
  }
  const keys = Object.keys(record)
  return keys.length === 0 ? '' : `${keys.slice(0, 3).join(', ')}`
}

function numberAt(source: unknown, key: string): number {
  const record = asRecord(source)
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Default roots, overridable for tests. */
export const CLAUDE_ROOT = join(homedir(), '.claude', 'projects')
export const CODEX_ROOT = join(homedir(), '.codex', 'sessions')

/**
 * Read Claude Code transcripts into sessions.
 *
 * One `assistant` record is one step: it carries the model, the reported
 * usage, a timestamp, and the tool calls that request produced.
 * @param limit - how many recent session files to read.
 * @param root - transcript root; defaults to the standard location.
 * @returns sessions, newest file first.
 */
export async function readClaudeSessions(limit = 40, root = CLAUDE_ROOT): Promise<Session[]> {
  if (!existsSync(root)) return []
  const files = await newestFirst(await walk(root, '.jsonl'), limit)
  const sessions: Session[] = []

  for (const file of files) {
    let text: string
    try { text = await readFile(file, 'utf8') } catch { continue }
    const steps: Step[] = []
    const events: LedgerEvent[] = []
    let version: string | undefined
    let cwd: string | undefined
    let gitBranch: string | undefined
    let startedAt = 0
    let previousAt = 0
    let turn = 0
    // Tool results arrive on the NEXT user record, so a pending index lets the
    // call keep its own row and gain a result rather than spawning a stray one.
    const awaiting = new Map<string, number>()

    for (const row of rows(text)) {
      if (typeof row['version'] === 'string') version ??= row['version']
      if (typeof row['cwd'] === 'string') cwd ??= row['cwd']
      if (typeof row['gitBranch'] === 'string' && row['gitBranch'] !== '') gitBranch ??= row['gitBranch']
      const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : 0
      if (at > 0 && startedAt === 0) startedAt = at

      if (row['type'] === 'user') {
        const userMessage = asRecord(row['message'])
        const content = userMessage?.['content']
        // A user record carrying tool_result is the harness returning output,
        // not a person typing; attach it to the call that is waiting.
        const results = Array.isArray(content)
          ? content.filter(b => asRecord(b)?.['type'] === 'tool_result')
          : []
        if (results.length > 0) {
          for (const block of results) {
            const record = asRecord(block)
            const id = typeof record?.['tool_use_id'] === 'string' ? record['tool_use_id'] : ''
            const at2 = awaiting.get(id)
            const target = at2 === undefined ? undefined : events[at2]
            if (target !== undefined) target.result = summarise(record?.['content'], 90)
            awaiting.delete(id)
          }
          continue
        }
        const said = summarise(content)
        if (said === '') continue
        turn += 1
        events.push({ kind: 'user', at, turn, text: said })
        continue
      }

      if (row['type'] === 'system') {
        const said = summarise(row['content'] ?? row['message'], 120)
        if (said !== '') events.push({ kind: 'context', at, turn: Math.max(1, turn), text: said })
        continue
      }

      if (row['type'] !== 'assistant') continue

      const message = asRecord(row['message'])
      const rawUsage = asRecord(message?.['usage'])
      if (message === undefined) continue

      const usage: Usage | undefined = rawUsage === undefined ? undefined : {
        input: numberAt(rawUsage, 'input_tokens'),
        output: numberAt(rawUsage, 'output_tokens'),
        cacheRead: numberAt(rawUsage, 'cache_read_input_tokens'),
        cacheWrite: numberAt(rawUsage, 'cache_creation_input_tokens'),
      }

      const content = Array.isArray(message['content']) ? message['content'] : []
      const said = summarise(content)
      if (said !== '') {
        events.push({ kind: 'assistant', at, turn: Math.max(1, turn), text: said })
      }
      for (const block of content) {
        const record = asRecord(block)
        if (record?.['type'] !== 'tool_use') continue
        const name = typeof record['name'] === 'string' ? record['name'] : 'unknown'
        events.push({
          kind: 'tool', at, turn: Math.max(1, turn), tool: name,
          text: toolArgSummary(name, record['input']),
        })
        const id = record['id']
        if (typeof id === 'string') awaiting.set(id, events.length - 1)
      }
      const calls: ToolCall[] = content.flatMap((block: unknown) => {
        const record = asRecord(block)
        if (record?.['type'] !== 'tool_use') return []
        return [{
          name: typeof record['name'] === 'string' ? record['name'] : 'unknown',
          argBytes: estimateTokens(JSON.stringify(record['input'] ?? {})),
        }]
      })

      const step: Step = {
        index: steps.length,
        startedAt: at,
        model: typeof message['model'] === 'string' ? message['model'] : 'unknown',
        wire: 'anthropic-messages',
        // Transcripts do not record the request envelope, so the static
        // payload is unknown here. The proxy is what fills this in.
        staticTokens: { prompt: 0, tools: 0 },
        toolCount: 0,
        historyLength: steps.length,
        calls,
      }
      // Gap since the previous record is the closest honest stand-in for how
      // long this step took; the transcript records no explicit duration.
      if (previousAt > 0 && at > previousAt) step.durationMs = at - previousAt
      if (usage !== undefined) step.usage = usage
      steps.push(step)
      previousAt = at
    }

    if (steps.length === 0) continue
    const session: Session = {
      id: file.split('/').pop()?.replace('.jsonl', '') ?? file,
      agent: 'claude-code',
      startedAt: startedAt || (steps[0]?.startedAt ?? 0),
      steps,
    }
    if (version !== undefined) session.agentVersion = version
    if (cwd !== undefined) session.cwd = cwd
    if (gitBranch !== undefined) session.gitBranch = gitBranch
    if (events.length > 0) session.events = events
    sessions.push(session)
  }
  return sessions
}

/**
 * Read Codex rollouts into sessions.
 *
 * Codex reports usage cumulatively, so each `token_count` frame carries both
 * the running total and the last call's own figures; the latter is what maps
 * onto a step.
 * @param limit - how many recent rollout files to read.
 * @param root - rollout root; defaults to the standard location.
 * @returns sessions, newest file first.
 */
export async function readCodexSessions(limit = 40, root = CODEX_ROOT): Promise<Session[]> {
  if (!existsSync(root)) return []
  const files = await newestFirst(await walk(root, '.jsonl'), limit)
  const sessions: Session[] = []

  for (const file of files) {
    let text: string
    try { text = await readFile(file, 'utf8') } catch { continue }
    const steps: Step[] = []
    let startedAt = 0
    let previousAt = 0
    let pendingCalls: ToolCall[] = []
    let model = 'unknown'

    for (const row of rows(text)) {
      const payload = asRecord(row['payload'])
      const kind = typeof payload?.['type'] === 'string' ? payload['type'] : ''
      const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : 0
      if (at > 0 && startedAt === 0) startedAt = at

      if (kind === 'session_meta' || kind === 'turn_context') {
        const candidate = payload?.['model']
        if (typeof candidate === 'string') model = candidate
        continue
      }
      // Tool calls arrive as their own frames and belong to the step that the
      // next usage frame closes.
      if (kind === 'function_call' || kind === 'mcp_tool_call_end' || kind === 'web_search_call') {
        pendingCalls.push({
          name: typeof payload?.['name'] === 'string' ? payload['name'] : kind,
          argBytes: estimateTokens(typeof payload?.['arguments'] === 'string' ? payload['arguments'] : ''),
        })
        continue
      }
      if (kind !== 'token_count') continue

      const last = asRecord(asRecord(payload?.['info'])?.['last_token_usage'])
      if (last === undefined) continue
      const step: Step = {
        index: steps.length,
        startedAt: at,
        model,
        wire: 'openai-responses',
        staticTokens: { prompt: 0, tools: 0 },
        toolCount: 0,
        historyLength: steps.length,
        usage: {
          input: numberAt(last, 'input_tokens'),
          output: numberAt(last, 'output_tokens'),
          cacheRead: numberAt(last, 'cached_input_tokens'),
          cacheWrite: 0,
        },
        calls: pendingCalls,
      }
      if (previousAt > 0 && at > previousAt) step.durationMs = at - previousAt
      steps.push(step)
      pendingCalls = []
      previousAt = at
    }

    if (steps.length === 0) continue
    sessions.push({
      id: file.split('/').pop()?.replace(/^rollout-|\.jsonl$/g, '') ?? file,
      agent: 'codex',
      startedAt: startedAt || (steps[0]?.startedAt ?? 0),
      steps,
    })
  }
  return sessions
}

/**
 * Read whatever this machine has, from every agent that keeps a record.
 * @param limit - recent sessions per agent.
 * @returns all sessions found.
 */
export async function readAllSessions(limit = 40): Promise<Session[]> {
  const [claude, codex] = await Promise.all([
    readClaudeSessions(limit),
    readCodexSessions(limit),
  ])
  return [...claude, ...codex]
}
