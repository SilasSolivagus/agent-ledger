/**
 * The resident view: one address that always shows what just happened.
 *
 * `report` writes a file, which means every look costs a command and every
 * look is stale the moment it lands. A server costs one command ever, and a
 * refresh is the whole interaction.
 *
 * Two things make that viable at real scale — this machine has over a thousand
 * transcripts and a gigabyte of them. First, listing is separated from
 * reading: the index knows every session exists but reads only the recent
 * ones, and one session page reads exactly one file. Second, a parsed session
 * is kept until its file's mtime moves, so the only thing re-read on a refresh
 * is the session you are still living in.
 *
 * Bound to loopback, always. The pages carry your commands, your paths and
 * your conversations; nothing here should be reachable from the network.
 *
 * @module
 */

import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import {
  defaultSources, installedAgents, listTranscripts, parseCursorFile, readTranscript,
  type Sources, type TranscriptFile,
} from './transcript.js'
import { renderLive, renderSession, ZOOMS } from './render.js'
import {
  baselineFrom, boardsOf, movedSince, sinceBaseline, windowFrom, RANGES, type Baseline,
} from './live.js'
import { readBaseline, writeBaseline } from './baseline.js'
import { readWorkbuddySessions, workbuddyTouchedAt, type WorkbuddyDetail } from './workbuddy.js'
import { redactSession } from './redact.js'
import type { Session } from './types.js'

/** How to serve. */
export interface ServeOptions {
  port: number
  /** How many recent sessions the index reads and totals. */
  limit: number
  /** Serve shape without content — safe for a screen share. */
  redact?: boolean
  /** Seconds between the board's own reloads. */
  refreshSeconds?: number
  /**
   * Where to remember the baseline across restarts.
   *
   * Absent means no persistence at all — never "use the default location". A
   * test that forgets it must write nothing, the same rule the transcript
   * roots follow.
   */
  state?: string
  /** Ignore any stored baseline and start watching from now. */
  fresh?: boolean
  /**
   * Where every source lives. Defaults to this machine's real installation.
   *
   * A test builds on `noSources()` so that a path it forgets reads as absent
   * rather than as the developer's own data — the bug this shape exists to
   * make impossible.
   */
  roots?: Sources
}

/**
 * A parsed session, good until the file it came from is written again.
 *
 * `session` is absent when the file held no model call at all — an opened and
 * abandoned window. Remembering that emptiness is what keeps a hundred such
 * stubs from being re-read on every refresh.
 */
interface Cached { mtimeMs: number; session?: Session }

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } as const

/** A page for the two things that can go wrong, in the same voice as the rest. */
function plain(title: string, detail: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>`
    + `<title>${title}</title></head><body style="font-family:-apple-system,sans-serif;`
    + `padding:60px 40px;background:#efeee9;color:#1c1c1a">`
    + `<h1 style="font-size:20px">${title}</h1><p style="font-size:13px;color:#55554f">${detail}</p>`
    + `<p style="font-size:13px"><a href="/">← 全部会话</a></p></body></html>`
}

/**
 * Build the server without listening, so a test can pick its own port.
 * @param options - port is unused here; limit and roots are what matter.
 * @returns an idle HTTP server.
 */
