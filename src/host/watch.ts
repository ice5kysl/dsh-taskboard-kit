/**
 * Board-change watcher of dsh-taskboard-kit — the push half of the board.
 *
 * The agent loop is turn-based: without a trigger it never notices that the
 * human (or a CLI agent) moved the board. Where msg9-kit long-polls a server,
 * this watcher is purely local: one `fs.watch` per live session's
 * `<cwd>/.dsh/` directory, a 300ms debounce per change burst, a board diff
 * (`diffBoards`), and a per-workspace 5s storm window that merges a flurry of
 * changes into ONE multi-line notice.
 *
 * Delivery is context-only (`agent.inject`, never `followup`): the notice is
 * information, not an interruption. Workspaces without a live session are
 * not notified — the session-start notice catches them up next time.
 *
 * What is worth notifying (see diffBoards): a task assigned to me, a verdict
 * (approved/rejected/done) on a task I hold or created, a new pool task, a
 * new comment on a task of mine. My own actions never echo back.
 *
 * @module dsh-taskboard-kit/watch
 */

import { mkdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { inboxFor, stalenessOf, type InboxItem } from '../shared/board.ts'
import type { Board, Task } from '../shared/types.ts'
import { L } from './locale.ts'

/** One live dsh session, as the wiring layer sees it. */
export interface WatchAgentInfo {
  id: string
  /** The session's cwd; undefined = unknown, the watcher skips it. */
  cwd?: string
}

/** A card that has been parked on a human long enough to warrant a nudge. */
export interface HumanWaitEscalation {
  cwd: string
  task: Task
  question: string
  waitedMs: number
  reason: 'overdue'
}

export interface BoardWatcherDeps {
  loadBoard(cwd: string): Promise<Board>
  /** Every currently-live session (id + cwd). */
  resolveAgents(): WatchAgentInfo[]
  /** Deliver one merged notice to a session (context-only at the call site). */
  injectNotice(agentId: string, text: string): void
  /** The names this instance answers to (default: TASKBOARD_WATCH_NAMES or ['dsh', 'dsh-agent']). */
  names?: readonly string[]
  /** Other sessions of this instance, working this workspace (default: TASKBOARD_SIBLING_NAMES). */
  siblingNames?: readonly string[]
  log(message: string): void
  /** fs.watch seam (tests drive the callback by hand). Returns an unwatch fn. */
  watchDir?(cwd: string, onChange: () => void): () => void
  /** Change-burst debounce (default 300ms). */
  debounceMs?: number
  /** Per-workspace storm window: at most one notice per window (default 5s). */
  throttleMs?: number
  /** Watch-set recompute from the live session list (default 30s). */
  reconcileMs?: number
  /**
   * A card has been parked on a human past its wait SLA. The wiring layer
   * pushes it out-of-band (TASKBOARD_NOTIFY_CMD) — the watcher itself only
   * detects and reports, it never talks to the outside world.
   */
  onHumanWaitOverdue?(escalation: HumanWaitEscalation): void
  /** Self-audit period: how often to re-read a board with no file change (default 5min). */
  auditMs?: number
  /** At most one audit nudge per workspace per window (default 30min). */
  auditThrottleMs?: number
}

export interface BoardWatcher {
  /** Start watching; returns the stop function. */
  start(): () => void
  /** Recompute the watch set from the live sessions (one interval pass). */
  reconcile(): void
  /** Test seam: run one change cycle for a cwd (load + diff + inject). */
  poke(cwd: string): Promise<void>
  /**
   * Test seam: run one self-audit pass for a cwd — re-read the board even
   * without a file change and nudge whichever of my items have gone pressing.
   */
  audit(cwd: string): Promise<void>
}

/** TASKBOARD_WATCH_NAMES=claude,cc — comma-separated override of the defaults. */
function envNames(): string[] | undefined {
  const raw = process.env.TASKBOARD_WATCH_NAMES
  if (!raw) return undefined
  const names = raw.split(',').map((name) => name.trim()).filter(Boolean)
  return names.length > 0 ? names : undefined
}

/**
 * `TASKBOARD_SIBLING_NAMES=dsh-audit,dsh-web` — the OTHER sessions of this same
 * instance, working this same workspace under their own names.
 *
 * They are ours for ownership (their cards, their staleness and their
 * delegations are mine to keep an eye on) but NOT for echo suppression: their
 * actions must reach me, because two sessions of one harness do not share
 * memory. Without this, a workspace running two dsh sessions either spams each
 * with its own actions (if the sibling signs as me) or hides the sibling's work
 * entirely (if every name in the list suppresses) — the exact trap that forced
 * a sibling session here to sign as `dsh-audit` and hope I read the board.
 */
function envSiblings(): string[] | undefined {
  const raw = process.env.TASKBOARD_SIBLING_NAMES
  if (!raw) return undefined
  const names = raw.split(',').map((name) => name.trim()).filter(Boolean)
  return names.length > 0 ? names : undefined
}

/** The default directory watch: `.dsh/` is created on demand (the board file
 * itself is still only written by the store). */
function defaultWatchDir(cwd: string, onChange: () => void): () => void {
  const dir = join(cwd, '.dsh')
  mkdirSync(dir, { recursive: true })
  const watcher = watch(dir, (_event, filename) => {
    // The store's tmp+rename shows up as both names; only the board matters.
    if (filename === 'taskboard.json') onChange()
  })
  watcher.on('error', () => {}) // an fs error must never kill the plugin
  return () => watcher.close()
}

// --------------------------------------------------------------- diffBoards

function quoted(task: Task): string {
  const title = task.title.length > 40 ? `${task.title.slice(0, 40)}…` : task.title
  return `"${title}"`
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

/**
 * The notify-worthy changes between two board snapshots, as language-neutral
 * fact lines (the caller wraps them in a localized notice). `prev: null` is
 * the bootstrap sight of a board — never a notification.
 *
 * Worth notifying: a task newly assigned to one of `names`; a verdict
 * (approved / rejected / done) on a task one of `names` holds or created; a
 * new pool task; a new comment on a task of ours; a review handed to me; a card
 * that started (or stopped) waiting on me; a card parked on the human (the
 * agent's job is to go ping them). Actions performed BY one of the names never
 * echo back.
 *
 * `siblingNames` are the other sessions of this same instance: they count as
 * ours (`isMine`) so their cards, staleness and delegations are still my
 * business, but they are NOT echo-suppressed — a sibling session's work has to
 * reach me, since two sessions don't share memory.
 */
export function diffBoards(
  prev: Board | null,
  next: Board,
  names: string[],
  siblingNames: readonly string[] = [],
): string[] {
  if (!prev) return []
  const self = new Set(names)
  const owned = new Set([...names, ...siblingNames])
  const isMine = (task: Task): boolean =>
    (task.assignee !== null && owned.has(task.assignee)) || owned.has(task.created_by)
  const lines: string[] = []

  for (const [id, after] of Object.entries(next.tasks)) {
    const before = prev.tasks[id]
    if (!before) {
      // A new task: tell me when it is mine, or when it joins the pool.
      // Anything MY OWN session created is not news (a sibling's is).
      if (self.has(after.created_by)) continue
      if (after.assignee && owned.has(after.assignee)) {
        lines.push(`${id} · assigned to you (by ${after.created_by}) · ${quoted(after)}`)
      } else if (after.waiting_on) {
        // Born parked on someone: never advertise it as claimable work.
        lines.push(waitLine(id, after))
      } else if (!after.assignee) {
        lines.push(`${id} · new in pool (by ${after.created_by}) · ${quoted(after)}`)
      }
      continue
    }

    // Reassigned to me (delegated or handed over), unless I did it myself.
    if (after.assignee !== before.assignee && after.assignee && owned.has(after.assignee)) {
      const actor = after.log.at(-1)?.by
      if (!actor || !self.has(actor)) {
        lines.push(`${id} · assigned to you${actor ? ` (by ${actor})` : ''} · ${quoted(after)}`)
      }
    }

    // Review handed to me (submit named me as the reviewer): this is my work
    // now — the old notice only fired on verdicts, so reviews could sit unseen.
    if (after.reviewer && after.reviewer !== before.reviewer && owned.has(after.reviewer)) {
      const actor = after.log.at(-1)?.by
      if (!actor || !self.has(actor)) {
        lines.push(`${id} · review requested from you${actor ? ` (by ${actor})` : ''} · ${quoted(after)}`)
      }
    }

    // A card started or stopped waiting on me / on the human.
    const waitBefore = before.waiting_on?.who ?? before.waiting_on?.kind ?? null
    const waitAfter = after.waiting_on?.who ?? after.waiting_on?.kind ?? null
    if (waitAfter !== waitBefore && after.waiting_on) {
      const actor = after.log.at(-1)?.by
      if (!actor || !self.has(actor)) lines.push(waitLine(id, after))
    }
    if (before.waiting_on && !after.waiting_on) {
      const actor = after.log.at(-1)?.by
      if (actor && !self.has(actor)) lines.push(`${id} · no longer waiting on anyone (by ${actor}) · ${quoted(after)}`)
    }

    // Verdicts on tasks of mine (the log is append-only, so the tail is new).
    for (const entry of after.log.slice(before.log.length)) {
      if (self.has(entry.by)) continue
      if (entry.event !== 'approved' && entry.event !== 'rejected' && entry.event !== 'done') continue
      if (!isMine(after)) continue
      const note = entry.note ? ` — ${excerpt(entry.note)}` : ''
      lines.push(`${id} · ${entry.event} by ${entry.by}${note} · ${quoted(after)}`)
    }

    // New comments on tasks of mine, from others (a sibling session counts as
    // "others": it cannot see that it already told me).
    const newComments = after.comments.slice(before.comments.length).filter((comment) => !self.has(comment.by))
    if (newComments.length > 0 && isMine(after)) {
      const last = newComments[newComments.length - 1]!
      lines.push(newComments.length === 1
        ? `${id} · new comment by ${last.by}: ${excerpt(last.text)} · ${quoted(after)}`
        : `${id} · ${newComments.length} new comments (latest by ${last.by}) · ${quoted(after)}`)
    }
  }
  return lines
}

/** One fact line for a card that is parked on someone else. */
function waitLine(id: string, task: Task): string {
  const wait = task.waiting_on!
  const who = wait.who ? `(${wait.who})` : ''
  const question = excerpt(wait.question)
  if (wait.kind === 'human') {
    return `${id} · waiting on the HUMAN${who}: ${question} · ${quoted(task)} — ping them (msg9) if they may not be looking`
  }
  return `${id} · waiting on ${wait.kind}${who}: ${question} · ${quoted(task)}`
}

// --------------------------------------------------------------- the watcher

interface WatchedBoard {
  unwatch(): void
  /** Last snapshot seen (the diff baseline); undefined until first load. */
  lastBoard?: Board
  /** Fact lines accumulated inside the current storm window. */
  pending: string[]
  debounceTimer?: ReturnType<typeof setTimeout>
  flushTimer?: ReturnType<typeof setTimeout>
  lastFlushAt: number
  /** Last self-audit result per name: which pressing items we already nagged about. */
  lastAuditSignature?: string
  lastAuditAt: number
  /** Per-task time of the last "still waiting on the human" escalation. */
  humanEscalatedAt: Map<string, number>
}

/** Actions that are genuinely pressing: they are owed by me right now. */
const PRESSING_KINDS = new Set(['review_owed', 'unblock_me', 'returned', 'stalled_mine', 'orphaned_mine'])

function isPressing(item: InboxItem, board: Board): boolean {
  if (PRESSING_KINDS.has(item.kind)) return true
  // A card parked on the human is my problem too — but only once it is overdue,
  // so a fresh question does not get nagged about every audit tick.
  if (item.kind === 'human_blocked') return stalenessOf(item.task).waitOverdue
  return false
}

export function createBoardWatcher(deps: BoardWatcherDeps): BoardWatcher {
  const names = [...(deps.names ?? envNames() ?? ['dsh', 'dsh-agent'])]
  // Sibling sessions of this instance: ours for ownership, not for echo
  // suppression (see envSiblings).
  const siblings = [...(deps.siblingNames ?? envSiblings() ?? [])]
  const debounceMs = deps.debounceMs ?? 300
  const throttleMs = deps.throttleMs ?? 5_000
  const reconcileMs = deps.reconcileMs ?? 30_000
  const auditMs = deps.auditMs ?? 5 * 60_000
  const auditThrottleMs = deps.auditThrottleMs ?? 30 * 60_000
  const watchDir = deps.watchDir ?? defaultWatchDir
  const watched = new Map<string, WatchedBoard>()
  let stopped = false

  function renderNotice(lines: string[]): string {
    return L(
      '[看板变化] 本 workspace 的任务看板有更新：\n{lines}\n用 taskboard_get 看详情；待认领任务用 taskboard_claim 认领，被指派的用 taskboard_update（action=start）开工。',
      '[board change] this workspace\'s task board changed:\n{lines}\ntaskboard_get for details; taskboard_claim to take a pool task, taskboard_update (action=start) for one assigned to you.',
      { lines: lines.map((line) => `· ${line}`).join('\n') },
    )
  }

  /**
   * The self-audit notice. Board changes only fire on file writes, which means
   * the most common failure — nobody touched the card for three days — is
   * exactly what the change watcher can never see. This notice is driven by
   * the clock instead, and it always comes with the one command that unblocks
   * the situation.
   */
  function renderAuditNotice(name: string, items: InboxItem[]): string {
    const lines = items.map((item) => {
      const wait = item.task.waiting_on
      const why = wait ? `waiting on ${wait.kind}${wait.who ? ` (${wait.who})` : ''}: ${wait.question}` : `${item.task.status}`
      return `· ${item.task.id} [${item.kind}] ${item.task.title} — ${why} · 已 ${Math.round(item.ageMs / 3_600_000)}h\n  → ${item.suggest}`
    })
    return L(
      '[看板自检] {name}：有 {count} 件事压着没动（看板没有文件变化，所以没人被通知过）：\n{lines}\n没有人类的参与也该由你自己推进：催人、改派、或先把能做的做完。',
      '[board self-audit] {name}: {count} item(s) are sitting on you (no file change, so nothing was ever pushed):\n{lines}\nAdvance these without waiting for a human: ping, reassign, or finish what you can.',
      { name, count: items.length, lines: lines.join('\n') },
    )
  }

  function flush(cwd: string, entry: WatchedBoard): void {
    if (entry.pending.length === 0) return
    const lines = [...new Set(entry.pending)]
    entry.pending = []
    entry.lastFlushAt = Date.now()
    // One notice per live session of this workspace; none when it has none.
    const agents = deps.resolveAgents().filter((agent) => agent.cwd === cwd)
    if (agents.length === 0) return
    const text = renderNotice(lines)
    for (const agent of agents) {
      try {
        deps.injectNotice(agent.id, text)
      } catch (error) {
        deps.log(`notice injection failed for ${agent.id}: ${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  function enqueue(cwd: string, entry: WatchedBoard, lines: string[]): void {
    entry.pending.push(...lines)
    const elapsed = Date.now() - entry.lastFlushAt
    if (elapsed >= throttleMs) {
      flush(cwd, entry)
      return
    }
    // Inside the storm window: merge into ONE notice when the window closes.
    entry.flushTimer ??= setTimeout(() => {
      entry.flushTimer = undefined
      if (!stopped) flush(cwd, entry)
    }, throttleMs - elapsed)
  }

  async function poke(cwd: string): Promise<void> {
    const entry = watched.get(cwd)
    if (!entry || stopped) return
    let next: Board
    try {
      next = await deps.loadBoard(cwd)
    } catch (error) {
      // A mid-rename or corrupt read keeps the old baseline; the next change retries.
      deps.log(`board reload failed for ${cwd}: ${(error as Error)?.message ?? String(error)}`)
      return
    }
    const prev = entry.lastBoard
    entry.lastBoard = next
    if (!prev) return // first sight is the baseline, never a notification
    const lines = diffBoards(prev, next, names, siblings)
    if (lines.length > 0) enqueue(cwd, entry, lines)
  }

  /**
   * The clock-driven half: re-read the board even when nothing changed, and
   * push whatever of MINE has gone pressing. Throttled per workspace so it
   * nudges rather than nags — a nudge repeats only when the item set changes
   * or the window rolls over.
   */
  async function audit(cwd: string): Promise<void> {
    const entry = watched.get(cwd)
    if (!entry || stopped) return
    let board: Board
    try {
      board = await deps.loadBoard(cwd)
    } catch (error) {
      deps.log(`board audit failed for ${cwd}: ${(error as Error)?.message ?? String(error)}`)
      return
    }
    entry.lastBoard = board
    const now = Date.now()

    // Cards parked on a human past the wait SLA: escalate out-of-band.
    for (const task of Object.values(board.tasks)) {
      const wait = task.waiting_on
      if (!wait || wait.kind !== 'human') continue
      const staleness = stalenessOf(task, now)
      if (!staleness.waitOverdue) continue
      const lastEscalation = entry.humanEscalatedAt.get(task.id) ?? 0
      if (now - lastEscalation < auditThrottleMs) continue
      entry.humanEscalatedAt.set(task.id, now)
      try {
        deps.onHumanWaitOverdue?.({ cwd, task, question: wait.question, waitedMs: staleness.waitMs, reason: 'overdue' })
      } catch (error) {
        deps.log(`human escalation failed for ${task.id}: ${(error as Error)?.message ?? String(error)}`)
      }
    }

    const pressing: InboxItem[] = []
    for (const name of names) {
      for (const item of inboxFor(board, name, { poolLimit: 0, includeHumanBlocked: true, now })) {
        if (isPressing(item, board)) pressing.push(item)
      }
    }
    if (pressing.length === 0) {
      entry.lastAuditSignature = undefined
      return
    }
    const signature = pressing.map((item) => `${item.kind}:${item.task.id}`).sort().join(',')
    const changed = signature !== entry.lastAuditSignature
    if (!changed && now - entry.lastAuditAt < auditThrottleMs) return
    entry.lastAuditSignature = signature
    entry.lastAuditAt = now

    const agents = deps.resolveAgents().filter((agent) => agent.cwd === cwd)
    if (agents.length === 0) return
    const text = renderAuditNotice(names[0] ?? 'dsh', pressing)
    for (const agent of agents) {
      try {
        deps.injectNotice(agent.id, text)
      } catch (error) {
        deps.log(`audit notice injection failed for ${agent.id}: ${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  function onChange(cwd: string): void {
    const entry = watched.get(cwd)
    if (!entry || stopped) return
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = undefined
      void poke(cwd)
    }, debounceMs)
  }

  function reconcile(): void {
    const wanted = new Set<string>()
    for (const agent of deps.resolveAgents()) {
      if (agent.cwd) wanted.add(agent.cwd)
    }
    for (const [cwd, entry] of [...watched]) {
      if (wanted.has(cwd)) continue
      entry.unwatch()
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      if (entry.flushTimer) clearTimeout(entry.flushTimer)
      watched.delete(cwd)
    }
    for (const cwd of wanted) {
      if (watched.has(cwd)) continue
      try {
        const unwatch = watchDir(cwd, () => onChange(cwd))
        const entry: WatchedBoard = {
          unwatch,
          pending: [],
          lastFlushAt: 0,
          lastAuditAt: 0,
          humanEscalatedAt: new Map(),
        }
        watched.set(cwd, entry)
        // Baseline: the first load is never a notification.
        void deps.loadBoard(cwd).then((board) => {
          if (watched.get(cwd) === entry && !entry.lastBoard) entry.lastBoard = board
        }, () => {})
      } catch (error) {
        deps.log(`cannot watch ${cwd}: ${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  function start(): () => void {
    stopped = false
    reconcile()
    const interval = setInterval(() => {
      if (!stopped) reconcile()
    }, reconcileMs)
    const auditInterval = setInterval(() => {
      if (stopped) return
      for (const cwd of watched.keys()) void audit(cwd)
    }, auditMs)
    return () => {
      stopped = true
      clearInterval(interval)
      clearInterval(auditInterval)
      for (const entry of watched.values()) {
        entry.unwatch()
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        if (entry.flushTimer) clearTimeout(entry.flushTimer)
      }
      watched.clear()
    }
  }

  return { start, reconcile, poke, audit }
}
