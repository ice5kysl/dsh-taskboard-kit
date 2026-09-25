/**
 * Shared data model of dsh-taskboard-kit — the contract both faces build on.
 *
 * One board per dsh workspace; the board's only source of truth is a JSON
 * file inside the workspace itself (`<workspace>/.dsh/taskboard.json`), so
 * every harness and every human working in the same directory sees the same
 * board. No server, no account system.
 *
 * Status names deliberately mirror the msg9 task model (open ≈ pending,
 * in_progress, done ≈ completed), so a future msg9-backed board store keeps
 * the semantics intact.
 *
 * @module dsh-taskboard-kit/shared/types
 */

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled'

export type TaskPriority = 'high' | 'medium' | 'low'

export type TaskEvent =
  | 'created'
  | 'assigned'
  | 'claimed'
  | 'started'
  | 'stopped'
  | 'done'
  | 'reopened'
  | 'cancelled'
  | 'updated'

export interface TaskLogEntry {
  at: string
  by: string
  event: TaskEvent
  note?: string
}

/**
 * A free-form information comment on a task: findings, handoff notes for the
 * next agent, test feedback. Comments never change the task's state — the
 * state machine lives in `log`; the conversation lives here.
 */
export interface TaskComment {
  at: string
  by: string
  text: string
}

export interface Task {
  /** `T-<seq>`, allocated from the board's next_seq. */
  id: string
  title: string
  /** Markdown body; the panel renders it as plain pre-wrap text (MVP). */
  detail: string
  status: TaskStatus
  /** Who the task belongs to. `null` while it waits in the claimable pool. */
  assignee: string | null
  priority: TaskPriority
  tags: string[]
  created_by: string
  created_at: string
  updated_at: string
  log: TaskLogEntry[]
  /** Information thread (findings / handoffs / test feedback). Oldest first. */
  comments: TaskComment[]
}

export interface Board {
  version: 1
  /** Absolute path of the workspace this board belongs to. */
  workspace: string
  next_seq: number
  tasks: Record<string, Task>
}

/** The four kanban columns the panel renders. */
export type BoardColumn = 'pool' | 'assigned' | 'in_progress' | 'done'

export const BOARD_COLUMNS: readonly BoardColumn[] = ['pool', 'assigned', 'in_progress', 'done']

/**
 * Column derivation: an open task with no assignee waits in the claimable
 * pool; with an assignee it has been delegated; cancelled tasks land in the
 * done column (the panel hides them behind a toggle).
 */
export function columnOf(task: Pick<Task, 'status' | 'assignee'>): BoardColumn {
  if (task.status === 'open') return task.assignee ? 'assigned' : 'pool'
  if (task.status === 'in_progress') return 'in_progress'
  return 'done'
}

export function emptyBoard(workspace: string): Board {
  return { version: 1, workspace, next_seq: 1, tasks: {} }
}

/** Column ordering inside one column: priority first, then oldest first. */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

export function compareTasks(a: Task, b: Task): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
}
