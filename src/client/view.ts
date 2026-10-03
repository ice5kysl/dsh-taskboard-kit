/**
 * Shared view helpers of the taskboard browser face — labels, badges and the
 * drop-execution pipeline used by both the board tab (BoardPanel) and the
 * composer-side mini board (MiniBoard). Pure / store-driven, no JSX here.
 *
 * @module dsh-taskboard-kit/client-view
 */

import { useCallback } from 'react'
import type { Board, BoardColumn, Task, TaskPriority, TaskValue } from '../shared/types.ts'
import { columnOf, compareTasks, isTerminalStatus } from '../shared/types.ts'
import { DEFAULT_QUIET_MS, actorKey, actorKeyOf, actorSeenAt } from '../shared/board.ts'
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
    case 'done': return L('待收口', 'To settle')
    case 'closed': return L('已结清', 'Settled')
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

/**
 * The entry button's badge: everything still on somebody's plate.
 *
 * `done` COUNTS as open work (v0.6): approved-but-unsettled cards still need a
 * human/PO to close them out, so they must not disappear from the badge — that
 * disappearance is exactly what let finished work rot unnoticed.
 */
export function openTaskCount(board: Board | null): number {
  if (!board) return 0
  let count = 0
  for (const task of Object.values(board.tasks)) {
    if (!isTerminalStatus(task.status)) count += 1
  }
  return count
}

/**
 * A task is settled (terminal) — only `closed` is. Used by the「含已关闭」
 * filter in the owner view: `done` cards stay visible because they still owe
 * a settle, while `closed` ones are history.
 */
export function isFinal(task: Task): boolean {
  return isTerminalStatus(task.status)
}

/**
 * One lane of the「按负责人」view: a group of tasks that belong to the same
 * owner. `kind` says WHY they are grouped, and drives the header treatment:
 *
 *   • `unassigned` — `assignee === null`: the pool, nobody's head yet;
 *   • `human`      — parked on a person (`waiting_on.kind === 'human'`): the
 *                   "到底卡在谁那" lane, which is not the same question as
 *                   "who owns it" — the owner may be an agent waiting on you;
 *   • `actor`      — an ordinary owner (agent or human assignee).
 */
export interface OwnerGroup {
  /** Canonical (alias-folded) actor key, or the `unassigned` sentinel. */
  key: string
  /** Display name (the canonical roster name when the board knows one). */
  label: string
  kind: 'unassigned' | 'actor' | 'human'
  tasks: Task[]
  /** Whether the owner has gone quiet (roster evidence only); `false` if unknown. */
  quiet: boolean
}

/** The sentinel key of the pool lane (never collides with a real actor name). */
export const UNASSIGNED_KEY = '\u0000unassigned'

/** Prefix of a waiting-on-human lane's key: same owner, different lane. */
const HUMAN_LANE_PREFIX = '\u0000human:'

/** Lane order of the `kind`s: work-on-nobody first, then owners, human last. */
const OWNER_KIND_ORDER: Record<OwnerGroup['kind'], number> = { unassigned: 0, actor: 1, human: 2 }

/**
 * Group the board's tasks by owner, for the「按负责人」view.
 *
 * Alias-aware: names are folded through the roster (`actorKeyOf`), so
 * `dsh` / `dsh-agent` / `dsh-web` land in ONE lane instead of three — the same
 * contract the roster uses everywhere else. Cards in a lane keep the board's
 * own ordering (`compareTasks`), so priority/age read the same in both views.
 *
 * Options:
 *   • `includeClosed` (default false) — settled (`closed`) tasks are history and
 *     would bury the live ones. Note this hides ONLY `closed`: `done` cards
 *     keep showing, because they still owe a settle (v0.6).
 *
 * Lanes are ordered: 待认领 → owners (alphabetical) → 等人类. Nothing is
 * dropped: a lane exists only when it has at least one task, and an empty
 * board yields an empty list (the caller renders its own empty state).
 */
export function groupByOwner(
  board: Board | null,
  options: { includeClosed?: boolean; quietMs?: number; now?: number } = {},
): OwnerGroup[] {
  if (!board) return []
  const includeClosed = options.includeClosed ?? false
  const now = options.now ?? Date.now()
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS

  const groups = new Map<string, OwnerGroup>()
  const lane = (key: string, label: string, kind: OwnerGroup['kind']): OwnerGroup => {
    let found = groups.get(key)
    if (!found) {
      found = { key, label, kind, tasks: [], quiet: false }
      groups.set(key, found)
    }
    return found
  }

  for (const task of Object.values(board.tasks)) {
    if (!includeClosed && isFinal(task)) continue
    if (!task.assignee) {
      lane(UNASSIGNED_KEY, '', 'unassigned').tasks.push(task)
      continue
    }
    // Fold aliases to one canonical owner, and display the roster's own name.
    const key = actorKeyOf(board, task.assignee)
    const label = displayNameOf(board, task.assignee)
    // A card parked on a person is NOT part of its owner's active load — the
    // owner is blocked, not working. It gets its own lane instead, so it can
    // never be mistaken for work in flight. The `!` prefix keeps that lane's
    // key distinct from the owner's own lane (they share the owner's name).
    const onHuman = task.waiting_on?.kind === 'human'
    const entry = onHuman
      ? lane(`${HUMAN_LANE_PREFIX}${key}`, label, 'human')
      : lane(key, label, 'actor')
    entry.tasks.push(task)
  }

  for (const group of groups.values()) {
    group.tasks.sort(compareTasks)
    if (group.kind === 'actor') {
      const seenAt = actorSeenAt(board, group.label)
      group.quiet = typeof seenAt === 'string' && now - Date.parse(seenAt) > quietMs
    }
  }

  return [...groups.values()].sort((a, b) => {
    const byKind = OWNER_KIND_ORDER[a.kind] - OWNER_KIND_ORDER[b.kind]
    if (byKind !== 0) return byKind
    return a.label.localeCompare(b.label)
  })
}

/** The roster's canonical name for an actor when it knows one, else the alias. */
function displayNameOf(board: Board, name: string): string {
  const key = actorKeyOf(board, name)
  for (const entryName of Object.keys(board.actors ?? {})) {
    if (actorKey(entryName) === key) return entryName
  }
  return name
}

/** The overlay stack of the board tab, topmost first. */
export type BoardLayer = 'about' | 'guide' | 'picker' | 'drawer'

/**
 * Which layer an Escape keypress should close.
 *
 * One keypress closes exactly ONE layer, innermost/topmost first — never two
 * at once. The order below follows the panel's own z-index stack (about 41 >
 * guide 31 > picker 25 > drawer 21), so unwinding matches what the user sees
 * on screen. `about` (v0.7.3) is the ⓘ popover: it floats above everything,
 * so while it is up Escape closes it and touches nothing underneath.
 *
 * A focused input that already consumed the Escape (`defaultPrevented`) wins:
 * the control keeps the key and nothing closes. Returns `null` when there is
 * nothing to close.
 */
export function escapeTarget(layers: Record<BoardLayer, boolean>, event?: { defaultPrevented?: boolean }): BoardLayer | null {
  if (event?.defaultPrevented) return null
  if (layers.about) return 'about'
  if (layers.guide) return 'guide'
  if (layers.picker) return 'picker'
  if (layers.drawer) return 'drawer'
  return null
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
