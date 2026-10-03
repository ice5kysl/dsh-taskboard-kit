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
import type { BoardGrouping, TaskboardStore } from './store.ts'

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

// --------------------------------------------------------- keyboard navigation
// v0.7.4: `j` / `k` walk the board in VISUAL order and `Enter` opens the first
// card. Everything here is pure so node tests can drive the exact code path the
// panel's keydown listener uses — the DOM wiring itself (BoardPanel) is a thin
// dispatcher. ESC is deliberately NOT part of this: it keeps `escapeTarget`
// above as its single source of truth (one key, one layer), and adding a second
// Escape semantics here is exactly what the layering exists to prevent.

/** The slice of a KeyboardEvent the navigation rules read (tests pass literals). */
export interface KeyEventLike {
  key: string
  /** The event target: the focused element in a browser. */
  target?: unknown
  defaultPrevented?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /** True while an IME composition is in flight (pinyin etc.). */
  isComposing?: boolean
}

/** What a board-tab key press asks for; `null` = the key is not ours to take. */
export type BoardKeyIntent = { kind: 'step'; delta: 1 | -1 } | { kind: 'open' }

/**
 * The modal layers that OWN the keyboard while they are up. Note what is NOT
 * here: the task drawer. `j`/`k` with the drawer open is the whole point — the
 * drawer follows the selection. Only the create form (an unsaved draft), the
 * roster picker and the guide/about overlays take the keys away.
 */
export interface BoardKeyLayers {
  about?: boolean
  guide?: boolean
  picker?: boolean
  create?: boolean
}

/**
 * Whether a key event's target is a text control — `input` / `textarea` /
 * `[contenteditable]`. Those keep `j`, `k` and `Enter` for themselves: typing
 * into the comment box, the create form or the member search must never move
 * the board selection out from under the caret.
 *
 * Written against the element's shape (tagName + `isContentEditable`), not
 * against a DOM class, so the same predicate is callable from node tests.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown; getAttribute?: (name: string) => unknown }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if (el.isContentEditable === true) return true
  // A descendant of a contenteditable is covered by `isContentEditable` in the
  // browser; the attribute fallback keeps hand-built targets honest too.
  if (typeof el.getAttribute === 'function') {
    const attr = el.getAttribute('contenteditable')
    if (attr !== null && attr !== undefined && attr !== false && attr !== 'false') return true
  }
  return false
}

/**
 * Classify one `keydown` for the board tab.
 *
 * Returns `null` — "not ours, let the page have it" — when…
 *   • the target is a text control (`isTypingTarget`): focused inputs win, always;
 *   • a modal layer is up (about / guide / picker / create): the layer owns the key;
 *   • the event was already consumed (`defaultPrevented`), carries a modifier
 *     (⌘/Ctrl/Alt shortcuts are the OS's or the app's), or is mid-IME-composition.
 *
 * `Escape` never reaches here: it unwinds through `escapeTarget` (the panel's
 * own effects), so the layering has exactly one owner.
 */
export function boardKeyIntent(event: KeyEventLike, layers: BoardKeyLayers = {}): BoardKeyIntent | null {
  if (!event || typeof event.key !== 'string') return null
  if (isTypingTarget(event.target)) return null
  if (event.defaultPrevented) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (event.isComposing) return null
  if (layers.about || layers.guide || layers.picker || layers.create) return null
  if (event.key === 'j') return { kind: 'step', delta: 1 }
  if (event.key === 'k') return { kind: 'step', delta: -1 }
  if (event.key === 'Enter') return { kind: 'open' }
  return null
}

/**
 * Flatten the rendered lanes into the ids in VISUAL order: lane by lane, card
 * by card inside a lane. This is literally the DOM order the board paints —
 * 按进度 is 列序 × 列内序, 按负责人 is 泳道序 × 卡序 — so `j` moves the selection
 * the way the eye reads the screen. Lanes that are not rendered (the collapsed
 * 已关闭 strip) must not be passed in: a keypress cannot land on a card that is
 * not on screen.
 */
export function visualOrder(lanes: ReadonlyArray<ReadonlyArray<{ id: string }>>): string[] {
  const order: string[] = []
  for (const lane of lanes) for (const card of lane) order.push(card.id)
  return order
}

/** The board-tab view state `keyboardOrderFor` reads (a subset of TaskboardState). */
export interface KeyboardOrderInput {
  groupBy: BoardGrouping
  /** Whether the 已关闭 lane is expanded into a real lane (default: a strip). */
  showClosed: boolean
  /** The 按进度 lanes AS RENDERED (BOARD_COLUMNS order, each already sorted). */
  columns: ReadonlyArray<{ column: BoardColumn; tasks: ReadonlyArray<{ id: string }> }>
  /** The 按负责人 lanes AS RENDERED (groupByOwner order). */
  groups: ReadonlyArray<{ tasks: ReadonlyArray<{ id: string }> }>
}

/**
 * The card ids `j` / `k` walk for one view state, in visual order.
 *
 * Derived from the very lanes the board renders, so the walk can never drift
 * from what is on screen — and two cases are excluded on purpose:
 *   • the collapsed 已关闭 strip: those cards are NOT painted, and a keypress
 *     may not land on a card nobody can see;
 *   • the 统计 view: it renders no cards at all, so there is nowhere to walk.
 */
export function keyboardOrderFor(input: KeyboardOrderInput): string[] {
  if (input.groupBy === 'stats') return []
  if (input.groupBy === 'owner') return visualOrder(input.groups.map((group) => group.tasks))
  return visualOrder(
    input.columns
      .filter(({ column }) => column !== 'closed' || input.showClosed)
      .map(({ tasks: lane }) => lane),
  )
}

/**
 * The id one `j` (+1) / `k` (-1) step lands on, or `null` when there is nowhere
 * to go (an empty board is a no-op, never an error).
 *
 * Boundaries do NOT wrap: `k` on the first card stays on it, `j` on the last
 * stays on it. With nothing selected, `j` enters the list at the top and `k` at
 * the bottom — the direction the key moves. A selection that is not in the
 * current order (the card was filtered away, or the view changed under it) is
 * treated as "nothing selected" rather than snapping to a neighbour, so a stale
 * selection can never drag the highlight to an unrelated card.
 */
export function stepSelection(order: readonly string[], currentId: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null
  const at = currentId === null ? -1 : order.indexOf(currentId)
  if (at < 0) return delta > 0 ? order[0]! : order[order.length - 1]!
  const next = at + delta
  if (next < 0 || next >= order.length) return order[at]!
  return order[next]!
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
