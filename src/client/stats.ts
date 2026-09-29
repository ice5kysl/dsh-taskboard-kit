/**
 * Board analytics — the「统计」view's data layer.
 *
 * Pure functions over `Board`, no React and no I/O, so the numbers are testable
 * and the panel stays a projection. Everything here is derived from the ONE
 * source of truth we already have: task fields plus the append-only `log`
 * (which carries `at` / `by` / `event` per transition). No new board fields,
 * nothing to keep in sync.
 *
 * What it answers, in the order a human asks it:
 *   1. 现状 (where are we?)      — status / priority / value distribution, WIP
 *   2. 谁在扛 (who carries it?)  — per-owner open load, throughput, cycle time
 *   3. 在变好吗 (is it moving?)  — daily created/settled flow + backlog trend
 *   4. 卡在哪 (where does it stall?) — time-in-column, rejection rate
 *
 * Design notes:
 *   • A task's "entered column X at" is derived from the log by replaying it
 *     (see `columnEnteredAt`), because the board stores no per-column stamps.
 *   • Days are bucketed in LOCAL time (`dayKey`), matching how a human reads
 *     "今天/昨天" — a UTC bucket would shift the boundary by 8h here.
 *   • Every list is returned newest-or-largest first; the panel does no sorting.
 *
 * @module dsh-taskboard-kit/client-stats
 */

import type { Board, Task, TaskEvent, TaskPriority, TaskStatus, TaskValue } from '../shared/types.ts'
import { TERMINAL_STATUS, columnOf, isTerminalStatus, needsSettling } from '../shared/types.ts'

const HOUR = 3600_000
const DAY = 24 * HOUR

