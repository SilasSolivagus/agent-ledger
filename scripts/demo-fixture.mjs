#!/usr/bin/env node
/**
 * Write a fake machine's worth of transcripts, for screenshots and for trying
 * this out with nothing installed.
 *
 * The board is only as legible as the data behind it, and the two ways of
 * showing it off both fail: a real machine puts the author's commands, paths
 * and spending into a public README, and `--redact` turns every row into
 * 「··· 129 字」, which demonstrates the redactor rather than the product.
 * So this writes transcripts in the exact shapes the parsers expect — a third
 * place those formats are written down, and one that runs.
 *
 * Nothing here is anyone's data. The projects, commands and figures are made
 * up; the token counts are shaped like real ones, which mostly means cache
 * reads dwarfing fresh input.
 *
 * Usage:
 *   node scripts/demo-fixture.mjs <dir>
 *   HOME=<dir> node bin/agent-ledger.js serve
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node scripts/demo-fixture.mjs <dir>')
  process.exit(2)
}

/**
 * Deterministic pseudo-random, so a regenerated screenshot is the same
 * screenshot. `Math.random()` here would make every run a new diff.
 */
let seed = 20260819
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const pick = xs => xs[Math.floor(rnd() * xs.length)]
const between = (a, b) => Math.floor(a + rnd() * (b - a))

const START = Date.UTC(2026, 7, 19, 1, 0, 0)
const at = ms => new Date(START + ms).toISOString()

const WORK = [
  {
    project: 'acme-api', branch: 'fix/rate-limit-headers',
    said: '限流返回的 Retry-After 有时是秒有时是日期，客户端解析炸了。统一成秒，并且给个测试。',
    steps: [
      ['Bash', 'rg -n "Retry-After" src/', 'src/middleware/limit.ts:41\nsrc/middleware/limit.ts:88'],
      ['Read', 'src/middleware/limit.ts', '124 lines'],
      ['Edit', 'src/middleware/limit.ts', 'applied'],
      ['Bash', 'npm test -- limit', '12 passing'],
    ],
  },
  {
    project: 'acme-api', branch: 'main',
    said: '把上一版的迁移脚本回滚，线上那张表已经有数据了，不能重建。',
    steps: [
      ['Bash', 'git log --oneline -5 migrations/', '4 commits'],
      ['Read', 'migrations/0042_rebuild_orders.sql', '38 lines'],
      ['Write', 'migrations/0043_revert_0042.sql', 'written'],
      ['Bash', 'psql -f migrations/0043_revert_0042.sql --dry-run', 'OK'],
    ],
  },
  {
    project: 'payments-web', branch: 'feat/refund-flow',
    said: '退款流程差一个「部分退款」的分支，金额要能改，但不能超过原单。',
    steps: [
      ['Grep', 'refund', '17 matches in 6 files'],
      ['Read', 'app/refund/page.tsx', '210 lines'],
      ['Edit', 'app/refund/page.tsx', 'applied'],
      ['Edit', 'app/refund/schema.ts', 'applied'],
      ['Bash', 'pnpm test refund', '8 passing'],
    ],
  },
  {
    project: 'payments-web', branch: 'feat/refund-flow',
    said: '刚才那个校验漏了币种，跨币种退款会算错。',
    steps: [
      ['Read', 'app/refund/schema.ts', '64 lines'],
      ['Edit', 'app/refund/schema.ts', 'applied'],
      ['Bash', 'pnpm test refund', '9 passing'],
    ],
  },
  {
    project: 'infra', branch: 'main',
    said: '构建从 4 分钟涨到 11 分钟了，找出是哪一步。',
    steps: [
      ['Bash', 'gh run list --limit 20 --json databaseId,conclusion', '20 runs'],
      ['Bash', 'gh run view 8821 --log | tail -200', 'log'],
      ['WebSearch', 'turbo cache miss docker layer', '5 results'],
      ['Read', '.github/workflows/build.yml', '96 lines'],
      ['Edit', '.github/workflows/build.yml', 'applied'],
    ],
  },
]

