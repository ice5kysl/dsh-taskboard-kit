/**
 * Board store for dsh-taskboard-kit.
 *
 * One board per dsh workspace; its only source of truth is a JSON file inside
 * the workspace itself:
 *
 *   <cwd>/.dsh/taskboard.json        (mode 0600, written tmp-then-rename)
 *   <cwd>/.dsh/taskboard.json.lock   (O_EXCL lock file while mutating)
 *
 * Every mutation runs its load → mutate → save cycle inside `withBoardLock`,
 * which serializes in-process callers with a promise queue and other processes
 * with the lock file — so a model tool and the browser bridge can never
 * overwrite each other with a stale snapshot, and two agents racing to claim
 * the same task produce exactly one winner.
 *
 * All failures the caller can do something about are `StoreError`s carrying a
 * bridge `ErrorCode`; anything else is a genuine unexpected throw.
 *
 * @module dsh-taskboard-kit/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ErrorCode, UpdateAction } from '../shared/bridge.ts'
import {
  HUMAN_ACTOR,
  actorKey,
  actorNames,
  ageInColumnMs,
  boardHealth,
  inboxFor,
  parseAliasConfig,
  parseWatchNames,
  resolveActor,
  sameActor,
  stalenessOf,
  type BoardHealth,
  type HealthOptions,
  type InboxItem,
  type InboxOptions,
} from '../shared/board.ts'
import {
  TASK_VALUES,
  compareTasks,
  emptyBoard,
  type ActorEntry,
  type ActorKind,
  type Board,
  type Task,
  type TaskEvent,
  type TaskLogEntry,
  type TaskPriority,
  type TaskStatus,
  type TaskValue,
  type WaitOn,
} from '../shared/types.ts'

/** A structured store failure; `code` is the bridge-facing error code. */
export class StoreError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

/** Absolute path of the board file for one workspace. */
export function boardFilePath(cwd: string): string {
  return join(cwd, '.dsh', 'taskboard.json')
}

// ------------------------------------------------------------------ raw file

/**
 * How many tasks this process last saw in each workspace's board. Used to tell
 * "this workspace has no board yet" (a normal first run → empty board) apart
 * from "the board file vanished out from under us" (never a fresh start: see
 * the ENOENT branch in loadBoard).
 */
const boardsSeen = new Map<string, number>()

export async function loadBoard(cwd: string): Promise<Board> {
  const file = boardFilePath(cwd)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    // A missing file is the normal first-run case; anything else (EACCES …)
    // must surface instead of masquerading as an empty board.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // …but "missing" and "vanished" are not the same thing. A cloud-synced or
      // otherwise churning filesystem can make an existing board briefly
      // unreadable (observed in this very workspace: iCloud evicting files
      // mid-read, plus a `git` SIGBUS from mmapping its pack inside the synced
      // tree). Loading an EMPTY board there is not a harmless read — the next
      // mutation saves it back and silently replaces every task with the one
      // being written. So once this process has seen a non-empty board for a
      // workspace, its disappearance is an error to resolve, not a fresh start.
      const seen = boardsSeen.get(resolve(cwd)) ?? 0
      if (seen > 0) {
        throw new StoreError(
          'internal',
          `the board file disappeared while this process was running (it held ${seen} task(s) a moment ago); `
          + 'refusing to treat it as an empty board — restore .dsh/taskboard.json (or restart dsh) and retry',
        )
      }
      return emptyBoard(resolve(cwd))
    }
    throw error
  }
  let parsed: Board
  try {
    parsed = JSON.parse(raw) as Board
  } catch {
    // Never silently empty a corrupt board: keep ONE copy for manual recovery.
    // Exactly one, and only if none exists yet: the backup lands in the same
    // `.dsh/` directory the board watcher listens to, so a fresh copy per
    // failed parse (every poll, every retry) re-triggered the watcher, which
    // read the board again — an unbounded write loop. `wx` makes the second
    // and later attempts a no-op, so the loop cannot start.
    await writeFile(`${file}.corrupt`, raw, { mode: 0o600, flag: 'wx' }).catch(() => {})
    throw new StoreError(
      'internal',
      'taskboard file is not valid JSON (the raw bytes were kept beside it as taskboard.json.corrupt); fix or remove it',
    )
  }
  if (!parsed || parsed.version !== 1) {
    throw new StoreError('internal', 'unsupported taskboard version (expected 1)')
  }
  // A structurally broken board must be an explicit error, not a raw TypeError
  // somewhere down the call chain (and never a silent overwrite).
  if (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) {
    throw new StoreError('internal', 'taskboard file has no "tasks" object; refusing to treat it as an empty board')
  }
  // Schema drift normalization (version stays 1 for added/renamed fields):
  //   v0.2 added comments — hydrate it in place;
  //   v0.3 renamed cancelled → closed (status AND log events) and added value;
  //   v0.5.4 added reviewer / waiting_on (per task) and actors (per board).
  parsed.actors ??= {}
  // Everything a consumer reads without a guard is hydrated here, and the
  // record key is the task's address — a drifting `id` is healed back to it.
  let maxSeq = 0
  for (const [key, task] of Object.entries(parsed.tasks)) {
    if (!task || typeof task !== 'object') {
      throw new StoreError('internal', `taskboard entry ${key} is not an object`)
    }
    if (task.id !== key) task.id = key
    if (!Array.isArray(task.comments)) task.comments = []
    if (!Array.isArray(task.log)) task.log = []
    if (!Array.isArray(task.tags)) task.tags = []
    if (task.value === undefined) task.value = null
    if ((task.status as string) === 'cancelled') task.status = 'closed'
    if (task.reviewer === undefined) task.reviewer = null
    if (task.waiting_on === undefined) task.waiting_on = null
    for (const entry of task.log) {
      if ((entry.event as string) === 'cancelled') entry.event = 'closed'
    }
    const seq = /^T-(\d+)$/.exec(key)
    if (seq) maxSeq = Math.max(maxSeq, Number(seq[1]))
  }
  // Roster backfill for boards written before v0.5.4 (or by a harness that
  // never touched the roster): the log and the comment thread are *evidence of
  // activity* — the same evidence `touchActor` records — so an actor that is
  // absent from the roster is derived from them rather than reported as
  // "never acted". Strictly additive: a recorded `last_seen_at` is never
  // overwritten, so live boards keep their exact observation.
  const seen = new Map<string, string>()
  for (const task of Object.values(parsed.tasks ?? {})) {
    for (const entry of task.log ?? []) {
      if (typeof entry?.by !== 'string' || typeof entry?.at !== 'string') continue
      const key = actorKey(entry.by)
      if (!key) continue
      const known = seen.get(key)
      if (!known || entry.at > known) seen.set(key, entry.at)
    }
    for (const comment of task.comments ?? []) {
      if (typeof comment?.by !== 'string' || typeof comment?.at !== 'string') continue
      const key = actorKey(comment.by)
      if (!key) continue
      const known = seen.get(key)
      if (!known || comment.at > known) seen.set(key, comment.at)
    }
  }
  for (const [key, at] of seen) {
    const entry = resolveActor(parsed, key)
    if (!entry) {
      parsed.actors[key] = { kind: kindOf(key), aliases: [], first_seen_at: at, last_seen_at: at }
      continue
    }
    // A recorded observation is never overwritten — but `null` is the ABSENCE
    // of an observation, not evidence of absence, so evidence fills that gap.
    if (entry.last_seen_at === null) entry.last_seen_at = at
  }

  // `next_seq` must never point at an existing task: createTask allocates
  // `T-<next_seq>` and `board.tasks[id] = task` would overwrite that task in
  // place, silently (a restored backup or a hand-merged board does this).
  const next = parsed.next_seq
  const base = typeof next === 'number' && Number.isInteger(next) && next > 0 ? next : 1
  parsed.next_seq = Math.max(base, maxSeq + 1)
  // Workspace moves (the directory was relocated since the board was written):
  // report the CURRENT cwd from here on. Lazy on purpose — read paths never
  // take the lock, and every mutation saves the loaded board back, so the
  // correction rides the next normal write instead of forcing a locked write
  // into a read-only list.
  const currentWorkspace = resolve(cwd)
  if (parsed.workspace !== currentWorkspace) parsed.workspace = currentWorkspace
  // Remember what we saw, so a later disappearance cannot pass as a first run.
  boardsSeen.set(currentWorkspace, Object.keys(parsed.tasks ?? {}).length)
  return parsed
}