/** Local-time day key (`2026-09-29`), the bucket unit of every time series. */
export function dayKey(at: number | string): string {
  const date = typeof at === 'string' ? new Date(at) : new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Today's key in local time. */
export function todayKey(now: number = Date.now()): string {
  return dayKey(now)
}

/**
 * The day keys for the last `days` days ending today, oldest first — the fixed
 * x-axis every chart shares, so two charts side by side line up even when one
 * of them has no events on a given day.
 */
export function daySeries(days: number, now: number = Date.now()): string[] {
  const out: string[] = []
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  for (let index = days - 1; index >= 0; index -= 1) {
    out.push(dayKey(start.getTime() - index * DAY))
  }
  return out
}

/** One row of the per-day flow chart. */
export interface DayFlow {
  day: string
  /** Cards created that day. */
  created: number
  /** Cards that reached a terminal state (`closed`) that day. */
  settled: number
  /** submitted→… transitions: work actually pushed forward. */
  reviewEvents: number
  /** Cumulative created − settled up to and including this day (backlog). */
  backlog: number
}

/** Tasks whose log contains `event`, with the FIRST such timestamp. */
function firstEventAt(task: Task, events: readonly TaskEvent[]): number | null {
  for (const entry of task.log) {
    if (events.includes(entry.event)) {
      const at = Date.parse(entry.at)
      if (!Number.isNaN(at)) return at
    }
  }
  return null
}

/** Tasks whose log contains `event`, with the LAST such timestamp. */
function lastEventAt(task: Task, events: readonly TaskEvent[]): number | null {
  let found: number | null = null
  for (const entry of task.log) {
    if (events.includes(entry.event)) {
      const at = Date.parse(entry.at)
      if (!Number.isNaN(at)) found = at
    }
  }
  return found
}

/**
 * When the card entered the column it is in NOW.
 *
 * Replayed from the log: the last transition that changes which column a task
 * belongs to. `created` starts the clock for a brand-new card, and field-only
 * events (`updated`, `blocked`, comments) deliberately do not restart it — that
 * is the same rule the staleness check uses, so the two never disagree.
 */
export function columnEnteredAt(task: Task, now: number = Date.now()): number {
  const CREATED = Date.parse(task.created_at)
  let at = Number.isNaN(CREATED) ? now : CREATED
  for (const entry of task.log) {
    if (!COLUMN_EVENTS.has(entry.event)) continue
    const ts = Date.parse(entry.at)
    if (!Number.isNaN(ts) && ts >= at) at = ts
  }
  return at
}

/**
 * Events that move a card between columns. Kept in one place so
 * `columnEnteredAt` and the flow charts agree on what "progress" means.
 * `updated` / `blocked` / `unblocked` are NOT here: they are orthogonal to the
 * column (blocking changes `waiting_on`, not the lane).
 */
const COLUMN_EVENTS: ReadonlySet<TaskEvent> = new Set<TaskEvent>([
  'created', 'claimed', 'assigned', 'started', 'stopped',
  'submitted', 'approved', 'rejected', 'done', 'reopened', 'closed',
])

/** How long a card has been in its current column. */
export function timeInColumnMs(task: Task, now: number = Date.now()): number {
  return Math.max(0, now - columnEnteredAt(task, now))
}

// ------------------------------------------------------------------ headline

/**
 * A median plus the number of samples behind it.
 *
 * The count is NOT optional bookkeeping: a median over one card is that card,
 * and showing "10.3h" from a single sample is how a statistic starts lying.
 * Every surface that renders `value` must be able to render `n` too.
 */
export interface Metric {
  value: number | null
  /** How many observations produced `value`; 0 when it is null. */
  n: number
}

export interface Headline {
  total: number
  /** Not yet settled (everything except `closed`) — the real "open" number. */
  open: number
  /** done but not closed: finished, still owes a settle (v0.6). */
  unsettled: number
  settled: number
  /** Cards in progress-like columns right now (in_progress + review). */
  wip: number
  /** Blocked on someone right now. */
  blocked: number
  /**
   * Median `created → done` (ms): how long the WORK takes. Measured to the
   * `done`/`approved` transition, NOT to `closed` — closing is an
   * administrative step that can lag for days, and folding that lag in makes
   * delivery look slower the more nobody gets around to settling cards.
   */
  cycle: Metric
  /**
   * Median `done → closed` (ms): the settle lag. Separate from `cycle` on
   * purpose — together they say "the work is fast, the paperwork is slow",
   * which one combined number can never express.
   */
  settleLag: Metric
  /** Of the cards that reached review, the share rejected at least once. */
  rejectRate: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function headline(board: Board | null, now: number = Date.now()): Headline {
  const tasks = board ? Object.values(board.tasks) : []
  const cycles: number[] = []
  const lags: number[] = []
  let reviewed = 0
  let rejected = 0
  for (const task of tasks) {
    const createdAt = Date.parse(task.created_at)
    // Work time ends when the work ended, not when someone filed it away.
    const finishedAt = firstEventAt(task, ['done', 'approved'])
    if (finishedAt !== null && !Number.isNaN(createdAt)) cycles.push(Math.max(0, finishedAt - createdAt))
    const closedAt = firstEventAt(task, ['closed'])
    if (closedAt !== null && finishedAt !== null) lags.push(Math.max(0, closedAt - finishedAt))
    if (firstEventAt(task, ['submitted']) !== null) {
      reviewed += 1
      if (firstEventAt(task, ['rejected']) !== null) rejected += 1
    }
  }
  void now
  return {
    total: tasks.length,
    open: tasks.filter((task) => !isTerminalStatus(task.status)).length,
    unsettled: tasks.filter((task) => needsSettling(task)).length,
    settled: tasks.filter((task) => isTerminalStatus(task.status)).length,
    wip: tasks.filter((task) => task.status === 'in_progress' || task.status === 'review').length,
    blocked: tasks.filter((task) => task.waiting_on !== null && !isTerminalStatus(task.status)).length,
    cycle: { value: median(cycles), n: cycles.length },
    settleLag: { value: median(lags), n: lags.length },
    rejectRate: reviewed === 0 ? null : rejected / reviewed,
  }
}

// ------------------------------------------------------------- distributions

export interface Slice {
  key: string
  /** Count of tasks in this slice. */
  count: number
  /** Share of the whole, 0…1. */
  share: number
}

function toSlices(entries: Array<[string, number]>, total: number): Slice[] {
  return entries
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count, share: total === 0 ? 0 : count / total }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** Tasks per status column, largest first. */
export function byStatus(board: Board | null): Slice[] {
  const tasks = board ? Object.values(board.tasks) : []
  const counts = new Map<string, number>()
  for (const task of tasks) {
    const column = columnOf(task)
    counts.set(column, (counts.get(column) ?? 0) + 1)
  }
  return toSlices([...counts.entries()], tasks.length)
}

export function byPriority(board: Board | null): Slice[] {
  const tasks = board ? Object.values(board.tasks) : []
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.priority, (counts.get(task.priority) ?? 0) + 1)
  return toSlices([...counts.entries()], tasks.length)
}

/**
 * Value points per owner (sum of `value`), largest first — "where is the
 * effort actually going". Tasks with `null` value contribute 0 and are
 * reported separately via `unestimated`.
 */
export function valueByOwner(board: Board | null): { rows: Array<{ owner: string; value: number; tasks: number }>; unestimated: number } {
  const tasks = board ? Object.values(board.tasks) : []
  const acc = new Map<string, { value: number; tasks: number }>()
  let unestimated = 0
  for (const task of tasks) {
    if (task.value === null) {
      unestimated += 1
      continue
    }
    const owner = task.assignee ?? ''
    const row = acc.get(owner) ?? { value: 0, tasks: 0 }
    row.value += task.value
    row.tasks += 1
    acc.set(owner, row)
  }
  const rows = [...acc.entries()]
    .map(([owner, row]) => ({ owner, ...row }))
    .sort((a, b) => b.value - a.value || a.owner.localeCompare(b.owner))
  return { rows, unestimated }
}

// ------------------------------------------------------------------ per owner

export interface OwnerStat {
  owner: string
  /** Not settled right now. */
  open: number
  /** done but unsettled (owes a close). */
  unsettled: number
  settled: number
  /** Sum of value points over this owner's tasks. */
  value: number
  /** Events this owner logged in the window (a cheap activity measure). */
  actions: number
  /** Median `created → done` over this owner's finished cards (see `Metric`). */
  cycle: Metric
}

/**
 * Per-owner table: current load plus how much they actually moved.
 * `owner` is the raw assignee string (`''` = the unassigned pool) — folding
 * aliases is the roster's job and is applied by the caller when it has one.
 */
export function byOwner(board: Board | null, options: { days?: number; now?: number } = {}): OwnerStat[] {
  const now = options.now ?? Date.now()
  const since = now - (options.days ?? 30) * DAY
  const tasks = board ? Object.values(board.tasks) : []
  const acc = new Map<string, OwnerStat & { cycles: number[] }>()

  const rowFor = (owner: string) => {
    let row = acc.get(owner)
    if (!row) {
      row = { owner, open: 0, unsettled: 0, settled: 0, value: 0, actions: 0, cycle: { value: null, n: 0 }, cycles: [] }
      acc.set(owner, row)
    }
    return row
  }

  for (const task of tasks) {
    const owner = task.assignee ?? ''
    const row = rowFor(owner)
    if (isTerminalStatus(task.status)) row.settled += 1
    else row.open += 1
    if (needsSettling(task)) row.unsettled += 1
    if (task.value !== null) row.value += task.value
    // Same rule as the headline: measure the WORK, not the paperwork.
    const finishedAt = firstEventAt(task, ['done', 'approved'])
    const createdAt = Date.parse(task.created_at)
    if (finishedAt !== null && !Number.isNaN(createdAt)) row.cycles.push(Math.max(0, finishedAt - createdAt))
  }

  // Activity is attributed to whoever logged the event, which may be someone
  // other than the assignee (a reviewer approving, a PO closing).
  for (const task of tasks) {
    for (const entry of task.log) {
      const at = Date.parse(entry.at)
      if (Number.isNaN(at) || at < since) continue
      if (entry.event === 'updated') continue // field edits, not progress
      rowFor(entry.by).actions += 1
    }
  }

  return [...acc.values()]
    .map(({ cycles, ...row }) => ({ ...row, cycle: { value: median(cycles), n: cycles.length } }))
    .sort((a, b) => b.open - a.open || b.actions - a.actions || a.owner.localeCompare(b.owner))
}

// ------------------------------------------------------------------ the flow

/**
 * The daily flow series — created vs settled, with a running backlog.
 *
 * `backlog` is the headline number for "are we keeping up": it counts cards
 * created on or before that day and not yet settled by the end of it. A backlog
 * that only ever rises means work arrives faster than it closes.
 */
export function flow(board: Board | null, options: { days?: number; now?: number } = {}): DayFlow[] {
  const now = options.now ?? Date.now()
  const days = options.days ?? 30
  const tasks = board ? Object.values(board.tasks) : []
  const series = daySeries(days, now)
  const index = new Map(series.map((day, position) => [day, position]))
  const created = new Array<number>(series.length).fill(0)
  const settled = new Array<number>(series.length).fill(0)
  const reviews = new Array<number>(series.length).fill(0)

  const bump = (bucket: number | undefined, counters: number[]): void => {
    if (bucket !== undefined) counters[bucket] = (counters[bucket] ?? 0) + 1
  }

  for (const task of tasks) {
    bump(index.get(dayKey(task.created_at)), created)
    for (const entry of task.log) {
      if (entry.event === 'created') continue // counted from created_at
      const bucket = index.get(dayKey(entry.at))
      if (entry.event === 'closed') bump(bucket, settled)
      if (entry.event === 'submitted') bump(bucket, reviews)
    }
  }

  // Backlog is seeded with everything created BEFORE the window so the trend
  // starts from the real number instead of from zero.
  const windowStart = series.length > 0 ? Date.parse(`${series[0]}T00:00:00`) : now
  let running = tasks.filter((task) => {
    const createdAt = Date.parse(task.created_at)
    return !Number.isNaN(createdAt) && createdAt < windowStart && !isTerminalStatus(task.status)
  }).length

  return series.map((day, position) => {
    running += created[position]!
    running -= settled[position]!
    if (running < 0) running = 0
    return {
      day,
      created: created[position]!,
      settled: settled[position]!,
      reviewEvents: reviews[position]!,
      backlog: running,
    }
  })
}

/**
 * Cumulative time-in-column, for the「卡在哪」chart: how much waiting has piled
 * up in each column across the cards sitting there right now.
 */
export function dwellByColumn(board: Board | null, now: number = Date.now()): Array<{ column: string; totalMs: number; tasks: number; longestMs: number }> {
  const tasks = board ? Object.values(board.tasks) : []
  const acc = new Map<string, { totalMs: number; tasks: number; longestMs: number }>()
  for (const task of tasks) {
    if (isTerminalStatus(task.status)) continue
    const column = columnOf(task)
    const ms = timeInColumnMs(task, now)
    const row = acc.get(column) ?? { totalMs: 0, tasks: 0, longestMs: 0 }
    row.totalMs += ms
    row.tasks += 1
    row.longestMs = Math.max(row.longestMs, ms)
    acc.set(column, row)
  }
  return [...acc.entries()]
    .map(([column, row]) => ({ column, ...row }))
    .sort((a, b) => b.totalMs - a.totalMs)
}

/** Throughput per actor over the window, largest first. */
export function actionsByActor(board: Board | null, options: { days?: number; now?: number } = {}): Slice[] {
  const now = options.now ?? Date.now()
  const since = now - (options.days ?? 30) * DAY
  const counts = new Map<string, number>()
  let total = 0
  for (const task of board ? Object.values(board.tasks) : []) {
    for (const entry of task.log) {
      const at = Date.parse(entry.at)
      if (Number.isNaN(at) || at < since) continue
      if (entry.event === 'updated') continue
      counts.set(entry.by, (counts.get(entry.by) ?? 0) + 1)
      total += 1
    }
  }
  return toSlices([...counts.entries()], total)
}

// ------------------------------------------------------------------ helpers

/** `1.5d` / `4h` / `12m` — compact durations for the stat tiles. */
export function durationText(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = ms / HOUR
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(ms / DAY).toFixed(1)}d`
}

/** `82%` — percentages never show a false precision above a whole point. */
export function percentText(share: number | null): string {
  if (share === null) return '—'
  return `${Math.round(share * 100)}%`
}

/** Sum of value points on the board (estimated cards only). */
export function totalValue(board: Board | null): number {
  let sum = 0
  for (const task of board ? Object.values(board.tasks) : []) {
    if (task.value !== null) sum += task.value
  }
  return sum
}

/** Value/priority/status label keys the panel localizes. */
export type StatKey = TaskStatus | TaskPriority | TaskValue | string
