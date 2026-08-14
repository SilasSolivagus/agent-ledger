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

/** A transcript on disk, before anything has been read out of it. */
export interface TranscriptFile {
  path: string
  agent: 'claude-code' | 'codex'
  /** Stable identity, derived from the filename; what a URL can carry. */
  id: string
  mtimeMs: number
}

/** The id a session gets: the filename, minus the parts that are packaging. */
function idFor(path: string, agent: TranscriptFile['agent']): string {
  const base = path.split('/').pop() ?? path
  return agent === 'codex' ? base.replace(/^rollout-|\.jsonl$/g, '') : base.replace('.jsonl', '')
}

/**
 * Every transcript under a root, stamped but unread.
 *
 * Stat is three orders of magnitude cheaper than parse — a thousand files cost
 * milliseconds here and seconds there — so listing and reading stay separate.
 */
async function filesIn(root: string, agent: TranscriptFile['agent']): Promise<TranscriptFile[]> {
  if (!existsSync(root)) return []
  const paths = await walk(root, '.jsonl')
  return await Promise.all(paths.map(async path => {
    let mtimeMs = 0
    try { mtimeMs = (await stat(path)).mtimeMs } catch { /* vanished mid-walk */ }
    return { path, agent, id: idFor(path, agent), mtimeMs }
  }))
}

