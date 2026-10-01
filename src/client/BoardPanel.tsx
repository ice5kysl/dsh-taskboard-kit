/**
 * The taskboard kanban view, registered as a「看板」session view tab next to
 * 对话 | 轨迹 | 文件 | 消息 (`conversation.view`, order 40).
 *
 * Layout: a top bar (workspace, task count, guide, refresh, new task) above
 * the six swim-lane columns (待认领 / 已指派 / 进行中 / 待审核 / 已完成 / 已关闭
 * from the contract's BOARD_COLUMNS); 已关闭 renders collapsed as a narrow
 * vertical strip on the right edge until clicked (store.showClosed). The「?
 * 指南」top-bar button opens a centered in-panel guide overlay — what the
 * board is, how humans drive it, copyable templates for getting kimi /
 * Claude Code on board, and self-monitoring hook configs so those agents
 * check the board unprompted (guide.ts). Cards carry a ref (#N), a priority
 * dot and a 价值度 badge (◆½…◆8), and are HTML5-draggable between lanes — a
 * drop compiles into the shared `planDrop` op sequence, never a hand-rolled
 * status mapping; a drop on 已指派 opens the lane's roster picker (no prompt,
 * no typing — the roster comes from the board itself, see actors.ts).
 * Clicking a card opens a 560px detail drawer that is absolutely positioned
 * INSIDE the panel (no portal — the shell's overlay layer would lose the
 * --dsw-alias-* theme tokens), tabbed into 详情 (read-only until 编辑 is hit;
 * the detail renders as sanitized markdown, markdown.ts), 评论 (same markdown
 * pipeline) and 动态 (the log timeline).
 *
 * It is a pure projection of the store (`useSyncExternalStore`) — every
 * action goes through `TaskboardStore`, so the model tools, the view and the
 * tests share one implementation of "load / create / claim / update".
 * Colors ride the shell's design tokens; interactive states are class-based
 * (TB_CSS is injected once into document.head by `ensureTaskboardStyles`), no
 * emoji glyphs anywhere.
 *
 * The root-height sync (`useRootHeightSync`) is the same host workaround the
 * msg9 panel ships: dsh web wraps the view body in an overflow-y:auto scroll
 * container, so height:100% resolves to nothing — we pin the root to the
 * scroll box's pixel height instead, which is what makes the per-column
 * vertical scroll and the in-panel drawer work at all.
 *
 * @module dsh-taskboard-kit/client-panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import {
  BOARD_COLUMNS,
  TASK_VALUES,
  columnOf,
  compareTasks,
  needsSettling,
  type Board,
  type BoardColumn,
  type Task,
  type TaskComment,
  type TaskEvent,
  type TaskPriority,
  type TaskValue,
  type WaitOn,
} from '../shared/types.ts'
import {
  DEFAULT_QUIET_MS,
  ageInColumnMs,
  resolveActor,
  stalenessOf,
  waitingOnHuman,
  type HealthIssue,
} from '../shared/board.ts'
import { planDrop, type DropOp } from '../shared/dnd.ts'
import { knownActors } from './actors.ts'
import { conventionSnippet, dispatchSnippet, guideProjectDir, hookSnippetClaude, hookSnippetKimi } from './guide.ts'
import { L } from './locale.ts'
import { renderMarkdown } from './markdown.ts'
import { StatsView } from './StatsView.tsx'
import type { BoardGrouping, TaskboardState, TaskboardStore } from './store.ts'
import {
  ACCENT,
  BG,
  BG_RAISED,
  BG_SUNK,
  BORDER,
  BORDER_STRONG,
  DANGER,
  DANGER_BG,
  DIM,
  FAINT,
  FG,
  HOVER_BG,
  LINK,
  MASK,
  PRIORITY_COLORS,
  TERTIARY,
  WARN,
  ensureTaskboardStyles,
} from './theme.ts'
import { columnLabel, escapeTarget, groupByOwner, priorityLabel, runPlanOps, taskRef, useSessionCwd, valueText, type OwnerGroup, type SessionListLike } from './view.ts'

// taskRef moved to view.ts (shared with the mini board); keep the export path.
export { taskRef } from './view.ts'

/** Props handed to the view: injected store + the standard slot shares. */
export interface BoardPanelProps {
  /** The page-wide store (injected). */
  store: TaskboardStore
  /** Leave the view (unused by conversation.view; kept for compatibility). */
  onBack?: () => void
  /** Current session list state; the view follows the selected session. */
  useSessions?: (selector: (state: SessionListLike) => unknown) => unknown
  /** Current session identity (0.1.7 session-scoped standard prop). */
  sessionId?: string
  /** Open the guide overlay on first render (tests drive the open state). */
  initialGuideOpen?: boolean
}

/** Drag-and-drop wiring the panel hands down to the lanes and their cards. */
interface LaneDnd {
  /** Id of the card currently being dragged (drives its translucent style). */
  dragId: string | null
  /** Lane under the pointer during a drag (drives the drop-target highlight). */
  overColumn: BoardColumn | null
  setDragId(id: string | null): void
  setOverColumn(column: BoardColumn | null): void
  /** A card was dropped on a lane: run the planned op sequence. */
  onDropTask(id: string, column: BoardColumn): void
}

// ------------------------------------------------------------------ helpers

/** 从 root 向上找第一个 computed overflowY 为 auto/scroll 的祖先。
 *  不写死宿主的 class 名，宿主改版也能活；找不到返回 null。
 *  computed 可注入，测试用纯对象链驱动（导出以便测试）。 */
export function findScrollParent(
  node: { parentElement: Element | null },
  computed: (el: Element) => { overflowY: string },
): Element | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflowY = computed(parent).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
  }
  return null
}

/** dsh web 把面板包在一个 overflow-y:auto 的滚动容器里——root 的 height:100%
 *  解析不到有效高度，面板按内容撑开后被宿主整体滚走（泳道滚动和抽屉定位全坏）。
 *  修：找到那个祖先，用 ResizeObserver + window resize + 宿主滚动把可用高度
 *  同步成 root 的 px 高度。返回 callback ref：卸载时自动清理。 */
function useRootHeightSync(): (node: HTMLDivElement | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null)
  return useCallback((node: HTMLDivElement | null) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    if (!node || typeof getComputedStyle !== 'function' || typeof window === 'undefined') return
    const found = findScrollParent(node, (el) => getComputedStyle(el))
    if (!found) return
    const box = found as HTMLElement
    const sync = (): void => {
      const rootTop = node.getBoundingClientRect().top
      const offsetInBox = rootTop - box.getBoundingClientRect().top + box.scrollTop
      const roomInBox = box.clientHeight - Math.max(0, offsetInBox)
      const roomInView = window.innerHeight - rootTop
      const height = Math.max(200, Math.min(roomInBox, roomInView))
      node.style.flex = '0 0 auto'
      node.style.height = `${height}px`
      node.style.maxHeight = `${height}px`
    }
    sync()
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(sync)
      observer.observe(box)
    }
    window.addEventListener('resize', sync)
    box.addEventListener('scroll', sync, { passive: true })
    cleanupRef.current = () => {
      observer?.disconnect()
      window.removeEventListener('resize', sync)
      box.removeEventListener('scroll', sync)
    }
  }, [])
}

/** `/very/long/workspace/path` → `workspace/path` (the last two segments). */
function shortPath(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || cwd
}

/** 「ui, kit，看板」→ ['ui', 'kit', '看板']：逗号/中文逗号/空白分隔，去空去重。 */
function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean))]
}

/** Log timeline timestamp: 刚刚 / 5 分钟前 / 3h ago … */
function relTime(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  if (minutes < 1) return L('刚刚', 'just now')
  if (minutes < 60) return L('{n} 分钟前', '{n}m ago', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return L('{n} 小时前', '{n}h ago', { n: hours })
  return L('{n} 天前', '{n}d ago', { n: Math.floor(hours / 24) })
}

function statusLabel(task: Task): string {
  return columnLabel(columnOf(task))
}

/**
 * Titles on a real board often carry their own id and owner — 「【kimi】 T-93 ·
 * iOS v2 M7 连接与推送」— which the card already renders as badges. Owner
 * request (2026-10-01): row 2 should be the TITLE, not title + redundant
 * bookkeeping. A prefix is stripped ONLY when it duplicates what this very card
 * already shows:
 *   · 【name】 when name is this card's assignee or creator — never some other
 *     actor (「【kimi】」 on cc's card is information, not noise);
 *   · T-93 / #93 when the number is this card's own id.
 * Three passes, so 「【kimi】 T-93 · …」 collapses fully. Display-only: the board
 * is never mutated, and the original string stays in the card's tooltip.
 */
export function displayTitle(task: Task, _board?: Board | null): string {
  const n = task.id.replace(/^T-/, '')
  let title = task.title
  for (let pass = 0; pass < 3; pass += 1) {
    const before = title
    const boxed = /^\s*[【\[](?<who>[^】\]]{1,32})[】\]]\s*[·:：\-–—,]?\s*/.exec(title)
    if (boxed && (boxed.groups?.who === task.assignee || boxed.groups?.who === task.created_by || boxed.groups?.who === task.reviewer)) {
      title = title.slice(boxed[0].length)
    }
    // The id may sit behind a boxed prefix that is NOT redundant (an unassigned
    // card's 「【kimi】」 names the requester and stays) — 「【kimi】 T-93 · X」 must
    // still lose its redundant T-93.
    // Capture (and re-emit) any non-redundant boxed prefix, so this replacement
    // drops ONLY the id — 「【kimi】 T-93 · X」 → 「【kimi】 X」.
    const ref = new RegExp(`^(\\s*(?:[【\\[][^】\\]]{1,32}[】\\]]\\s*[·:：\\-–—,]?\\s*)?)(?:T-?|#)${n}\\s*[·:：\\-–—,]?\\s*`, 'i')
    if (ref.test(title)) title = title.replace(ref, '$1')
    if (title === before) break
  }
  return title.trim() || task.title
}

/**
 * The card's marks. Owner request 2026-10-01: 「卡上好多文字显得啰嗦」 — the
 * LABELS become marks, the DATA (ids, numbers, names) stays.
 *
 * 只用**文本呈现**的 Unicode 字形，绝不用 emoji：emoji 会被系统字体渲染成
 * 彩色位图、跟主题色打架、在不同平台大小不一，10px 的说明行会立刻散架。
 * 每个记号的含义都写在各自的 tooltip 里 —— 图标省的是重复的标签，不是信息。
 */
const MARK = {
  /** 负责人（跨阶段不变的责任人） */
  owner: '@',
  /** 创建者 */
  creator: '✎',
  /** 球在谁手上（持球人） */
  holder: '➤',
  /** 球在池子里（没人认领） */
  pool: '○',
  /** 等待某人（human / agent / external） —— 保留上一版的表盘字形 */
  wait: '◷',
  /** 等一个裁决 */
  decide: '⚑',
  /** 等一个收口 */
  settle: '⌂',
} as const

/** The four actions a card can owe, and who owes them. */
export type HolderAction = 'claim' | 'work' | 'answer' | 'reply' | 'decide' | 'settle'

export interface Holder {
  /** The actor the ball is with; null when nobody holds it (closed) or the
   *  card is unclaimed (the ball is in the pool). */
  who: string | null
  action: HolderAction
  /** Milliseconds the current holder has held the ball, when the board knows. */
  sinceMs?: number
}

/** 每个动作一个记号：提交 ➤ / 认领 ○ / 回复·回执 ◷ / 裁决 ⚑ / 收口 ⌂ */
const HOLDER_MARKS: Record<HolderAction, string> = {
  work: MARK.holder,
  claim: MARK.pool,
  answer: MARK.wait,
  reply: MARK.wait,
  decide: MARK.decide,
  settle: MARK.settle,
}

const HOLDER_ACTIONS: Record<HolderAction, [string, string]> = {
  claim: ['待认领', 'to claim'],
  work: ['待提交', 'to submit'],
  answer: ['待回复', 'to answer'],
  reply: ['待回执', 'to reply'],
  decide: ['待裁决', 'to decide'],
  settle: ['待收口', 'to settle'],
}

export function holderActionLabel(action: HolderAction): string {
  const pair = HOLDER_ACTIONS[action]
  return L(pair[0], pair[1])
}

