/**
 * Shared data model of dsh-taskboard-kit — the contract both faces build on.
 *
 * One board per dsh workspace; the board's only source of truth is a JSON
 * file inside the workspace itself (`<workspace>/.dsh/taskboard.json`), so
 * every harness and every human working in the same directory sees the same
 * board. No server, no account system.
 *
 * Status flow (v0.3): 待认领/已指派(open) → 进行中(in_progress) →
 * 待审核(review) → 已完成(done)；任何非终态可 已关闭(closed，面板默认折叠)。
 * open/in_progress/done 刻意对齐 msg9 任务模型，未来服务端后端语义不变。
 *
 * @module dsh-taskboard-kit/shared/types
 */

export type TaskStatus = 'open' | 'in_progress' | 'review' | 'done' | 'closed'

export type TaskPriority = 'high' | 'medium' | 'low'

/**
 * 价值度（价值点数），斐波那契刻度：½ / 1 / 2 / 3 / 5 / 8。
 * `null` = 未评估。
 */
export type TaskValue = 0.5 | 1 | 2 | 3 | 5 | 8

export const TASK_VALUES: readonly TaskValue[] = [0.5, 1, 2, 3, 5, 8]

export type TaskEvent =
  | 'created'
  | 'assigned'
  | 'claimed'
  | 'started'
  | 'stopped'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'done'
  | 'reopened'
  | 'closed'
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
  /** 价值度；`null` = 未评估。 */
  value: TaskValue | null
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

/** The six kanban columns; `closed` renders collapsed by default. */
export type BoardColumn = 'pool' | 'assigned' | 'in_progress' | 'review' | 'done' | 'closed'

export const BOARD_COLUMNS: readonly BoardColumn[] = ['pool', 'assigned', 'in_progress', 'review', 'done', 'closed']

/**
 * Column derivation: an open task with no assignee waits in the claimable
 * pool; with an assignee it has been delegated; the other four statuses map
 * one-to-one onto their columns.
 */
export function columnOf(task: Pick<Task, 'status' | 'assignee'>): BoardColumn {
  if (task.status === 'open') return task.assignee ? 'assigned' : 'pool'
  return task.status
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
