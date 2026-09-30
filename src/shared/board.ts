/**
 * Derived collaboration math of dsh-taskboard-kit — the half of the protocol
 * that is computed, not stored. Shared by the host (tools / CLI / watcher) and
 * the browser face (badges, the "waiting on you" strip), so the board, the
 * agent and the human never disagree about what is late or who owes what.
 *
 * Five questions this module answers, all from the board file alone:
 *
 *   1. **Who is this actor?** (`resolveActor`) — one agent often shows up under
 *      several names (dsh / dsh-agent); the roster's aliases unify them.
 *   2. **How long has this card sat in its current column?** (`columnSince`) —
 *      derived from the last column-changing log event, never from
 *      `created_at` (creation time says nothing about the review column).
 *   3. **Is it late?** (`stalenessOf`) — per-column SLA, quiet by default.
 *   4. **Who is missing?** (`boardHealth`) — cards delegated to an actor with no
 *      recent activity, review nobody owns, cards parked on a human.
 *   5. **What should *I* do right now?** (`inboxFor`) — the ordered, actionable
 *      list that makes the board push instead of being polled.
 *
 * Language-neutral on purpose (like `diffBoards`): every string here is a fact
 * or a suggested command, the prose lives in the two locale modules.
 *
 * @module dsh-taskboard-kit/shared/board
 */

import {
  columnOf,
  type ActorEntry,
  type Board,
  type BoardColumn,
  type Task,
  type TaskEvent,
  type WaitOn,
} from './types.ts'

// ------------------------------------------------------------------ identity

/** 浏览器面所有变更的固定操作者（与 host/http.ts 的 HUMAN_ACTOR 一致）。 */
export const HUMAN_ACTOR = 'human'

/** 比较用的规范化形式：去空白 + 小写。显示名保持原样。 */
export function actorKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * `TASKBOARD_ACTOR_ALIASES` — 「规范名:别名1|别名2,规范名2:…」。
 * 让同一个 Agent 的多个名字（dsh / dsh-agent / dsh-web）落进同一条名册。
 */
export function parseAliasConfig(raw: string | undefined | null): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  if (!raw) return groups
  for (const chunk of raw.split(',')) {
    const [canonical, rest] = chunk.split(':')
    const name = canonical?.trim()
    if (!name) continue
    const aliases = (rest ?? '').split('|').map((alias) => alias.trim()).filter(Boolean)
    if (aliases.length > 0) groups[actorKey(name)] = aliases
  }
  return groups
}

/**
 * `TASKBOARD_WATCH_NAMES` 是「这个实例回答的所有名字」，第一个即规范名：
 * dsh,dsh-agent → 名册里的规范名是 dsh，dsh-agent 是它的别名。
 * 这样"我"在板上的身份是唯一的，而不是两个互不相认的操作者。
 */
