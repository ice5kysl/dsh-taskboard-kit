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
import type { Board, Task } from '../shared/types.ts'
import { L } from './locale.ts'

/** One live dsh session, as the wiring layer sees it. */
export interface WatchAgentInfo {
  id: string
  /** The session's cwd; undefined = unknown, the watcher skips it. */
  cwd?: string
}

export interface BoardWatcherDeps {
  loadBoard(cwd: string): Promise<Board>
  /** Every currently-live session (id + cwd). */
  resolveAgents(): WatchAgentInfo[]
  /** Deliver one merged notice to a session (context-only at the call site). */
  injectNotice(agentId: string, text: string): void
  /** The names this instance answers to (default: TASKBOARD_WATCH_NAMES or ['dsh', 'dsh-agent']). */
  names?: readonly string[]
  log(message: string): void
  /** fs.watch seam (tests drive the callback by hand). Returns an unwatch fn. */
  watchDir?(cwd: string, onChange: () => void): () => void
  /** Change-burst debounce (default 300ms). */
  debounceMs?: number
  /** Per-workspace storm window: at most one notice per window (default 5s). */
  throttleMs?: number
  /** Watch-set recompute from the live session list (default 30s). */
  reconcileMs?: number
}

export interface BoardWatcher {
  /** Start watching; returns the stop function. */
  start(): () => void
  /** Recompute the watch set from the live sessions (one interval pass). */
  reconcile(): void
  /** Test seam: run one change cycle for a cwd (load + diff + inject). */
  poke(cwd: string): Promise<void>
}

/** TASKBOARD_WATCH_NAMES=claude,cc — comma-separated override of the defaults. */
function envNames(): string[] | undefined {
  const raw = process.env.TASKBOARD_WATCH_NAMES
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
 * new pool task; a new comment on a task of ours. Actions performed BY one of
 * the names never echo back.
 */
export function diffBoards(prev: Board | null, next: Board, names: string[]): string[] {
  if (!prev) return []
  const mine = new Set(names)
  const isMine = (task: Task): boolean =>
    (task.assignee !== null && mine.has(task.assignee)) || mine.has(task.created_by)
  const lines: string[] = []

  for (const [id, after] of Object.entries(next.tasks)) {
    const before = prev.tasks[id]
    if (!before) {
      // A new task: tell me when it is mine, or when it joins the pool.
      // Anything I created myself is not news.
      if (mine.has(after.created_by)) continue
      if (after.assignee && mine.has(after.assignee)) {
        lines.push(`${id} · assigned to you (by ${after.created_by}) · ${quoted(after)}`)
      } else if (!after.assignee) {
        lines.push(`${id} · new in pool (by ${after.created_by}) · ${quoted(after)}`)
      }
      continue
    }

    // Reassigned to me (delegated or handed over), unless I did it myself.
    if (after.assignee !== before.assignee && after.assignee && mine.has(after.assignee)) {
      const actor = after.log.at(-1)?.by
      if (!actor || !mine.has(actor)) {
        lines.push(`${id} · assigned to you${actor ? ` (by ${actor})` : ''} · ${quoted(after)}`)
      }
    }

    // Verdicts on tasks of mine (the log is append-only, so the tail is new).
    for (const entry of after.log.slice(before.log.length)) {
      if (mine.has(entry.by)) continue
      if (entry.event !== 'approved' && entry.event !== 'rejected' && entry.event !== 'done') continue
      if (!isMine(after)) continue
      const note = entry.note ? ` — ${excerpt(entry.note)}` : ''
      lines.push(`${id} · ${entry.event} by ${entry.by}${note} · ${quoted(after)}`)
    }

    // New comments on tasks of mine, from others.
    const newComments = after.comments.slice(before.comments.length).filter((comment) => !mine.has(comment.by))
    if (newComments.length > 0 && isMine(after)) {
      const last = newComments[newComments.length - 1]!
      lines.push(newComments.length === 1
        ? `${id} · new comment by ${last.by}: ${excerpt(last.text)} · ${quoted(after)}`
        : `${id} · ${newComments.length} new comments (latest by ${last.by}) · ${quoted(after)}`)
    }
  }
  return lines
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
}

export function createBoardWatcher(deps: BoardWatcherDeps): BoardWatcher {
  const names = [...(deps.names ?? envNames() ?? ['dsh', 'dsh-agent'])]
  const debounceMs = deps.debounceMs ?? 300
  const throttleMs = deps.throttleMs ?? 5_000
  const reconcileMs = deps.reconcileMs ?? 30_000
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
    const lines = diffBoards(prev, next, names)
    if (lines.length > 0) enqueue(cwd, entry, lines)
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
        const entry: WatchedBoard = { unwatch, pending: [], lastFlushAt: 0 }
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
    return () => {
      stopped = true
      clearInterval(interval)
      for (const entry of watched.values()) {
        entry.unwatch()
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        if (entry.flushTimer) clearTimeout(entry.flushTimer)
      }
      watched.clear()
    }
  }

  return { start, reconcile, poke }
}
