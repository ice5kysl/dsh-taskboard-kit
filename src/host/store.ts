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

export async function loadBoard(cwd: string): Promise<Board> {
  const file = boardFilePath(cwd)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    // A missing file is the normal first-run case; anything else (EACCES …)
    // must surface instead of masquerading as an empty board.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyBoard(resolve(cwd))
    throw error
  }
  let parsed: Board
  try {
    parsed = JSON.parse(raw) as Board
  } catch (error) {
    // Never silently empty a corrupt board: keep a copy for manual recovery.
    const backup = `${file}.corrupt-${Date.now()}`
    await writeFile(backup, raw, { mode: 0o600 }).catch(() => {})
    throw new StoreError(
      'internal',
      `taskboard file is not valid JSON (a copy was kept at ${backup}): ${(error as Error).message}`,
    )
  }
  if (!parsed || parsed.version !== 1) {
    throw new StoreError('internal', `unsupported taskboard version in ${file} (expected 1)`)
  }
  // Schema drift normalization (version stays 1 for added/renamed fields):
  //   v0.2 added comments — hydrate it in place;
  //   v0.3 renamed cancelled → closed (status AND log events) and added value;
  //   v0.5.4 added reviewer / waiting_on (per task) and actors (per board).
  parsed.actors ??= {}
  for (const task of Object.values(parsed.tasks ?? {})) {
    if (!Array.isArray(task.comments)) task.comments = []
    if (task.value === undefined) task.value = null
    if ((task.status as string) === 'cancelled') task.status = 'closed'
    if (task.reviewer === undefined) task.reviewer = null
    if (task.waiting_on === undefined) task.waiting_on = null
    for (const entry of task.log ?? []) {
      if ((entry.event as string) === 'cancelled') entry.event = 'closed'
    }
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

  // Workspace moves (the directory was relocated since the board was written):
  // report the CURRENT cwd from here on. Lazy on purpose — read paths never
  // take the lock, and every mutation saves the loaded board back, so the
  // correction rides the next normal write instead of forcing a locked write
  // into a read-only list.
  const currentWorkspace = resolve(cwd)
  if (parsed.workspace !== currentWorkspace) parsed.workspace = currentWorkspace
  return parsed
}

let tempCounter = 0

export async function saveBoard(cwd: string, board: Board): Promise<void> {
  const file = boardFilePath(cwd)
  await mkdir(dirname(file), { recursive: true })
  // Write-then-rename: a crash mid-write must not leave a truncated board.
  const temp = `${file}.tmp-${process.pid}-${(tempCounter += 1)}`
  await writeFile(temp, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, file)
}

// -------------------------------------------------------------------- lock
// In-process queue first (the common case is one dsh process per workspace),
// then a cross-process O_EXCL lock file. A lock whose mtime is older than
// LOCK_STALE_MS — or whose pid is gone — is a crashed holder's residue and is
// removed before retrying.

const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 100
const LOCK_MAX_ATTEMPTS = 50 // ~5s of waiting, then fail loudly

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

async function acquireBoardLock(cwd: string): Promise<() => Promise<void>> {
  const lockPath = `${boardFilePath(cwd)}.lock`
  await mkdir(dirname(lockPath), { recursive: true })
  for (let attempt = 0; ; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      await handle.close()
      return async () => {
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true })
        continue
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        throw new StoreError(
          'internal',
          `taskboard is locked by another process (${lockPath}); still busy after ~${(LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS) / 1000}s`,
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
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true
  const raw = await readFile(lockPath, 'utf8').catch(() => '')
  let pid = NaN
  try {
    pid = Number(JSON.parse(raw).pid)
  } catch {
    /* unreadable content: judge by mtime alone */
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0)
    } catch {
      return true // the holder is dead
    }
  }
  return false
}

// ------------------------------------------------------------- input parsing

const PRIORITIES: readonly TaskPriority[] = ['high', 'medium', 'low']
const STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'review', 'done', 'closed']
// `cancel` is the pre-v0.3 name of `close`; accepted as an alias forever.
// `block` / `unblock` (v0.5.4) park a card on someone without moving the status.
const ACTIONS: readonly UpdateAction[] = [
  'start', 'stop', 'submit', 'approve', 'reject', 'done', 'close', 'reopen', 'cancel', 'block', 'unblock',
]

function requireId(id: unknown): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new StoreError('invalid-input', 'task id is required')
  }
  return id.trim()
}

function requireTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new StoreError('invalid-input', 'title is required and must be a non-empty string')
  }
  return title.trim()
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
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))]
}

function parseDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined
  if (typeof detail !== 'string') throw new StoreError('invalid-input', 'detail must be a string')
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
  const task = board.tasks[id]
  if (!task) throw new StoreError('not-found', `no such task: ${id}`)
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
    const id = `T-${board.next_seq}`
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
 * Status transitions by action (v0.3 review flow):
 *   start:   open → in_progress ('started')
 *   stop:    in_progress → open ('stopped', assignee kept)
 *   submit:  in_progress → review ('submitted', reviewer = resolved)
 *   approve: review → done ('approved')
 *   reject:  review → in_progress ('rejected')
 *   done:    open | in_progress | review → done ('done')
 *   close:   open | in_progress | review | done → closed ('closed')
 *   reopen:  done | closed → open ('reopened', assignee kept)
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
  const note = typeof patch?.note === 'string' && patch.note.trim() !== '' ? patch.note.trim() : undefined

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