let tempCounter = 0

export async function saveBoard(cwd: string, board: Board): Promise<void> {
  const file = boardFilePath(cwd)
  await mkdir(dirname(file), { recursive: true })
  // Write-then-rename: a crash mid-write must not leave a truncated board.
  const temp = `${file}.tmp-${process.pid}-${(tempCounter += 1)}`
  try {
    await writeFile(temp, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    // A failed write/rename must not leave `.tmp-*` litter behind: the file
    // would sit in the watched `.dsh/` directory forever.
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

// ------------------------------------------------------------------ enable

/** What `enableBoard` did, so the UI can report it honestly. */
export interface EnableResult {
  /** The board file's absolute path. */
  board_file: string
  /** The workspace protocol doc's path when it was written, else null. */
  protocol_file: string | null
  /** Whether the board file already existed (we then left its tasks alone). */
  already_existed: boolean
}

/**
 * Turn the board on for a workspace.
 *
 * "On" means two things, and both matter:
 *   1. `.dsh/taskboard.json` exists, so the panel shows a real (possibly
 *      empty) board instead of the first-run prompt;
 *   2. `.dsh/BOARD-PROTOCOL.md` exists, so an agent that has never seen this
 *      board has the local rules in the project itself — the plugin's system
 *      prompt covers the flow, but the project doc is what a human or a
 *      different harness can read without the plugin.
 *
 * Idempotent and non-destructive: an existing board is NEVER rewritten (its
 * tasks are the user's data), and an existing protocol doc is left as-is so a
 * project can keep its own edits. Both are reported back.
 */
export async function enableBoard(
  cwd: string,
  options: { seedProtocol?: boolean } = {},
): Promise<EnableResult> {
  const boardFile = boardFilePath(cwd)
  const protocolFile = join(cwd, '.dsh', 'BOARD-PROTOCOL.md')
  const alreadyExisted = await fileExists(boardFile)

  // Creating a board is a write, so it goes through the lock like any other.
  if (!alreadyExisted) {
    await withBoardLock(cwd, async () => {
      // Re-check under the lock: another writer may have won the race.
      if (await fileExists(boardFile)) return
      await saveBoard(cwd, emptyBoard(resolve(cwd)))
    })
  }

  let protocolWritten: string | null = null
  if (options.seedProtocol !== false && !(await fileExists(protocolFile))) {
    await mkdir(dirname(protocolFile), { recursive: true })
    await writeFile(protocolFile, protocolDoc(), { mode: 0o600 })
    protocolWritten = protocolFile
  }

  return {
    board_file: boardFile,
    protocol_file: protocolWritten,
    already_existed: alreadyExisted,
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The workspace protocol doc seeded by `enableBoard`.
 *
 * Deliberately short: it points at the plugin's full spec instead of copying
 * it, because a copy would go stale the moment the plugin ships a change. What
 * it DOES state is the part an agent cannot infer — above all that only
 * `closed` is terminal, so `done` still owes a settle.
 */
function protocolDoc(): string {
  return `# 本工作区的任务看板约定

> 本文件由 dsh-taskboard-kit 在「开启看板」时生成，之后**归本工作区所有** —— 可以自由编辑、扩充、
> 甚至删除；插件不会覆盖它。完整规范见插件自带文档（\`dsh-taskboard-kit/docs/COLLABORATION.md\`），
> 这里只写本板不可不知的几条。

## 唯一事实源

看板就是一个文件：\`.dsh/taskboard.json\`（本目录下）。**永远不要手改它** ——
锁、原子认领、状态机都在工具里，手改会绕过全部保护。用 \`taskboard_*\` 工具，
或没有插件时的 \`dsh-taskboard-kit/bin/taskboard.mjs\` CLI。

## 状态机：只有 closed 是终点

\`\`\`
open ──▶ in_progress ──▶ review ──▶ done ──▶ closed
\`\`\`

- \`done\` = 干完且审核通过，**但还没结清**：卡仍在看板上，仍算「未结清」。
- \`closed\` = 结清，**唯一的终态**：结清后卡离开活跃视图与活跃计数。
- 「这事不做了」也走 \`close\`，但**必须在 note 里写清原因** ——
  没有单独的 abandoned 状态，「做完了」和「放弃了」的区别只存在于留言里。

所以：审核通过之后，**还有一步收口**。没人收口的卡会一直挂在面板顶部的
「待收口」条上，超过 72h 会被自检点名。

## 三条最常被违反的规矩

1. **动手前先占位**：池里的卡 \`claim\`，指派给你的卡 \`start\`。没占位不开工。
2. **做完交审核，不要自己 done**：\`submit --reviewer <名字>\` + 一条 \`comment\` 写清
   「做了什么 / 验证了什么 / 还差什么」。没有交接留言的提交，审核人无法验收。
3. **卡住要说清在等谁**：等人类 \`block --on human --question "一句能直接转发的问句"\`；
   等 Agent \`block --on agent --who <名字>\`。等谁的卡不能被认领。

## 会话开始先看自己那一份

\`taskboard_inbox\` —— 现在压在你身上的事，按急迫度排好，每条都带该敲的命令。
`
}

// -------------------------------------------------------------------- lock
// In-process queue first (the common case is one dsh process per workspace),
// then a cross-process O_EXCL lock file.
//
// Staleness is judged pid-FIRST: a signallable pid means the holder is alive,
// so its lock is never stolen (a suspended laptop, a slow disk or a debug
// breakpoint must not hand the board to a second writer). Only an unreadable
// pid — the writer died between creating the file and filling it in — falls
// back to the mtime heuristic.
//
// The lock file also carries a random token, and release unlinks it only while
// that token is still ours: a lock that was reclaimed meanwhile belongs to its
// new holder and must survive us.

const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 100
// The wait budget must OUTLAST the stale window. It used to be 50 × 100ms ≈ 5s
// while a lock only becomes reclaimable at 10s: a waiter that arrived with a
// dead holder's lock a few seconds short of stale gave up first and reported
// "still busy" — even though the very next attempt after the window would have
// reclaimed it. ~12s covers the window plus a margin for a slow reclaim.
// Deliberately spelled as its own literal (not derived) so the invariant
// `maxAttempts * retryMs >= staleMs` stays testable — see LOCK_TIMING.
const LOCK_MAX_ATTEMPTS = 120
/** Timing constants exported for the invariant test (see tests/store.test.mjs). */
export const LOCK_TIMING = {
  staleMs: LOCK_STALE_MS,
  retryMs: LOCK_RETRY_MS,
  maxAttempts: LOCK_MAX_ATTEMPTS,
} as const

let boardQueue: Promise<unknown> = Promise.resolve()

/**
 * Run `task` holding the workspace's board lock. The task body must use plain
 * loadBoard/saveBoard — calling `withBoardLock` again from inside deadlocks
 * the in-process queue.
 */
export function withBoardLock<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const run = boardQueue.then(async () => {
    const release = await acquireBoardLock(cwd)
    try {
      return await task()
    } finally {
      await release()
    }
  })
  boardQueue = run.catch(() => {})
  return run
}

/** The pid recorded in a lock file, or undefined when it cannot be read. */
async function lockHolderPid(lockPath: string): Promise<number | undefined> {
  const raw = await readFile(lockPath, 'utf8').catch(() => '')
  try {
    const pid = Number(JSON.parse(raw).pid)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function acquireBoardLock(cwd: string): Promise<() => Promise<void>> {
  const lockPath = `${boardFilePath(cwd)}.lock`
  await mkdir(dirname(lockPath), { recursive: true })
  for (let attempt = 0; ; attempt += 1) {
    const token = randomUUID()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }))
      await handle.close()
      return async () => {
        // Compare-and-delete: if the lock was reclaimed while we held it, the
        // file now belongs to someone else — removing it would let a third
        // writer in next to them.
        const owner = await readFile(lockPath, 'utf8')
          .then((raw) => String(JSON.parse(raw).token ?? ''))
          .catch(() => '')
        if (owner === token) await rm(lockPath, { force: true })
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      // A lock file we created but could not fill in must not be left behind:
      // it records our own live pid, so nobody (including us) would ever call
      // it stale.
      if (handle) await rm(lockPath, { force: true }).catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true })
        continue
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        const holder = await lockHolderPid(lockPath)
        throw new StoreError(
          'internal',
          holder === undefined
            ? `taskboard is locked (${lockPath}); still busy after ~${(LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS) / 1000}s and the holder is unknown`
            : `taskboard is locked by live pid ${holder} (${lockPath}); still busy after ~${(LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS) / 1000}s`,
        )
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, LOCK_RETRY_MS))
    }
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  let info
  try {
    info = await stat(lockPath)
  } catch {
    return true // the lock vanished between our checks; the next retry takes it
  }
  const pid = await lockHolderPid(lockPath)
  if (pid !== undefined) {
    // A lock naming US can only be a leak (nothing else writes our pid) or a
    // pid reused after a reboot — so the mtime decides: a fresh one may still
    // be a critical section of ours, an ancient one never is. Never steal from
    // ourselves on the strength of liveness alone, or such a lock would block
    // this process forever.
    if (pid === process.pid) return Date.now() - info.mtimeMs > LOCK_STALE_MS
    try {
      process.kill(pid, 0)
      return false // alive — EPERM included: unsignalable is not dead
    } catch (error) {
      // Only ESRCH proves the holder is gone; anything else (EPERM, EINVAL …)
      // must count as alive, so a live holder is never preempted.
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }
  return Date.now() - info.mtimeMs > LOCK_STALE_MS
}

// ------------------------------------------------------------- input parsing

const PRIORITIES: readonly TaskPriority[] = ['high', 'medium', 'low']
const STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'review', 'done', 'closed']
// `cancel` is the pre-v0.3 name of `close`; accepted as an alias forever.
// `block` / `unblock` (v0.5.4) park a card on someone without moving the status.
const ACTIONS: readonly UpdateAction[] = [
  'start', 'stop', 'submit', 'approve', 'reject', 'done', 'close', 'reopen', 'cancel', 'block', 'unblock',
]

