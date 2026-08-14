/**
 * What each agent looks like when it works.
 *
 * The tempting thing to build here is a scoreboard. It cannot be built. A
 * transcript records what was sent and what came back; it does not record
 * whether the answer was any good, whether the task was finished, or whether
 * the person had to ask again. Without those, "which agent is better" has no
 * numerator, and any ranking printed here would be invented.
 *
 * So this module computes two groups and labels them apart.
 *
 * **Habit** — how an agent works between actions: how many tools it fires in
 * one step, how often a step produces no action at all, how big its arguments
 * run. These barely move with task size; they are the harness's design showing
 * through, and they are comparable across agents.
 *
 * **Load** — what a turn cost: steps, output, wall time, context carried.
 * These move almost entirely with what you asked for. Two agents used on
 * different work will differ here for reasons that have nothing to do with the
 * agents. Shown, never ranked.
 *
 * @module
 */

import type { Session, Step } from './types.js'
import { median, summarise, byAgent } from './summary.js'

/** One agent's shape, in numbers that mean the same thing for every agent. */
export interface AgentProfile {
  agent: string
  sessions: number
  /** Turns a person actually opened; zero when the source records no events. */
  turns: number
  steps: number
  calls: number

  /** Tool calls per step — whether the agent batches its actions. */
  callsPerStep: number
  /** Share of steps that called no tool at all, 0..1. */
  silentStepShare: number
  /** Steps spent per tool call — model chatter per action taken. */
  stepsPerCall: number
  /** Median serialized size of one call's arguments. */
  argTokens: number
  /** Share of input served from cache, 0..1. */
  cacheHitRate: number

  /** Median tokens a single request carried, fresh plus cached. */
  contextPerStep: number
  /** Median output tokens in one step. */
  outputPerStep: number
  /** Median steps between one thing a person asked and the next. */
  stepsPerTurn: number
  /** Median output tokens spent on one turn. */
  outputPerTurn: number
  /** Median wall time a turn spanned, in seconds. */
  spanPerTurn: number
}

/**
 * Split a session's steps by the turn they fell in.
 *
 * A turn opens when a person types. Steps belong to the turn that was open
 * when they started, which is the last one opened at or before them.
 * @param session - the session to split.
 * @returns one array of steps per turn, empty turns dropped.
 */
export function stepsByTurn(session: Session): Step[][] {
  const opened = (session.events ?? [])
    .filter(event => event.kind === 'user' && event.at > 0)
    .map(event => event.at)
    .sort((a, b) => a - b)
  if (opened.length === 0) return []

  const turns: Step[][] = opened.map(() => [])
  for (const step of session.steps) {
    // Steps before the first turn belong to no turn a person opened — a
    // resumed session replays them — so they are dropped rather than
    // attributed to a question nobody asked.
    let seat = -1
    for (let i = 0; i < opened.length; i += 1) {
      if ((opened[i] as number) <= step.startedAt) seat = i
      else break
    }
    if (seat >= 0) (turns[seat] as Step[]).push(step)
  }
  return turns.filter(steps => steps.length > 0)
}

/**
 * Profile one agent's sessions.
 * @param agent - the label to carry.
 * @param sessions - that agent's sessions.
 * @returns the profile; zeroes rather than NaN for anything unmeasured.
 */
export function profile(agent: string, sessions: readonly Session[]): AgentProfile {
  const totals = summarise(sessions)
  const steps = sessions.flatMap(session => session.steps)
  const turns = sessions.flatMap(session => stepsByTurn(session))

  const context = steps
    .map(step => (step.usage?.input ?? 0) + (step.usage?.cacheRead ?? 0))
    .filter(value => value > 0)
  const argTokens = steps.flatMap(step => step.calls.map(call => call.argBytes)).filter(v => v > 0)
  const silent = steps.filter(step => step.calls.length === 0).length
  const sum = (list: readonly Step[], pick: (s: Step) => number): number =>
    list.reduce((t, s) => t + pick(s), 0)

  return {
    agent,
    sessions: sessions.length,
    turns: turns.length,
    steps: steps.length,
    calls: totals.toolCalls,

    callsPerStep: steps.length === 0 ? 0 : totals.toolCalls / steps.length,
    silentStepShare: steps.length === 0 ? 0 : silent / steps.length,
    stepsPerCall: totals.toolCalls === 0 ? 0 : steps.length / totals.toolCalls,
    argTokens: median(argTokens),
    cacheHitRate: totals.cacheHitRate,

    contextPerStep: median(context),
    outputPerStep: median(steps.map(step => step.usage?.output ?? 0)),
    stepsPerTurn: median(turns.map(list => list.length)),
    outputPerTurn: median(turns.map(list => sum(list, s => s.usage?.output ?? 0))),
    spanPerTurn: Math.round(median(turns.map(list => sum(list, s => s.durationMs ?? 0))) / 1000),
  }
}

/**
 * Profile every agent present, busiest first.
 * @param sessions - sessions from any number of agents.
 * @returns one profile per agent that produced at least one step.
 */
export function profiles(sessions: readonly Session[]): AgentProfile[] {
  return [...byAgent(sessions).entries()]
    .map(([agent, list]) => profile(agent, list))
    .filter(one => one.steps > 0)
    .sort((a, b) => b.steps - a.steps)
}
