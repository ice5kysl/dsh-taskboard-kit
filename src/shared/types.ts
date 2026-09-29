/**
 * Shared data model of dsh-taskboard-kit — the contract both faces build on.
 *
 * One board per dsh workspace; the board's only source of truth is a JSON
 * file inside the workspace itself (`<workspace>/.dsh/taskboard.json`), so
 * every harness and every human working in the same directory sees the same
 * board. No server, no account system.
 *
 * Status flow (v0.6): 待认领/已指派(open) → 进行中(in_progress) →
 * 待审核(review) → 已完成(done) → 已关闭(closed)。
 *
 * **只有 closed 是终态。** done 表示"干完了、审核通过了"，但卡还没结清：
 * 它仍留在活跃视图里（在 已完成 列），直到有人收口成 closed。
 * 这是刻意的两段式——审核通过 ≠ 这件事了结（可能还要部署、还要等上游确认、
 * 还要收尾文档），把两者分开，看板上就不会出现"看起来完了但没人负责收口"的灰区。
 *
 * 因此：
 *   • closed 是唯一终态，不再出现在活跃计数/活跃视图里；
 *   • reopened 可以从 done 或 closed 回到 open（closed → open 就是"结清错了"）；
 *   • 废弃（abandoned）不另立状态：close 掉并在 note 里写清为什么不做。
 *
 * open/in_progress/done 刻意对齐 msg9 任务模型，未来服务端后端语义不变。
 *
 * v0.5.4 加了两条**与状态正交**的协作轴（都不新增状态，见 docs/COLLABORATION.md）：
 *   • `reviewer` —— 谁欠这次审核（submit 时必须有人接）；没有它 review 列就是黑洞；
 *   • `waiting_on` —— 这张卡在等谁（人类 / 另一个 Agent / 外部），等人类不是"待认领"。
 * 另有板级 `actors` 名册：谁在这个 workspace 出现过、最近一次是什么时候，
 * 用来回答"派给一个已经不在场的 Agent"这类问题（别名 dsh ≡ dsh-agent）。
 *
 * @module dsh-taskboard-kit/shared/types
 */

export type TaskStatus = 'open' | 'in_progress' | 'review' | 'done' | 'closed'

/**
 * The ONE terminal status: a card here is settled and leaves the active board.
 * Everything else (including `done`) is still somebody's business.
 */
export const TERMINAL_STATUS: TaskStatus = 'closed'

/** Is this status terminal (settled)? Only `closed` is. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === TERMINAL_STATUS
}

/**
 * Is this card awaiting a final settle? `done` means "work finished, approved"
 * — it still sits on the board until someone closes it, because approval is
 * not the same as the matter being closed out.
 */
export function needsSettling(task: Pick<Task, 'status'>): boolean {
  return task.status === 'done'
}

/** 一个 Actor 是人还是 Agent（人类要单独对待：他不在 Agent 的自省循环里）。 */
export type ActorKind = 'agent' | 'human'

/** 这张卡在等谁：`kind` 决定由谁去叫人（human → 通知人类）。 */
export interface WaitOn {
  kind: ActorKind | 'external'
  /** 具体等谁（Agent 名 / 人类名）；`null` = 只写了 kind，没指名。 */
  who: string | null
  /** 到底要对方回答什么——要能直接抄进发给人类的消息里。 */
  question: string
  /** 进入等待的时刻（算"等了多久"、决定升级催办的依据）。 */
  since: string
}

/**
 * 板级名册的一条：这个 workspace 里出现过的 Actor。
 * 活性的唯一证据是 `last_seen_at`（该 Actor 每次动手都会刷新），
 * 不从 log 文本里猜——把卡派给一个已消失的 claude，就是猜错的代价。
 */
export interface ActorEntry {
  kind: ActorKind
  /** 同一个 Actor 的其他名字（dsh ≡ dsh-agent ≡ dsh-web）。 */
  aliases: string[]
  first_seen_at: string
  /** 最后一次动手的时间；创建时就指派、对方从未动手时为 `null`。 */
  last_seen_at: string | null
}

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
  | 'blocked'
  | 'unblocked'
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
  /** 谁欠这次审核（`status === 'review'` 时有意义）；`null` = 无人认领审核。 */
  reviewer: string | null
  /** 在等谁（与状态正交）；`null` = 没在等谁。等人类 ≠ 待认领。 */
  waiting_on: WaitOn | null
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
  /** Actor 名册：别名解析 + 活性证据 + 人类是谁（v0.5.4 起）。 */
  actors: Record<string, ActorEntry>
}

/**
 * The six kanban columns. `done` is a normal, always-visible lane (cards there
 * finished but are not settled yet); only `closed` renders collapsed, because
 * it is the one lane holding settled work nobody needs to act on.
 */
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
  return { version: 1, workspace, next_seq: 1, tasks: {}, actors: {} }
}

/** Column ordering inside one column: priority first, then oldest first. */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

export function compareTasks(a: Task, b: Task): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
}