// Caps that keep a board readable and every poll cheap: the file is re-read
// whole by the panel and parsed on every mutation, and nothing else prunes it.
const MAX_TITLE_LENGTH = 500
const MAX_DETAIL_LENGTH = 200_000
const MAX_TEXT_LENGTH = 50_000
const MAX_TAG_LENGTH = 100
const MAX_TAGS = 50

/** `T-<n>` — the only shape that may ever reach a lookup. */
const TASK_ID = /^T-\d+$/

function requireId(id: unknown): string {
  const value = typeof id === 'string' ? id.trim() : ''
  // Shape first: `__proto__`, `constructor` and friends resolve through the
  // prototype chain and must never be treated as a task record.
  if (!TASK_ID.test(value)) {
    throw new StoreError('invalid-input', `task id must look like T-1 (got ${JSON.stringify(id)})`)
  }
  return value
}

function requireTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new StoreError('invalid-input', 'title is required and must be a non-empty string')
  }
  const value = title.trim()
  if (value.length > MAX_TITLE_LENGTH) {
    throw new StoreError('invalid-input', `title must be at most ${MAX_TITLE_LENGTH} characters`)
  }
  return value
}

function parsePriority(priority: unknown): TaskPriority | undefined {
  if (priority === undefined) return undefined
  if (typeof priority !== 'string' || !PRIORITIES.includes(priority as TaskPriority)) {
    throw new StoreError('invalid-input', `priority must be one of ${PRIORITIES.join(' | ')}`)
  }
  return priority as TaskPriority
}