export function createLedgerServer(options: ServeOptions, now = Date.now()): Server {
  const cache = new Map<string, Cached>()
  const sources = options.roots ?? defaultSources()
  // Taken when the server is built, not when the first request arrives.
  // Otherwise starting the server and opening the browser five minutes later
  // would fold those five minutes of real work into the baseline and hide it.
  const ready: Promise<Baseline> = (async (): Promise<Baseline> => {
    const stored = options.fresh === true ? undefined : await readBaseline(options.state)
    if (stored !== undefined) return stored
    const files = await listTranscripts(Infinity, sources)
    const made = baselineFrom(files, now)
    await writeBaseline(options.state, made)
    return made
  })()
  const refreshSeconds = options.refreshSeconds ?? 5

  /** Parse a file, or hand back the copy that is still good. */
  const load = async (file: TranscriptFile): Promise<Session | undefined> => {
    const hit = cache.get(file.path)
    if (hit !== undefined && hit.mtimeMs === file.mtimeMs) return hit.session
    const parsed = await readTranscript(file)
    // Redacting on the way into the cache means no route can serve the raw
    // session by forgetting to ask for it.
    const session = parsed !== undefined && options.redact === true
      ? redactSession(parsed)
      : parsed
    cache.set(file.path, session === undefined
      ? { mtimeMs: file.mtimeMs }
      : { mtimeMs: file.mtimeMs, session })
    return session
  }

  return createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = req.url ?? '/'
      const path = decodeURIComponent(url.split('?')[0] ?? '/')
      // The page carries no script, so its one control — how many pixels a
      // second is worth — travels in the URL.
      // Empty means "not asked", which is different from an explicit `all`:
      // the bare board must still land on whichever vendor is busy, and the
      // cross-vendor comparison must be something you chose to open.
      const wanted = decodeURIComponent(/[?&]agent=([^&]+)/.exec(url)?.[1] ?? '')
      const picked = decodeURIComponent(/[?&]s=([^&]+)/.exec(url)?.[1] ?? '')
      const askedZoom = /[?&]zoom=([a-z]+)/.exec(url)?.[1] ?? ''
      const zoom = askedZoom in ZOOMS ? askedZoom : 'mid'
      const compress = /[?&]idle=on/.test(url) ? false : true
      // Pausing removes the meta refresh, which is also the only way the
      // entrance animation is ever seen: it plays on load, and a page that
      // reloads every few seconds must not animate.
      const paused = /[?&]live=off/.test(url)
      // Which slice of time the board is about. The baseline is the default
      // and the product's original idea, but it is now one window of four.
      const askedRange = /[?&]range=([a-z]+)/.exec(url)?.[1] ?? ''
      const range = askedRange in RANGES ? askedRange : 'watch'

      if (path === '/favicon.ico') { res.writeHead(204).end(); return }

      // Every route needs the file list and nothing else needs a scan, so this
      // is the one place the disk is walked. Stat over a thousand files is
      // milliseconds; it is the reads that are expensive.
      const files = await listTranscripts(Infinity, sources)

      if (path === '/') {
        const baseline = await ready
        const since = windowFrom(range, baseline, Date.now())
        // The baseline window asks "what moved", which needs the byte sizes.
        // Every other window is a plain time filter, and the per-agent budget
        // applies there because "全部" on this machine is 1,806 files.
        const candidates = range === 'watch'
          ? movedSince(files, baseline)
          : files.filter(file => file.mtimeMs >= since)
        const sessions: Session[] = []
        const budget = new Map<string, number>()
        // A cap that is not announced reads as "this is everything". It is
        // not: widening to 全部 on this machine offers 1,806 files and the
        // board reads the newest few per agent.
        let capped = 0
        for (const file of candidates) {
          if (range !== 'watch' && (budget.get(file.agent) ?? 0) >= options.limit) { capped += 1; continue }
          // A source without timestamps is trimmed by position: records past
          // the byte offset the baseline recorded are the new ones. The cache
          // is bypassed for those, since what counts as new depends on the
          // baseline rather than on the file alone. Only the baseline window
          // has an offset to trim against; the others read the file whole.
          const parsed = file.agent === 'cursor'
            ? await parseCursorFile(file, range === 'watch' ? baseline.sizes.get(file.path) ?? 0 : 0)
            : await load(file)
          if (parsed === undefined) continue
          const live = sinceBaseline(parsed, since)
          if (live === undefined) continue
          budget.set(file.agent, (budget.get(file.agent) ?? 0) + 1)
          sessions.push(live)
        }
        // WorkBuddy keeps a database rather than files, so it is read whole
        // and filtered by each row's own last-activity time.
        const source: WorkbuddyDetail[] = []
        for (const row of await readWorkbuddySessions(sources.workbuddy)) {
          if ((row.session.endedAt ?? row.session.startedAt) < since) continue
          sessions.push(row.session)
          source.push(row.detail)
        }

        const boards = boardsOf(sessions)
        // A source is watched because it is installed, not because it has been
        // busy. Otherwise WorkBuddy is missing from "正在监听" until it happens
        // to move, which reads as "not supported" rather than "nothing yet".
        // Installed, not busy: a root that exists but holds nothing yet still
        // belongs in the switcher, or an idle agent reads as unsupported.
        const watching = [...new Set([
          ...installedAgents(sources),
          ...sessions.map(one => one.agent),
          ...(await workbuddyTouchedAt(sources.workbuddy) > 0 ? ['workbuddy'] : []),
        ])].sort()
        // A watched agent stays selected even with nothing to show. The
        // fallback is for an unknown value in the URL, and "installed but
        // idle" is not one — falling back there silently bounced a click on a
        // quiet agent to whichever one happened to be busy.
        const agents = [...boards.keys()]
        // `all` is the cross-vendor tab rather than an agent, so it is allowed
        // through here even though no source is named that.
        const chosen = wanted === 'all' || watching.includes(wanted) ? wanted
          : agents[0] ?? watching[0] ?? ''
        res.writeHead(200, HTML).end(renderLive(
          boards, watching, since, chosen,
          picked === '' ? undefined : picked,
          paused ? null : refreshSeconds, zoom, compress, source, range,
          capped === 0 ? undefined : { dropped: capped, limit: options.limit },
        ))
        return
      }

      if (path.startsWith('/s/')) {
        const id = path.slice(3)
        // Matched against the list rather than joined into a path: an id from
        // a URL never becomes a filename, so there is nothing to traverse.
        const file = files.find(f => f.id === id)
        if (file === undefined) {
          res.writeHead(404, HTML).end(plain('没有这个会话', `找不到 ${id}。它可能已经被删掉了。`))
          return
        }
        const session = await load(file)
        if (session === undefined) {
          res.writeHead(200, HTML).end(plain('这个会话是空的', '记录存在，但里面没有任何模型请求。'))
          return
        }
        res.writeHead(200, HTML).end(renderSession(session, zoom, compress))
        return
      }

      res.writeHead(404, HTML).end(plain('没有这一页', `${path} 不是一个地址。`))
    })().catch((error: unknown) => {
      // A parse that goes wrong must not take the server down with it; the
      // next refresh should still work.
      const detail = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) res.writeHead(500, HTML)
      res.end(plain('出错了', detail))
    })
  })
}

