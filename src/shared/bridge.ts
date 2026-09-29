/**
 * Browser-bridge contract of dsh-taskboard-kit — shared by the host face
 * (`src/host/http.ts`, which serves it) and the client face
 * (`src/client/api.ts`, which calls it). Keep the two in sync through THIS
 * file, never by drift.
 *
 * Routes (all under BRIDGE_PREFIX; mutations are POST and MUST carry the
 * custom header `x-taskboard: mutate`):
 *
 *   GET  /dsh-taskboard/board?cwd=<abs path>   → BoardResponse
 *   POST /dsh-taskboard/create   CreateRequest → TaskResponse
 *   POST /dsh-taskboard/claim    ClaimRequest  → TaskResponse (conflict → ok:false, code 'conflict')
 *   POST /dsh-taskboard/update   UpdateRequest → TaskResponse
 *   POST /dsh-taskboard/comment  CommentRequest → TaskResponse
 *   POST /dsh-taskboard/enable   EnableRequest  → EnableResponse (create the
 *                                board for a workspace; idempotent)
 *
 * The browser's mutations are always attributed to actor `human`; the host
 * stamps `by` itself — the request bodies carry no actor field.
 *
 * @module dsh-taskboard-kit/shared/bridge
 */

import type { ActorKind, Board, Task, TaskPriority, TaskValue } from './types.ts'

export const BRIDGE_PREFIX = '/dsh-taskboard'

/** Custom header every POST to the bridge must carry (CSRF posture). */
export const MUTATE_HEADER = 'x-taskboard'
export const MUTATE_HEADER_VALUE = 'mutate'

export interface CreateRequest {
  cwd: string
  title: string
  detail?: string
  /** Set = delegate to that actor; omitted/null = into the claimable pool. */
  assignee?: string | null
  priority?: TaskPriority
  /** 价值度（½/1/2/3/5/8）；省略 = 未评估。 */
  value?: TaskValue | null
  tags?: string[]
}

export interface ClaimRequest {
  cwd: string
  id: string
}

/**
 * 状态流转动作：start(open→in_progress) · stop(in_progress→open) ·
 * submit(in_progress→review) · approve(review→done) · reject(review→in_progress) ·
 * done(open|in_progress|review→done) · close(非终态→closed) · reopen(done|closed→open)。
 * 旧名 `cancel` 作为 `close` 的别名继续接受。
 *
 * v0.5.4 加了两个**不动状态机**的动作：block / unblock —— 它们只写
 * `task.waiting_on`（这张卡在等谁），所以"在等人类"不会被误当成"待认领"。
 */
export type UpdateAction =
  | 'start' | 'stop' | 'submit' | 'approve' | 'reject' | 'done' | 'close' | 'reopen' | 'cancel'
  | 'block' | 'unblock'

export interface UpdateRequest {
  cwd: string
  id: string
  action?: UpdateAction
  assignee?: string | null
  /** 交接审核：submit 时指定审核人；approve/reject 时校验是不是他。 */
  reviewer?: string | null
  /** block 参数：在等谁（human / agent / external）。 */
  wait_kind?: ActorKind | 'external'
  /** block 参数：等谁（人类名 / Agent 名）。 */
  wait_who?: string | null
  /** block 参数：要对方回答什么（会原样进给人类的消息）。 */
  wait_question?: string
  title?: string
  detail?: string
  priority?: TaskPriority
  /** 价值度（½/1/2/3/5/8）；null = 清除为未评估。 */
  value?: TaskValue | null
  tags?: string[]
  note?: string
}

/** Add an information comment; the task's state is untouched. */
export interface CommentRequest {
  cwd: string
  id: string
  text: string
}

export type ErrorCode = 'invalid-input' | 'not-found' | 'conflict' | 'invalid-transition' | 'forbidden' | 'internal'

export interface ApiError {
  ok: false
  error: string
  code?: ErrorCode
}

/**
 * `board_exists` distinguishes the two empty-looking states: a board file that
 * is absent (nobody has turned the board on for this workspace) versus one that
 * exists with zero tasks (on, and waiting for its first card). The panel shows
 * a different prompt for each — the first needs enabling before any agent can
 * work, the second just needs a task.
 */
export type BoardResponse = { ok: true; board: Board; cli?: string | null; board_file?: string; board_exists?: boolean } | ApiError
export type TaskResponse = { ok: true; task: Task } | ApiError

/**
 * Turn the board on for a workspace: create `.dsh/taskboard.json` if absent,
 * and seed `.dsh/BOARD-PROTOCOL.md` if absent. Never rewrites either.
 */
export interface EnableRequest {
  cwd: string
  /** When false, only the board is created (no protocol doc). Default true. */
  seed_protocol?: boolean
}

export type EnableResponse =
  | { ok: true; board_file: string; protocol_file: string | null; already_existed: boolean }
  | ApiError
