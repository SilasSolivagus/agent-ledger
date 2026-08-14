/**
 * The recording proxy.
 *
 * It sits between your agent and the model API and must be invisible: bytes go
 * up unchanged, bytes come back unchanged, and if anything in this file throws
 * the traffic still gets through. Observation is strictly a side effect of a
 * `tee()` on the response stream — the client's copy is never waited on by the
 * parser, and the parser's failures are swallowed rather than propagated.
 *
 * One port serves every agent: the upstream is chosen by request path, so
 * Claude Code and Codex can point at the same address.
 *
 * @module
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Step, Wire } from './types.js'

/** Upstream selection by path — the only routing this proxy performs. */
const ROUTES: readonly { match: RegExp; origin: string; wire: Wire }[] = [
  { match: /^\/v1\/messages/, origin: 'https://api.anthropic.com', wire: 'anthropic-messages' },
  { match: /^\/v1\/responses/, origin: 'https://api.openai.com', wire: 'openai-responses' },
  { match: /^\/v1\/chat\/completions/, origin: 'https://api.openai.com', wire: 'openai-chat' },
]

/** Headers a proxy must not forward verbatim. */
const STRIP = new Set(['host', 'connection', 'content-length', 'accept-encoding'])

/** What the recorder is handed once a step completes. */
export type StepSink = (step: Step) => void

export interface ProxyOptions {
  port: number
  /** Override the upstream for every route — for tests, or a gateway. */
  upstream?: string
  /** Receives each completed step. Throwing here cannot break traffic. */
  onStep: StepSink
  /** Optional log line for operational visibility. */
  onLog?: (line: string) => void
}

/** Resolve which upstream and dialect a path belongs to. */
export function routeFor(path: string): { origin: string; wire: Wire } | undefined {
  const hit = ROUTES.find(r => r.match.test(path))
  return hit === undefined ? undefined : { origin: hit.origin, wire: hit.wire }
}

/** Copy request headers, dropping the hop-by-hop ones a proxy must rewrite. */
function forwardHeaders(source: IncomingMessage['headers']): Headers {
  const out = new Headers()
  for (const [key, value] of Object.entries(source)) {
    if (STRIP.has(key.toLowerCase()) || value === undefined) continue
    out.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return out
}

/** Read a request body fully; agents send modest JSON, not uploads. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Drain a stream into the parser without ever blocking the client's copy.
 *
 * Errors are swallowed on purpose: a malformed frame, an unknown event, or a
 * bug in the parser must not surface as a failed request to the user.
 */
function observe(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  onDone: () => void,
): void {
  void (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) onChunk(decoder.decode(value, { stream: true }))
      }
    } catch {
      // Observation is best-effort; the client already has its own copy.
    } finally {
      try { onDone() } catch { /* a sink bug must not take the process down */ }
    }
  })()
}

/**
 * Start the recording proxy.
 *
 * @param options - port, sink, and optional upstream override.
 * @param parse - builds a step from one request/response pair.
 * @returns the listening server.
 */
export function startProxy(
  options: ProxyOptions,
  parse: (input: {
    wire: Wire
    requestBody: unknown
    startedAt: number
    firstByteAt?: number
    endedAt: number
    responseText: string
    status: number
    index: number
  }) => Step,
): Server {
  let index = 0
  const log = options.onLog ?? (() => {})

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = req.url ?? '/'
      const route = routeFor(path)
      const origin = options.upstream ?? route?.origin

      if (origin === undefined) {
        // An unrecognised path is still forwarded nowhere useful; say so
        // plainly rather than hanging the agent.
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `agent-ledger: no upstream for ${path}` }))
        return
      }

      const body = await readBody(req)
      const startedAt = Date.now()
      let upstream: Response
      try {
        upstream = await fetch(origin + path, {
          method: req.method ?? 'POST',
          headers: forwardHeaders(req.headers),
          body: body.length === 0 ? undefined : body,
        })
      } catch (error) {
        // The upstream is unreachable. Report it as a gateway error so the
        // agent can retry, and record nothing.
        log(`upstream failed: ${error instanceof Error ? error.message : String(error)}`)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'agent-ledger: upstream unreachable' }))
        return
      }

      const headers: Record<string, string> = {}
      upstream.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'content-encoding') return
        headers[key] = value
      })
      res.writeHead(upstream.status, headers)

      if (upstream.body === null) {
        res.end()
        return
      }

      // One copy to the client, one to the parser. The client's copy is
      // never gated on parsing.
      const [toClient, toParser] = upstream.body.tee()

      let firstByteAt: number | undefined
      let text = ''
      const myIndex = index
      index += 1
      observe(
        toParser,
        chunk => {
          firstByteAt ??= Date.now()
          // Bound retention: a long stream's tail carries usage, which is what
          // the parser needs; the middle is already summarised by then.
          text = (text + chunk).slice(-2_000_000)
        },
        () => {
          let requestBody: unknown
          try { requestBody = JSON.parse(body.toString('utf8')) } catch { requestBody = undefined }
          try {
            options.onStep(parse({
              wire: options.upstream === undefined ? (route?.wire ?? 'unknown') : (route?.wire ?? 'unknown'),
              requestBody,
              startedAt,
              firstByteAt,
              endedAt: Date.now(),
              responseText: text,
              status: upstream.status,
              index: myIndex,
            }))
          } catch (error) {
            log(`parse failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      )

      const reader = toClient.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined) res.write(value)
        }
      } catch {
        // Client hung up mid-stream; nothing to do but stop writing.
      } finally {
        res.end()
      }
    })().catch((error: unknown) => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'agent-ledger: internal error' }))
      } else {
        res.end()
      }
    })
  })

  server.listen(options.port, '127.0.0.1')
  return server
}
