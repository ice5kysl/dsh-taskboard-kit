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
import { ensureTaskboardStyles } from './theme.ts'

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
export { BoardPanel, DetailDrawer } from './BoardPanel.tsx'
export { taskRef, taskRefTitle, displayTitle, currentHolder, holderActionLabel } from './BoardPanel.tsx'
// T-37（v0.7.4）：滚入视口的"要不要滚"判定 + 可滚动祖先的可见矩形（可注入，
// 纯对象链即可 node 单测）。
export { scrollAncestorBoxes } from './BoardPanel.tsx'
// 0.7.3：持球记号 + 持球行 tooltip 只此一处 —— mini 抽屉与卡面/抽屉共用同一套语言。
export { HOLDER_MARKS, holderTitle } from './BoardPanel.tsx'
// T-42 第 5 条：卡面记号图例（`?` 指南里的对照表）—— 纯函数，node 单测直接钉住
// 「每个真正会渲染的记号都在图例里」。
export { markLegend } from './BoardPanel.tsx'
export type { MarkLegendRow } from './BoardPanel.tsx'
// 0.7.3：「关于」浮层的纯内容（版本回落 / 四个外链 / 本地透明度事实），可 node 单测。
export {
  ABOUT_VERSION_RAW, TB_VERSION, aboutVersion, aboutVersionLabel, aboutFacts,
  aboutLinks, aboutTagline, aboutLocalNote, PLUGIN_ID,
  REPO_URL, ISSUES_URL, COLLAB_URL, CHANGELOG_URL, AUTHOR, AUTHOR_URL, LICENSE,
} from './about.ts'
export type { AboutFact, AboutFactsInput, AboutLink } from './about.ts'
// T-29：抽屉 v2 的派生全部是纯函数（可 node 单测），一并从包里导出。
export {
  drawerActions, drawerProps, assigneeChoices, milestoneTags, tasksWithTag,
  unseenActivity, detailNeedsFold,
} from './BoardPanel.tsx'
export type { DrawerAction, ActionRow, DrawerProp, AssigneeChoice, AssigneeChoices } from './BoardPanel.tsx'
export { MiniBoardButton, MiniBoardDrawer } from './MiniBoard.tsx'
export { createBridgeClient } from './api.ts'
export { createTaskboardStore, getTaskboardStore } from './store.ts'
export { TB_CSS, TB_TOOLBAR, CLIENT_PLUGIN_ID, CSS_TAG_ID, ensureTaskboardStyles } from './theme.ts'
export { columnOf, compareTasks, isTerminalStatus, needsSettling, TERMINAL_STATUS } from '../shared/types.ts'
export { planDrop } from '../shared/dnd.ts'
export type { DropOp } from '../shared/dnd.ts'
export { knownActors } from './actors.ts'
// T-29：抽屉读的板级派生（同一个 stalenessOf / ageLabel），导出以便不变量测试直接对齐口径。
export { ageLabel, isQuietActor } from './BoardPanel.tsx'
export { stalenessOf, ageInColumnMs, columnSince, DEFAULT_QUIET_MS } from '../shared/board.ts'
export { conventionSnippet, dispatchSnippet, guideProjectDir, hookSnippetClaude, hookSnippetKimi } from './guide.ts'
export { renderMarkdown } from './markdown.ts'
export { openTaskCount, runPlanOps, groupByOwner, isFinal, escapeTarget, UNASSIGNED_KEY } from './view.ts'
// T-38（v0.7.4）：导航区的降级判定是纯函数（阈值 / 身份段取舍顺序 / 每档留什么），
// 导出以便 node 单测直接钉住三档边界与"哪一档在位的控件集合"。
export { toolbarModeFor, toolbarPlanFor, TOOLBAR_FULL_MIN, TOOLBAR_COMPACT_MIN, TOOLBAR_VIEWS_MIN, TOOLBAR_IDENTITY_DROP_ORDER } from './view.ts'
export type { ToolbarMode, ToolbarPlan, ToolbarIdentityPart } from './view.ts'
// T-36（v0.7.4）：键盘导航的判定与走位全是纯函数（焦点守卫 / 视觉顺序 / 边界），
// 导出以便 node 单测直接跑面板真正用的那条判定路径。
export { boardKeyIntent, isTypingTarget, stepSelection, visualOrder, keyboardOrderFor } from './view.ts'
export type { BoardKeyIntent, BoardKeyLayers, KeyEventLike, KeyboardOrderInput } from './view.ts'
// T-37（v0.7.4）：选中卡滚入视口的可见性判定 + 滚动选项（纯函数，可 node 单测）。
export { isVisibleIn, revealIntoView, REVEAL_MARGIN, REVEAL_SCROLL_OPTIONS } from './view.ts'
export type { RevealBox, RevealTargetLike } from './view.ts'
export { StatsView } from './StatsView.tsx'
export {
  headline, byStatus, byPriority, byOwner, flow, dwellByColumn, actionsByActor,
  valueByOwner, totalValue, columnEnteredAt, timeInColumnMs, dayKey, daySeries,
  todayKey, durationText, percentText,
  // T-28：时间窗 / 环比 / 持球人 / 异常 / 价值度 / 里程碑 / 坐标轴
  windowBounds, statusAt, kpis, holderGroups, holderIsQuiet, anomalies, valueView,
  milestones, isMilestoneTag, niceAxis, WINDOW_CHOICES, DEFAULT_WINDOW_DAYS,
  MIN_TREND_SAMPLES, MILESTONE_TAG,
} from './stats.ts'
export type {
  Headline, Slice, OwnerStat, DayFlow,
  WindowDays, WindowOptions, WindowBounds, KpiKey, KpiUnit, Kpi, KpiSet,
  HolderGroup, HolderActionBucket, Anomaly, AnomalyKind, ValueView, Milestone,
} from './stats.ts'
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

  // One package-owned <head> tag before any surface can render. It is NOT a
  // React-rendered <style>: the dsh client module loader claims every untagged
  // <style> in the document for whichever plugin materializes next and deletes
  // it on that plugin's unload — which silently stripped the status-bar pill
  // down to a UA <button> (T-15). See ensureTaskboardStyles.
  ensureTaskboardStyles()

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