function parseTags(tags: unknown): string[] | undefined {
  if (tags === undefined) return undefined
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new StoreError('invalid-input', 'tags must be an array of strings')
  }
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))]
  if (cleaned.length > MAX_TAGS) {
    throw new StoreError('invalid-input', `at most ${MAX_TAGS} tags are allowed`)
  }
  if (cleaned.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new StoreError('invalid-input', `each tag must be at most ${MAX_TAG_LENGTH} characters`)
  }
  return cleaned
}

function parseDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined
  if (typeof detail !== 'string') throw new StoreError('invalid-input', 'detail must be a string')
  if (detail.length > MAX_DETAIL_LENGTH) {
    throw new StoreError('invalid-input', `detail must be at most ${MAX_DETAIL_LENGTH} characters`)
  }
  return detail
}

/** Assignee normalization: `undefined` = untouched, anything empty = unassigned. */
function parseAssignee(assignee: unknown): string | null | undefined {
  if (assignee === undefined) return undefined
  if (assignee === null) return null
  if (typeof assignee !== 'string') {
    throw new StoreError('invalid-input', 'assignee must be a string or null')
  }
  const trimmed = assignee.trim()
  return trimmed === '' || trimmed.toLowerCase() === 'none' ? null : trimmed
}

function parseAction(action: unknown): UpdateAction | undefined {
  if (action === undefined) return undefined
  if (typeof action !== 'string' || !ACTIONS.includes(action as UpdateAction)) {
    throw new StoreError('invalid-input', `action must be one of ${ACTIONS.join(' | ')}`)
  }
  return action as UpdateAction
}

/** Value points: one of TASK_VALUES (0.5/1/2/3/5/8); `undefined` = untouched, `null` = clear. */
function parseValue(value: unknown): TaskValue | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !TASK_VALUES.includes(value as TaskValue)) {
    throw new StoreError('invalid-input', `value must be one of ${TASK_VALUES.join(' | ')} (or null to clear)`)
  }
  return value as TaskValue
}

function mustTask(board: Board, id: string): Task {
  // Own properties only: `board.tasks['__proto__']` resolves through the
  // prototype chain and would hand back Object.prototype itself — the guard
  // `!task` passes, and the caller then writes fields onto the global
  // prototype of this process.
  const task = Object.hasOwn(board.tasks, id) ? board.tasks[id] : undefined
  if (!task || typeof task !== 'object') throw new StoreError('not-found', `no such task: ${id}`)
  return task
}

function logEntry(at: string, by: string, event: TaskEvent): TaskLogEntry {
  return { at, by, event }
}

// ------------------------------------------------------------------- roster
// The roster answers "who is here, and when did we last see them" — the fact
// the board cannot derive from the log alone (a task delegated to an actor
// that never ran again just looks busy). Aliases unify one agent's many names
// so `dsh` and `dsh-agent` are one owner, not two.

/**
 * Alias groups in force: the built-in `dsh ≡ dsh-agent`, plus
 * `TASKBOARD_ACTOR_ALIASES` (`canonical:alias1|alias2,…`), plus
 * `TASKBOARD_WATCH_NAMES` (whose FIRST name is canonical and the rest aliases —
 * the instance already declares "these names are all me" there).
 */