/** A Claude Code transcript: one file, one session, JSONL. */
function claude(job, model, t0) {
  const rows = []
  let t = t0
  const push = o => rows.push(JSON.stringify(o))
  push({
    type: 'user', timestamp: at(t), cwd: `/work/${job.project}`, gitBranch: job.branch,
    version: '2.1.0', message: { content: job.said },
  })
  t += between(400, 1200)

  for (const [tool, input, out] of job.steps) {
    const id = `t${String(rows.length)}`
    // Cache reads dwarf fresh input on any session past its first turn; a
    // demo that showed them level would misrepresent every cost figure.
    push({
      type: 'assistant', timestamp: at(t), message: {
        model,
        usage: {
          input_tokens: between(120, 900),
          output_tokens: between(180, 1400),
          cache_read_input_tokens: between(140000, 320000),
          cache_creation_input_tokens: between(0, 9000),
        },
        content: [
          { type: 'text', text: pick(['先看一眼现状。', '定位到了，改这里。', '跑一下测试确认。', '这里还有一处同样的问题。']) },
          { type: 'tool_use', id, name: tool, input: tool === 'Bash' ? { command: input } : { file_path: input } },
        ],
      },
    })
    t += between(2000, 14000)
    push({
      type: 'user', timestamp: at(t),
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: out }] },
    })
    t += between(300, 2500)
  }

  push({
    type: 'assistant', timestamp: at(t), message: {
      model,
      usage: {
        input_tokens: between(120, 600), output_tokens: between(300, 900),
        cache_read_input_tokens: between(150000, 300000), cache_creation_input_tokens: 0,
      },
      content: [{ type: 'text', text: '改完了，测试过了。' }],
    },
  })
  return rows.join('\n') + '\n'
}

/** A Codex rollout: same session, the other dialect. */
function codex(job, t0) {
  const rows = []
  let t = t0
  const push = o => rows.push(JSON.stringify(o))
  push({ timestamp: at(t), type: 'session_meta', payload: { id: `cx-${job.project}`, cwd: `/work/${job.project}`, cli_version: '0.140.0' } })
  push({ timestamp: at(t), type: 'turn_context', payload: { model: 'gpt-5.4' } })
  push({ timestamp: at(t), type: 'event_msg', payload: { type: 'user_message', message: job.said } })
  t += between(500, 1500)

  for (const [tool, input, out] of job.steps) {
    const call = `c${String(rows.length)}`
    push({
      timestamp: at(t), type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这一步先确认。' }] },
    })
    push({
      timestamp: at(t), type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: call, arguments: JSON.stringify({ cmd: `${tool === 'Bash' ? '' : 'cat '}${input}` }) },
    })
    t += between(1500, 9000)
    push({
      timestamp: at(t), type: 'response_item',
      payload: { type: 'function_call_output', call_id: call, output: out },
    })
    // OpenAI counts cached tokens inside input_tokens; the adapter splits them
    // back out, and a fixture that ignored that would hide the bug it exists
    // to prevent.
    const cached = between(90000, 240000)
    push({
      timestamp: at(t), type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: {
        input_tokens: cached + between(200, 1100), output_tokens: between(200, 1200), cached_input_tokens: cached,
      } } },
    })
    t += between(300, 2000)
  }
  return rows.join('\n') + '\n'
}

const cdir = join(root, '.claude', 'projects', 'work-demo')
const xdir = join(root, '.codex', 'sessions', '2026', '08', '19')
await mkdir(cdir, { recursive: true })
await mkdir(xdir, { recursive: true })

let t = 0
for (const [i, job] of WORK.entries()) {
  const model = i % 3 === 0 ? 'claude-opus-5' : 'claude-sonnet-5'
  await writeFile(join(cdir, `session-demo-${String(i + 1)}.jsonl`), claude(job, model, t), 'utf8')
  t += between(600000, 2400000)
}
// Two of the same jobs run through Codex, so the comparison has both sides.
for (const [i, job] of WORK.slice(0, 2).entries()) {
  await writeFile(
    join(xdir, `rollout-2026-08-19T0${String(i + 2)}-00-00-demo${String(i + 1)}.jsonl`),
    codex(job, 300000 + i * 900000), 'utf8',
  )
}

console.error(`demo fixture: ${String(WORK.length)} Claude sessions, 2 Codex rollouts → ${root}`)
console.error(`  HOME=${root} node bin/agent-ledger.js serve --fresh`)
