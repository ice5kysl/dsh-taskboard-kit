/**
 * dsh-taskboard-kit — browser (client) face.
 *
 * Three official seams, one shared store:
 *
 *  1. `conversation.view` (list/session) — a「看板」view tab registered after
 *     the shipped chat (0), trajectory (10), files (20) and the msg9 messages
 *     tab (30), so the session header reads 对话 | 轨迹 | 文件 | 消息 | 看板.
 *     While active, the session body is the six-lane kanban of the current
 *     session's workspace.
 *  2. `conversation.composer.dock` (list/session) — the entry: a quiet pill
 *     floated into the right end of the shipped stats row (「3 轮 73 步 ·
 *     262 tok/s · …」is this dock's order-0 entry 'stats', a centered row).
 *     Its residency in the composer is also what drives the store's cwd
 *     tracking when the 看板 tab is never opened.
 *  3. `shell.overlay` (list/root) — the mini board drawer: a full-height
 *     right-edge side drawer over the frame. The layer portals to body, so
 *     the drawer re-inherits the theme tokens itself (MiniBoard.tsx).
 *
 * The page-wide store keeps the board fresh with a low-frequency poll of
 * `/dsh-taskboard/board` (15s, only while the page is visible).
 *
 * Registered by the same Loader entry as the host face, and only ever executed
 * in the browser cordis tree (the package's `./client` export).
 *
 * @module dsh-taskboard-kit/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { BoardPanel } from './BoardPanel.tsx'
import { L } from './locale.ts'
import { MiniBoardButton, MiniBoardDrawer } from './MiniBoard.tsx'
import { getTaskboardStore } from './store.ts'

export const name = 'taskboard-kit'
export const inject = ['slots'] as const

/** The conversation view id (also used as the tab label key). */
export const TASKBOARD_VIEW_ID = 'taskboard'
/** The composer-side mini board slot ids (entry button + floating drawer). */
export const MINI_ENTRY_ID = 'taskboard-mini-entry'
export const MINI_OVERLAY_ID = 'taskboard-mini'

// Re-exported so the built bundle can be driven directly by tests (and reused
// by another client plugin): the store, the components, the bridge, and the
// shared board math.
export { BoardPanel } from './BoardPanel.tsx'
export { taskRef } from './BoardPanel.tsx'
export { MiniBoardButton, MiniBoardDrawer } from './MiniBoard.tsx'
export { createBridgeClient } from './api.ts'
export { createTaskboardStore, getTaskboardStore } from './store.ts'
export { columnOf, compareTasks } from '../shared/types.ts'
export { planDrop } from '../shared/dnd.ts'
export type { DropOp } from '../shared/dnd.ts'
export { knownActors } from './actors.ts'
export { conventionSnippet, dispatchSnippet, guideProjectDir, hookSnippetClaude, hookSnippetKimi } from './guide.ts'
export { renderMarkdown } from './markdown.ts'
export { openTaskCount, runPlanOps, groupByOwner, isFinal, escapeTarget, UNASSIGNED_KEY } from './view.ts'
export type { BoardLayer, OwnerGroup } from './view.ts'
export { L } from './locale.ts'
export type { BridgeClient } from './api.ts'
export type { BoardGrouping, TaskboardState, TaskboardStore, StoreOptions } from './store.ts'

/** Minimal service faces this plugin consumes (typed locally at the boundary). */
interface SlotsLike {
  inject(slot: string, cb: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): () => void
}
interface ClientCtxLike {
  logger(name: string): { info(...parts: unknown[]): void }
  effect(fn: () => (() => void) | void, name?: string): void
  slots: SlotsLike
}

export function apply(raw: Context): void {
  const ctx = raw as unknown as ClientCtxLike
  const log = ctx.logger('taskboard-kit:client')
  const store = getTaskboardStore()

  // Keep the board warm before the view is ever opened (no cwd → no-op).
  ctx.effect(() => store.start(), 'taskboard-kit: board poller')

  // The「看板」view tab: order 40 renders right after messages (30); the
  // header tab strip lists conversation.view entries automatically, and the
  // body renders only the active entry (官方 `only: <active id>` 机制).
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      name: 'conversation.view',
      id: TASKBOARD_VIEW_ID,
      order: 40,
      label: () => L('看板', 'Board'),
      inject: () => ({ store }),
    },
    BoardPanel,
  ))

  // The status-bar entry: a quiet pill riding the stats row inline (order 40,
  // right after the shipped stats entries — not pinned to the frame's edge).
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    {
      name: 'conversation.composer.dock',
      id: MINI_ENTRY_ID,
      order: 40,
      label: () => L('看板', 'Board'),
      inject: () => ({ store }),
    },
    MiniBoardButton,
  ))

  // The mini board drawer: shell.overlay is the frame-wide floating layer
  // (portal'd to body; the drawer re-inherits theme tokens itself).
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: MINI_OVERLAY_ID,
      order: 40,
      label: () => L('看板', 'Board'),
      inject: () => ({ store }),
    },
    MiniBoardDrawer,
  ))

  log.info('taskboard-kit browser face ready (conversation view + status-bar mini board)')
}