function newestFirst(files: readonly TranscriptFile[], limit: number): TranscriptFile[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
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

/**
 * Flatten a message's content blocks into one short readable line.
 *
 * Anthropic calls its text blocks `text`; OpenAI Responses calls them
 * `input_text` and `output_text`. Same sentence, three names.
 */
function summarise(content: unknown, limit = 160): string {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim().slice(0, limit)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    const type = record['type']
    if ((type === 'text' || type === 'input_text' || type === 'output_text')
      && typeof record['text'] === 'string') parts.push(record['text'])
    else if (type === 'thinking') parts.push('（思考）')
    else if (type === 'input_image') parts.push('（图片）')
    else if (type === 'tool_result') {
      const inner = record['content']
      parts.push(typeof inner === 'string' ? inner : summarise(inner, limit))
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** One line of what a tool returned. */
function resultSummary(output: unknown, limit = 90): string {
  if (typeof output !== 'string') return summarise(output, limit)
  // apply_patch wraps its result in JSON; the readable half is inside.
  if (output.startsWith('{')) {
    try {
      const inner = asRecord(JSON.parse(output))?.['output']
      if (typeof inner === 'string') return inner.replace(/\s+/g, ' ').trim().slice(0, limit)
    } catch { /* not JSON after all */ }
  }
  return output.replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Condense tool arguments to the one field a reader actually scans for. */
function toolArgSummary(name: string, input: unknown, limit = 120): string {
  const record = asRecord(input)
  if (record === undefined) return ''
  // `cmd` is Codex's name for what Claude Code calls `command`; without it the
  // most common tool call in a Codex session reads as "cmd, workdir".
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
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
 * Read one Claude Code transcript into a session.
 *
 * One `assistant` record is one step: it carries the model, the reported
 * usage, a timestamp, and the tool calls that request produced.
 * @param file - the transcript to read.
 * @returns the session, or undefined when the file held no steps.
 */
export async function parseClaudeFile(file: TranscriptFile): Promise<Session | undefined> {
  let text: string
  try { text = await readFile(file.path, 'utf8') } catch { return undefined }
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

  if (steps.length === 0) return undefined
  const session: Session = {
    id: file.id,
    agent: 'claude-code',
    startedAt: startedAt || (steps[0]?.startedAt ?? 0),
    steps,
  }
  if (version !== undefined) session.agentVersion = version
  if (cwd !== undefined) session.cwd = cwd
  if (gitBranch !== undefined) session.gitBranch = gitBranch
  if (events.length > 0) session.events = events
  return session
}

/**
 * Read Claude Code transcripts into sessions.
 * @param limit - how many recent session files to read.
 * @param root - transcript root; defaults to the standard location.
 * @returns sessions, newest file first.
 */
export async function readClaudeSessions(limit = 40, root = CLAUDE_ROOT): Promise<Session[]> {
  const files = newestFirst(await filesIn(root, 'claude-code'), limit)
  const sessions: Session[] = []
  for (const file of files) {
    const session = await parseClaudeFile(file)
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}

/**
 * Read one Codex rollout into a session.
 *
 * Codex reports usage cumulatively, so each `token_count` frame carries both
 * the running total and the last call's own figures; the latter is what maps
 * onto a step.
 * @param file - the rollout to read.
 * @returns the session, or undefined when the file held no steps.
 */
export async function parseCodexFile(file: TranscriptFile): Promise<Session | undefined> {
  let text: string
  try { text = await readFile(file.path, 'utf8') } catch { return undefined }
  const steps: Step[] = []
  const events: LedgerEvent[] = []
  let startedAt = 0
  let previousAt = 0
  let pendingCalls: ToolCall[] = []
  let model = 'unknown'
  let version: string | undefined
  let cwd: string | undefined
  let gitBranch: string | undefined
  let turn = 0
  // Outputs arrive as their own frames further down, keyed by call_id.
  const awaiting = new Map<string, number>()

  for (const row of rows(text)) {
    const payload = asRecord(row['payload'])
    // Codex nests a `type` inside the payload for most frames — but not for
    // session_meta and turn_context, which put their fields straight on the
    // payload. Reading only the inner type silently loses both.
    const top = typeof row['type'] === 'string' ? row['type'] : ''
    const kind = typeof payload?.['type'] === 'string' ? payload['type'] : ''
    const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : 0
    if (at > 0 && startedAt === 0) startedAt = at

    if (top === 'session_meta') {
      if (typeof payload?.['cwd'] === 'string') cwd ??= payload['cwd']
      if (typeof payload?.['cli_version'] === 'string') version ??= payload['cli_version']
      const branch = asRecord(payload?.['git'])?.['branch']
      if (typeof branch === 'string' && branch !== '') gitBranch ??= branch
      continue
    }
    if (top === 'turn_context') {
      const candidate = payload?.['model']
      if (typeof candidate === 'string') model = candidate
      continue
    }

    if (kind === 'context_compacted') {
      events.push({ kind: 'context', at, turn: Math.max(1, turn), text: '上下文被压缩' })
      continue
    }

    // What a person typed, and only that. The conversation Codex sends to the
    // model also holds `role: 'user'` records the harness wrote itself —
    // AGENTS.md preambles, <environment_context> blocks, liveness pings — and
    // counting those as turns inflates every per-turn figure. This event is
    // emitted when a human presses enter, in every CLI version seen so far.
    if (kind === 'user_message') {
      const said = typeof payload?.['message'] === 'string'
        ? payload['message'].replace(/\s+/g, ' ').trim().slice(0, 160)
        : ''
      if (said === '') continue
      turn += 1
      events.push({ kind: 'user', at, turn, text: said })
      continue
    }

    if (kind === 'message' && payload?.['role'] === 'assistant') {
      const said = summarise(payload['content'])
      if (said !== '') events.push({ kind: 'assistant', at, turn: Math.max(1, turn), text: said })
      continue
    }

    // Tool calls arrive as their own frames and belong to the step that the
    // next usage frame closes.
    if (kind === 'function_call' || kind === 'custom_tool_call'
      || kind === 'mcp_tool_call_end' || kind === 'web_search_call') {
      const name = typeof payload?.['name'] === 'string' ? payload['name'] : kind
      // `function_call` serialises arguments as JSON; `custom_tool_call` sends
      // a raw body — apply_patch's is the patch itself.
      const args = payload?.['arguments']
      const body = payload?.['input']
      pendingCalls.push({
        name,
        argBytes: estimateTokens(typeof args === 'string' ? args : typeof body === 'string' ? body : ''),
      })
      let what = ''
      if (typeof args === 'string') {
        try { what = toolArgSummary(name, JSON.parse(args)) } catch { /* keep it blank */ }
      } else if (typeof body === 'string') {
        what = body.split('\n').find(line => line.trim() !== '')?.slice(0, 120) ?? ''
      }
      events.push({ kind: 'tool', at, turn: Math.max(1, turn), tool: name, text: what })
      const id = payload?.['call_id']
      if (typeof id === 'string') awaiting.set(id, events.length - 1)
      continue
    }

    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const id = payload?.['call_id']
      const seat = typeof id === 'string' ? awaiting.get(id) : undefined
      const target = seat === undefined ? undefined : events[seat]
      if (target !== undefined) target.result = resultSummary(payload?.['output'])
      if (typeof id === 'string') awaiting.delete(id)
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
        // OpenAI counts cached tokens inside `input_tokens`; Anthropic counts
        // them beside it, and the neutral model follows Anthropic. Reporting
        // the raw figure here would count Codex's cached context twice and
        // put its cache hit rate on a different scale from Claude Code's.
        input: Math.max(0, numberAt(last, 'input_tokens') - numberAt(last, 'cached_input_tokens')),
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

  if (steps.length === 0) return undefined
  const session: Session = {
    id: file.id,
    agent: 'codex',
    startedAt: startedAt || (steps[0]?.startedAt ?? 0),
    steps,
  }
  if (version !== undefined) session.agentVersion = version
  if (cwd !== undefined) session.cwd = cwd
  if (gitBranch !== undefined) session.gitBranch = gitBranch
  if (events.length > 0) session.events = events
  return session
}

/**
 * Read Codex rollouts into sessions.
 * @param limit - how many recent rollout files to read.
 * @param root - rollout root; defaults to the standard location.
 * @returns sessions, newest file first.
 */
export async function readCodexSessions(limit = 40, root = CODEX_ROOT): Promise<Session[]> {
  const files = newestFirst(await filesIn(root, 'codex'), limit)
  const sessions: Session[] = []
  for (const file of files) {
    const session = await parseCodexFile(file)
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}

/**
 * Every transcript this machine has, newest first, unread.
 *
 * The list is what an index page needs; the parse is what a session page
 * needs. Keeping them apart is what lets a thousand sessions be listed
 * without a gigabyte being read.
 * @param limit - how many recent files to return, across all agents.
 * @param roots - transcript roots; defaults to the standard locations.
 * @returns files, newest first.
 */
export async function listTranscripts(
  limit = 40,
  roots: { claude?: string; codex?: string } = {},
): Promise<TranscriptFile[]> {
  const [claude, codex] = await Promise.all([
    filesIn(roots.claude ?? CLAUDE_ROOT, 'claude-code'),
    filesIn(roots.codex ?? CODEX_ROOT, 'codex'),
  ])
  return newestFirst([...claude, ...codex], limit)
}

/**
 * Read one listed transcript, whichever agent wrote it.
 * @param file - a file from {@link listTranscripts}.
 * @returns the session, or undefined when the file held no steps.
 */
export async function readTranscript(file: TranscriptFile): Promise<Session | undefined> {
  return file.agent === 'codex' ? await parseCodexFile(file) : await parseClaudeFile(file)
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
