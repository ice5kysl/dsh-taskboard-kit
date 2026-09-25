/**
 * Drag-and-drop semantics of the board panel — pure planning, shared so the
 * client and the tests agree on what "drop this card on that column" means.
 *
 * A drop is planned as a short sequence of store operations the caller runs
 * in order (`claim`, or `update` patches in the bridge's UpdateRequest
 * shape). The status machine does the real validation server-side; this plan
 * only encodes the intuitive mapping:
 *
 *   pool        unassign (and back to open from in_progress / done)
 *   assigned    open + a concrete assignee (empty name ⇒ same as pool)
 *   in_progress pool card ⇒ claim; delegated card ⇒ start; finished ⇒ reopen+start
 *   done        finish (already done/cancelled ⇒ no-op)
 *
 * @module dsh-taskboard-kit/shared/dnd
 */

import type { BoardColumn, Task } from './types.ts'

export type DropOp =
  | { kind: 'claim' }
  | { kind: 'update'; patch: { action?: 'start' | 'stop' | 'done' | 'reopen' | 'cancel'; assignee?: string | null } }

/**
 * Plan the operations for dropping `task` on `target`. An empty array means
 * the drop is a no-op (card already belongs there).
 */
export function planDrop(task: Pick<Task, 'status' | 'assignee'>, target: BoardColumn, assignee?: string): DropOp[] {
  switch (target) {
    case 'pool':
      if (task.status === 'open' && !task.assignee) return []
      if (task.status === 'open') return [{ kind: 'update', patch: { assignee: null } }]
      if (task.status === 'in_progress') return [{ kind: 'update', patch: { action: 'stop', assignee: null } }]
      return [{ kind: 'update', patch: { action: 'reopen', assignee: null } }]
    case 'assigned': {
      const name = assignee?.trim()
      if (!name) return planDrop(task, 'pool')
      if (task.status === 'open' && task.assignee === name) return []
      if (task.status === 'open') return [{ kind: 'update', patch: { assignee: name } }]
      if (task.status === 'in_progress') return [{ kind: 'update', patch: { action: 'stop', assignee: name } }]
      return [{ kind: 'update', patch: { action: 'reopen', assignee: name } }]
    }
    case 'in_progress':
      if (task.status === 'in_progress') return []
      if (task.status === 'open' && !task.assignee) return [{ kind: 'claim' }]
      if (task.status === 'open') return [{ kind: 'update', patch: { action: 'start' } }]
      return [{ kind: 'update', patch: { action: 'reopen' } }, { kind: 'update', patch: { action: 'start' } }]
    case 'done':
      if (task.status === 'open' || task.status === 'in_progress') return [{ kind: 'update', patch: { action: 'done' } }]
      return []
  }
}
