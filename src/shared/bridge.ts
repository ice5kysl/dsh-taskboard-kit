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
 *
 * The browser's mutations are always attributed to actor `human`; the host
 * stamps `by` itself — the request bodies carry no actor field.
 *
 * @module dsh-taskboard-kit/shared/bridge
 */

import type { Board, Task, TaskPriority } from './types.ts'

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
  tags?: string[]
}

export interface ClaimRequest {
  cwd: string
  id: string
}

export type UpdateAction = 'start' | 'done' | 'reopen' | 'cancel'

export interface UpdateRequest {
  cwd: string
  id: string
  action?: UpdateAction
  assignee?: string | null
  title?: string
  detail?: string
  priority?: TaskPriority
  tags?: string[]
  note?: string
}

export type ErrorCode = 'invalid-input' | 'not-found' | 'conflict' | 'invalid-transition' | 'forbidden' | 'internal'

export interface ApiError {
  ok: false
  error: string
  code?: ErrorCode
}

export type BoardResponse = { ok: true; board: Board } | ApiError
export type TaskResponse = { ok: true; task: Task } | ApiError
