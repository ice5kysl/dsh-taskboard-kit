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
  TASK_VALUES,
  compareTasks,
  emptyBoard,
  type Board,
  type Task,
  type TaskEvent,
  type TaskLogEntry,
  type TaskPriority,
  type TaskStatus,
  type TaskValue,
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
  //   v0.3 renamed cancelled → closed (status AND log events) and added value.
  for (const task of Object.values(parsed.tasks ?? {})) {
    if (!Array.isArray(task.comments)) task.comments = []
    if (task.value === undefined) task.value = null
    if ((task.status as string) === 'cancelled') task.status = 'closed'
    for (const entry of task.log ?? []) {
      if ((entry.event as string) === 'cancelled') entry.event = 'closed'
    }
  }
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
const ACTIONS: readonly UpdateAction[] = ['start', 'stop', 'submit', 'approve', 'reject', 'done', 'close', 'reopen', 'cancel']

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
    await saveBoard(cwd, board)
    return task
  })
}

/**
 * The core atomic action: take a task out of the claimable pool. Succeeds only
 * while the task is open AND unassigned; anything else (already claimed, in
 * progress, review, done, closed, or delegated to someone) is a conflict.
 */
export async function claimTask(cwd: string, id: string, by: string): Promise<Task> {
  const taskId = requireId(id)
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd)
    const task = mustTask(board, taskId)
    if (task.status !== 'open' || task.assignee) {
      const held = task.assignee ? ` (held by ${task.assignee})` : ''
      throw new StoreError('conflict', `${taskId} cannot be claimed: status is ${task.status}${held}`)
    }
    const now = new Date().toISOString()
    task.status = 'in_progress'
    task.assignee = by
    task.updated_at = now
    task.log.push(logEntry(now, by, 'claimed'))
    await saveBoard(cwd, board)
    return task
  })
}

export interface UpdateTaskPatch {
  action?: UpdateAction
  /** Change the owner while open/in_progress; null unassigns back to the pool. */
  assignee?: string | null
  title?: string
  detail?: string
  priority?: TaskPriority
  /** Value points (0.5/1/2/3/5/8); null clears back to unestimated. */
  value?: TaskValue | null
  tags?: string[]
  /** Appended to the last log entry this update produces (or a new 'updated' one). */
  note?: string
}

/**
 * Status transitions by action (v0.3 review flow):
 *   start:   open → in_progress ('started')
 *   stop:    in_progress → open ('stopped', assignee kept)
 *   submit:  in_progress → review ('submitted')
 *   approve: review → done ('approved')
 *   reject:  review → in_progress ('rejected')
 *   done:    open | in_progress | review → done ('done')
 *   close:   open | in_progress | review | done → closed ('closed')
 *   reopen:  done | closed → open ('reopened', assignee kept)
 * The legacy action `cancel` behaves exactly as `close`.
 * The action lands first; an assignee change in the same call is then checked
 * against the RESULTING status.
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
      const transition = transitionOf(task, action)
      task.status = transition.to
      events.push(transition.event)
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
    await saveBoard(cwd, board)
    return { task, events }
  })
}

/** The status machine (v0.3): action → allowed source statuses → target + event. */
type EffectiveAction = Exclude<UpdateAction, 'cancel'>

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
  const effective: EffectiveAction = action === 'cancel' ? 'close' : action
  const transition = TRANSITIONS[effective]
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
}

export async function listTasks(cwd: string, filter?: ListTasksFilter): Promise<Task[]> {
  if (filter?.status !== undefined && !STATUSES.includes(filter.status)) {
    throw new StoreError('invalid-input', `status must be one of ${STATUSES.join(' | ')}`)
  }
  const board = await loadBoard(cwd)
  return Object.values(board.tasks)
    .filter((task) => {
      if (filter?.status && task.status !== filter.status) return false
      if (filter?.assignee === 'none' && task.assignee !== null) return false
      if (filter?.assignee !== undefined && filter.assignee !== 'none' && task.assignee !== filter.assignee) return false
      return true
    })
    .sort(compareTasks)
}