/**
 * WHO HOLDS THE BALL — the one question a card must answer, and the only place
 * the answer lives (owner decision 2026-10-01).
 *
 * The board already moves the ball between stages — but it expresses that with
 * three different fields, so a reader had to combine four signals (assignee +
 * status + waiting_on + reviewer) and could easily combine them wrongly:
 *   · review:   assignee is FROZEN (the store refuses to reassign outside
 *               open/in_progress) while the verdict is owed by the reviewer;
 *   · waiting:  the assignee still owns the work, but the ball is with whoever
 *               must answer;
 *   · done:     the reviewer is cleared and the settle is owed by the creator.
 * In all three, 「当前处理人」 read literally points at the WRONG person.
 *
 * The derivation is total: every status yields exactly ONE holder (or none for
 * closed), which is what makes the ball *timable* — and therefore warnable
 * (a holder who has had it too long, a holder who has gone quiet).
 */
export function currentHolder(task: Task, board?: Board | null, now: number = Date.now()): Holder | null {
  if (task.status === 'closed') return null
  const since = (at?: string): number | undefined => {
    const ms = at ? Date.parse(at) : NaN
    return Number.isFinite(ms) ? Math.max(0, now - ms) : undefined
  }
  // A wait outranks everything: while a card is parked, the ball is with the
  // person who must answer — including a review that got stuck mid-verdict.
  if (task.waiting_on) {
    const who = task.waiting_on.who ?? null
    return {
      who,
      action: task.waiting_on.kind === 'human' ? 'answer' : 'reply',
      sinceMs: since(task.waiting_on.since),
    }
  }
  if (task.status === 'review') {
    const reviewer = task.reviewer ?? task.created_by
    return { who: reviewer, action: 'decide', sinceMs: since(lastEventAt(task, 'submitted')) }
  }
  if (task.status === 'done') {
    return { who: task.created_by, action: 'settle', sinceMs: since(lastEventAt(task, 'approved') ?? lastEventAt(task, 'done')) }
  }
  if (!task.assignee) return { who: null, action: 'claim' }
  return { who: task.assignee, action: 'work', sinceMs: since(lastEventAt(task, 'started') ?? lastEventAt(task, 'assigned') ?? lastEventAt(task, 'claimed')) }
}

/** The holder chip's tooltip: the full sentence behind the compact phrase. */
function holderTitle(task: Task, holder: Holder, reviewerQuiet: boolean): string {
  const parts: string[] = []
  if (holder.who === null) parts.push(L('还没有人认领这张卡', 'nobody has claimed this card yet'))
  else if (task.waiting_on) {
    parts.push(`${waitLabel(task.waiting_on)}${task.waiting_on.who ? ` (${task.waiting_on.who})` : ''}`)
    if (task.waiting_on.question) parts.push(task.waiting_on.question)
  } else if (holder.action === 'decide') {
    parts.push(reviewerQuiet
      ? L('{who} 欠这次审核，但花名册里它已久未活动', '{who} owes this review but has been quiet per the roster', { who: holder.who })
      : L('裁决人：{who}', 'reviewer: {who}', { who: holder.who }))
  } else if (holder.action === 'settle') {
    parts.push(L('已完成待收口，收口权在卡主 {who}', 'done and awaiting settle — the owner {who} closes it', { who: holder.who }))
  } else {
    parts.push(L('负责人：{who}', 'owner: {who}', { who: holder.who }))
  }
  if (holder.sinceMs !== undefined) parts.push(L('已 {age}', '{age} so far', { age: ageLabel(holder.sinceMs) }))
  return parts.join(' — ')
}

/** The most recent timestamp of one event type, if the log carries one. */
function lastEventAt(task: Task, event: TaskEvent): string | undefined {
  for (let i = task.log.length - 1; i >= 0; i -= 1) {
    const entry = task.log[i]
    if (entry && entry.event === event) return entry.at
  }
  return undefined
}

const EVENT_LABELS: Record<TaskEvent, [string, string]> = {
  created: ['创建', 'created'],
  assigned: ['指派', 'assigned'],
  claimed: ['认领', 'claimed'],
  started: ['开始', 'started'],
  stopped: ['停止', 'stopped'],
  submitted: ['提交审核', 'submitted'],
  approved: ['通过', 'approved'],
  rejected: ['打回', 'rejected'],
  done: ['完成', 'done'],
  reopened: ['重开', 'reopened'],
  closed: ['关闭', 'closed'],
  blocked: ['挂起等待', 'waiting'],
  unblocked: ['解除等待', 'released'],
  updated: ['更新', 'updated'],
}

function eventLabel(event: TaskEvent): string {
  const pair = EVENT_LABELS[event]
  return pair ? L(pair[0], pair[1]) : event
}

// ------------------------------------------------- collaboration derivations
// Thin, view-shaped wrappers over the shared derived math (src/shared/board.ts)
// plus the two labels only the browser face needs. Kept here (and re-imported
// by MiniBoard) so both surfaces read the same answer — never two opinions
// about what is late or who owes what.

/** '3d2h' / '5m' — compact duration, the host's ageLabel shape (duplicated
 *  locally on purpose: importing src/host would drag node built-ins into the
 *  browser bundle). */
