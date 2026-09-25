/**
 * The board's actor roster — who the assignment UI can offer, derived purely
 * from board data.
 *
 * There is no directory service behind a local board: the people and agents
 * you can sensibly assign a task to are exactly the actors who have touched
 * it before. The roster is the union of every task's `assignee`,
 * `created_by`, `log[].by` and `comments[].by` — nulls and empty strings
 * dropped, deduplicated, sorted. A brand-new board has an empty roster, and
 * the UI says so instead of offering a dead text input.
 *
 * @module dsh-taskboard-kit/client-actors
 */

import type { Board } from '../shared/types.ts'

/** Every actor the board has ever seen, sorted alphabetically. */
export function knownActors(board: Board): string[] {
  const names = new Set<string>()
  for (const task of Object.values(board.tasks)) {
    if (task.assignee) names.add(task.assignee)
    if (task.created_by) names.add(task.created_by)
    for (const entry of task.log) {
      if (entry.by) names.add(entry.by)
    }
    for (const comment of task.comments) {
      if (comment.by) names.add(comment.by)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