export function actorAliasGroups(): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  const add = (canonical: string, aliases: readonly string[]) => {
    const key = actorKey(canonical)
    if (!key) return
    groups[key] = [...new Set([...(groups[key] ?? []), ...aliases.map((alias) => alias.trim()).filter(Boolean)])]
  }
  add('dsh', ['dsh-agent'])
  for (const [canonical, aliases] of Object.entries(parseAliasConfig(process.env.TASKBOARD_ACTOR_ALIASES))) {
    add(canonical, aliases)
  }
  const watch = parseWatchNames(process.env.TASKBOARD_WATCH_NAMES)
  if (watch) add(watch.canonical, watch.aliases)
  return groups
}

/** Names that are humans, not agents: `human` plus `TASKBOARD_HUMANS` (逗号分隔). */
export function humanNames(): string[] {
  const configured = (process.env.TASKBOARD_HUMANS ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  return [HUMAN_ACTOR, ...configured]
}

function kindOf(name: string): ActorKind {
  const key = actorKey(name)
  return humanNames().some((human) => actorKey(human) === key) ? 'human' : 'agent'
}

/**
 * Record that `name` just acted (or was just referenced): refresh
 * `last_seen_at`, materialize its aliases from the configured groups.
 * `touchActor` (actor) and `noteActor` (mere reference — no liveness claim)
 * are deliberately different: being *named* in an assignee field is not
 * evidence of being alive.
 */
function touchActor(board: Board, name: string, now: string): void {
  const key = actorKey(name)
  if (!key) return
  board.actors ??= {}
  const groups = actorAliasGroups()
  // The canonical spelling of an alias group wins when we mint a new entry, so
  // `dsh-agent` acting first still files under `dsh` (one owner, not two).
  const canonical = Object.keys(groups).find((group) =>
    group === key || groups[group]!.some((alias) => actorKey(alias) === key))
  const aliases = groups[key] ?? (canonical ? groups[canonical] ?? [] : [])
  const existingKey = Object.keys(board.actors).find((entry) => actorKey(entry) === key)
    ?? Object.keys(board.actors).find((entry) => (board.actors[entry]?.aliases ?? []).some((alias) => actorKey(alias) === key))
  const target = existingKey ?? canonical ?? name.trim()
  const entry: ActorEntry = board.actors[target] ?? {
    kind: kindOf(name),
    aliases: [],
    first_seen_at: now,
    last_seen_at: null,
  }
  entry.aliases = [...new Set([...entry.aliases, ...aliases])].filter((alias) => actorKey(alias) !== actorKey(target))
  entry.last_seen_at = now
  board.actors[target] = entry
}

/** Register a name we merely referenced (assignee / reviewer / waiting_on). */
function noteActor(board: Board, name: string | null | undefined, now: string, kind?: ActorKind): void {
  if (!name) return
  const key = actorKey(name)
  if (!key) return
  if (resolveActor(board, name)) return
  board.actors ??= {}
  board.actors[name.trim()] = {
    kind: kind ?? kindOf(name),
    aliases: [],
    first_seen_at: now,
    last_seen_at: null,
  }
}

/** 名册成员的名字集合（规范名 + 别名）——通知"是谁"时用得到。 */
export function actorNamesOf(board: Board, name: string): string[] {
  return actorNames(board, name)
}

/** 解析成名册里的规范名，解析不到就给规范化后的自身。 */
export function canonicalActor(board: Board, name: string): string {
  const entry = resolveActor(board, name)
  if (!entry) return name.trim()
  const found = Object.entries(board.actors ?? {}).find(([, value]) => value === entry)
  return found?.[0] ?? name.trim()
}

// ---------------------------------------------------------- domain operations

export interface CreateTaskInput {
  title: string
  detail?: string
  /** Set = delegate to that actor; omitted/null/empty = into the claimable pool. */
  assignee?: string | null
  priority?: TaskPriority
  /** Value points (0.5/1/2/3/5/8); omitted/null = unestimated. */
  value?: TaskValue | null
  tags?: string[]
}

export async function createTask(cwd: string, input: CreateTaskInput, by: string): Promise<Task> {
  const title = requireTitle(input?.title)
  const detail = parseDetail(input?.detail) ?? ''
  const assignee = parseAssignee(input?.assignee) ?? null
  const priority = parsePriority(input?.priority) ?? 'medium'
  const value = parseValue(input?.value) ?? null
  const tags = parseTags(input?.tags) ?? []
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd)
    const now = new Date().toISOString()
    // Never allocate an id that already exists: `board.tasks[id] = task` would
    // overwrite that task in place, silently. loadBoard heals next_seq, this is
    // the belt to that pair of braces.
    let id = `T-${board.next_seq}`
    while (Object.hasOwn(board.tasks, id)) {
      board.next_seq += 1
      id = `T-${board.next_seq}`
    }
    board.next_seq += 1
    const log: TaskLogEntry[] = [logEntry(now, by, 'created')]
    if (assignee) log.push(logEntry(now, by, 'assigned'))
    const task: Task = {
      id,
      title,
      detail,
      status: 'open',
      assignee,
      reviewer: null,
      waiting_on: null,
      priority,
      value,
      tags,
      created_by: by,
      created_at: now,
      updated_at: now,
      log,
      comments: [],
    }
    board.tasks[id] = task
    touchActor(board, by, now)
    noteActor(board, assignee, now)
    await saveBoard(cwd, board)
    return task
  })
}

/**
 * The core atomic action: take a task out of the claimable pool. Succeeds only
 * while the task is open AND unassigned; anything else (already claimed, in
 * progress, review, done, closed, or delegated to someone) is a conflict.
 *
 * v0.5.4: a task **waiting on someone** (usually the human) is NOT claimable —
 * "waiting for a decision" must never be advertised as "free work" (that is
 * exactly how T-8 sat in the pool looking like it was up for grabs).
 */