export function ageLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 > 0 ? `${hours % 24}h` : ''}`
}

/** 「等人类 / 等 Agent / 等外部」 + who, for the card and drawer badges. */
export function waitLabel(waiting: WaitOn): string {
  const who = waiting.who ? ` ${waiting.who}` : ''
  switch (waiting.kind) {
    case 'human': return L('等人类{who}', 'waiting on human{who}', { who })
    case 'agent': return L('等 Agent{who}', 'waiting on agent{who}', { who })
    case 'external': return L('等外部{who}', 'waiting on external{who}', { who })
  }
}

/**
 * Has this actor gone quiet? Evidence, not a guess: the roster's
 * `last_seen_at` is the only source. An actor the roster has never heard of,
 * that has never touched the board, or that last acted longer than the quiet
 * window ago is quiet. HINT ONLY — the panel never reassigns on this.
 */
export function isQuietActor(board: Board | null, name: string | null | undefined, now: number = Date.now()): boolean {
  if (!board || !name) return false
  const entry = resolveActor(board, name)
  if (!entry || !entry.last_seen_at) return true
  const seen = Date.parse(entry.last_seen_at)
  return Number.isNaN(seen) || now - seen > DEFAULT_QUIET_MS
}

/** The waiting cards the HUMAN must look at (the strip's data source).
 *  `waitingOnHuman` covers every parked card; the human's list is only the
 *  ones actually parked on a human — 等 Agent / 等外部 belong to the agents. */
export function humanWaiting(board: Board | null, now: number = Date.now()): HealthIssue[] {
  if (!board) return []
  return waitingOnHuman(board, now).filter((issue) => issue.task.waiting_on?.kind === 'human')
}

// ------------------------------------------------------------------ panel

export function BoardPanel(props: BoardPanelProps): JSX.Element {
  const { store } = props
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const cwd = useSessionCwd(props)
  const rootHeightRef = useRootHeightSync()
  const [createOpen, setCreateOpen] = useState(false)
  // HTML5 drag-and-drop: the dragged card's id + the lane under the pointer.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<BoardColumn | null>(null)
  // A drop on 已指派 parks here while the roster picker waits for a name.
  const [assignPickerId, setAssignPickerId] = useState<string | null>(null)
  // The「? 指南」overlay.
  const [guideOpen, setGuideOpen] = useState(props.initialGuideOpen === true)

  // Follow the current session's workspace.
  useEffect(() => {
    store.setCwd(cwd ?? null)
  }, [store, cwd])

  // The stylesheet lives in <head>, owned by this package (never by React): a
  // mount re-asserts it, so a tag removed behind our back heals on the next
  // visit instead of leaving the whole panel unstyled (see ensureTaskboardStyles).
  useEffect(() => {
    ensureTaskboardStyles()
  }, [])

  // First paint / returning to the tab: make sure the board is fresh.
  useEffect(() => {
    void store.refresh()
  }, [store])

  // ESC aborts a pending assignment (no request fires). Held back while the
  // guide is up: that overlay owns the key first (escapeTarget's layer order).
  useEffect(() => {
    if (!assignPickerId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (escapeTarget({ guide: guideOpen, picker: true, drawer: false }, event) !== 'picker') return
      setAssignPickerId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [assignPickerId, guideOpen])

  // ESC closes the guide overlay (the topmost layer).
  useEffect(() => {
    if (!guideOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setGuideOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [guideOpen])

  const board = state.board
  const tasks = useMemo(() => (board ? Object.values(board.tasks) : []), [board])
  const actors = useMemo(() => (board ? knownActors(board) : []), [board])
  const columns = useMemo(
    () =>
      BOARD_COLUMNS.map((column) => ({
        column,
        tasks: tasks.filter((task) => columnOf(task) === column).sort(compareTasks),
      })),
    [tasks],
  )
  const selectedId = state.selectedId
  /** The「按负责人」lanes (only computed while that view is active). */
  const ownerGroups = useMemo(
    () => (state.groupBy === 'owner' && board ? groupByOwner(board, { includeClosed: state.includeClosed }) : []),
    [state.groupBy, state.includeClosed, board],
  )
  const selected: Task | null = selectedId && board ? board.tasks[selectedId] ?? null : null
  const pickerTask: Task | null = assignPickerId && board ? board.tasks[assignPickerId] ?? null : null
  // The human's own list: cards parked on a PERSON. (等 Agent / 等外部 are the
  // agents' business — they carry a card badge, not a place in this strip.)
  const waitingHuman = useMemo(() => humanWaiting(board), [board])
  /**
   * Approved-but-unsettled cards (v0.6): `done` is not terminal, so these still
   * need someone to close them out. They get their own strip because the whole
   * point of the two-step close is that finished work must not quietly rot in a
   * lane nobody feels responsible for.
   */
  const unsettled = useMemo(
    () => tasks.filter((task) => needsSettling(task)).sort(compareTasks),
    [tasks],
  )
  const drawerOpen = createOpen || selected !== null
  const closeDrawer = (): void => {
    setCreateOpen(false)
    store.select(null)
  }

  // ESC closes the right-hand drawer (the create form and the task detail),
  // matching the mini board's unwind: one layer at a time, innermost first.
  // The guide can sit on top of the drawer, so it swallows the first Escape
  // (its own effect above) while this one is held back by `guideOpen` — a
  // single keypress must never tear down two layers at once.
  // The drawer hosts real inputs, so the guard keeps ESC from stealing a key a
  // focused control already handled: such a control calls preventDefault and
  // the drawer stays put.
  useEffect(() => {
    if (!drawerOpen || guideOpen || assignPickerId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setCreateOpen(false)
      store.select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, guideOpen, assignPickerId, store])

  /**
   * Execute one shared `planDrop` op sequence in order through the store
   * (claim → store.claim, update → store.update with the patch). An empty
   * plan is a no-op (no request); a failed step surfaces through the store's
   * error channel and stops the sequence. Shared with the mini board via
   * view.ts (runPlanOps).
   */
  const runPlan = async (task: Task, ops: DropOp[]): Promise<void> => {
    if (ops.length === 0) return
    await runPlanOps(store, task.id, ops)
  }

  /**
   * One drop on a lane. Dropping on 已指派 never prompts: it opens the
   * in-column roster picker (assignPickerId) and the drop continues when the
   * user picks a name, chooses the pool, or aborts. Every other lane compiles
   * straight into its planDrop sequence.
   */
  const runDrop = async (id: string, target: BoardColumn): Promise<void> => {
    const task = tasks.find((row) => row.id === id)
    if (!task) return
    if (target === 'assigned') {
      setAssignPickerId(id)
      return
    }
    await runPlan(task, planDrop(task, target))
  }
  /** DnD wiring shared by the lanes and their cards. */
  const dnd: LaneDnd = {
    dragId,
    overColumn,
    setDragId,
    setOverColumn,
    onDropTask(id, column) {
      setDragId(null)
      setOverColumn(null)
      void runDrop(id, column)
    },
  }

  // No session selected (or the session share hasn't resolved one): say so —
  // the bare loading branch used to mask this as an endless「正在加载看板」,
  // because a null cwd never refreshes and never leaves status 'loading'.
  if (!state.cwd) {
    return (
      <div style={styles.root} ref={rootHeightRef}>
        <div style={styles.center}>
          <p style={styles.centerText}>{L('进入一个会话后，这里显示该工作区的看板。', 'Open a session to see its workspace board here.')}</p>
        </div>
      </div>
    )
  }

  if (state.status === 'loading' && !board) {
    return (
      <div style={styles.root} ref={rootHeightRef}>
        <div style={styles.center}>
          <p style={styles.centerText}>{L('正在加载看板…', 'Loading the board…')}</p>
        </div>
      </div>
    )
  }

  if (state.status === 'error' && !board) {
    return (
      <div style={styles.root} ref={rootHeightRef}>
        <div style={styles.center}>
          <p style={styles.errorText}>{L('无法读取看板：{error}', 'Cannot read the board: {error}', { error: state.error ?? '?' })}</p>
          <button type="button" className="tb-btn tb-btn-primary" onClick={() => void store.refresh()}>
            {L('重试', 'Retry')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.root} ref={rootHeightRef}>
      <TopBar state={state} store={store} total={tasks.length} onCreate={() => setCreateOpen(true)} onGuide={() => setGuideOpen(true)} />
      {state.error && (
        <div style={styles.noticeError}>
          <span style={styles.noticeText}>{state.error}</span>
          <button type="button" className="tb-iconbtn" onClick={() => store.clearError()} title={L('关闭', 'Dismiss')}>
            ×
          </button>
        </div>
      )}
      {waitingHuman.length > 0 && (
        <HumanStrip items={waitingHuman} state={state} store={store} />
      )}
      {unsettled.length > 0 && (
        <SettleStrip tasks={unsettled} store={store} />
      )}
      {!state.cwd ? (
        <div style={styles.center}>
          <p style={styles.centerText}>
            {L('没有选中的会话。打开一个会话后，这里显示它所在 workspace 的看板。', 'No session selected. Open a session to see its workspace board here.')}
          </p>
        </div>
      ) : tasks.length === 0 ? (
        state.boardExists ? (
          // Board is ON but has no cards yet: an agent can already work here,
          // so the honest prompt is "create the first one".
          <div style={styles.center}>
            <p style={styles.centerText}>
              {L('看板已开启，还没有任务——让 Agent 用 taskboard_create 建一个，或点下面的按钮。', 'The board is on and has no cards yet — ask an agent to run taskboard_create, or use the button below.')}
            </p>
            <button type="button" className="tb-btn tb-btn-primary" onClick={() => setCreateOpen(true)}>
              {L('+ 新建任务', '+ New task')}
            </button>
          </div>
        ) : (
          <EnableBoardWizard
            cwd={state.cwd}
            boardFile={state.boardFile}
            cli={state.cli}
            busy={state.busy}
            onCreate={() => setCreateOpen(true)}
            onEnable={() => store.enableBoard()}
          />
        )
      ) : state.groupBy === 'stats' ? (
        <StatsView board={board} onOpenTask={(id) => store.select(id)} />
      ) : state.groupBy === 'owner' ? (
        <div style={styles.lanes}>
          <OwnerLanes
            groups={ownerGroups}
            state={state}
            onOpen={(id) => store.select(id)}
          />
        </div>
      ) : (
        <div style={styles.lanes}>
          {columns.map(({ column, tasks: list }) =>
            column === 'closed' && !state.showClosed ? (
              // The closed column defaults to a narrow strip (still a drop
              // target); a click expands it into a full lane.
              <ClosedStrip key={column} count={list.length} dnd={dnd} onExpand={() => store.setShowClosed(true)} />
            ) : (
              <ColumnView
                key={column}
                column={column}
                tasks={list}
                state={state}
                store={store}
                onCreate={() => setCreateOpen(true)}
                dnd={dnd}
                onCollapse={column === 'closed' ? () => store.setShowClosed(false) : undefined}
                overlay={
                  column === 'assigned' && pickerTask ? (
                    <AssignPicker
                      actors={actors}
                      current={pickerTask.assignee}
                      onPick={(name) => {
                        const task = pickerTask
                        setAssignPickerId(null)
                        void runPlan(task, planDrop(task, 'assigned', name))
                      }}
                      onPool={() => {
                        const task = pickerTask
                        setAssignPickerId(null)
                        void runPlan(task, planDrop(task, 'pool'))
                      }}
                      onCancel={() => setAssignPickerId(null)}
                    />
                  ) : undefined
                }
              />
            ),
          )}
        </div>
      )}
      {pickerTask && <div style={styles.backdrop} onClick={() => setAssignPickerId(null)} />}
      {drawerOpen && (
        <>
          <div style={styles.backdrop} onClick={closeDrawer} />
          {createOpen ? (
            <CreateForm state={state} store={store} actors={actors} onClose={() => setCreateOpen(false)} />
          ) : (
            selected && <DetailDrawer key={selected.id} task={selected} state={state} store={store} actors={actors} onClose={() => store.select(null)} />
          )}
        </>
      )}
      {guideOpen && (
        <GuideOverlay
          cli={state.cli}
          cwd={guideProjectDir(state.boardFile, state.cwd)}
          boardFile={state.boardFile}
          onClose={() => setGuideOpen(false)}
        />
      )}
    </div>
  )
}

/** Top bar: title, workspace, count, view switch, refresh, guide, new task. */
function TopBar({ state, store, total, onCreate, onGuide }: { state: TaskboardState; store: TaskboardStore; total: number; onCreate(): void; onGuide(): void }): JSX.Element {
  return (
    <header style={styles.topbar}>
      <span style={styles.topbarTitle}>{L('看板', 'Board')}</span>
      {state.cwd && (
        <span style={styles.topbarPath} title={state.cwd}>
          {shortPath(state.cwd)}
        </span>
      )}
      <span style={styles.topbarCount}>{L('{n} 个任务', '{n} tasks', { n: total })}</span>
      <span style={styles.topbarSpacer} />
      <ViewSwitch mode={state.groupBy} onSwitch={(mode) => store.setGroupBy(mode)} />
      {state.groupBy === 'owner' && (
        <label style={styles.doneToggle} title={L('负责人视角默认只显示未结清的任务（已完成但未收口的仍会显示）', 'The owner view hides settled tasks; finished-but-unsettled ones still show')}>
          <input
            type="checkbox"
            checked={state.includeClosed}
            onChange={(event) => store.setIncludeClosed(event.target.checked)}
          />
          {L('含已关闭', 'Include closed')}
        </label>
      )}
      <button type="button" className="tb-iconbtn" onClick={onGuide} title={L('使用指南', 'Guide')}>
        ?
      </button>
      <button type="button" className="tb-iconbtn" onClick={() => void store.refresh()} title={L('刷新', 'Refresh')}>
        ↻
      </button>
      <button type="button" className="tb-btn tb-btn-primary" onClick={onCreate}>
        {L('+ 新建任务', '+ New task')}
      </button>
    </header>
  )
}

/**
 * The board's two groupings, as a segmented control: 按进度 (the six status
 * lanes) and 按负责人 (one lane per owner). Both render the same data with the
 * same cards — switching only re-groups, so nothing is lost or refetched.
 */
function ViewSwitch({ mode, onSwitch }: { mode: BoardGrouping; onSwitch(mode: BoardGrouping): void }): JSX.Element {
  // Two groups, separated by a rule: 逐卡 (the two lane views, which render the
  // cards) and 宏观 (stats, which renders numbers). The split is not cosmetic —
  // you pick within a group to change how the SAME cards are arranged, and
  // across groups to change what you are looking at entirely.
  const groups: Array<Array<{ value: BoardGrouping; label: string; title: string }>> = [
    [
      { value: 'column', label: L('按进度', 'By status'), title: L('按状态分列：待认领 / 已指派 / 进行中 / 待审核 / 待收口 / 已结清', 'Lanes by status: pool / assigned / in progress / in review / to settle / settled') },
      { value: 'owner', label: L('按负责人', 'By owner'), title: L('按负责人分列，看清每个人头上挂了哪些任务', 'Lanes by owner — what is on each person\'s plate') },
    ],
    [
      { value: 'stats', label: L('统计', 'Stats'), title: L('宏观统计：现状、每日流量、分布、负责人负载与周期', 'The macro read: current state, daily flow, distributions, per-owner load and cycle time') },
    ],
  ]
  return (
    // Two SEPARATE boxes, not one box with a rule inside it: a rule between two
    // segments of the same pill is indistinguishable from the segment borders,
    // which is exactly how it read before. A real gap makes the grouping obvious.
    <div style={styles.viewSwitch} role="tablist" aria-label={L('看板视角', 'Board view')}>
      {groups.map((group) => (
        <div key={group[0]!.value} style={styles.segGroup} role="group">
          {group.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={mode === option.value}
              className={mode === option.value ? 'tb-seg active' : 'tb-seg'}
              style={mode === option.value ? { ...styles.seg, ...styles.segActive } : styles.seg}
              title={option.title}
              onClick={() => onSwitch(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The「开启看板」wizard — what a workspace sees before its board exists.
 *
 * Before this, an unopened workspace showed "no tasks yet", which is a lie of
 * omission: the board file does not exist, so NO agent can use it, and the
 * reader was told to "ask an agent to create a task" — advice that cannot work
 * because the agent has no board to write to. The two states are genuinely
 * different and now look different:
 *
 *   • 未开启 (boarnd file absent) — this wizard: turn it on, in one click.
 *   • 已开启但为空 (board exists, zero tasks) — the plain "create the first
 *     task" prompt, because an agent CAN work here now.
 *
 * "On" writes two things and says so, because both are load-bearing: the board
 * file (the agent's data) and the workspace protocol doc (the agent's rules).
 */
function EnableBoardWizard({
  cwd,
  boardFile,
  cli,
  busy,
  onCreate,
  onEnable,
}: {
  cwd: string | null
  boardFile: string | null
  cli: string | null
  busy: boolean
  onCreate(): void
  onEnable(): Promise<{ boardFile: string; protocolFile: string | null; alreadyExisted: boolean } | null>
}): JSX.Element {
  const [result, setResult] = useState<{ boardFile: string; protocolFile: string | null; alreadyExisted: boolean } | null>(null)
  const projectDir = guideProjectDir(boardFile, cwd)

  const enable = async (): Promise<void> => {
    if (busy) return
    const outcome = await onEnable()
    if (outcome) setResult(outcome)
  }

  if (result) {
    return (
      <div style={styles.center}>
        <div style={styles.wizard}>
          <h3 style={styles.wizardTitle}>{L('看板已开启', 'Board is on')}</h3>
          <p style={styles.wizardText}>
            {result.alreadyExisted
              ? L('这个工作区本来就有看板，我没有动它已用的数据。', 'This workspace already had a board — I left its data untouched.')
              : L('已为这个工作区建好看板。', 'Created the board for this workspace.')}
          </p>
          <ul style={styles.wizardFiles}>
            <li style={styles.wizardFile}>
              <span style={styles.wizardFileLabel}>{L('看板数据', 'Board data')}</span>
              <code style={styles.wizardCode} title={result.boardFile}>.dsh/taskboard.json</code>
            </li>
            <li style={styles.wizardFile}>
              <span style={styles.wizardFileLabel}>{L('工作区规范', 'Rules')}</span>
              {result.protocolFile
                ? <code style={styles.wizardCode} title={result.protocolFile}>.dsh/BOARD-PROTOCOL.md</code>
                : <span style={styles.wizardMuted}>{L('已存在，保持原样（不会覆盖）', 'already present — left as-is (never overwritten)')}</span>}
            </li>
          </ul>
          <p style={styles.wizardText}>
            {L(
              '现在 Agent 可以按规范用了：会话开始会拿到自己那一份待办，动手前先占位，做完交审核，审核通过后收口。',
              'Agents can use the board now: each session starts with its own slice of work, claims before starting, hands off for review, and settles after approval.',
            )}
          </p>
          <div style={styles.wizardActions}>
            <button type="button" className="tb-btn tb-btn-primary" onClick={onCreate}>
              {L('+ 新建第一张卡', '+ Create the first card')}
            </button>
            <button type="button" className="tb-btn" onClick={() => setResult(null)}>
              {L('返回', 'Back')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.center}>
      <div style={styles.wizard}>
        <h3 style={styles.wizardTitle}>{L('这个工作区还没开启看板', 'The board is not on for this workspace')}</h3>
        <p style={styles.wizardText}>
          {L(
            '开启后 Agent 就能按规范协作：会话开始先看自己那一份待办、动手前占位、做完交审核、审核过后收口。',
            'Once on, agents collaborate by the protocol: each session starts with its own slice, claims before working, hands off for review, and settles after approval.',
          )}
        </p>
        <ul style={styles.wizardFiles}>
          <li style={styles.wizardFile}>
            <span style={styles.wizardFileLabel}>{L('会创建', 'Will create')}</span>
            <code style={styles.wizardCode} title={`${projectDir}/.dsh/taskboard.json`}>.dsh/taskboard.json</code>
            <span style={styles.wizardMuted}>{L('看板数据', 'board data')}</span>
          </li>
          <li style={styles.wizardFile}>
            <span style={styles.wizardFileLabel}>{L('会创建', 'Will create')}</span>
            <code style={styles.wizardCode} title={`${projectDir}/.dsh/BOARD-PROTOCOL.md`}>.dsh/BOARD-PROTOCOL.md</code>
            <span style={styles.wizardMuted}>{L('协作规范', 'protocol')}</span>
          </li>
        </ul>
        <p style={styles.wizardMuted}>
          {L('两者都已存在时不会覆盖任何东西。', 'Neither is overwritten if it already exists.')}
        </p>
        <div style={styles.wizardActions}>
          <button type="button" className="tb-btn tb-btn-primary" disabled={busy} onClick={() => void enable()}>
            {busy ? L('开启中…', 'Turning on…') : L('开启看板', 'Turn the board on')}
          </button>
          <button type="button" className="tb-btn" disabled={busy} onClick={onCreate}>
            {L('只想先建一张卡', 'Just create a card')}
          </button>
        </div>
        <code style={styles.wizardCli} title={L('这个工作区', 'This workspace')}>{projectDir}</code>
      </div>
    </div>
  )
}

/**
 * The「待收口」strip: cards that are `done` but not yet settled.
 *
 * v0.6 made `done` non-terminal, which introduces a new way for the board to
 * rot — a card everyone agrees is finished, that nobody feels owns the closing
 * step. This strip is the answer: it lists them at the top with a one-click
 * settle, so "approved" and "actually closed out" cannot silently diverge.
 */
function SettleStrip({ tasks, store }: { tasks: Task[]; store: TaskboardStore }): JSX.Element {
  return (
    <section style={styles.settleStrip} className="tb-settle-strip">
      <div style={styles.humanHead}>
        <span style={styles.settleTitle}>{L('✔ {n} 张卡已完成、待收口', '✔ {n} card(s) done, awaiting settle', { n: tasks.length })}</span>
        <span style={styles.humanHint}>
          {L('已完成 ≠ 结清：收口后卡才会离开活跃视图。不做了也走收口，但请在备注里写明原因。', 'Done ≠ settled: a card leaves the active view only once closed. Not doing it after all? Settle it too — but say why in the note.')}
        </span>
      </div>
      <ul style={styles.humanList}>
        {tasks.map((task) => (
          <li key={task.id} style={styles.settleRow}>
            <button type="button" className="tb-link" style={styles.settleRef} onClick={() => store.select(task.id)} title={L('打开详情', 'Open details')}>
              {taskRef(task.id)}
            </button>
            <span style={styles.settleTitleText}>{task.title}</span>
            {task.assignee && <span style={styles.humanMeta}>{task.assignee}</span>}
            <span style={styles.topbarSpacer} />
            <button
              type="button"
              className="tb-btn tb-btn-primary"
              onClick={() => void store.update({ id: task.id, action: 'close' })}
              title={L('结清这张卡', 'Settle this card')}
            >
              {L('收口', 'Settle')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The human's strip — the one surface on this board that speaks to the person
 * instead of to an agent. It exists because "在等人类决定" used to be
 * indistinguishable from "待认领": a card parked on a person is not work
 * anyone can pick up, and it must not rot unnoticed in a lane.
 *
 * Every row lists the card, who is waiting, how long, and the FULL question
 * verbatim — it has to be answerable without opening anything. The row's main
 * button opens the card's drawer; 回复 unfolds an inline answer box that posts
 * the answer as a comment and then releases the wait (comment → unblock, in
 * that order), so the waiting agent is told the answer and the card leaves
 * this list in one gesture.
 */
function HumanStrip({ items, state, store }: { items: HealthIssue[]; state: TaskboardState; store: TaskboardStore }): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const busy = state.busy

  const answer = async (id: string): Promise<void> => {
    const text = (drafts[id] ?? '').trim()
    if (!text || busy) return
    // The store owns the two-step write (comment → unblock, in that order) so
    // the panel, the tests and any future surface share one implementation.
    if (await store.answerWaiting(id, text)) {
      setDrafts((prev) => ({ ...prev, [id]: '' }))
      setExpandedId(null)
    }
  }

  return (
    <section style={styles.humanStrip} className="tb-human-strip">
      <div style={styles.humanHead}>
        <span style={styles.humanTitle}>{L('◷ {n} 张卡在等你决定', '◷ {n} card(s) waiting on you', { n: items.length })}</span>
        <span style={styles.humanHint}>
          {L('回答后点「回复并解除等待」——留言入档并解除挂起，等你的 Agent 会收到通知。', 'Answer and hit 回复并解除等待 — the reply joins the thread, the wait is released, and the waiting agent is notified.')}
        </span>
      </div>
      <ul style={styles.humanList}>
        {items.map((issue) => {
          const task = issue.task
          const waiting = task.waiting_on
          if (!waiting) return null
          const open = expandedId === task.id || state.selectedId === task.id
          const overdue = stalenessOf(task).waitOverdue
          const draft = drafts[task.id] ?? ''
          return (
            <li key={task.id} style={styles.humanItem}>
              <div style={styles.humanItemHead}>
                <button type="button" className="tb-human-card" onClick={() => store.select(task.id)} title={task.title}>
                  <span style={styles.humanRef}>{taskRef(task.id)}</span>
                  <span style={styles.humanItemTitle}>{task.title}</span>
                </button>
                <span style={styles.humanMeta}>
                  {L('等 {who} · 已等 {age}', 'waiting on {who} · {age}', {
                    who: waiting.who ?? L('人类', 'human'),
                    age: ageLabel(issue.ageMs),
                  })}
                </span>
                {overdue && (
                  <span style={styles.humanOverdue} title={L('等待已超过升级阈值', 'the wait passed its escalation threshold')}>
                    {L('已超时', 'overdue')}
                  </span>
                )}
                <button type="button" className="tb-btn" onClick={() => setExpandedId(open ? null : task.id)}>
                  {open ? L('收起', 'Hide') : L('回复', 'Reply')}
                </button>
              </div>
              <div style={styles.humanQuestion} className="tb-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(waiting.question) }} />
              {open && (
                <div style={styles.humanComposer}>
                  <textarea
                    className="tb-textarea"
                    rows={2}
                    value={draft}
                    placeholder={L('写下你的决定或答复（会作为评论留在这张卡上）…', 'Write your decision or answer (it lands on this card as a comment)…')}
                    onChange={(event) => setDrafts((prev) => ({ ...prev, [task.id]: event.target.value }))}
                  />
                  <div style={styles.humanComposerFoot}>
                    <button
                      type="button"
                      className="tb-btn tb-btn-primary"
                      disabled={busy || !draft.trim()}
                      onClick={() => void answer(task.id)}
                    >
                      {busy ? L('提交中…', 'Sending…') : L('回复并解除等待', 'Reply & release')}
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** One swim lane: header (name + count + quick-add) above its sorted cards.
 *  The lane is also the drop target: dragOver highlights it (class-based,
 *  token colors), drop compiles into a planDrop sequence by the panel.
 *  `overlay` floats a card inside the lane (the assigned lane's roster
 *  picker after a drop). */
function ColumnView({
  column,
  tasks,
  state,
  store,
  onCreate,
  dnd,
  overlay,
  onCollapse,
}: {
  column: BoardColumn
  tasks: Task[]
  state: TaskboardState
  store: TaskboardStore
  onCreate(): void
  dnd: LaneDnd
  overlay?: ReactNode
  /** Given only for the expanded closed lane: folds it back into the strip. */
  onCollapse?: () => void
}): JSX.Element {
  return (
    <section
      style={styles.column}
      className={dnd.overColumn === column ? 'tb-column dragover' : 'tb-column'}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (dnd.overColumn !== column) dnd.setOverColumn(column)
      }}
      onDragLeave={(event) => {
        // Moving onto a child inside the same lane is not leaving the lane.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        dnd.setOverColumn(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        const id = event.dataTransfer.getData('text/plain')
        if (id) dnd.onDropTask(id, column)
      }}
    >
      <div style={styles.columnHead}>
        <span style={styles.columnTitle}>{columnLabel(column)}</span>
        <span style={styles.columnCount}>{tasks.length}</span>
        <span style={styles.topbarSpacer} />
        {onCollapse && (
          <button type="button" className="tb-iconbtn" onClick={onCollapse} title={L('收起已关闭列', 'Collapse the closed column')}>
            ⇥
          </button>
        )}
        <button type="button" className="tb-iconbtn" onClick={onCreate} title={L('新建任务', 'New task')}>
          +
        </button>
      </div>
      <div style={styles.columnBody}>
        {tasks.length === 0 ? (
          <div style={styles.columnEmpty}>{L('（空）', '(empty)')}</div>
        ) : (
          tasks.map((task) => (
            <TaskCard key={task.id} task={task} board={state.board} selected={task.id === state.selectedId} onOpen={() => store.select(task.id)} dnd={dnd} busy={state.busy} />
          ))
        )}
      </div>
      {overlay}
    </section>
  )
}

/**
 * The「按负责人」lanes: one column per owner, so "每个人头上挂了哪些任务" is
 * answerable at a glance.
 *
 * Deliberately READ-ONLY: cards open their drawer, but the lanes are not drop
 * targets. Dragging between status lanes means "change status" (planDrop); a
 * drag between owner lanes would mean "reassign", a different verb with its
 * own picker flow — shipping half of it would make the same gesture do two
 * unrelated things depending on the view.
 *
 * The header carries the lane's meaning: nobody's plate (待认领), a real owner
 * (with a quiet dot when the roster says they have gone silent), and 等人类 —
 * the lane that answers "到底卡在谁那" when the owner is an agent waiting on you.
 */
function OwnerLanes({
  groups,
  state,
  onOpen,
}: {
  groups: OwnerGroup[]
  state: TaskboardState
  onOpen(id: string): void
}): JSX.Element {
  if (groups.length === 0) {
    return (
      <div style={styles.center}>
        <p style={styles.centerText}>
          {state.includeClosed
            ? L('这个板还没有任务。', 'This board has no tasks yet.')
            : L('没有未结清的任务。勾选「含已关闭」可以看到全部。', 'No unsettled tasks. Tick「Include closed」to see everything.')}
        </p>
      </div>
    )
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} style={styles.column} className="tb-column" data-lane={group.key}>
          <div style={styles.columnHead}>
            <span style={styles.columnTitle}>{ownerLabel(group)}</span>
            <span style={styles.columnCount}>{group.tasks.length}</span>
            {group.kind === 'actor' && group.quiet && (
              <span style={styles.quietDot} title={L('这个负责人很久没动静了', 'This owner has been quiet for a while')} />
            )}
            <span style={styles.topbarSpacer} />
            {group.kind === 'human' && (
              <span style={styles.laneHint} title={L('这些卡在等你决定——在上方「等你」条里可以直接回复', 'These are waiting on YOU — answer them in the「等你」strip above')}>
                {L('等你', 'you')}
              </span>
            )}
          </div>
          <div style={styles.columnBody}>
            {group.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                board={state.board}
                selected={task.id === state.selectedId}
                onOpen={() => onOpen(task.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

/** Lane header text for an owner group. */
function ownerLabel(group: OwnerGroup): string {
  switch (group.kind) {
    case 'unassigned': return L('待认领', 'Unassigned')
    case 'human': return L('等人类 · {name}', 'Waiting on human · {name}', { name: group.label })
    case 'actor': return group.label
  }
}

/** The collapsed closed column: a narrow vertical strip on the board's right
 *  edge. It stays a live drop target (a drop here = close the task); a click
 *  expands the lane. */
function ClosedStrip({ count, dnd, onExpand }: { count: number; dnd: LaneDnd; onExpand(): void }): JSX.Element {
  return (
    <button
      type="button"
      style={styles.closedStrip}
      className={dnd.overColumn === 'closed' ? 'tb-closed-strip tb-column dragover' : 'tb-closed-strip'}
      title={L('展开已关闭列', 'Expand the closed column')}
      onClick={onExpand}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (dnd.overColumn !== 'closed') dnd.setOverColumn('closed')
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        dnd.setOverColumn(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        const id = event.dataTransfer.getData('text/plain')
        if (id) dnd.onDropTask(id, 'closed')
      }}
    >
      <span style={styles.closedStripText}>{L('已关闭 ({n})', 'Closed ({n})', { n: count })}</span>
    </button>
  )
}

/** One task card: a compact meta row (priority dot · value badge · #N ref at
 *  the right end), then the full-width title row, then assignee badge, age,
 *  tags. Cards are the drag source: the task id rides dataTransfer, and the
 *  card turns translucent while it is being dragged.
 *
 *  Collaboration marks ride the card quietly (v0.5.4): the age badge counts
 *  time in the CURRENT column (creation time says nothing about the review
 *  lane), a faint dot appears once that age passes the column's SLA, and
 *  reviewer / waiting-on get their own badges — a card parked on a person must
 *  never look like a card anyone can pick up. */
function TaskCard({ task, board, selected, onOpen, dnd, busy }: { task: Task; board: Board | null; selected: boolean; onOpen(): void; dnd?: LaneDnd; busy?: boolean }): JSX.Element {
  const dragging = dnd?.dragId === task.id
  const now = Date.now()
  const staleness = stalenessOf(task, now)
  const waiting = task.waiting_on
  const reviewer = task.status === 'review' ? task.reviewer : null
  const reviewerQuiet = reviewer ? isQuietActor(board, reviewer, now) : false
  const holder = currentHolder(task, board)
  return (
    <button
      type="button"
      className={selected ? 'tb-card active' : 'tb-card'}
      style={{ opacity: dragging ? 0.5 : 1 }}
      // No `dnd` ⇒ the card is not a drag source. The「按负责人」view is a
      // projection of ownership, not a status board (see OwnerLanes). And a
      // mutation in flight (busy) suspends dragging too: a drop fired into
      // the busy gate used to vanish without a word (m12).
      draggable={dnd !== undefined && !busy}
      onDragStart={dnd === undefined ? undefined : (event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
        dnd.setDragId(task.id)
      }}
      onDragEnd={dnd === undefined ? undefined : () => {
        dnd.setDragId(null)
        dnd.setOverColumn(null)
      }}
      onClick={onOpen}
    >
      {/* Row 1 — the card's FIXED attributes on one 10px line: priority dot,
          #id, ◆value, status, creator … with the column age pinned right.
          Owner request 2026-10-01: attributes on top (caption-sized), title in
          the middle, everything that MOVES (owner / who owes / tags) at the foot. */}
      <div style={styles.cardMetaTop}>
        <span
          style={{ ...styles.dot, background: PRIORITY_COLORS[task.priority] ?? FAINT }}
          title={L('优先级：{p}', 'Priority: {p}', { p: priorityLabel(task.priority) })}
        />
        <span style={styles.cardRef} title={task.id}>{taskRef(task.id)}</span>
        {task.value != null && (
          <span style={styles.valueBadge} title={L('价值度 {v}', 'Value {v}', { v: valueText(task.value) })}>
            ◆{valueText(task.value)}
          </span>
        )}
        <span style={styles.cardStatus} title={L('状态：{s}', 'Status: {s}', { s: statusLabel(task) })}>
          {statusLabel(task)}
        </span>
        {/* 负责人 (accountable, stage-independent) — shown only when there IS
            one (the status already reads 待认领 otherwise: the same phrase twice
            is the redundancy the owner asked us to remove) — and the creator
            only when it is somebody else. Both are now a MARK + the name: the
            labels 「负责人」/「创建」 live in the tooltip. */}
        {task.assignee !== null && (
          <span
            style={styles.cardFact}
            title={L('负责人：{who} · 由 {by} 创建', 'owner: {who} · created by {by}', { who: task.assignee, by: task.created_by })}
          >
            <span style={styles.cardMark}>{MARK.owner}</span>{task.assignee}
          </span>
        )}
        {task.assignee !== task.created_by && (
          <span style={styles.cardFact} title={L('由 {by} 创建', 'created by {by}', { by: task.created_by })}>
            <span style={styles.cardMark}>{MARK.creator}</span>{task.created_by}
          </span>
        )}
        <span
          style={styles.cardAge}
          title={L('在当前列 {age} · 创建于 {created}', '{age} in this column · created {created}', { age: ageLabel(staleness.ageMs), created: task.created_at })}
        >
          {ageLabel(staleness.ageMs)}
        </span>
        {staleness.stale && (
          <span
            className="tb-stale"
            title={L('在这一列待了 {age}，已超过该列 {sla} 的阈值', '{age} in this column — past its {sla} threshold', { age: ageLabel(staleness.ageMs), sla: ageLabel(staleness.slaMs ?? 0) })}
          />
        )}
      </div>
      {/* Row 2 — the title alone, at most two lines. A redundant leading
          「【owner】 T-93 ·」 is stripped for DISPLAY only (displayTitle); the
          untouched string stays in the tooltip. */}
      <div style={styles.cardTitle} title={displayTitle(task, board) === task.title ? undefined : task.title}>
        {displayTitle(task, board)}
      </div>
      {/* Row 3 — what actually moves, strictly one line: WHO HOLDS THE BALL
          (one derivation, not three overlapping name badges) + the tags pinned
          right. See currentHolder() for why 「当前处理人」 read literally would
          point at the wrong person in review / waiting / done. */}
      <div style={styles.cardFoot}>
        <div style={styles.cardWho}>
          {holder && (
            <span
              className={task.waiting_on ? 'tb-badge-wait' : 'tb-badge-outline'}
              style={styles.cardWait}
              title={holderTitle(task, holder, reviewerQuiet)}
            >
              {/* The mark carries the ACTION (see HOLDER_MARKS), the name carries
                  the WHO, and the words 「球在 kimi（待裁决）」 live in the tooltip.
                  The stage word on row 1 already says what is owed, so repeating
                  it as copy here was the noise the owner asked us to drop. */}
              <span style={styles.cardHoldMark}>{HOLDER_MARKS[holder.action]}</span>
              {holder.who === null ? (
                <span style={styles.cardWaitWho}>{L('池子里', 'in the pool')}</span>
              ) : (
                <span style={styles.cardWaitWho}>{holder.who}</span>
              )}
            </span>
          )}
          {holder && holder.sinceMs !== undefined && (
            <span style={styles.cardHoldAge} title={L('球在它手上已经 {age}', 'holding the ball for {age}', { age: ageLabel(holder.sinceMs) })}>
              {ageLabel(holder.sinceMs)}
            </span>
          )}
        </div>
        {task.tags.length > 0 && (
          <div style={styles.cardTags}>
            {task.tags.slice(0, 2).map((tag) => (
              <span key={tag} className="tb-tag">{tag}</span>
            ))}
            {task.tags.length > 2 && <span className="tb-tag">+{task.tags.length - 2}</span>}
          </div>
        )}
      </div>
    </button>
  )
}

/**
 * The in-panel detail drawer (absolute, no portal; 560px wide). Three tabs:
 * 详情 (read-only by default — meta, status actions, roster chips, detail;
 * an explicit 编辑 button opens the edit form), 评论 (the comment thread +
 * composer) and 动态 (the log timeline). Keyed by task id at the call site,
 * so the tab, edit mode and drafts reset when the selection changes — but
 * survive background refreshes of the same task.
 *
 * Exported for the mini board (MiniBoard), which stacks it as the layer-2
 * drawer with a `style` override (its default positioning is the board
 * panel's right edge).
 */
export function DetailDrawer({ task, state, store, actors, onClose, style, initialTab }: { task: Task; state: TaskboardState; store: TaskboardStore; actors: string[]; onClose(): void; style?: CSSProperties; initialTab?: 'detail' | 'comments' | 'activity' }): JSX.Element {
  const [tab, setTab] = useState<'detail' | 'comments' | 'activity'>(initialTab ?? 'detail')
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)
  const [detailDraft, setDetailDraft] = useState(task.detail)
  const [priorityDraft, setPriorityDraft] = useState<TaskPriority>(task.priority)
  const [valueDraft, setValueDraft] = useState<TaskValue | null>(task.value)
  const [tagsDraft, setTagsDraft] = useState(task.tags.join(', '))
  const [rejectNote, setRejectNote] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const busy = state.busy
  const column = columnOf(task)
  const staleness = stalenessOf(task)
  const waiting = task.waiting_on
  const reviewerQuiet = task.reviewer ? isQuietActor(state.board, task.reviewer) : false
  const log = useMemo(() => [...task.log].sort((a, b) => a.at.localeCompare(b.at)), [task.log])

  const update = (patch: Parameters<TaskboardStore['update']>[0]): void => {
    void store.update(patch)
  }

  const switchTab = (next: 'detail' | 'comments' | 'activity'): void => {
    setTab(next)
    setEditing(false) // leaving the tab discards an unsaved edit form
  }

  const startEdit = (): void => {
    setTitleDraft(task.title)
    setDetailDraft(task.detail)
    setPriorityDraft(task.priority)
    setValueDraft(task.value)
    setTagsDraft(task.tags.join(', '))
    setEditing(true)
  }

  const saveEdit = async (): Promise<void> => {
    const title = titleDraft.trim()
    if (!title || busy) return
    const ok = await store.update({
      id: task.id,
      title,
      detail: detailDraft,
      priority: priorityDraft,
      value: valueDraft,
      tags: parseTags(tagsDraft),
    })
    // On failure the error strip explains it and the form stays open.
    if (ok) setEditing(false)
  }

  const editDirty =
    titleDraft.trim() !== task.title ||
    detailDraft !== task.detail ||
    priorityDraft !== task.priority ||
    valueDraft !== task.value ||
    parseTags(tagsDraft).join(' ') !== task.tags.join(' ')

  /** 打回 review：可选的一句 note 随 reject 一起提交。 */
  const submitReject = async (): Promise<void> => {
    const note = rejectNote.trim()
    const ok = await store.update({ id: task.id, action: 'reject', ...(note ? { note } : {}) })
    if (ok) setRejectNote('')
  }

  const submitComment = async (): Promise<void> => {
    const text = commentDraft.trim()
    if (!text || busy) return
    // On failure the store's error strip explains it and the draft survives.
    const ok = await store.comment({ id: task.id, text })
    if (ok) setCommentDraft('')
  }

  return (
    <aside style={{ ...styles.drawer, ...style }}>
      <div style={styles.drawerHead}>
        <span style={styles.drawerRef} title={task.id}>
          {taskRef(task.id)}
        </span>
        <span style={styles.drawerTitle}>{task.title}</span>
        {tab === 'detail' && !editing && (
          <button type="button" className="tb-btn" onClick={startEdit}>
            {L('编辑', 'Edit')}
          </button>
        )}
        <button type="button" className="tb-iconbtn" onClick={onClose} title={L('关闭', 'Close')}>
          ×
        </button>
      </div>
      <div style={styles.tabRow}>
        <button type="button" className={tab === 'detail' ? 'tb-tab active' : 'tb-tab'} onClick={() => switchTab('detail')}>
          {L('详情', 'Details')}
        </button>
        <button type="button" className={tab === 'comments' ? 'tb-tab active' : 'tb-tab'} onClick={() => switchTab('comments')}>
          {L('评论 ({n})', 'Comments ({n})', { n: task.comments.length })}
        </button>
        <button type="button" className={tab === 'activity' ? 'tb-tab active' : 'tb-tab'} onClick={() => switchTab('activity')}>
          {L('动态', 'Activity')}
        </button>
      </div>

      {tab === 'detail' && !editing && (
        <>
          <div style={styles.drawerMeta}>
            <span>{task.id}</span>
            <span>{statusLabel(task)}</span>
            <span>{L('优先级 {p}', 'priority {p}', { p: priorityLabel(task.priority) })}</span>
            <span>{task.value != null ? `◆${valueText(task.value)}` : L('未评估', 'unestimated')}</span>
            <span>{task.assignee ?? L('待认领', 'unclaimed')}</span>
            {task.tags.map((tag) => (
              <span key={tag} className="tb-tag">{tag}</span>
            ))}
          </div>
          <div style={styles.drawerMeta}>
            <span>{L('由 {by} 创建', 'created by {by}', { by: task.created_by })}</span>
            <span>{relTime(task.created_at)}</span>
          </div>

          {/* Collaboration facts (v0.5.4): how long this card has sat where it
              is, who owes the verdict, and who it is parked on. */}
          <div style={styles.drawerMeta}>
            <span
              title={L('在当前列 {age} · 创建于 {created}', '{age} in this column · created {created}', { age: ageLabel(staleness.ageMs), created: task.created_at })}
            >
              {L('在当前列 {age}', '{age} in this column', { age: ageLabel(staleness.ageMs) })}
              {staleness.stale ? L(' · 已超时', ' · overdue') : ''}
            </span>
            {column === 'review' && (
              <span style={reviewerQuiet ? { color: WARN } : undefined}>
                {task.reviewer
                  ? (reviewerQuiet
                    ? L('审核人 {who}（久未活动）', 'reviewer {who} (inactive)', { who: task.reviewer })
                    : L('审核人 {who}', 'reviewer {who}', { who: task.reviewer }))
                  : L('审核人未指定——没人欠这次审核', 'no reviewer set — nobody owes this verdict')}
              </span>
            )}
          </div>
          {waiting && (
            <div style={styles.waitBox}>
              <div style={styles.humanItemHead}>
                <span className="tb-badge-wait" title={waiting.question}>
                  {waitLabel(waiting)} · {ageLabel(Math.max(0, Date.now() - (Date.parse(waiting.since) || Date.now())))}
                </span>
                {staleness.waitOverdue && <span style={styles.humanOverdue}>{L('已超时', 'overdue')}</span>}
              </div>
              <div style={styles.humanQuestion} className="tb-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(waiting.question) }} />
            </div>
          )}

          <div style={styles.drawerActions}>
            {column === 'pool' && (
              <button type="button" className="tb-btn tb-btn-primary" disabled={busy} onClick={() => void store.claim(task.id)}>
                {L('认领', 'Claim')}
              </button>
            )}
            {column === 'assigned' && (
              <button type="button" className="tb-btn tb-btn-primary" disabled={busy} onClick={() => update({ id: task.id, action: 'start' })}>
                {L('开始', 'Start')}
              </button>
            )}
            {column === 'in_progress' && (
              <>
                <button type="button" className="tb-btn tb-btn-primary" disabled={busy} onClick={() => update({ id: task.id, action: 'submit' })}>
                  {L('提交审核', 'Submit for review')}
                </button>
                <button type="button" className="tb-btn" disabled={busy} onClick={() => update({ id: task.id, action: 'done' })}>
                  {L('完成', 'Done')}
                </button>
              </>
            )}
            {column === 'review' && (
              <>
                <button type="button" className="tb-btn tb-btn-primary" disabled={busy} onClick={() => update({ id: task.id, action: 'approve' })}>
                  {L('通过', 'Approve')}
                </button>
                <button type="button" className="tb-btn" disabled={busy} onClick={() => void submitReject()}>
                  {L('打回', 'Reject')}
                </button>
              </>
            )}
            {column === 'done' && (
              <>
                {/* done is not terminal in v0.6: the primary action here is the
                    settle, so a finished card cannot silently stay unsettled. */}
                <button type="button" className="tb-btn tb-btn-primary" disabled={busy} onClick={() => update({ id: task.id, action: 'close' })}>
                  {L('收口结清', 'Settle (close)')}
                </button>
                <button type="button" className="tb-btn" disabled={busy} onClick={() => update({ id: task.id, action: 'reopen' })}>
                  {L('重开', 'Reopen')}
                </button>
              </>
            )}
            {column === 'closed' && (
              <button type="button" className="tb-btn" disabled={busy} onClick={() => update({ id: task.id, action: 'reopen' })}>
                {L('重开（结清错了）', 'Reopen (settled by mistake)')}
              </button>
            )}
            {(column === 'pool' || column === 'assigned' || column === 'in_progress' || column === 'review') && (
              <button type="button" className="tb-btn tb-btn-danger" disabled={busy} onClick={() => update({ id: task.id, action: 'close' })}>
                {L('关闭', 'Close')}
              </button>
            )}
          </div>
          {column === 'review' && (
            <input
              className="tb-input"
              value={rejectNote}
              placeholder={L('打回原因（可选，随打回一起提交）', 'Reject reason (optional, sent with the rejection)')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setRejectNote(event.target.value)}
            />
          )}

          <div style={styles.drawerSection}>
            <div style={styles.sectionTitle}>{L('指派', 'Assignee')}</div>
            <ActorChips
              actors={actors}
              current={task.assignee}
              busy={busy}
              onSelect={(name) => {
                if (name !== task.assignee) update({ id: task.id, assignee: name })
              }}
              poolLabel={L('移回待认领', 'Back to pool')}
              emptyHint={L('暂无可指派成员——Agent 或人认领过一次就会出现在这里', 'No assignable members yet — an agent or human shows up here after claiming once.')}
            />
          </div>

          <div style={styles.drawerSection}>
            <div style={styles.sectionTitle}>{L('描述', 'Description')}</div>
            {task.detail ? (
              // Rendered markdown (XSS-safe — markdown.ts escapes first); the
              // read-only default stays read-only, just no longer raw text.
              <div className="tb-md" style={styles.detailBody} dangerouslySetInnerHTML={{ __html: renderMarkdown(task.detail) }} />
            ) : (
              <div style={styles.detailEmpty}>{L('（没有描述）', '(no description)')}</div>
            )}
          </div>
        </>
      )}

      {tab === 'detail' && editing && (
        <div style={styles.drawerSection}>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>{L('标题', 'Title')}</span>
            <input className="tb-input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} />
          </label>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>{L('描述', 'Details')}</span>
            <textarea className="tb-textarea" rows={8} value={detailDraft} onChange={(event) => setDetailDraft(event.target.value)} />
          </label>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>{L('优先级', 'Priority')}</span>
            <span style={styles.fieldRow}>
              {(['high', 'medium', 'low'] as const).map((priority) => (
                <button
                  key={priority}
                  type="button"
                  className={priorityDraft === priority ? 'tb-chip active' : 'tb-chip'}
                  disabled={busy}
                  onClick={() => setPriorityDraft(priority)}
                >
                  {priorityLabel(priority)}
                </button>
              ))}
            </span>
          </div>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>{L('价值度（再点已选 = 未评估）', 'Value (click the pick again = unestimated)')}</span>
            <ValueChips value={valueDraft} disabled={busy} onChange={setValueDraft} />
          </div>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>{L('标签（逗号分隔）', 'Tags (comma separated)')}</span>
            <input
              className="tb-input"
              value={tagsDraft}
              placeholder="ui, kit"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTagsDraft(event.target.value)}
            />
          </label>
          <div style={styles.drawerActions}>
            <button
              type="button"
              className="tb-btn tb-btn-primary"
              disabled={busy || !titleDraft.trim() || !editDirty}
              onClick={() => void saveEdit()}
            >
              {busy ? L('保存中…', 'Saving…') : L('保存修改', 'Save changes')}
            </button>
            <button type="button" className="tb-btn" disabled={busy} onClick={() => setEditing(false)}>
              {L('取消', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {tab === 'comments' && (
        <div style={styles.drawerSection}>
          {task.comments.length === 0 ? (
            <div style={styles.detailEmpty}>{L('还没有评论。', 'No comments yet.')}</div>
          ) : (
            <ul style={styles.logList}>
              {task.comments.map((comment, index) => (
                <CommentRow key={`${comment.at}-${index}`} comment={comment} />
              ))}
            </ul>
          )}
          <div style={styles.commentComposer}>
            <textarea
              className="tb-textarea"
              rows={3}
              value={commentDraft}
              placeholder={L('写下发现、交接说明或测试反馈…', 'Findings, handoff notes or test feedback…')}
              onChange={(event) => setCommentDraft(event.target.value)}
            />
            <div style={styles.drawerActions}>
              <button
                type="button"
                className="tb-btn tb-btn-primary"
                disabled={busy || !commentDraft.trim()}
                onClick={() => void submitComment()}
              >
                {busy ? L('发送中…', 'Sending…') : L('发表评论', 'Comment')}
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div style={styles.drawerSection}>
          {log.length === 0 ? (
            <div style={styles.detailEmpty}>{L('（还没有动态）', '(no activity yet)')}</div>
          ) : (
            <ul style={styles.logList}>
              {log.map((entry, index) => (
                <li key={`${entry.at}-${index}`} style={styles.logRow}>
                  <span style={styles.logDot} />
                  <div style={styles.logMain}>
                    <span style={styles.logEvent}>{eventLabel(entry.event)}</span>
                    <span style={styles.logBy}>{entry.by}</span>
                    <span style={styles.logTime} title={entry.at}>{relTime(entry.at)}</span>
                    {entry.note ? <span style={styles.logNote}>{entry.note}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  )
}

/** One comment in the task's discussion thread (human and agent alike).
 *  The text renders as sanitized markdown, same pipeline as the detail. */
function CommentRow({ comment }: { comment: TaskComment }): JSX.Element {
  return (
    <li style={styles.logRow}>
      <span style={styles.logDot} />
      <div style={styles.logMain}>
        <span style={styles.logEvent}>{comment.by}</span>
        <span style={styles.logTime} title={comment.at}>{relTime(comment.at)}</span>
        <div className="tb-md" style={styles.commentText} dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.text) }} />
      </div>
    </li>
  )
}

/**
 * The roster as a chip row: one chip per known actor (the current selection
 * highlighted), plus an optional trailing "back to pool" chip. The parent
 * decides what a selection means (immediate reassign in the drawer, a draft
 * pick in the create form). An empty roster degrades to a one-line hint.
 */
function ActorChips({
  actors,
  current,
  busy = false,
  onSelect,
  poolLabel,
  emptyHint,
}: {
  actors: string[]
  /** The selected actor (highlighted); null = none / pool. */
  current: string | null
  busy?: boolean
  onSelect(name: string | null): void
  /** When given, a trailing chip selects null (back to the claimable pool). */
  poolLabel?: string
  emptyHint?: string
}): JSX.Element {
  if (actors.length === 0) {
    return (
      <div style={styles.detailEmpty}>
        {emptyHint ?? L('暂无可指派成员——Agent 或人认领过一次就会出现在这里', 'No assignable members yet — an agent or human shows up here after claiming once.')}
      </div>
    )
  }
  return (
    <div style={styles.actorChips}>
      {actors.map((name) => (
        <button
          key={name}
          type="button"
          className={name === current ? 'tb-chip active' : 'tb-chip'}
          disabled={busy}
          onClick={() => onSelect(name)}
        >
          {name}
        </button>
      ))}
      {poolLabel && (
        <button type="button" className="tb-chip" disabled={busy || current === null} onClick={() => onSelect(null)}>
          {poolLabel}
        </button>
      )}
    </div>
  )
}

/**
 * The six 价值度 chips (½ 1 2 3 5 8): single-select, and clicking the
 * selected chip again clears back to 未评估 (null).
 */
function ValueChips({ value, disabled, onChange }: { value: TaskValue | null; disabled?: boolean; onChange(next: TaskValue | null): void }): JSX.Element {
  return (
    <span style={styles.fieldRow}>
      {TASK_VALUES.map((option) => (
        <button
          key={option}
          type="button"
          className={value === option ? 'tb-chip active' : 'tb-chip'}
          disabled={disabled}
          onClick={() => onChange(value === option ? null : option)}
        >
          {valueText(option)}
        </button>
      ))}
    </span>
  )
}

/**
 * The roster picker that floats over the drop target after a card is dropped
 * on 已指派 (the board's assigned lane, the mini board's assigned block):
 * pick a name (the drop's planDrop runs with it), send the card back to the
 * pool, or cancel (backdrop / 取消 / ESC — no request). Its `style` override
 * lets the mini board re-anchor it outside a lane.
 */
export function AssignPicker({
  actors,
  current,
  onPick,
  onPool,
  onCancel,
  style,
}: {
  actors: string[]
  /** The task's assignee right now (marked, still re-pickable). */
  current: string | null
  onPick(name: string): void
  onPool(): void
  onCancel(): void
  /** Root positioning override (default: floats inside the relative lane). */
  style?: CSSProperties
}): JSX.Element {
  return (
    <div style={{ ...styles.picker, ...style }}>
      <div style={styles.pickerTitle}>{L('指派给…', 'Assign to…')}</div>
      <div style={styles.pickerList}>
        {actors.length === 0 ? (
          <div style={styles.pickerEmpty}>
            {L('花名册还是空的——Agent 或人认领过一次就会出现在这里。', 'The roster is empty — an agent or human shows up here after claiming once.')}
          </div>
        ) : (
          actors.map((name) => (
            <button key={name} type="button" className="tb-picker-row" onClick={() => onPick(name)}>
              <span style={styles.pickerName}>{name}</span>
              {name === current && <span style={styles.pickerCurrent}>{L('当前', 'current')}</span>}
            </button>
          ))
        )}
      </div>
      <div style={styles.pickerFoot}>
        <button type="button" className="tb-picker-row" onClick={onPool}>
          {L('放回待认领池', 'Back to the pool')}
        </button>
        <button type="button" className="tb-picker-row" style={styles.pickerCancel} onClick={onCancel}>
          {L('取消', 'Cancel')}
        </button>
      </div>
    </div>
  )
}

/** The new-task form, shown in the same drawer slot as the task detail. */
function CreateForm({ state, store, actors, onClose }: { state: TaskboardState; store: TaskboardStore; actors: string[]; onClose(): void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [value, setValue] = useState<TaskValue | null>(null)
  // No pick = into the claimable pool.
  const [assignee, setAssignee] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!title.trim() || state.busy) return
    const ok = await store.create({
      title: title.trim(),
      detail,
      priority,
      value,
      assignee,
    })
    // On failure the store's error strip explains it and the draft survives.
    if (ok) onClose()
  }

  return (
    <aside style={styles.drawer}>
      <div style={styles.drawerHead}>
        <span style={styles.drawerTitle}>{L('新建任务', 'New task')}</span>
        <button type="button" className="tb-iconbtn" onClick={onClose} title={L('关闭', 'Close')}>
          ×
        </button>
      </div>
      <form
        style={styles.createForm}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label style={styles.field}>
          <span style={styles.fieldLabel}>{L('标题（必填）', 'Title (required)')}</span>
          <input className="tb-input" value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>{L('描述', 'Details')}</span>
          <textarea className="tb-textarea" rows={6} value={detail} onChange={(event) => setDetail(event.target.value)} />
        </label>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>{L('优先级', 'Priority')}</span>
          <span style={styles.fieldRow}>
            {(['high', 'medium', 'low'] as const).map((value) => (
              <button key={value} type="button" className={priority === value ? 'tb-chip active' : 'tb-chip'} onClick={() => setPriority(value)}>
                {priorityLabel(value)}
              </button>
            ))}
          </span>
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>{L('价值度（不选 = 未评估）', 'Value (no pick = unestimated)')}</span>
          <ValueChips value={value} onChange={setValue} />
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>{L('指派给（不选 = 进待认领池）', 'Assign to (no pick = into the pool)')}</span>
          <ActorChips
            actors={actors}
            current={assignee}
            onSelect={(name) => setAssignee(name === assignee ? null : name)}
          />
        </div>
        <div style={styles.drawerActions}>
          <button type="submit" className="tb-btn tb-btn-primary" disabled={state.busy || !title.trim()}>
            {state.busy ? L('创建中…', 'Creating…') : L('创建任务', 'Create task')}
          </button>
          <button type="button" className="tb-btn" onClick={onClose}>
            {L('取消', 'Cancel')}
          </button>
        </div>
      </form>
    </aside>
  )
}

// ------------------------------------------------------------------ guide

/** Clipboard write with a fallback for webviews without the async API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // execCommand path: select a temporary textarea and copy the selection.
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** One template block: a <pre> plus its copy button (turns 已复制 briefly). */
function SnippetBlock({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    if (!(await copyText(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div style={styles.snippet}>
      <div style={styles.snippetLabel}>{label}</div>
      <pre style={styles.snippetPre}>{text}</pre>
      <button type="button" className="tb-btn" style={styles.snippetCopy} onClick={() => void copy()}>
        {copied ? L('已复制', 'Copied') : L('复制', 'Copy')}
      </button>
    </div>
  )
}

/**
 * The「? 指南」overlay: an in-panel, centered card (above the drawer) that
 * explains the board to humans and — the point of the thing — hands them
 * ready-to-paste templates for getting kimi / Claude Code on board.
 */
function GuideOverlay({ cli, cwd, boardFile, onClose }: { cli: string | null; cwd: string; boardFile: string | null; onClose(): void }): JSX.Element {
  const file = boardFile ?? '.dsh/taskboard.json'
  return (
    <>
      <div style={styles.guideBackdrop} onClick={onClose} />
      <div style={styles.guideCard} role="dialog" aria-label={L('使用指南', 'Guide')}>
        <div style={styles.guideHead}>
          <span style={styles.guideTitle}>{L('使用指南', 'Guide')}</span>
          <button type="button" className="tb-iconbtn" onClick={onClose} title={L('关闭', 'Close')}>
            ×
          </button>
        </div>
        <div style={styles.guideBody}>
          <section style={styles.guideSection}>
            <div style={styles.guideH}>{L('这是什么', 'What this is')}</div>
            <p style={styles.guideP}>
              {L('每个 workspace 一块任务看板；全部数据就是 {file} 这一个文件——没有服务端、没有账号。在同一个目录里干活的 Agent 和人类，看到的是同一块板。', 'Every workspace has one task board; all its data lives in a single file — {file}. No server, no accounts: agents and humans working in the same directory share the same board.', { file })}
            </p>
          </section>

          <section style={styles.guideSection}>
            <div style={styles.guideH}>{L('人类怎么用', 'For humans')}</div>
            <ul style={styles.guideList}>
              <li>{L('拖卡片换列推进状态；拖到「已指派」会弹出成员选择器，拖到最右的窄竖条 = 关闭任务。', 'Drag cards between lanes to move them; dropping on 已指派 opens the roster picker, dropping on the narrow strip at the right edge closes the task.')}</li>
              <li>{L('点卡片开抽屉：详情（默认只读，改内容点「编辑」）/ 评论 / 动态 三个 tab。', 'Click a card for its drawer: three tabs — 详情 (read-only until you hit 编辑), 评论 and 动态.')}</li>
              <li>{L('标准流程：认领或指派 → 开始 → 提交审核 → 通过/打回 → 完成；任何非终态都可关闭。', 'The flow: claim or assign → start → submit for review → approve/reject → done; anything not final can be closed.')}</li>
            </ul>
          </section>

          <section style={styles.guideSection}>
            <div style={styles.guideH}>{L('状态栏的看板入口', 'The board entry in the status bar')}</div>
            <p style={styles.guideP}>
              {L('底部状态栏（轮次/步数/token 那一行）右端有一个低调的「看板」小按钮（带未完成任务数）：点开从右侧拉出全高抽屉——六个状态块纵排，拖任务行改状态（拖到「已指派」出成员选择器），点行再叠一层完整详情抽屉；已关闭默认折叠成一行。', 'At the right end of the bottom status bar (the turns/steps/tokens row) sits a quiet「看板」pill with the open-task count: it opens a full-height drawer from the right edge — six status blocks stacked vertically; drag a row to change its state (dropping on 已指派 opens the roster picker), click a row to stack the full detail drawer on top; 已关闭 stays collapsed into one row until expanded.')}
            </p>
          </section>

          <section style={styles.guideSection}>
            <div style={styles.guideH}>{L('dsh 里的 Agent', 'Agents inside dsh')}</div>
            <p style={styles.guideP}>
              {L('taskboard_* 工具在 dsh 会话里自动可用，会话开始的提示里已经写明用法——零配置，直接用。', 'The taskboard_* tools are automatically available inside dsh sessions, and the session-start prompt already explains them — zero configuration needed.')}
            </p>
          </section>

          <section style={styles.guideSection}>
            <div style={styles.guideH}>{L('让 kimi / Claude Code 用起来', 'Get kimi / Claude Code on board')}</div>
            <ul style={styles.guideList}>
              <li>
                <strong>{L('方式 A · 工作区约定文件（最省心）', 'A · Workspace convention file (easiest)')}</strong>
                <br />
                {L('把下面的「约定模板」存成 workspace 根目录的 AGENTS.md——他们每次会话开始都会读到。模板里的目录一律用 $PWD，任何项目原样可用，不用改。', 'Save the convention template below as AGENTS.md in the workspace root — they read it at the start of every session. Paths use $PWD, so the file works verbatim in any project.')}
              </li>
              <li>
                <strong>{L('方式 B · 邮件 / 消息派活', 'B · Dispatch by mail / message')}</strong>
                <br />
                {L('装了消息插件（例如 msg9）就切到它的页签，发到对方的地址（形如 kimi@<项目pod>.ice.msg9.io，真实地址在联系人里查），正文用「派活模板」+ 任务 ID；没有消息插件就用方式 C 直接粘贴。', 'With a messaging plugin installed (e.g. msg9), switch to its tab and mail their address (of the form kimi@<project-pod>.ice.msg9.io — look the real one up in Contacts) with the dispatch template below plus a task id; without one, use option C.')}
              </li>
              <li>
                <strong>{L('方式 C · 直接粘进会话', 'C · Paste straight into a session')}</strong>
                <br />
                {L('复制「派活模板」，粘进他们会话的输入框即可。', 'Copy the dispatch template and paste it into their session input.')}
              </li>
            </ul>
            <SnippetBlock label={L('约定模板（存为 AGENTS.md）', 'Convention template (save as AGENTS.md)')} text={conventionSnippet(cli)} />
            <SnippetBlock label={L('派活模板（邮件 / 粘贴）', 'Dispatch template (mail / paste)')} text={dispatchSnippet(cli, cwd)} />
          </section>

          <section style={styles.guideSection}>
            <div style={styles.guideH}>{L('自监控 hook（不用催）', 'Self-monitoring hooks (no nudging needed)')}</div>
            <ul style={styles.guideList}>
              <li>
                {L('SessionStart = 会话开始自动查板；UserPromptSubmit = 每次发消息顺带查。没有指派时静默不打扰。', 'SessionStart checks the board when a session starts; UserPromptSubmit re-checks on every message. Silent when nothing is assigned — no nagging.')}
              </li>
              <li>
                {L('没板的项目零打扰：命令自带 [ -f .dsh/taskboard.json ] 守卫。', 'Projects without a board stay untouched: the command is guarded by [ -f .dsh/taskboard.json ].')}
              </li>
              <li>
                {L('改完配置后开新会话生效。', 'Takes effect in a new session after the config change.')}
              </li>
            </ul>
            <SnippetBlock label={L('kimi-code（追加到 ~/.kimi-code/config.toml）', 'kimi-code (append to ~/.kimi-code/config.toml)')} text={hookSnippetKimi(cli)} />
            <SnippetBlock label={L('Claude Code（合并进 ~/.claude/settings.json）', 'Claude Code (merge into ~/.claude/settings.json)')} text={hookSnippetClaude(cli)} />
          </section>
        </div>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ styles

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    color: FG,
    background: BG,
    fontSize: 13,
  },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderBottom: `1px solid ${BORDER}`,
    flexShrink: 0,
  },
  topbarTitle: { fontSize: 14, fontWeight: 600 },
  topbarPath: {
    color: DIM,
    fontSize: 11,
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  topbarCount: { color: DIM, fontSize: 11, flexShrink: 0 },
  topbarSpacer: { flex: 1 },
  noticeError: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    margin: '8px 14px 0',
    padding: '5px 6px 5px 12px',
    borderRadius: 8,
    background: DANGER_BG,
    color: DANGER,
    fontSize: 12,
    flexShrink: 0,
  },
  noticeText: { minWidth: 0, overflowWrap: 'anywhere' },
  lanes: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: 10,
    padding: 12,
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  column: {
    position: 'relative', // anchors the in-lane roster picker overlay
    width: 240,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: BG_SUNK,
    borderRadius: 8,
  },
  columnHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 10px 4px',
    flexShrink: 0,
  },
  columnTitle: { fontSize: 12, fontWeight: 600 },
  // The segmented view switch in the top bar (按进度 / 按负责人).
  // The two groups sit side by side with a real gap; each carries its own
  // border so "which group am I in" needs no rule to explain it.
  viewSwitch: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  segGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    border: `1px solid ${BORDER}`,
    borderRadius: 7,
    overflow: 'hidden',
  },
  seg: {
    border: 'none',
    background: 'transparent',
    color: DIM,
    fontFamily: 'inherit',
    fontSize: 11.5,
    padding: '3px 10px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  segActive: { background: HOVER_BG, color: FG, fontWeight: 600, boxShadow: `inset 0 0 0 1px ${BORDER}` },
  // A quiet-owner marker in an owner lane's header.
  quietDot: { width: 6, height: 6, borderRadius: 3, background: WARN, flexShrink: 0 },
  // The「含已完成」checkbox shown only in the owner view.
  doneToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11.5,
    color: DIM,
    flexShrink: 0,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  laneHint: {
    fontSize: 10,
    color: WARN,
    border: `1px solid ${WARN}`,
    borderRadius: 999,
    padding: '0 6px',
    whiteSpace: 'nowrap',
  },
  columnCount: {
    fontSize: 10,
    color: DIM,
    border: `1px solid ${BORDER}`,
    borderRadius: 999,
    padding: '0 7px',
  },
  columnBody: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 8,
  },
  columnEmpty: { color: FAINT, fontSize: 11, textAlign: 'center', padding: '14px 0' },
  closedStrip: {
    width: 36,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: BG,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  closedStripText: { writingMode: 'vertical-rl', fontSize: 11, color: DIM, letterSpacing: 1, whiteSpace: 'nowrap' },
  // Meta row of a card: one compact line (dot · value · #N at the right end).
  // Row 1: the card's FIXED attributes — one 10px line, read as a caption.
  cardMetaTop: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, lineHeight: '15px', minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardStatus: { flexShrink: 0, color: DIM, fontSize: 10 },
  cardSep: { flexShrink: 0, color: FAINT, fontSize: 10 },
  cardFact: { color: FAINT, fontSize: 10, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // 记号本身稍微提亮一档：它是"这是什么字段"的锚，比值更需要被一眼看到
  cardMark: { color: DIM, marginRight: 3 },
  // The title is its own full-width row below the meta row, clamped to 2 lines.
  cardTitle: {
    minWidth: 0,
    fontSize: 12.5,
    fontWeight: 500,
    lineHeight: 1.35,
    overflowWrap: 'anywhere',
    marginTop: 3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  // 价值点从"描边药丸"降为"记号 + 数字"：10px 行里一圈边框就是一圈噪声
  valueBadge: { flexShrink: 0, fontSize: 10, color: FAINT, whiteSpace: 'nowrap' },
  cardRef: { flexShrink: 0, fontSize: 10, color: FAINT, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  // Row 3: strictly ONE line (owner request 2026-10-01) — owner + who owes /
  // waits on the left (shrinkable, ellipsized rather than wrapped), tags pinned
  // right; row 1 keeps the column age at its right end.
  cardFoot: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, minWidth: 0 },
  cardWho: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', minWidth: 0, flex: '0 1 auto' },
  cardAge: { marginLeft: 'auto', color: FAINT, fontSize: 10, flexShrink: 0 },
  reviewerBadge: { maxWidth: '100%' },
  // One line ⇒ the chip truncates instead of wrapping — which is why its text
  // is the compact 「◷ who · 1h12m」 (full sentence + question live in the
  // tooltip): the AGE is the half that says "this is stuck" and must survive.
  // Never squeezed: the people cluster yields only as a last resort, so the
  // waiting chip keeps谁 + 时长 whole; the TAGS are the ones that clip.
  cardWait: { whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0, flexShrink: 0 },
  cardWaitWho: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
  cardHoldMark: { flexShrink: 0, color: DIM, marginRight: 3 },
  cardHoldAge: { flexShrink: 0, color: FAINT, fontSize: 10 },
  cardWaitAge: { flexShrink: 0 },
  // The human strip: the only warn-tinted surface on the board (amber, never
  // alarm-red — the shell has no warn-bg token, so the raised surface plus a
  // warn left rule carries the emphasis).
  humanStrip: {
    flexShrink: 0,
    margin: '6px 12px 0',
    padding: '6px 10px 8px',
    borderRadius: 8,
    border: `1px solid ${BORDER_STRONG}`,
    borderLeft: `3px solid ${WARN}`,
    background: BG_RAISED,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  humanHead: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  humanTitle: { fontSize: 12.5, fontWeight: 600, color: WARN },
  // The「待收口」strip (done but unsettled): same shape as the human strip,
  // quieter accent — it is a nudge, not a blocked-on-you alarm.
  settleStrip: {
    flexShrink: 0,
    margin: '6px 12px 0',
    padding: '6px 10px 8px',
    borderRadius: 8,
    border: `1px solid ${BORDER_STRONG}`,
    borderLeft: `3px solid ${ACCENT}`,
    background: BG_RAISED,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  settleTitle: { fontSize: 12.5, fontWeight: 600, color: ACCENT },
  settleRow: { display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${BORDER}`, paddingTop: 7 },
  settleRef: { flexShrink: 0, fontSize: 10.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  settleTitleText: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  humanHint: { fontSize: 10.5, color: DIM },
  humanList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  humanItem: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px solid ${BORDER}`, paddingTop: 7 },
  humanItemHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  humanRef: { flexShrink: 0, fontSize: 10.5, color: FAINT, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  humanItemTitle: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  humanMeta: { fontSize: 10.5, color: DIM, flexShrink: 0 },
  humanOverdue: { fontSize: 10, color: WARN, border: `1px solid ${WARN}`, borderRadius: 999, padding: '0 7px', flexShrink: 0 },
  humanQuestion: { fontSize: 12, lineHeight: 1.6, color: FG, maxWidth: '70ch' },
  humanComposer: { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2 },
  humanComposerFoot: { display: 'flex', gap: 6 },
  // The drawer's parked-on box (same warn edge as the strip, sunk surface).
  waitBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    border: `1px solid ${BORDER}`,
    borderLeft: `3px solid ${WARN}`,
    borderRadius: 8,
    padding: '7px 10px',
    background: BG_SUNK,
  },
  cardTags: { display: 'flex', gap: 4, marginLeft: 'auto', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', justifyContent: 'flex-end' },
  center: {
    margin: 'auto',
    padding: 24,
    maxWidth: 520,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    alignItems: 'center',
  },
  centerText: { color: DIM, fontSize: 12, lineHeight: 1.6, margin: 0 },
  // The「开启看板」wizard card. The file rows need real gap between the label,
  // the code and the hint — they ran together ("jsonboard data") while these
  // keys were missing, because an unknown style key renders as nothing at all.
  wizard: {
    maxWidth: 540,
    background: BG_RAISED,
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    padding: '14px 16px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
  },
  wizardTitle: { margin: 0, fontSize: 13.5, fontWeight: 600 },
  wizardText: { margin: 0, fontSize: 12, lineHeight: 1.65, color: FG },
  wizardFiles: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 5 },
  wizardFile: { display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 11.5, flexWrap: 'wrap' },
  wizardFileLabel: { color: DIM, flexShrink: 0, minWidth: 62 },
  wizardCode: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    overflowWrap: 'anywhere',
    minWidth: 0,
    color: FG,
  },
  wizardMuted: { margin: 0, fontSize: 11, color: DIM },
  wizardActions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  wizardCli: { fontSize: 10.5, color: FAINT, overflowWrap: 'anywhere' },
  errorText: { color: DANGER, fontSize: 12, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
  backdrop: { position: 'absolute', inset: 0, background: MASK, zIndex: 20 },
  drawer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 560,
    maxWidth: '92%',
    background: BG,
    borderLeft: `1px solid ${BORDER_STRONG}`,
    boxShadow: '-8px 0 24px rgba(0,0,0,0.12)',
    zIndex: 21,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    boxSizing: 'border-box',
  },
  drawerHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  drawerRef: { fontSize: 13, fontWeight: 600, color: FAINT, marginTop: 1, flexShrink: 0 },
  drawerTitle: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.45, overflowWrap: 'anywhere' },
  drawerMeta: { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', color: DIM, fontSize: 11 },
  drawerActions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  drawerSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    borderTop: `1px solid ${BORDER}`,
    paddingTop: 10,
  },
  sectionTitle: { fontSize: 11, fontWeight: 600, color: DIM },
  detailBody: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 12.5,
    lineHeight: 1.65,
    maxWidth: '70ch',
  },
  detailEmpty: { color: FAINT, fontSize: 11 },
  field: { display: 'flex', flexDirection: 'column', gap: 3 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 6 },
  fieldLabel: { color: DIM, fontSize: 10 },
  createForm: { display: 'flex', flexDirection: 'column', gap: 10 },
  logList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  logRow: { display: 'flex', gap: 8, alignItems: 'flex-start' },
  logDot: { width: 6, height: 6, borderRadius: 3, background: BORDER_STRONG, marginTop: 5, flexShrink: 0 },
  logMain: { display: 'flex', flexWrap: 'wrap', gap: '1px 8px', alignItems: 'baseline', minWidth: 0, fontSize: 11.5 },
  logEvent: { fontWeight: 600 },
  logBy: { color: DIM },
  logTime: { color: FAINT, fontSize: 10 },
  logNote: { flexBasis: '100%', color: DIM, fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  // Block container (not a span + pre-wrap): tables/lists are block content and
  // the renderer already emits <br> for single newlines, so pre-wrap would only
  // double the spacing. (T-12)
  commentText: { flexBasis: '100%', fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' },
  commentComposer: { display: 'flex', flexDirection: 'column', gap: 6 },
  tabRow: {
    display: 'flex',
    gap: 14,
    borderBottom: `1px solid ${BORDER}`,
    marginTop: -4,
    flexShrink: 0,
  },
  actorChips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  // The roster picker: floats inside the assigned lane after a drop on it
  // (z above the panel-wide backdrop's 20, below the drawer's 21).
  picker: {
    position: 'absolute',
    top: 34,
    left: 6,
    right: 6,
    zIndex: 25,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    background: BG_RAISED,
    border: `1px solid ${BORDER_STRONG}`,
    borderRadius: 8,
    boxShadow: '0 10px 28px rgba(0,0,0,0.18)',
    padding: 6,
    maxHeight: 'calc(100% - 48px)',
  },
  pickerTitle: { fontSize: 12, fontWeight: 600, padding: '2px 6px 4px' },
  pickerList: { display: 'flex', flexDirection: 'column', gap: 1, overflowY: 'auto', minHeight: 0 },
  pickerName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pickerCurrent: { fontSize: 10, color: LINK, flexShrink: 0 },
  pickerEmpty: { color: FAINT, fontSize: 11, padding: '6px 8px', lineHeight: 1.5 },
  pickerFoot: { display: 'flex', flexDirection: 'column', gap: 1, borderTop: `1px solid ${BORDER}`, paddingTop: 4 },
  pickerCancel: { color: DIM },
  // The guide overlay: centered card above everything else in the panel
  // (backdrop z 30, card z 31 — the drawer sits at 21, the roster picker 25).
  guideBackdrop: { position: 'absolute', inset: 0, background: MASK, zIndex: 30 },
  guideCard: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 720,
    maxWidth: '94%',
    maxHeight: '88%',
    display: 'flex',
    flexDirection: 'column',
    background: BG,
    border: `1px solid ${BORDER_STRONG}`,
    borderRadius: 10,
    boxShadow: '0 16px 44px rgba(0,0,0,0.22)',
    zIndex: 31,
    overflow: 'hidden',
  },
  guideHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '10px 14px',
    borderBottom: `1px solid ${BORDER}`,
    flexShrink: 0,
  },
  guideTitle: { fontSize: 14, fontWeight: 600 },
  guideBody: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '14px 18px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    fontSize: 12.5,
    lineHeight: 1.7,
  },
  guideSection: { display: 'flex', flexDirection: 'column', gap: 6 },
  guideH: { fontSize: 13, fontWeight: 600 },
  guideP: { margin: 0, overflowWrap: 'anywhere' },
  guideList: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 },
  snippet: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 },
  snippetLabel: { fontSize: 11, fontWeight: 600, color: DIM },
  snippetPre: {
    margin: 0,
    background: BG_SUNK,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 11.5,
    lineHeight: 1.6,
    overflowX: 'auto',
    whiteSpace: 'pre',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  snippetCopy: { position: 'absolute', top: 24, right: 8, zIndex: 1 },
}
