/**
 * Drag-and-drop semantics of the board panel — pure planning, shared so the
 * client and the tests agree on what "drop this card on that column" means.
 *
 * A drop is planned as a short sequence of store operations the caller runs
 * in order (`claim`, or `update` patches in the bridge's UpdateRequest
 * shape). The status machine does the real validation server-side; this plan
 * only encodes the intuitive mapping over the six columns:
 *
 *   pool        unassign + back to open
 *   assigned    open + a concrete assignee (empty name ⇒ same as pool)
 *   in_progress pool ⇒ claim · delegated ⇒ start · review ⇒ reject(打回继续干) · done/closed ⇒ reopen+start
 *   review      in_progress ⇒ submit（已完成/已关闭不回审核）
 *   done        review ⇒ approve · open/in_progress ⇒ done
 *   closed      anything not closed ⇒ close
 *
 * @module dsh-taskboard-kit/shared/dnd
 */

import type { BoardColumn, Task } from './types.ts'

export type DropOp =
  | { kind: 'claim' }
  | { kind: 'update'; patch: { action?: 'start' | 'stop' | 'submit' | 'approve' | 'reject' | 'done' | 'close' | 'reopen'; assignee?: string | null } }

const FINISHED = new Set(['done', 'closed'])

/** Route a finished (done/closed) card back onto the board via reopen. */
function viaReopen(then: { action?: 'start' | 'stop'; assignee?: string | null }): DropOp[] {
  const ops: DropOp[] = [{ kind: 'update', patch: { action: 'reopen', ...(then.assignee !== undefined ? { assignee: then.assignee } : {}) } }]
  if (then.action) ops.push({ kind: 'update', patch: { action: then.action } })
  return ops
}

/**
 * Plan the operations for dropping `task` on `target`. An empty array means
 * the drop is a no-op (card already belongs there, or the move makes no sense).
 */
export function planDrop(task: Pick<Task, 'status' | 'assignee'>, target: BoardColumn, assignee?: string): DropOp[] {
  switch (target) {
    case 'pool':
      if (task.status === 'open' && !task.assignee) return []
      if (task.status === 'open') return [{ kind: 'update', patch: { assignee: null } }]
      if (task.status === 'in_progress') return [{ kind: 'update', patch: { action: 'stop', assignee: null } }]
      if (task.status === 'review') {
        return [{ kind: 'update', patch: { action: 'reject' } }, { kind: 'update', patch: { action: 'stop', assignee: null } }]
      }
      return viaReopen({ assignee: null })
    case 'assigned': {
      const name = assignee?.trim()
      if (!name) return planDrop(task, 'pool')
      if (task.status === 'open' && task.assignee === name) return []
      if (task.status === 'open') return [{ kind: 'update', patch: { assignee: name } }]
      if (task.status === 'in_progress') return [{ kind: 'update', patch: { action: 'stop', assignee: name } }]
      if (task.status === 'review') {
        return [{ kind: 'update', patch: { action: 'reject' } }, { kind: 'update', patch: { action: 'stop', assignee: name } }]
      }
      return viaReopen({ assignee: name })
    }
    case 'in_progress':
      if (task.status === 'in_progress') return []
      if (task.status === 'open' && !task.assignee) return [{ kind: 'claim' }]
      if (task.status === 'open') return [{ kind: 'update', patch: { action: 'start' } }]
      if (task.status === 'review') {
        // `reject` keeps the assignee — an unowned review card would land in
        // 进行中 with nobody holding it, where `claim` refuses it forever
        // (claim needs `open`). Send it back to the pool and claim it instead.
        return task.assignee
          ? [{ kind: 'update', patch: { action: 'reject' } }]
          : [
              { kind: 'update', patch: { action: 'reject' } },
              { kind: 'update', patch: { action: 'stop' } },
              { kind: 'claim' },
            ]
      }
      // done|closed: reopen keeps the assignee, so an unowned card must be
      // CLAIMED after the reopen — `reopen` + `start` would leave 进行中 with
      // no owner (the same dead end as above).
      return task.assignee ? viaReopen({ action: 'start' }) : [...viaReopen({}), { kind: 'claim' }]
    case 'review':
      if (task.status === 'review' || FINISHED.has(task.status)) return []
      if (task.status === 'in_progress') return [{ kind: 'update', patch: { action: 'submit' } }]
      if (task.assignee) return [{ kind: 'update', patch: { action: 'start' } }, { kind: 'update', patch: { action: 'submit' } }]
      return [{ kind: 'claim' }, { kind: 'update', patch: { action: 'submit' } }]
    case 'done':
      if (FINISHED.has(task.status)) return []
      if (task.status === 'review') return [{ kind: 'update', patch: { action: 'approve' } }]
      return [{ kind: 'update', patch: { action: 'done' } }]
    case 'closed':
      if (task.status === 'closed') return []
      return [{ kind: 'update', patch: { action: 'close' } }]
  }
}