export async function claimTask(cwd: string, id: string, by: string): Promise<Task> {
  const taskId = requireId(id)
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd)
    const task = mustTask(board, taskId)
    if (task.waiting_on) {
      throw new StoreError(
        'conflict',
        `${taskId} is waiting on ${task.waiting_on.kind}${task.waiting_on.who ? ` (${task.waiting_on.who})` : ''}: ${task.waiting_on.question} — unblock it before claiming`,
      )
    }
    if (task.status !== 'open' || task.assignee) {
      const held = task.assignee ? ` (held by ${task.assignee})` : ''
      throw new StoreError('conflict', `${taskId} cannot be claimed: status is ${task.status}${held}`)
    }
    const now = new Date().toISOString()
    task.status = 'in_progress'
    task.assignee = by
    task.updated_at = now
    task.log.push(logEntry(now, by, 'claimed'))
    touchActor(board, by, now)
    await saveBoard(cwd, board)
    return task
  })
}

export interface UpdateTaskPatch {
  action?: UpdateAction
  /** Change the owner while open/in_progress; null unassigns back to the pool. */
  assignee?: string | null
  /** Who owes the review (set at submit, or pre-delegated); null clears it. */
  reviewer?: string | null
  /** block: 在等谁（human / agent / external）；省略时由 wait_who 推断。 */
  wait_kind?: WaitOn['kind']
  /** block: 具体等谁（人类名 / Agent 名）。 */
  wait_who?: string | null
  /** block: 要对方回答什么——必须是一句能直接抄给对方的问句。 */
  wait_question?: string
  title?: string
  detail?: string
  priority?: TaskPriority
  /** Value points (0.5/1/2/3/5/8); null clears back to unestimated. */
  value?: TaskValue | null
  tags?: string[]
  /** Appended to the last log entry this update produces (or a new 'updated' one). */
  note?: string
}

const WAIT_KINDS: readonly WaitOn['kind'][] = ['human', 'agent', 'external']

function parseWaitKind(kind: unknown): WaitOn['kind'] | undefined {
  if (kind === undefined) return undefined
  if (typeof kind !== 'string' || !WAIT_KINDS.includes(kind as WaitOn['kind'])) {
    throw new StoreError('invalid-input', `wait kind must be one of ${WAIT_KINDS.join(' | ')}`)
  }
  return kind as WaitOn['kind']
}

/**
 * Self-review is refused by default: a card approved by whoever wrote it is not
 * reviewed at all. `TASKBOARD_ALLOW_SELF_REVIEW=1` is the escape hatch for a
 * one-agent workspace, where the alternative is a card stuck forever.
 */
function allowsSelfReview(): boolean {
  return process.env.TASKBOARD_ALLOW_SELF_REVIEW === '1'
}

/**
 * Who owes the review of this card. Explicit wins; otherwise keep an existing
 * reviewer; otherwise the task's creator (the person accountable for the work);
 * otherwise the most recently active other agent; finally the human.
 */
function resolveReviewer(board: Board, task: Task, by: string, requested: string | null | undefined): string {
  const selfReview = (name: string) => allowsSelfReview() || !sameActor(board, name, by)
  if (requested && requested.trim() !== '') {
    if (!selfReview(requested)) {
      throw new StoreError('invalid-input', `you cannot review your own work: pick another reviewer (or set TASKBOARD_ALLOW_SELF_REVIEW=1)`)
    }
    return requested.trim()
  }
  if (task.reviewer && sameActor(board, task.reviewer, by) === false) return task.reviewer
  if (task.created_by && !sameActor(board, task.created_by, by)) return task.created_by
  const others = Object.entries(board.actors ?? {})
    .filter(([name, entry]) => entry.kind === 'agent' && !sameActor(board, name, by) && entry.last_seen_at)
    .sort((a, b) => String(b[1].last_seen_at).localeCompare(String(a[1].last_seen_at)))
  if (others.length > 0) return others[0]![0]
  return HUMAN_ACTOR
}

/** 审核裁决权：审核人本人、卡主（对自己派出去的活负责）、以及人类。 */
function canDecide(board: Board, task: Task, by: string): boolean {
  if (kindOf(by) === 'human') return true
  if (!task.reviewer) return true // legacy board: nobody named, don't block the flow
  return sameActor(board, task.reviewer, by) || sameActor(board, task.created_by, by)
}

/**
 * Status transitions by action (v0.6 two-step closing):
 *   start:   open → in_progress ('started')
 *   stop:    in_progress → open ('stopped', assignee kept)
 *   submit:  in_progress → review ('submitted', reviewer = resolved)
 *   approve: review → done ('approved')
 *   reject:  review → in_progress ('rejected')
 *   done:    open | in_progress | review → done ('done')
 *   close:   open | in_progress | review | done → closed ('closed')
 *   reopen:  done | closed → open ('reopened', assignee kept)
 *
 * `done` is NOT terminal: it means "finished and approved", and the card stays
 * on the board (still counted as open work) until someone settles it with
 * `close`. `closed` is the one terminal status. Abandoning work is also a
 * `close` — the difference lives in the note, not in a separate status.
 *
 * The legacy action `cancel` behaves exactly as `close`.
 * The action lands first; an assignee change in the same call is then checked
 * against the RESULTING status.
 *
 * v0.5.4 adds two actions that do NOT move the status machine:
 *   block:   set `waiting_on` (open | in_progress | review) — 'blocked'
 *   unblock: clear `waiting_on` — 'unblocked'
 * so "parked on a human" stops looking like "free work".
 */
