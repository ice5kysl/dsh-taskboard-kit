/**
 * Shared view helpers of the taskboard browser face — labels, badges and the
 * drop-execution pipeline used by both the board tab (BoardPanel) and the
 * composer-side mini board (MiniBoard). Pure / store-driven, no JSX here.
 *
 * @module dsh-taskboard-kit/client-view
 */

import { useCallback } from 'react'
import type { Board, BoardColumn, Task, TaskPriority, TaskValue } from '../shared/types.ts'
import { columnOf } from '../shared/types.ts'
import type { DropOp } from '../shared/dnd.ts'
import { L } from './locale.ts'
import type { TaskboardStore } from './store.ts'

/** The session-list slot share (host-provided hook argument shape). */
export interface SessionListLike {
  /** Selection INSIDE the list state — legacy (≤0.1.6) only. 0.1.7 moved the
   *  selection out of the Controller ("view selection remains outside"): the
   *  list state carries only ids/byId, and session-scoped slots receive the
   *  current session as the `sessionId` standard prop instead. */
  current?: string
  byId?: Record<string, { cwd?: string } | undefined>
}

/** Read the selected session's directory out of the standard slot shares.
 *  0.1.7 hands the current session to session-scoped slots as the `sessionId`
 *  prop; older hosts kept it in the list state's `current`. Prefer the prop,
 *  fall back to the legacy field. Shared by the board tab and the
 *  composer-side mini board entry. */
export function useSessionCwd(props: { sessionId?: string; useSessions?: (selector: (state: SessionListLike) => unknown) => unknown }): string | undefined {
  const scopedId = typeof props.sessionId === 'string' && props.sessionId ? props.sessionId : undefined
  const selector = props.useSessions
  const read = useCallback((state: SessionListLike): unknown => {
    const id = scopedId ?? state?.current
    if (!id) return undefined
    return state?.byId?.[id]?.cwd
  }, [scopedId])
  // `useSessions` is itself a hook when the host provides one: keep the call
  // unconditional in shape (no early return above it) so hook order stays
  // stable; the host keeps this prop stable for the lifetime of the surface.
  const value = typeof selector === 'function' ? selector(read) : undefined
  return typeof value === 'string' ? value : undefined
}

export function columnLabel(column: BoardColumn): string {
  switch (column) {
    case 'pool': return L('待认领', 'Pool')
    case 'assigned': return L('已指派', 'Assigned')
    case 'in_progress': return L('进行中', 'In progress')
    case 'review': return L('待审核', 'In review')
    case 'done': return L('已完成', 'Done')
    case 'closed': return L('已关闭', 'Closed')
  }
}

export function priorityLabel(priority: TaskPriority): string {
  switch (priority) {
    case 'high': return L('高', 'high')
    case 'medium': return L('中', 'medium')
    case 'low': return L('低', 'low')
  }
}

/** 0.5 renders as ½, everything else as its plain number. */
export function valueText(value: TaskValue): string {
  return value === 0.5 ? '½' : String(value)
}

/** Card age badge: 5m / 3h / 2d since creation. */
export function ageText(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Card/drawer shorthand: T-3 → #3; ids of any other shape display verbatim. */
export function taskRef(id: string): string {
  const digits = /^T-(\d+)$/.exec(id)?.[1]
  return digits ? `#${digits}` : id
}

/** The entry button's badge: every task not yet in a final column. */
export function openTaskCount(board: Board | null): number {
  if (!board) return 0
  let count = 0
  for (const task of Object.values(board.tasks)) {
    const column = columnOf(task)
    if (column !== 'done' && column !== 'closed') count += 1
  }
  return count
}

/**
 * Execute one shared `planDrop` op sequence in order through the store
 * (claim → store.claim, update → store.update with the patch). An empty plan
 * is a no-op (no request); a failed step surfaces through the store's error
 * channel and stops the sequence. Used by the board lanes and the mini
 * board's status blocks alike.
 */
export async function runPlanOps(store: TaskboardStore, id: Task['id'], ops: DropOp[]): Promise<void> {
  for (const op of ops) {
    const ok = op.kind === 'claim'
      ? await store.claim(id)
      : await store.update({ id, ...op.patch })
    if (!ok) return
  }
}
