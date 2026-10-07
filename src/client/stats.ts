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

import type { Board, BoardColumn, Task, TaskEvent, TaskPriority, TaskStatus, TaskValue } from '../shared/types.ts'
import { TERMINAL_STATUS, columnOf, isTerminalStatus, needsSettling } from '../shared/types.ts'
import {
  DEFAULT_COLUMN_SLA_MS,
  DEFAULT_QUIET_MS,
  actorKeyOf,
  actorSeenAt,
  ageInColumnMs,
  stalenessOf,
} from '../shared/board.ts'
// The ONE holder derivation lives in BoardPanel (T-26); the stats layer imports
// it instead of re-deriving who holds the ball. The import is circular on paper
// (BoardPanel → StatsView → stats → BoardPanel) but every use is inside a
// function body, so module init order never matters.
import { currentHolder, type Holder, type HolderAction } from './BoardPanel.tsx'

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
export function dwellByColumn(board: Board | null, now: number = Date.now()): Array<{ column: string; totalMs: number; tasks: number; longestMs: number; medianMs: number; slaMs: number | null }> {
  const tasks = board ? Object.values(board.tasks) : []
  const acc = new Map<string, { totalMs: number; tasks: number; longestMs: number; ages: number[] }>()
  for (const task of tasks) {
    if (isTerminalStatus(task.status)) continue
    const column = columnOf(task)
    const ms = timeInColumnMs(task, now)
    const row = acc.get(column) ?? { totalMs: 0, tasks: 0, longestMs: 0, ages: [] }
    row.totalMs += ms
    row.tasks += 1
    row.longestMs = Math.max(row.longestMs, ms)
    row.ages.push(ms)
    acc.set(column, row)
  }
  return [...acc.entries()]
    .map(([column, row]) => ({
      column,
      totalMs: row.totalMs,
      tasks: row.tasks,
      longestMs: row.longestMs,
      // The MEDIAN age, not the total: one 40-day card could otherwise make a
      // column look congested while every other card in it is a day old.
      medianMs: median(row.ages) ?? 0,
      slaMs: DEFAULT_COLUMN_SLA_MS[column as BoardColumn] ?? null,
    }))
    // 按中位年龄排序（不是累计时长）：柱长与排序依据是同一个量，一眼看出哪列卡住了。
    .sort((a, b) => b.medianMs - a.medianMs || b.totalMs - a.totalMs || a.column.localeCompare(b.column))
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

// ============================================================== 时间窗 (T-28)

/**
 * 统计页的三档时间窗（天）。**所有**窗口相关的计算都吃它：KPI 环比、迷你走势、
 * 流量图、价值吞吐、异常清单的"近期"。
 */
export type WindowDays = 7 | 14 | 30
export const WINDOW_CHOICES: readonly WindowDays[] = [7, 14, 30]
/** 默认 14 天：够看出趋势，又不至于把整块板的历史压成一个数。 */
export const DEFAULT_WINDOW_DAYS: WindowDays = 14

export interface WindowOptions {
  days?: number
  now?: number
}

/** 当前窗口 `[from, to)` 与**上一等长窗口** `[prevFrom, prevTo)` 的绝对边界。 */
export interface WindowBounds {
  from: number
  to: number
  prevFrom: number
  prevTo: number
}

export function windowBounds(options: WindowOptions = {}): WindowBounds {
  const now = options.now ?? Date.now()
  const span = (options.days ?? DEFAULT_WINDOW_DAYS) * DAY
  return { from: now - span, to: now, prevFrom: now - 2 * span, prevTo: now - span }
}

/** `[from, to)` 内的半开区间判定（"窗外的不算"就靠它）。 */
function inWindow(at: number, from: number, to: number): boolean {
  return !Number.isNaN(at) && at >= from && at < to
}

/** The status a task's log replay implies at `at`; null = not created yet. */
const STATUS_AFTER: Partial<Record<TaskEvent, TaskStatus>> = {
  created: 'open',
  claimed: 'open',
  assigned: 'open',
  stopped: 'open',
  reopened: 'open',
  started: 'in_progress',
  rejected: 'in_progress',
  submitted: 'review',
  approved: 'done',
  done: 'done',
  closed: 'closed',
}

/**
 * 这张卡在 `at` 那一刻处于什么状态 —— 由 `log` 重放得出（不是猜的）。
 * 返回 null 表示那一刻它还不存在。按事件时间而不是数组顺序取"最后一次"，
 * 所以乱序的 log 也读不错。
 */
export function statusAt(task: Task, at: number): TaskStatus | null {
  let status: TaskStatus | null = null
  let best = Number.NEGATIVE_INFINITY
  for (const entry of task.log) {
    const ts = Date.parse(entry.at)
    if (Number.isNaN(ts) || ts > at || ts < best) continue
    const next = STATUS_AFTER[entry.event]
    if (!next) continue
    status = next
    best = ts
  }
  if (status === null) {
    const createdAt = Date.parse(task.created_at)
    if (!Number.isNaN(createdAt) && createdAt <= at) status = 'open'
  }
  return status
}

/** 某个事件的**全部**时间戳（升序）。 */
function eventTimes(task: Task, event: TaskEvent): number[] {
  const out: number[] = []
  for (const entry of task.log) {
    if (entry.event !== event) continue
    const ts = Date.parse(entry.at)
    if (!Number.isNaN(ts)) out.push(ts)
  }
  return out.sort((a, b) => a - b)
}

/** 第一件命中的事件的时间戳（与 `headline` 的周期口径一致）。 */
function firstOf(task: Task, events: readonly TaskEvent[]): number | null {
  let best: number | null = null
  for (const event of events) {
    const times = eventTimes(task, event)
    if (times.length === 0) continue
    const first = times[0]!
    if (best === null || first < best) best = first
  }
  return best
}

/**
 * 这张卡在 `at` 那一刻是不是"在等某人"。
 *
 * `waiting_on` 只存**当前**那次等待，所以往回看只能用 `since`：它比 `at` 晚，
 * 说明那一刻还没在等；`since` 之后又出现过 `unblocked`，说明那次等待已解除。
 *
 * **已知取舍（T-28 ③ → T-50 第 3 条）：只反映"当前这一次"等待，历史等待会漏。**
 * 一张卡「挂起 → 解除 → 后来又挂起」时，`waiting_on.since` 只指向**后来**那一次，
 * 于是"第一次挂起期间"问 `blockedAt()` 会答 false —— 图上表现为「被卡住」偏低。
 * 这里刻意**不**补，理由：补它要给统计面加一层「等待区间重建」（`blocked` /
 * `unblocked` 在 `log` 里其实可以配对），那是另一张卡的活 —— 会动 KPI 口径、
 * 要处理没有 `blocked` 事件的旧板，而收益只落在统计页这一条趋势上，
 * 不影响任何协作动作。**要看历史等待就读 `log`**：`blocked`(ts1) … `unblocked`(ts2)
 * 就是一段 `[ts1, ts2)` 的等待区间，`taskboard get <id>` 的时间线里逐条可见。
 */
function blockedAt(task: Task, at: number): boolean {
  const waiting = task.waiting_on
  if (!waiting) return false
  const since = Date.parse(waiting.since)
  if (Number.isNaN(since) || since > at) return false
  if (statusAt(task, at) === 'closed') return false
  for (const ts of eventTimes(task, 'unblocked')) {
    if (ts > since && ts <= at) return false
  }
  return true
}

// ------------------------------------------------------------------- KPI 环比

export type KpiKey = 'open' | 'blocked' | 'unsettled' | 'wip' | 'rejectRate' | 'settled' | 'cycle' | 'settleLag' | 'value'
/** 数值单位 —— 视图只按它格式化，不再自己判断该显示 h 还是 %。 */
export type KpiUnit = 'count' | 'ms' | 'ratio' | 'points'
/**
 * 一个"比值/中位数"要几个样本才敢谈趋势。计数类（未结清 3 → 5）是精确值，
 * 不受这条约束；中位数与比率在 n 太小时只是噪音，宁可说"样本不足"。
 */
export const MIN_TREND_SAMPLES = 3

export interface Kpi {
  key: KpiKey
  unit: KpiUnit
  /** 当期值；null = 这一期没有样本。 */
  value: number | null
  /** 上一等长窗口的值（从 log 时间线派生，不是编的）。 */
  previous: number | null
  /** 当期样本量（计数类 = 卡片数）。 */
  n: number
  previousN: number
  /** (value − previous) / previous；上期为 0 / 缺值 / 样本不足时 null。 */
  delta: number | null
  /** value − previous（绝对值）。 */
  diff: number | null
  /** 样本够不够谈趋势。 */
  comparable: boolean
  /** 窗口内每天的取值（null = 那天没有样本），迷你走势用。 */
  series: Array<number | null>
}

export type KpiSet = Record<KpiKey, Kpi>

/**
 * 九个 KPI（未结清 / 被卡住 / 待收口 / 进行中 / 打回率 / 已结清 / 中位周期 /
 * 收口延迟 / 价值合计），每个都带「与上一等长窗口的环比」和一条迷你走势。
 *
 * 口径刻意分两类，因为它们本来就不同：
 *   • **状态类**（未结清 / 被卡住 / 待收口 / 价值存量）是某一刻的快照 ——
 *     当期取此刻，上期取"上一窗口结束那一刻"，用 `statusAt` 重放 log 得出；
 *   • **流量类**（已结清 / 中位周期 / 收口延迟 / 打回率）是窗口内发生的事 ——
 *     当期统计 `[now − days, now)`，上期统计紧挨着的那个等长窗口。
 * 两类都只吃 log 与卡片字段，没有新增任何状态。
 */
export function kpis(board: Board | null, options: WindowOptions = {}): KpiSet {
  const now = options.now ?? Date.now()
  const days = options.days ?? DEFAULT_WINDOW_DAYS
  const { from, to, prevFrom, prevTo } = windowBounds({ days, now })
  const tasks = board ? Object.values(board.tasks) : []
  const head = headline(board, now)
  const dayRows = daySeries(days, now)
  const bounds = dayRows.map((day) => ({
    start: Date.parse(`${day}T00:00:00`),
    end: Math.min(Date.parse(`${day}T23:59:59.999`), now),
  }))

  /** 状态快照：那一刻有多少张卡处于某个状态。 */
  const stateAt = (at: number, pick: (status: TaskStatus | null) => boolean): number =>
    tasks.filter((task) => pick(statusAt(task, at))).length
  const openAt = (at: number): number => stateAt(at, (status) => status !== null && status !== 'closed')
  const doneAt = (at: number): number => stateAt(at, (status) => status === 'done')
  const blockedCountAt = (at: number): number => tasks.filter((task) => blockedAt(task, at)).length

  /** 窗口内结清的卡数（按 log 里的 closed 事件时间，不是卡片当前状态）。 */
  const countClosed = (a: number, b: number): number =>
    tasks.filter((task) => eventTimes(task, 'closed').some((ts) => inWindow(ts, a, b))).length

  /** 窗口内的周期样本：这段时间里**干完**（done/approved）的卡的 created → done。 */
  const cycleSamples = (a: number, b: number): number[] =>
    tasks.flatMap((task) => {
      const finished = firstOf(task, ['done', 'approved'])
      const created = Date.parse(task.created_at)
      if (finished === null || Number.isNaN(created) || !inWindow(finished, a, b)) return []
      return [Math.max(0, finished - created)]
    })

  /** 窗口内的收口延迟样本：这段时间里 closed 的卡，done → closed。 */
  const lagSamples = (a: number, b: number): number[] =>
    tasks.flatMap((task) => {
      const closed = firstOf(task, ['closed'])
      const finished = firstOf(task, ['done', 'approved'])
      if (closed === null || finished === null || !inWindow(closed, a, b)) return []
      return [Math.max(0, closed - finished)]
    })

  /** 窗口内进过审核的卡，以及其中被打回的 —— 打回率的分母/分子。 */
  const reviewRate = (a: number, b: number): { value: number | null; n: number } => {
    const reached = tasks.filter((task) => eventTimes(task, 'submitted').some((ts) => inWindow(ts, a, b)))
    const rejected = reached.filter((task) => eventTimes(task, 'rejected').some((ts) => inWindow(ts, a, b)))
    return { value: reached.length === 0 ? null : rejected.length / reached.length, n: reached.length }
  }

  /** 价值存量：那一刻之前建出来、且估过价值的卡的 ◆ 之和。 */
  const valueStock = (at: number): number =>
    tasks.reduce((sum, task) => (task.value !== null && Date.parse(task.created_at) <= at ? sum + task.value : sum), 0)
  const valueCount = (at: number): number =>
    tasks.filter((task) => task.value !== null && Date.parse(task.created_at) <= at).length

  const cycle = cycleSamples(from, to)
  const cyclePrev = cycleSamples(prevFrom, prevTo)
  const lag = lagSamples(from, to)
  const lagPrev = lagSamples(prevFrom, prevTo)
  const rate = reviewRate(from, to)
  const ratePrev = reviewRate(prevFrom, prevTo)

  /** 组装一个 KPI：环比可信度与差值一次算清。 */
  const build = (
    key: KpiKey,
    unit: KpiUnit,
    current: { value: number | null; n: number },
    previous: { value: number | null; n: number },
    series: Array<number | null>,
    sampled: boolean,
  ): Kpi => {
    const both = current.value !== null && previous.value !== null
    const comparable = both && (!sampled || (current.n >= MIN_TREND_SAMPLES && previous.n >= MIN_TREND_SAMPLES))
    const diff = both ? current.value! - previous.value! : null
    const delta = comparable && previous.value !== 0
      ? (current.value! - previous.value!) / Math.abs(previous.value!)
      : null
    return { key, unit, value: current.value, previous: previous.value, n: current.n, previousN: previous.n, delta, diff, comparable, series }
  }

  return {
    // —— 要你动手的：现在就有人欠一次动作 ——
    open: build('open', 'count',
      { value: head.open, n: head.open },
      { value: openAt(prevTo), n: openAt(prevTo) },
      bounds.map(({ end }) => openAt(end)), false),
    blocked: build('blocked', 'count',
      { value: head.blocked, n: head.blocked },
      { value: blockedCountAt(prevTo), n: blockedCountAt(prevTo) },
      bounds.map(({ end }) => blockedCountAt(end)), false),
    unsettled: build('unsettled', 'count',
      { value: head.unsettled, n: head.unsettled },
      { value: doneAt(prevTo), n: doneAt(prevTo) },
      bounds.map(({ end }) => doneAt(end)), false),
    wip: build('wip', 'count',
      { value: head.wip, n: head.wip },
      { value: stateAt(prevTo, (status) => status === 'in_progress' || status === 'review'), n: stateAt(prevTo, (status) => status === 'in_progress' || status === 'review') },
      bounds.map(({ end }) => stateAt(end, (status) => status === 'in_progress' || status === 'review')), false),
    rejectRate: build('rejectRate', 'ratio',
      rate, ratePrev,
      bounds.map(({ start, end }) => reviewRate(start, end).value), true),

    // —— 背景数字：这段时间做得怎么样 ——
    settled: build('settled', 'count',
      { value: countClosed(from, to), n: countClosed(from, to) },
      { value: countClosed(prevFrom, prevTo), n: countClosed(prevFrom, prevTo) },
      bounds.map(({ start, end }) => countClosed(start, end)), false),
    cycle: build('cycle', 'ms',
      { value: median(cycle), n: cycle.length },
      { value: median(cyclePrev), n: cyclePrev.length },
      bounds.map(({ start, end }) => median(cycleSamples(start, end))), true),
    settleLag: build('settleLag', 'ms',
      { value: median(lag), n: lag.length },
      { value: median(lagPrev), n: lagPrev.length },
      bounds.map(({ start, end }) => median(lagSamples(start, end))), true),
    value: build('value', 'points',
      { value: totalValue(board), n: valueCount(now) },
      { value: valueStock(prevTo), n: valueCount(prevTo) },
      bounds.map(({ end }) => valueStock(end)), false),
  }
}

// ------------------------------------------------------------- 现在该动什么

export interface HolderActionBucket {
  action: HolderAction
  count: number
  /** 该动作里握得最久的那张卡握了多久（也是点击要打开的那张）。 */
  maxAgeMs: number | null
  /** 该动作下的卡（编号升序）。 */
  ids: string[]
}

/**
 * 分组的三类。`who === null` **不等于**"球在池子里"：
 * `waiting_on.who` 允许为 null（types.ts），那是一张**无名等待**的卡 ——
 * 球在某个没指名的人手上，而 store 明确拒绝认领等待中的卡。
 * 把两者合成"待认领池"是 T-26 复核（kimi）抓到的那个边界 bug，这里同样不能再犯。
 */
export type HolderGroupKind = 'actor' | 'pool' | 'unnamed_wait'

export interface HolderGroup {
  /** 分组键：actor = 名册规范名（别名已折叠 dsh ≡ dsh-agent）；pool = ''；无名等待 = '?<动作>'。 */
  key: string
  kind: HolderGroupKind
  /** 谁握着球；`actor` 之外为 null（池子 / 无名等待）。 */
  who: string | null
  /** 这个持球人手上的卡数。 */
  total: number
  /** 其中握得最久的一张，握了多久。 */
  maxAgeMs: number | null
  /** 名册说这个人已经久未活动（只有指名道姓的持球人才可能为 true）。 */
  quiet: boolean
  /** 按动作分桶，多的在前。 */
  actions: HolderActionBucket[]
}

/**
 * 持球人是不是已经"不在场"了 —— 与 `assigneeIsGone` 同一条规则，只是主体换成
 * `currentHolder`：欠裁决的审核人、欠收口的卡主、被等待的人同样可能失联，
 * 不只是 assignee。名册里有记录 → 距今超过静默窗才算；从未有记录 →
 * 卡自己先在当前列待够静默窗才算（刚派出去就告警是误报）。
 */
export function holderIsQuiet(board: Board, holder: Holder, task: Task, now: number = Date.now()): boolean {
  if (!holder.who) return false
  const seen = actorSeenAt(board, holder.who)
  if (seen === undefined || seen === null) {
    return (holder.sinceMs ?? ageInColumnMs(task, now)) > DEFAULT_QUIET_MS
  }
  const at = Date.parse(seen)
  if (Number.isNaN(at)) return false
  return now - at > DEFAULT_QUIET_MS
}

/**
 * 持球人排行：把每一张**未结清**的卡按 `currentHolder` 分组 —— 谁欠什么动作、
 * 欠了多久。派生是全的（`currentHolder` 对 closed 之外的一切都给出持球人），
 * 所以每张未结清卡**恰好**落进一个分组：谁也没认领的落进池子组（who === null）。
 */
export function holderGroups(board: Board | null, options: { now?: number } = {}): HolderGroup[] {
  const now = options.now ?? Date.now()
  const acc = new Map<string, { kind: HolderGroupKind; who: string | null; rows: Array<{ task: Task; holder: Holder }> }>()
  for (const task of board ? Object.values(board.tasks) : []) {
    const holder = currentHolder(task, board, now)
    if (!holder) continue // closed：球不在任何人手上
    const who = holder.who
    // who === null 有两种完全不同的处境，绝不能合并成一组：
    //   · action === 'claim' → 真的没人认领，球在池子里（可以认领）；
    //   · 等待类动作        → **无名等待**（waiting_on.who 允许为 null），
    //     store 明确拒绝认领等待中的卡，把它渲染成"池子"就是骗人。
    // （这正是 T-26 复核 kimi 抓到的那个边界 bug，统计页不能再犯一遍。）
    const kind: HolderGroupKind = who ? 'actor' : holder.action === 'claim' ? 'pool' : 'unnamed_wait'
    const key = kind === 'actor'
      ? (board ? actorKeyOf(board, who!) : who!)
      : kind === 'pool' ? '' : `?${holder.action}`
    const row = acc.get(key) ?? { kind, who, rows: [] }
    row.rows.push({ task, holder })
    acc.set(key, row)
  }

  const groups: HolderGroup[] = []
  for (const [key, row] of acc) {
    const buckets = new Map<HolderAction, HolderActionBucket>()
    let maxAgeMs: number | null = null
    let quiet = false
    for (const { task, holder } of row.rows) {
      const age = holder.sinceMs ?? null
      if (age !== null && (maxAgeMs === null || age > maxAgeMs)) maxAgeMs = age
      if (board && holderIsQuiet(board, holder, task, now)) quiet = true
      const bucket = buckets.get(holder.action) ?? { action: holder.action, count: 0, maxAgeMs: null, ids: [] }
      bucket.count += 1
      if (age !== null && (bucket.maxAgeMs === null || age > bucket.maxAgeMs)) bucket.maxAgeMs = age
      bucket.ids.push(task.id)
      buckets.set(holder.action, bucket)
    }
    const actions = [...buckets.values()]
      .map((bucket) => ({ ...bucket, ids: [...bucket.ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }))
      .sort((a, b) => b.count - a.count || (b.maxAgeMs ?? 0) - (a.maxAgeMs ?? 0) || a.action.localeCompare(b.action))
    groups.push({ key, kind: row.kind, who: row.who, total: row.rows.length, maxAgeMs, quiet, actions })
  }
  return groups.sort(
    (a, b) => b.total - a.total || (b.maxAgeMs ?? 0) - (a.maxAgeMs ?? 0) || (a.who ?? '').localeCompare(b.who ?? ''),
  )
}

export type AnomalyKind = 'wait_overdue' | 'review_overdue' | 'holder_quiet' | 'recent_reject' | 'idle'

/** 急迫度：数字越小越先看。 */
const ANOMALY_RANK: Record<AnomalyKind, number> = {
  wait_overdue: 0,     // 在等一个具体的人且已超时 —— 现在就该去催
  review_overdue: 1,   // 审核列欠裁决 > 24h
  holder_quiet: 2,     // 持球人（审核人 / 卡主 / 被等待的人）已经不在场
  recent_reject: 3,    // 窗口内被打回，回到作者手上
  idle: 4,             // 按各列自己的 SLA 算的"久未动"
}

export interface Anomaly {
  kind: AnomalyKind
  taskId: string
  /** 这张卡现在在谁手里（null = 池子里）。 */
  who: string | null
  action: HolderAction
  /** 这条异常已经持续多久（等待时长 / 列龄 / 静默时长）。 */
  ageMs: number
  /** 同一张卡上还命中的其他异常（按急迫度排）。 */
  also: AnomalyKind[]
}

/**
 * 异常清单：把"值得现在看一眼"的卡挑出来，**一张卡只占一行**（主因 = 最急的
 * 那条，其余进 `also`），否则同一张超时审核卡会在四个类别里各出现一次。
 *
 * 阈值全部沿用看板自己的陈旧规则（`DEFAULT_COLUMN_SLA_MS` / `DEFAULT_WAIT_SLA_MS`
 * / `DEFAULT_QUIET_MS`，见 shared/board.ts）：审核 24h、进行中/待收口 72h、
 * 指派未开工 48h、待认领 72h、等人类 24h、等 Agent 8h、静默 36h。
 * 另造一套数字只会让统计页和卡片上的陈旧点互相矛盾。
 */
export function anomalies(board: Board | null, options: WindowOptions = {}): Anomaly[] {
  const now = options.now ?? Date.now()
  const { from, to } = windowBounds(options)
  const out: Anomaly[] = []
  for (const task of board ? Object.values(board.tasks) : []) {
    if (task.status === 'closed') continue
    const holder = currentHolder(task, board, now)
    const stale = stalenessOf(task, now)
    const hit = new Map<AnomalyKind, number>()
    if (stale.waitOverdue) hit.set('wait_overdue', stale.waitMs)
    const column = columnOf(task)
    if (column === 'review' && stale.slaMs !== null && stale.ageMs > stale.slaMs) hit.set('review_overdue', stale.ageMs)
    if (board && holder && holderIsQuiet(board, holder, task, now)) hit.set('holder_quiet', holder.sinceMs ?? stale.ageMs)
    const rejected = eventTimes(task, 'rejected').filter((ts) => inWindow(ts, from, to))
    if (rejected.length > 0) hit.set('recent_reject', Math.max(0, now - rejected[rejected.length - 1]!))
    // 审核超时本身就是一种"久未动"，不再重复报一次 idle。
    if (stale.stale && !hit.has('review_overdue')) hit.set('idle', stale.ageMs)
    if (hit.size === 0) continue
    const kinds = [...hit.keys()].sort((a, b) => ANOMALY_RANK[a] - ANOMALY_RANK[b])
    const primary = kinds[0]!
    out.push({
      kind: primary,
      taskId: task.id,
      who: holder?.who ?? null,
      action: holder?.action ?? 'claim',
      ageMs: hit.get(primary)!,
      also: kinds.slice(1),
    })
  }
  return out.sort(
    (a, b) => ANOMALY_RANK[a.kind] - ANOMALY_RANK[b.kind] || b.ageMs - a.ageMs
      || a.taskId.localeCompare(b.taskId, undefined, { numeric: true }),
  )
}

// ------------------------------------------------------------------- 价值度

export interface ValueView {
  /** 积压价值：未结清卡的 ◆ 之和。 */
  backlogValue: number
  backlogTasks: number
  /** 窗口内交付价值：这段时间结清的卡的 ◆ 之和。 */
  deliveredValue: number
  deliveredTasks: number
  /** 价值吞吐：窗口内平均每天交付多少 ◆。 */
  throughputPerDay: number
  /** 每张已评估卡的平均价值。 */
  avgValue: number | null
  /** 已结清卡的平均周期（created → done/approved）。 */
  avgCycleMs: number | null
  cycleN: number
  /** 没有估过价值的卡数（平均/合计都不含它们）。 */
  unestimated: number
}

export function valueView(board: Board | null, options: WindowOptions = {}): ValueView {
  const now = options.now ?? Date.now()
  const days = options.days ?? DEFAULT_WINDOW_DAYS
  const { from, to } = windowBounds({ days, now })
  const tasks = board ? Object.values(board.tasks) : []
  let backlogValue = 0
  let backlogTasks = 0
  let deliveredValue = 0
  let deliveredTasks = 0
  let estimated = 0
  let unestimated = 0
  const cycles: number[] = []
  for (const task of tasks) {
    if (task.value === null) unestimated += 1
    else estimated += 1
    if (isTerminalStatus(task.status)) {
      const closed = firstOf(task, ['closed'])
      if (closed !== null && inWindow(closed, from, to)) {
        deliveredTasks += 1
        if (task.value !== null) deliveredValue += task.value
      }
      const finished = firstOf(task, ['done', 'approved'])
      const created = Date.parse(task.created_at)
      if (finished !== null && !Number.isNaN(created)) cycles.push(Math.max(0, finished - created))
    } else {
      backlogTasks += 1
      if (task.value !== null) backlogValue += task.value
    }
  }
  const sum = tasks.reduce((acc, task) => (task.value !== null ? acc + task.value : acc), 0)
  return {
    backlogValue,
    backlogTasks,
    deliveredValue,
    deliveredTasks,
    throughputPerDay: days === 0 ? 0 : deliveredValue / days,
    avgValue: estimated === 0 ? null : sum / estimated,
    avgCycleMs: cycles.length === 0 ? null : cycles.reduce((a, b) => a + b, 0) / cycles.length,
    cycleN: cycles.length,
    unestimated,
  }
}

// ------------------------------------------------------------------- 里程碑

export interface Milestone {
  tag: string
  total: number
  settled: number
  open: number
  valueTotal: number
  valueDelivered: number
  /** 还没结清的卡数（剩余工作量，按张数计）。 */
  remaining: number
  /** 里程碑内的卡 id（编号升序）。 */
  ids: string[]
}

/**
 * 里程碑 = 形如 `v1.42.0` 的 tag（唯一识别规则；**不读**壳的 goal）。
 *
 * T-42 第 4 条：前缀大小写不敏感 —— `semverParts()` 一直用 `/^v/i` 剥前缀，
 * 闸门却是大小写敏感的，于是 `V1.42.0` 能解析、却永远进不了这块统计（口径不齐，
 * kimi 在 T-28 复审里点名）。两条规则现在同口径：闸门收的前缀，解析器一定认。
 * 注意 tag 的**分组键仍是原文**（`v1.42.0` 与 `V1.42.0` 是两个 tag，与
 * `tasksWithTag()` 的精确匹配口径一致）。
 */
export const MILESTONE_TAG = /^v\d+\.\d+\.\d+$/i

export function isMilestoneTag(tag: string): boolean {
  return MILESTONE_TAG.test(tag.trim())
}

function semverParts(tag: string): number[] {
  return tag.trim().replace(/^v/i, '').split('.').map((part) => Number(part) || 0)
}

/**
 * 按 tag 派生的里程碑进度：已结清/总数、◆ 已交付/总、剩余。版本号大的在前
 * （新里程碑更值得看）。一个 tag 都没命中就返回空数组 —— 视图据此整块不渲染。
 */
export function milestones(board: Board | null): Milestone[] {
  const acc = new Map<string, Milestone>()
  for (const task of board ? Object.values(board.tasks) : []) {
    for (const raw of task.tags) {
      const tag = raw.trim()
      if (!isMilestoneTag(tag)) continue
      const row = acc.get(tag) ?? {
        tag, total: 0, settled: 0, open: 0, valueTotal: 0, valueDelivered: 0, remaining: 0, ids: [],
      }
      row.total += 1
      if (isTerminalStatus(task.status)) row.settled += 1
      else row.open += 1
      if (task.value !== null) {
        row.valueTotal += task.value
        if (isTerminalStatus(task.status)) row.valueDelivered += task.value
      }
      row.ids.push(task.id)
      acc.set(tag, row)
    }
  }
  return [...acc.values()]
    .map((row) => ({ ...row, ids: [...row.ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), remaining: row.total - row.settled }))
    .sort((a, b) => {
      const x = semverParts(a.tag)
      const y = semverParts(b.tag)
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        const diff = (y[i] ?? 0) - (x[i] ?? 0)
        if (diff !== 0) return diff
      }
      return a.tag.localeCompare(b.tag)
    })
}

// ------------------------------------------------------------------- 坐标轴

/**
 * 「好看」的坐标轴：1/2/5×10ⁿ 的刻度，覆盖 `max`，返回上界与全部刻度（含 0）。
 * 图表只认 `max` 做缩放，柱子就永远不会顶破画布。
 */
export function niceAxis(max: number, count = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] }
  const raw = max / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  // 上界 = 第一个 ≥ max 的刻度（不是"最后一个 ≤ max 的"）：否则 23 会拿到
  // 一根顶到 20 的轴，最大的柱子在画布外被切掉。
  const top = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let index = 0; index * step <= top + 1e-9 && ticks.length < 12; index += 1) {
    ticks.push(Number((index * step).toFixed(6)))
  }
  if (ticks.length < 2) ticks.push(Number((ticks[0]! + step).toFixed(6)))
  return { max: ticks[ticks.length - 1]!, ticks }
}