export async function updateTask(
  cwd: string,
  id: string,
  patch: UpdateTaskPatch,
  by: string,
): Promise<{ task: Task; events: TaskEvent[] }> {
  const taskId = requireId(id)
  const action = parseAction(patch?.action)
  const assignee = parseAssignee(patch?.assignee)
  const reviewer = parseAssignee(patch?.reviewer)
  const waitKind = parseWaitKind(patch?.wait_kind)
  const waitWho = parseAssignee(patch?.wait_who)
  const waitQuestion = parseDetail(patch?.wait_question)
  const title = patch?.title === undefined ? undefined : requireTitle(patch.title)
  const detail = parseDetail(patch?.detail)
  const priority = parsePriority(patch?.priority)
  const value = parseValue(patch?.value)
  const tags = parseTags(patch?.tags)
  let note: string | undefined
  if (patch?.note !== undefined) {
    if (typeof patch.note !== 'string') throw new StoreError('invalid-input', 'note must be a string')
    const trimmed = patch.note.trim()
    if (trimmed.length > MAX_TEXT_LENGTH) {
      throw new StoreError('invalid-input', `note must be at most ${MAX_TEXT_LENGTH} characters`)
    }
    note = trimmed === '' ? undefined : trimmed
  }

  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd)
    const task = mustTask(board, taskId)
    const now = new Date().toISOString()
    const events: TaskEvent[] = []

    if (action) {
      if (action === 'block') {
        if (task.status === 'done' || task.status === 'closed') {
          throw new StoreError('invalid-transition', `${taskId} is ${task.status}; a finished task cannot be blocked`)
        }
        const kind = waitKind ?? (waitWho ? kindOf(waitWho) : undefined)
        if (!kind) {
          throw new StoreError('invalid-input', 'block needs wait_kind (human | agent | external) or wait_who')
        }
        const question = (waitQuestion ?? '').trim()
        if (question === '') {
          throw new StoreError('invalid-input', 'block needs wait_question — say exactly what the other side must decide')
        }
        task.waiting_on = { kind, who: waitWho ?? null, question, since: now }
        // The wait target belongs on the roster so the panel and the CLI can
        // show "in review / waiting on <name> — never acted" instead of an
        // anonymous string.
        noteActor(board, waitWho, now, kind === 'human' ? 'human' : 'agent')
        events.push('blocked')
      } else if (action === 'unblock') {
        if (!task.waiting_on) {
          throw new StoreError('invalid-transition', `${taskId} is not waiting on anyone`)
        }
        task.waiting_on = null
        events.push('unblocked')
      } else {
        const transition = transitionOf(task, action)
        // Review ownership: submit hands the card to a named reviewer; the
        // verdict actions are reserved for that reviewer, the task's creator
        // and the human.
        if (action === 'submit') {
          // The reviewer rides the `submitted` event itself — no extra `updated`
          // entry, so the timeline stays one line per real state change.
          const resolved = resolveReviewer(board, task, by, reviewer)
          task.reviewer = resolved
          touchActor(board, resolved, now) // being handed the review IS presence
          task.waiting_on = null
        } else if (action === 'approve' || action === 'reject') {
          if (!canDecide(board, task, by)) {
            throw new StoreError(
              'conflict',
              `${taskId} is waiting for ${task.reviewer} to review it; only the reviewer, ${task.created_by} (creator) or the human can decide`,
            )
          }
          task.reviewer = null
          task.waiting_on = null
        } else if (action === 'done' || action === 'close' || action === 'reopen') {
          task.reviewer = null
          task.waiting_on = null
        }
        task.status = transition.to
        events.push(transition.event)
      }
    }

    if (assignee !== undefined && assignee !== task.assignee) {
      if (task.status !== 'open' && task.status !== 'in_progress') {
        throw new StoreError(
          'invalid-input',
          `${taskId} is ${task.status}; the assignee can only change while open or in_progress`,
        )
      }
      events.push(task.assignee === null && assignee !== null ? 'assigned' : 'updated')
      task.assignee = assignee
      noteActor(board, assignee, now)
    }

    if (reviewer !== undefined && action !== 'submit' && reviewer !== null && !sameActor(board, task.reviewer, reviewer)) {
      const mayDelegate = kindOf(by) === 'human'
        || sameActor(board, task.assignee, by)
        || sameActor(board, task.created_by, by)
        || sameActor(board, task.reviewer, by)
      if (!mayDelegate) {
        throw new StoreError('conflict', `${taskId} is not yours to hand over: only its owner, creator, current reviewer or the human can set the reviewer`)
      }
      if (sameActor(board, reviewer, by) && !allowsSelfReview()) {
        throw new StoreError('invalid-input', 'you cannot review your own work: pick another reviewer (or set TASKBOARD_ALLOW_SELF_REVIEW=1)')
      }
      task.reviewer = reviewer
      noteActor(board, reviewer, now)
      events.push('updated')
    } else if (reviewer === null && task.reviewer !== null) {
      task.reviewer = null
      events.push('updated')
    }

    let fieldsChanged = false
    if (title !== undefined && title !== task.title) {
      task.title = title
      fieldsChanged = true
    }
    if (detail !== undefined && detail !== task.detail) {
      task.detail = detail
      fieldsChanged = true
    }
    if (priority !== undefined && priority !== task.priority) {
      task.priority = priority
      fieldsChanged = true
    }
    if (value !== undefined && value !== task.value) {
      task.value = value
      fieldsChanged = true
    }
    if (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(task.tags)) {
      task.tags = tags
      fieldsChanged = true
    }
    if (fieldsChanged) events.push('updated')

    if (events.length === 0 && !note) {
      throw new StoreError('invalid-input', 'nothing to update: pass an action, a field change, or a note')
    }
    // A bare note still leaves a trace: it rides a fresh 'updated' entry when
    // the patch itself changed nothing else.
    if (events.length === 0) events.push('updated')
    const entries = events.map((event) => logEntry(now, by, event))
    if (note) entries[entries.length - 1]!.note = note
    task.log.push(...entries)
    task.updated_at = now
    touchActor(board, by, now)
    await saveBoard(cwd, board)
    return { task, events }
  })
}

