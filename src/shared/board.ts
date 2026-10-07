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
import { openTails, scanTails, type ReviewTail, type TailScanOptions } from './tails.ts'

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
  /**
   * 复核尾巴（v0.7.5）：closed / done 卡的裁决 note 与复核类 comment 里
   * "看起来是待办"的句子。**含已收口的**（看 `tail.settlement` 区分；`stale`
   * 只列未收口的，否则就又变成"列了没人看"）。
   *
   * 这是看板自检里**唯一**查"已经结清的卡"的一类 —— 正因为如此它必须存在：
   * 别的自检都只看未结清的工作，而"复核意见没消化"恰恰发生在卡结清之后。
   */
  reviewTails: ReviewTail[]
  /**
   * 收口记录里再也对不上任何尾巴的 id（判据或切句改过、原文被编辑过）。
   * 一并露出来，是为了让"收口记录变成孤儿"这件事**有人看得见** —— 否则它会
   * 以"明明标了已落卡却又被列出来"的形式表现为一个说不清的重影。
   */
  reviewTailOrphans: string[]
}

export interface HealthOptions extends StalenessOptions {
  /** 多久没动手算"不在场"。 */
  quietMs?: number
  now?: number
  /** 复核尾巴扫到什么程度（默认只扫 closed + done 的复核类文本）。 */
  tails?: TailScanOptions
}

/**
 * 复核尾巴的扫描选项：**总是**注入名册版的"同一 Actor"判断。
 *
 * `dsh ≡ dsh-agent`（还有 TASKBOARD_ACTOR_ALIASES / WATCH_NAMES 配的那些）是名册
 * 的知识，而名册解析在本模块；tails.ts 不能反向 import（循环）。少了这一步，
 * `dsh-agent` 写的交付说明会被当成"别人给的复核意见"（真实数据：T-3 一篇审计
 * 报告一个人刷出 29 条）。
 */
function tailScanOptions(board: Board, options?: HealthOptions): TailScanOptions {
  return { ...options?.tails, sameActor: (a, b) => sameActor(board, a, b) }
}

/**
 * 全板的协作健康度。**不替任何人改状态**——只把事实摆出来
 * （这正是 T-4 里「看板卫生只做让事实可见」的那条原则）。
 */
export function boardHealth(board: Board, options?: HealthOptions): BoardHealth {
  const now = options?.now ?? Date.now()
  const quietMs = options?.quietMs ?? DEFAULT_QUIET_MS
  // 已经结清的卡也在这里被查一次：复核意见的"待办"是最容易掉地的东西，
  // 而它掉的那一刻，卡恰好离开了所有别的自检视野。
  const tails = scanTails(board, tailScanOptions(board, options))
  const health: BoardHealth = {
    orphaned: [],
    unownedReview: [],
    waitingHuman: [],
    waitingOther: [],
    needsSettling: [],
    stale: [],
    reviewTails: tails.all,
    reviewTailOrphans: tails.orphans,
  }

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
      const issue: HealthIssue = {
        task,
        kind: task.waiting_on.kind === 'human' ? 'waiting_human' : 'stale',
        actor: task.waiting_on.who ?? undefined,
        ageMs: waitAgeMs(task.waiting_on, now),
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
  | 'review_tail'      // 我经手过的卡，复核留言里还有没消化的待办（v0.7.5）

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
  /** 是否把「复核尾巴」也列进来（默认 true —— 它默认静默，正需要这一推）。 */
  includeReviewTails?: boolean
  /** 复核尾巴最多推几条（默认 3；0 = 不推，剩下的由 `taskboard tails` 兜）。 */
  tailLimit?: number
}

const RANK: Record<InboxKind, number> = {
  review_owed: 10,
  unblock_me: 20,
  returned: 30,
  stalled_mine: 40,
  // Settling comes after live work but before picking up something new: an
  // unfinished close is cheap to finish and blocks the card from ever leaving.
  settle_mine: 42,
  // 复核尾巴紧跟收口：同样便宜、同样"不做就永远沉下去"，而且它比别的项更
  // 难自己浮上来（那些至少还挂在一张未结清的卡上）。
  review_tail: 44,
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
  const includeReviewTails = options?.includeReviewTails ?? true
  const tailLimit = options?.tailLimit ?? 3
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

  // 复核尾巴：写在 closed / done 卡上的待办。它们不在上面那个循环里（那张卡
  // 已经结清了）—— 这正是它们能一直静默的原因，所以单独走一遍，只推给
  // **经手过这张卡的人**（卡主 / 创建者 / 写这条复核的人）。
  //
  // 上限是刻意的：真实老板上这类句子能有近百条（T-3 一篇审计报告就够呛），
  // 一次全塞进 inbox 等于把 inbox 变成墙纸 —— 而那正是这个特性要治的病。
  // 只推**最老的几条**（最可能已经烂掉），其余的用一条尾巴指引去看全量。
  if (includeReviewTails && tailLimit > 0) {
    const mine = openTails(board, tailScanOptions(board, options))
      .filter((tail) => tail.responsibles.some((name) => isMe(name)))
      .sort((a, b) => (Date.parse(a.source.at) || 0) - (Date.parse(b.source.at) || 0))
    const shown = mine.slice(0, tailLimit)
    for (const tail of shown) {
      const task = board.tasks[tail.task_id]
      if (!task) continue
      items.push({
        kind: 'review_tail',
        task,
        ageMs: Math.max(0, now - (Date.parse(tail.source.at) || now)),
        rank: RANK.review_tail,
        suggest: `taskboard tails --file ${tail.id} --card T-新卡号（或 --waive ${tail.id} --reason "…"）`,
        actor: tail.source.by,
      })
    }
    const rest = mine.length - shown.length
    if (rest > 0 && items.length > 0) {
      const last = items[items.length - 1]!
      if (last.kind === 'review_tail') {
        last.suggest += `\n      ↳ 同类还有 ${rest} 条：taskboard tails（全量清单）`
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

/**
 * 人类视角的清单：所有在等人类的卡（面板顶部那条 strip 的数据源）。
 *
 * 刻意**不走 `boardHealth`**：浏览器面只用这一条，而 `boardHealth` 现在带着
 * 复核尾巴扫描器（要读全板文本）—— 走它会把整个扫描器拖进客户端 bundle
 * （实测 +2 KB minified），而客户端一行都用不到扫描器。这里与 boardHealth
 * 的 waitingHuman 是**同一条派生写了两遍**，所以 tests/tails.test.mjs 里有一条
 * 等价断言钉住两者（题目一旦漂开就红）—— 拿一点点重复换掉用不到的代码。
 */
export function waitingOnHuman(board: Board, now: number = Date.now()): HealthIssue[] {
  const out: HealthIssue[] = []
  for (const task of Object.values(board.tasks)) {
    // 与 boardHealth 同一口径：closed 离开看板；done 归"待收口"那一类。
    if (task.status === 'closed' || task.status === 'done') continue
    const wait = task.waiting_on
    if (!wait || wait.kind !== 'human') continue
    out.push({
      task,
      kind: 'waiting_human',
      actor: wait.who ?? undefined,
      ageMs: waitAgeMs(wait, now),
      detail: wait.question,
    })
  }
  return out.sort((a, b) => b.ageMs - a.ageMs || a.task.id.localeCompare(b.task.id))
}

/** 「已经等了多久」—— human 等待这一条派生的计时，boardHealth 与 waitingOnHuman 共用。 */
function waitAgeMs(wait: WaitOn, now: number): number {
  return Math.max(0, now - (Date.parse(wait.since) || now))
}