/** Ask the desktop to open a URL, and say nothing if it cannot. */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      .unref()
  } catch { /* a headless machine is a fine place to run this */ }
}

/**
 * Start serving until interrupted.
 * @param options - port, how many sessions the index reads, and roots.
 * @param open - whether to hand the URL to the desktop browser.
 * @returns the process exit code.
 */
export async function serve(options: ServeOptions, open: boolean): Promise<number> {
  const server = createLedgerServer(options)
  const url = `http://127.0.0.1:${String(options.port)}`

  const listening = await new Promise<boolean>(resolve => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      console.error(error.code === 'EADDRINUSE'
        ? `agent-ledger: port ${String(options.port)} is taken. Try --port ${String(options.port + 1)}.`
        : `agent-ledger: ${error.message}`)
      resolve(false)
    })
    server.listen(options.port, '127.0.0.1', () => resolve(true))
  })
  if (!listening) return 1

  console.error(`agent-ledger serving on ${url}`)
  if (options.redact === true) console.error('  redacted — shape only, no commands, paths, or conversation')
  console.error('  watching for new activity · everything already on disk stays off the board')
  console.error(`  widen the window on the board itself · ${String(options.limit)} sessions per agent when you do`)
  console.error('  local only, nothing uploaded · Ctrl-C to stop')
  if (open) openBrowser(url)

  await new Promise<void>(resolve => {
    process.on('SIGINT', () => {
      // An open tab holds a keep-alive socket, and close() waits for every
      // connection to end on its own — so Ctrl-C would appear to hang until
      // the browser gave up. Drop the sockets too.
      server.close()
      server.closeAllConnections()
      resolve()
    })
  })
  return 0
}
