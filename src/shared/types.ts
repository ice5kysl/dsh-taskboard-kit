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

/**
 * 一条**复核尾巴**的收口记录（v0.7.5）。
 *
 * 复核意见写在 note / comment 里，而 note 不改变列 ⇒ 没有载体、没有提醒、
 * 天生静默（T-40 审计：38 张 closed 卡里至少 10 条复核遗留掉了地）。
 * 这条记录就是那个载体：每条尾巴要么 **已落卡**（给卡号），要么 **显式作废**
 * （给理由）。收口后 `taskboard tails` 不再列它 —— 否则下次又列一遍，人就
 * 开始无视它。
 */
export interface TailSettlement {
  /** `filed` = 已落卡（`card` 指向承接它的卡）；`waived` = 已作废（`reason` 必填）。 */
  status: 'filed' | 'waived'
  /** filed：承接它的卡号，必须真实存在（否则只是把尾巴换个地方丢）。 */
  card: string | null
  /** waived：为什么不做 —— 收口记录里唯一能区分"做完了"和"放弃了"的东西。 */
  reason: string | null
  by: string
  at: string
}

/**
 * 一次「已把提交告诉 reviewer」的去重记录（T-56）。
 *
 * submit 是**附属通知**的触发点：通知是 best-effort，但**不能重复轰炸**。
 * 锚点是 `anchor`（`T-56#log:7` —— 卡上最后一条 `submitted` 事件的下标），
 * 所以「同一轮提交重放」命中同一条记录而跳过，而 reject 之后重新 submit
 * 是一轮新提交、会重新通知（那次交接本来就是新信息）。
 */
export interface ReviewNotice {
  /** 哪张卡。 */
  task: string
  /** 通知了谁（submit 时任命的 reviewer）。 */
  reviewer: string
  /** 本轮提交的锚点：`<卡号>#log:<下标>`。 */
  anchor: string
  /** 真的发出去了（msg9），还是只打印了可复制的提示。 */
  how: 'msg9' | 'printed'
  /** 只打印时的原因（发成功时为 null）。 */
  reason: 'no-msg9' | 'no-address' | 'send-failed' | 'disabled' | null
  /** 解析到的 msg9 收件地址（没解析到则 null —— 地址绝不猜）。 */
  address: string | null
  at: string
}

export interface Board {
  version: 1
  /** Absolute path of the workspace this board belongs to. */
  workspace: string
  next_seq: number
  tasks: Record<string, Task>
  /** Actor 名册：别名解析 + 活性证据 + 人类是谁（v0.5.4 起）。 */
  actors: Record<string, ActorEntry>
  /**
   * 复核尾巴的收口记录（v0.7.5 起）：key 是尾巴 id（`T-25#log:6:2`，见
   * shared/tails.ts），value 是它怎么被消化掉的。
   *
   * **刻意是可选的**：v0.7.5 之前的板没有这个字段，而读取端一律走
   * `board.tails ?? {}`。这样新字段不需要 host 侧的 schema 迁移就能读旧板，
   * 第一次收口时由写入方顺手落地 —— 向后兼容是"读端容忍缺失"，不是"写端补齐"。
   */
  tails?: Record<string, TailSettlement>
  /**
   * reviewer 通知的去重记录（T-56 起）：key 是 `<卡号>#log:<下标>@<reviewer>`。
   * 同样**刻意可选**（读端 `board.review_notices ?? {}`），旧板不需要迁移。
   */
  review_notices?: Record<string, ReviewNotice>
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
  return { version: 1, workspace, next_seq: 1, tasks: {}, actors: {}, tails: {} }
}

/** Column ordering inside one column: priority first, then oldest first. */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

export function compareTasks(a: Task, b: Task): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
}