export function parseWatchNames(raw: string | undefined | null): { canonical: string; aliases: string[] } | null {
  const names = (raw ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  if (names.length === 0) return null
  return { canonical: names[0]!, aliases: names.slice(1) }
}

/** 名册查找：先按规范名（大小写不敏感），再按任何别名。 */
export function resolveActor(board: Board, name: string | null | undefined): ActorEntry | undefined {
  if (!name) return undefined
  const key = actorKey(name)
  if (key === '') return undefined
  const actors = board.actors ?? {}
  for (const [entryName, entry] of Object.entries(actors)) {
    if (actorKey(entryName) === key) return entry
  }
  for (const entry of Object.values(actors)) {
    if ((entry.aliases ?? []).some((alias) => actorKey(alias) === key)) return entry
  }
  return undefined
}

/** 名册里该名字的规范键（无法解析时返回规范化后的自身）。 */
export function actorKeyOf(board: Board, name: string): string {
  const key = actorKey(name)
  for (const [entryName, entry] of Object.entries(board.actors ?? {})) {
    if (actorKey(entryName) === key) return actorKey(entryName)
    if ((entry.aliases ?? []).some((alias) => actorKey(alias) === key)) return actorKey(entryName)
  }
  return key
}

/** 两个名字是不是同一个 Actor（别名感知）。 */
export function sameActor(board: Board, a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return actorKeyOf(board, a) === actorKeyOf(board, b)
}

/** 该 Actor 的名字集合（规范名 + 别名），用于"我"在板上的所有出现。 */
export function actorNames(board: Board, name: string): string[] {
  const key = actorKey(name)
  for (const [entryName, entry] of Object.entries(board.actors ?? {})) {
    if (actorKey(entryName) === key || (entry.aliases ?? []).some((alias) => actorKey(alias) === key)) {
      return [entryName, ...(entry.aliases ?? [])]
    }
  }
  return [name]
}

/** 该 Actor 的活性：`last_seen_at` 是唯一证据，`null` = 从未出现。 */
export function actorSeenAt(board: Board, name: string | null | undefined): string | null | undefined {
  const entry = resolveActor(board, name)
  if (!entry) return undefined
  return entry.last_seen_at
}

// ------------------------------------------------------- column age / staleness

/**
 * 「当前列是从哪一刻开始的」——取 log 里最后一次改变列的事件时间。
 * `updated` / `blocked` / `unblocked` 不算：一条留言不该把陈旧计时器清零，
 * 否则"卡被留言刷活、实事没做"就永远暴露不出来。
 */
const COLUMN_EVENTS: ReadonlySet<TaskEvent> = new Set<TaskEvent>([
  'created', 'assigned', 'claimed', 'started', 'stopped', 'submitted',
  'approved', 'rejected', 'done', 'reopened', 'closed',
])

export function columnSince(task: Task): string {
  for (let index = task.log.length - 1; index >= 0; index -= 1) {
    const entry = task.log[index]!
    if (COLUMN_EVENTS.has(entry.event)) return entry.at
  }
  return task.created_at
}

export function ageInColumnMs(task: Task, now: number = Date.now()): number {
  const since = Date.parse(columnSince(task))
  if (Number.isNaN(since)) return 0
  return Math.max(0, now - since)
}

/**
 * 每列的陈旧阈值（毫秒），`null` = 永不陈旧。
 * 默认值刻意宽松：这块板宁可漏报也不要噪音（告警疲劳比漏报更伤）。
 */
export const DEFAULT_COLUMN_SLA_MS: Record<BoardColumn, number | null> = {
  pool: 72 * 3600_000,        // 待认领躺 3 天 = 没人要
  assigned: 48 * 3600_000,    // 指派了 2 天还没 start
  in_progress: 72 * 3600_000, // 3 天没动静
  review: 24 * 3600_000,      // 审核人欠 1 天
  // done is NOT terminal (v0.6): a card approved but never settled is exactly
  // the rot the two-step close exists to catch, so it goes stale like any
  // other unfinished work.
  done: 72 * 3600_000,        // 审核过了 3 天还没人收口
  closed: null,               // the only terminal column: never stale
}

/** 等人类/等 Agent 的升级阈值：等过这个时长就该催（或换人）。 */
export const DEFAULT_WAIT_SLA_MS: Record<WaitOn['kind'], number | null> = {
  human: 24 * 3600_000,
  agent: 8 * 3600_000,
  external: null,
}

export interface StalenessOptions {
  /** 覆盖某一列的阈值；`null` 表示该列不设陈旧。 */
  columnSla?: Partial<Record<BoardColumn, number | null>>
  /** 覆盖某类等待的阈值；`null` 表示该类不升级。 */
  waitSla?: Partial<Record<WaitOn['kind'], number | null>>
}

export interface Staleness {
  /** 卡在当前列待了多久。 */
  ageMs: number
  /** 当前列的陈旧阈值。 */
  slaMs: number | null
  /** 是否已过期。 */
  stale: boolean
  /** 过期了多久（未过期 = 0）。 */
  overdueMs: number
  /** 在等谁；没在等就是 null。 */
  waiting: WaitOn | null
  /** 等通知的时长；没在等 = 0。 */
  waitMs: number
  /** 等待是否已超过升级阈值（在等 human/agent 时才可能 true）。 */
  waitOverdue: boolean
}

/** 「这张卡是不是该有人管了」——列陈旧与等待升级的统一出口。 */
export function stalenessOf(task: Task, now: number = Date.now(), options?: StalenessOptions): Staleness {
  const column = columnOf(task)
  const slaMs = options?.columnSla?.[column] !== undefined
    ? options.columnSla[column]!
    : DEFAULT_COLUMN_SLA_MS[column]
  const ageMs = ageInColumnMs(task, now)
  const overdueMs = slaMs !== null && ageMs > slaMs ? ageMs - slaMs : 0
  const waiting = task.waiting_on ?? null
  const waitMs = waiting ? Math.max(0, now - (Date.parse(waiting.since) || now)) : 0
  const waitSla = waiting
    ? (options?.waitSla?.[waiting.kind] !== undefined ? options.waitSla[waiting.kind]! : DEFAULT_WAIT_SLA_MS[waiting.kind])
    : null
  return {
    ageMs,
    slaMs,
    stale: overdueMs > 0,
    overdueMs,
    waiting,
    waitMs,
    waitOverdue: waitSla !== null && waiting !== null && waitMs > waitSla,
  }
}

/** 便捷判断：只有已结清（closed）永不算陈旧；done 仍算未结清的工作。 */
export function isStale(task: Task, now: number = Date.now(), options?: StalenessOptions): boolean {
  return stalenessOf(task, now, options).stale
}

// --------------------------------------------------------------- board health

/** 一个 Agent 多久没动手就算"不在场"（默认 36h）。 */
export const DEFAULT_QUIET_MS = 36 * 3600_000

/**
 * 「这个负责人算不算不见了」——活性缺失要配上时间才算孤儿。
 *
 * `last_seen_at: null`（从未动手）本身不是罪证：刚把卡派给一个还没开工的
 * Agent，是正常交接，不是孤儿卡（真实误报：T-8 刚改派就被告警）。所以：
 * 有记录 → 距今超过 `quietMs` 才算；从未动手 → 卡自己先待够 `quietMs` 才算。
 */
export function assigneeIsGone(
  board: Board,
  task: Task,
  now: number = Date.now(),
  quietMs: number = DEFAULT_QUIET_MS,
): { gone: boolean; reason: 'quiet' | 'never-seen' | 'unknown-actor' | null; ageMs: number } {
  if (!task.assignee) return { gone: false, reason: null, ageMs: 0 }
  const seenAt = actorSeenAt(board, task.assignee)
  if (seenAt === undefined) {
    const ageMs = ageInColumnMs(task, now)
    return { gone: ageMs > quietMs, reason: 'unknown-actor', ageMs }
  }
  if (seenAt === null) {
    const ageMs = ageInColumnMs(task, now)
    return { gone: ageMs > quietMs, reason: 'never-seen', ageMs }
  }
  const seen = Date.parse(seenAt)
  if (Number.isNaN(seen)) return { gone: false, reason: null, ageMs: 0 }
  const ageMs = now - seen
  return { gone: ageMs > quietMs, reason: 'quiet', ageMs }
}

export interface HealthIssue {
  task: Task
  kind: 'orphaned' | 'unowned_review' | 'waiting_human' | 'needs_settling' | 'stale'
  /** 事实描述用的中性数据（谁、多久、什么问题）。 */
  actor?: string
  ageMs: number
  detail?: string
}

export interface BoardHealth {
  /** 派给了名册里久未出现（或从未出现）的 Agent：交接断了。 */
  orphaned: HealthIssue[]
  /** 在 review 列但审核人未知/空缺（v0.5.4 之前的板，或人工改出来的）。 */
  unownedReview: HealthIssue[]
  /** 在等**人类**决定的卡——人类这一侧唯一需要看的清单。 */
  waitingHuman: HealthIssue[]
  /** 在等另一个 Agent / 外部系统的卡（不是人类的事，但仍是"卡着"）。 */
  waitingOther: HealthIssue[]
  /**
   * 已经 done 但没人收口（v0.6）。done 不是终态，所以这是一类独立的腐烂：
   * 所有人都认为它完了，但没人负责把它结清。按列龄从久到近排。
   */
  needsSettling: HealthIssue[]
  /** 其他列陈旧（不含上面几类）。 */
  stale: HealthIssue[]
}

export interface HealthOptions extends StalenessOptions {
  /** 多久没动手算"不在场"。 */
  quietMs?: number
  now?: number
}

/**
 * 全板的协作健康度。**不替任何人改状态**——只把事实摆出来
 * （这正是 T-4 里「看板卫生只做让事实可见」的那条原则）。
 */
export function boardHealth(board: Board, options?: HealthOptions): BoardHealth {
  const now = options?.now ?? Date.now()
  const quietMs = options?.quietMs ?? DEFAULT_QUIET_MS
  const health: BoardHealth = { orphaned: [], unownedReview: [], waitingHuman: [], waitingOther: [], needsSettling: [], stale: [] }

  for (const task of Object.values(board.tasks)) {
    // `closed` is the only status that leaves the board entirely.
    if (task.status === 'closed') continue
    // done = approved but unsettled: its own rot category, and the ONLY thing
    // we track about it (a done card is not "blocked" or "orphaned" — it is
    // simply waiting for someone to write the closing note).
    if (task.status === 'done') {
      health.needsSettling.push({ task, kind: 'needs_settling', ageMs: ageInColumnMs(task, now) })
      continue
    }
    if (task.waiting_on) {
      const ageMs = Math.max(0, now - (Date.parse(task.waiting_on.since) || now))
      const issue: HealthIssue = {
        task,
        kind: task.waiting_on.kind === 'human' ? 'waiting_human' : 'stale',
        actor: task.waiting_on.who ?? undefined,
        ageMs,
        detail: task.waiting_on.question,
      }
      // Only genuine human waits belong in the human's list: a card parked on
      // another agent must never show up as "waiting for YOU to decide".
      if (task.waiting_on.kind === 'human') health.waitingHuman.push(issue)
      else health.waitingOther.push(issue)
      continue
    }
    if (task.status === 'review' && !task.reviewer) {
      health.unownedReview.push({ task, kind: 'unowned_review', ageMs: ageInColumnMs(task, now) })
      continue
    }
    if (task.assignee) {
      const gone = assigneeIsGone(board, task, now, quietMs)
      if (gone.gone) {
        health.orphaned.push({
          task,
          kind: 'orphaned',
          actor: task.assignee,
          ageMs: gone.ageMs,
          detail: gone.reason ?? undefined,
        })
        continue
      }
    }
    const staleness = stalenessOf(task, now, options)
    if (staleness.stale) health.stale.push({ task, kind: 'stale', ageMs: staleness.ageMs })
  }

  const byAge = (a: HealthIssue, b: HealthIssue) => b.ageMs - a.ageMs || a.task.id.localeCompare(b.task.id)
  health.orphaned.sort(byAge)
  health.unownedReview.sort(byAge)
  health.waitingHuman.sort(byAge)
  health.waitingOther.sort(byAge)
  health.needsSettling.sort(byAge)
  health.stale.sort(byAge)
  return health
}

// --------------------------------------------------------------------- inbox

/**
 * 「我现在该干什么」的一条。`kind` 决定措辞与建议动作，`task` 是事实，
 * `ageMs` 是这张卡在该状态/等待里待了多久。
 */
export type InboxKind =
  | 'review_owed'      // 我欠一次审核（reviewer 是我）
  | 'unblock_me'       // 有人在等我（waiting_on 是我）
  | 'returned'         // 我的卡被打回，等我改
  | 'stalled_mine'     // 我的卡在自己手里陈旧了
  | 'start_assigned'   // 指派给我但还没开工
  | 'orphaned_mine'    // 我派出去的卡，接的人不见了
  | 'pool_pick'        // 待认领池里值得拿的
  | 'settle_mine'      // 我的卡已 done 但没收口：该写结清说明并 close（v0.6）
  | 'human_blocked'    // 在等人类：需要去叫人（或人类自己来看）

export interface InboxItem {
  kind: InboxKind
  task: Task
  /** 该状态/等待已持续多久。 */
  ageMs: number
  /** 优先级排名（越小越急），`inboxFor` 已按它排好序。 */
  rank: number
  /** 建议动作（语言中性：一条可直接执行的 CLI 或工具调用要点）。 */
  suggest: string
  /** 中性事实补充（谁、什么问题、多久没出现）。 */
  actor?: string
}

export interface InboxOptions extends HealthOptions {
  /** 待认领池最多推荐几条（默认 3；0 = 不推荐）。 */
  poolLimit?: number
  /** 是否把「在等人类」也列进来（默认 true —— Agent 有责任去叫人）。 */
  includeHumanBlocked?: boolean
}

const RANK: Record<InboxKind, number> = {
  review_owed: 10,
  unblock_me: 20,
  returned: 30,
  stalled_mine: 40,
  // Settling comes after live work but before picking up something new: an
  // unfinished close is cheap to finish and blocks the card from ever leaving.
  settle_mine: 42,
  orphaned_mine: 45,
  start_assigned: 50,
  human_blocked: 60,
  pool_pick: 90,
}

/**
 * 按**急迫度**排好的行动清单。排序规则：先按 kind 的固定档位，
 * 同档位按"已经等了多久"倒序（越久越急），再按优先级、再按卡号。
 *
 * 只返回**对我可执行**的项 —— 但 `human_blocked` 是例外：Agent 的职责
 * 之一是"叫得动人"，所以即使等的是人类，也出现在 Agent 的清单里。
 */
export function inboxFor(board: Board, actor: string, options?: InboxOptions): InboxItem[] {
  const now = options?.now ?? Date.now()
  const poolLimit = options?.poolLimit ?? 3
  const includeHumanBlocked = options?.includeHumanBlocked ?? true
  const items: InboxItem[] = []
  const isMe = (name: string | null | undefined) => sameActor(board, name, actor)

  for (const task of Object.values(board.tasks)) {
    // `closed` is settled and gone; `done` is NOT terminal (v0.6) — it still
    // owes a settle, so it is handled below rather than skipped.
    if (task.status === 'closed') continue

    // Approved but unsettled, and it is mine to close out.
    if (task.status === 'done' && task.assignee && isMe(task.assignee)) {
      items.push({
        kind: 'settle_mine',
        task,
        ageMs: ageInColumnMs(task, now),
        rank: RANK.settle_mine,
        // done is not terminal: the closing step is a real action, and the
        // note is the only place "finished" vs "abandoned" is recorded.
        suggest: `taskboard update ${task.id} --action close --note "已交付…"（不做了也走 close，写清原因）`,
      })
      continue
    }
    if (task.status === 'done') continue

    if (task.status === 'review' && task.reviewer && isMe(task.reviewer)) {
      items.push({
        kind: 'review_owed',
        task,
        ageMs: ageInColumnMs(task, now),
        rank: RANK.review_owed,
        suggest: `taskboard get ${task.id} → taskboard update ${task.id} --action approve|reject --note "…"`,
        actor: task.assignee ?? undefined,
      })
      continue
    }

    const waiting = task.waiting_on ?? null
    if (waiting) {
      if (waiting.kind === 'agent' && isMe(waiting.who)) {
        items.push({
          kind: 'unblock_me',
          task,
          ageMs: Math.max(0, now - (Date.parse(waiting.since) || now)),
          rank: RANK.unblock_me,
          suggest: `taskboard comment ${task.id} --text "…" → taskboard update ${task.id} --action unblock`,
          actor: task.assignee ?? undefined,
        })
        continue
      }
      if (includeHumanBlocked && waiting.kind === 'human') {
        items.push({
          kind: 'human_blocked',
          task,
          ageMs: Math.max(0, now - (Date.parse(waiting.since) || now)),
          rank: RANK.human_blocked,
          suggest: `通知人类（用你的通知通道，如 msg9）：${task.id} 在等决定 —— ${waiting.question}`,
          actor: waiting.who ?? undefined,
        })
        continue
      }
      continue // 在等别人/外部：不是我的事，不出现在我的清单里
    }

    const last = task.log[task.log.length - 1]
    if (isMe(task.assignee)) {
      if (task.status === 'in_progress' && last?.event === 'rejected') {
        items.push({
          kind: 'returned',
          task,
          ageMs: ageInColumnMs(task, now),
          rank: RANK.returned,
          suggest: `taskboard get ${task.id} 看打回原因 → 改完 taskboard update ${task.id} --action submit`,
          actor: last.by,
        })
        continue
      }
      if (task.status === 'open') {
        items.push({
          kind: 'start_assigned',
          task,
          ageMs: ageInColumnMs(task, now),
          rank: RANK.start_assigned,
          suggest: `taskboard update ${task.id} --action start`,
        })
        continue
      }
      const staleness = stalenessOf(task, now, options)
      if (staleness.stale) {
        items.push({
          kind: 'stalled_mine',
          task,
          ageMs: staleness.ageMs,
          rank: RANK.stalled_mine,
          suggest: `taskboard update ${task.id} --note "进展…"（或 block / submit / close）`,
        })
      }
      continue
    }

    // 我派出去、接的人却不见了：交接断了，我欠一个改派。
    if (isMe(task.created_by) && task.assignee) {
      const gone = assigneeIsGone(board, task, now, options?.quietMs ?? DEFAULT_QUIET_MS)
      if (gone.gone) {
        items.push({
          kind: 'orphaned_mine',
          task,
          ageMs: gone.ageMs,
          rank: RANK.orphaned_mine,
          suggest: `taskboard update ${task.id} --assignee none（放回池子）或 --assignee <活跃的 Agent>`,
          actor: task.assignee,
        })
      }
    }
  }

  if (poolLimit > 0) {
    const pool = Object.values(board.tasks)
      .filter((task) => task.status === 'open' && !task.assignee && !task.waiting_on)
      .sort(compareByValue)
      .slice(0, poolLimit)
    for (const task of pool) {
      items.push({
        kind: 'pool_pick',
        task,
        ageMs: ageInColumnMs(task, now),
        rank: RANK.pool_pick,
        suggest: `taskboard claim ${task.id}`,
      })
    }
  }

  return items.sort((a, b) =>
    a.rank - b.rank
    || b.ageMs - a.ageMs
    || PRIORITY_RANK_LOCAL[a.task.priority] - PRIORITY_RANK_LOCAL[b.task.priority]
    || a.task.id.localeCompare(b.task.id))
}

const PRIORITY_RANK_LOCAL: Record<Task['priority'], number> = { high: 0, medium: 1, low: 2 }

/** 池子里的挑选顺序：价值度高的先，其次优先级，其次老的先。 */
export function compareByValue(a: Task, b: Task): number {
  const valueA = a.value ?? 0
  const valueB = b.value ?? 0
  if (valueA !== valueB) return valueB - valueA
  const byPriority = PRIORITY_RANK_LOCAL[a.priority] - PRIORITY_RANK_LOCAL[b.priority]
  if (byPriority !== 0) return byPriority
  return a.created_at.localeCompare(b.created_at)
}

/** 人类视角的清单：所有在等人类的卡（面板顶部那条 strip 的数据源）。 */
export function waitingOnHuman(board: Board, now: number = Date.now()): HealthIssue[] {
  return boardHealth(board, { now }).waitingHuman
}