/** The status machine (v0.3): action → allowed source statuses → target + event.
 *  `block` / `unblock` are deliberately absent — they write `waiting_on`, not
 *  the status, so a parked card keeps living in the column it really is in. */
type EffectiveAction = Exclude<UpdateAction, 'cancel' | 'block' | 'unblock'>

const TRANSITIONS: Record<EffectiveAction, { from: readonly TaskStatus[]; to: TaskStatus; event: TaskEvent }> = {
  start: { from: ['open'], to: 'in_progress', event: 'started' },
  stop: { from: ['in_progress'], to: 'open', event: 'stopped' },
  submit: { from: ['in_progress'], to: 'review', event: 'submitted' },
  approve: { from: ['review'], to: 'done', event: 'approved' },
  reject: { from: ['review'], to: 'in_progress', event: 'rejected' },
  done: { from: ['open', 'in_progress', 'review'], to: 'done', event: 'done' },
  close: { from: ['open', 'in_progress', 'review', 'done'], to: 'closed', event: 'closed' },
  reopen: { from: ['done', 'closed'], to: 'open', event: 'reopened' },
}

/** The transition one action produces, or an invalid-transition StoreError. */
function transitionOf(task: Task, action: UpdateAction): { to: TaskStatus; event: TaskEvent } {
  const effective: EffectiveAction = action === 'cancel' ? 'close' : (action as EffectiveAction)
  const transition = TRANSITIONS[effective]
  if (!transition) {
    throw new StoreError('invalid-input', `action "${action}" does not move the status; use it on its own`)
  }
  if (!transition.from.includes(task.status)) {
    throw new StoreError('invalid-transition', `${task.id} is ${task.status}; action "${action}" is not allowed now`)
  }
  return transition
}

/**
 * Add an information comment WITHOUT touching the state machine: the log is
 * for lifecycle events, comments are the conversation (findings, handoff
 * notes, test feedback). Only `updated_at` moves.
 */
export async function addComment(cwd: string, id: string, text: string, by: string): Promise<Task> {
  const taskId = requireId(id)
  if (typeof text !== 'string' || text.trim() === '') {
    throw new StoreError('invalid-input', 'comment text is required and must be a non-empty string')
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new StoreError('invalid-input', `comment text must be at most ${MAX_TEXT_LENGTH} characters`)
  }
  const body = text.trim()
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd)
    const task = mustTask(board, taskId)
    const now = new Date().toISOString()
    task.comments.push({ at: now, by, text: body })
    task.updated_at = now
    touchActor(board, by, now)
    await saveBoard(cwd, board)
    return task
  })
}

export async function getTask(cwd: string, id: string): Promise<Task> {
  const taskId = requireId(id)
  const board = await loadBoard(cwd)
  return mustTask(board, taskId)
}

export interface ListTasksFilter {
  status?: TaskStatus
  /** A concrete actor name, or 'none' for tasks still in the claimable pool. */
  assignee?: string | 'none'
  /** 只看在等谁：`human` / `agent` / `external` / `any`（在等任何人）。 */
  waiting?: WaitOn['kind'] | 'any'
}

export async function listTasks(cwd: string, filter?: ListTasksFilter): Promise<Task[]> {
  if (filter?.status !== undefined && !STATUSES.includes(filter.status)) {
    throw new StoreError('invalid-input', `status must be one of ${STATUSES.join(' | ')}`)
  }
  if (filter?.waiting !== undefined && filter.waiting !== 'any' && !WAIT_KINDS.includes(filter.waiting)) {
    throw new StoreError('invalid-input', `waiting must be one of ${WAIT_KINDS.join(' | ')} or any`)
  }
  const board = await loadBoard(cwd)
  return Object.values(board.tasks)
    .filter((task) => {
      if (filter?.status && task.status !== filter.status) return false
      if (filter?.assignee === 'none' && task.assignee !== null) return false
      if (filter?.assignee !== undefined && filter.assignee !== 'none' && task.assignee !== filter.assignee) return false
      if (filter?.waiting === 'any' && !task.waiting_on) return false
      if (filter?.waiting !== undefined && filter.waiting !== 'any' && task.waiting_on?.kind !== filter.waiting) return false
      return true
    })
    .sort(compareTasks)
}

// ------------------------------------------------------- derived collaboration

/**
 * 「我现在该干什么」——按急迫度排好的行动清单（见 shared/board.inboxFor）。
 * 这是让看板**主动推进**而不是被人轮询的那一半。
 */
export async function inbox(cwd: string, actor: string, options?: InboxOptions): Promise<InboxItem[]> {
  const board = await loadBoard(cwd)
  return inboxFor(board, actor, options)
}

/** 全板协作健康度：交接断了 / 审核没人认领 / 在等人类 / 列陈旧。 */
export async function health(cwd: string, options?: HealthOptions): Promise<BoardHealth> {
  return boardHealth(await loadBoard(cwd), options)
}

/** 名册快照（面板与 CLI 用来回答"谁还在场"）。 */
export async function roster(cwd: string): Promise<{ name: string; entry: ActorEntry; quietMs: number | null }[]> {
  const board = await loadBoard(cwd)
  const now = Date.now()
  return Object.entries(board.actors ?? {})
    .map(([name, entry]) => ({
      name,
      entry,
      quietMs: entry.last_seen_at ? Math.max(0, now - (Date.parse(entry.last_seen_at) || now)) : null,
    }))
    .sort((a, b) => (a.quietMs ?? Number.MAX_SAFE_INTEGER) - (b.quietMs ?? Number.MAX_SAFE_INTEGER))
}

/** 「这张卡在该列待了多久」——面板角标与 CLI stale 共用的那一句话。 */
export function columnAgeMs(task: Task, now: number = Date.now()): number {
  return ageInColumnMs(task, now)
}

/** 陈旧判定的再导出，方便调用方只依赖 store。 */
export function taskStaleness(task: Task, now?: number) {
  return stalenessOf(task, now)
}
