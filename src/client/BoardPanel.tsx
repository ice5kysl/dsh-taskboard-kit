/**
 * The taskboard kanban view, registered as a「看板」session view tab next to
 * 对话 | 轨迹 | 文件 | 消息 (`conversation.view`, order 40).
 *
 * Layout: a top bar (workspace, task count, refresh, cancelled toggle, new
 * task) above four swim-lane columns (待认领 / 已指派 / 进行中 / 已完成 from
 * the contract's BOARD_COLUMNS). Cards are HTML5-draggable between lanes —
 * a drop compiles into the shared `planDrop` op sequence, never a hand-rolled
 * status mapping; a drop on 已指派 opens the lane's roster picker (no prompt,
 * no typing — the roster comes from the board itself, see actors.ts).
 * Clicking a card opens a 560px detail drawer that is absolutely positioned
 * INSIDE the panel (no portal — the shell's overlay layer would lose the
 * --dsw-alias-* theme tokens), tabbed into 详情 (read-only until 编辑 is
 * hit), 评论 (the thread + composer) and 动态 (the log timeline).
 *
 * It is a pure projection of the store (`useSyncExternalStore`) — every
 * action goes through `TaskboardStore`, so the model tools, the view and the
 * tests share one implementation of "load / create / claim / update".
 * Colors ride the shell's design tokens; interactive states are class-based
 * (TB_CSS is injected once per panel), no emoji glyphs anywhere.
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
  columnOf,
  compareTasks,
  type BoardColumn,
  type Task,
  type TaskComment,
  type TaskEvent,
  type TaskPriority,
} from '../shared/types.ts'
import { planDrop, type DropOp } from '../shared/dnd.ts'
import { knownActors } from './actors.ts'
import { L } from './locale.ts'
import type { TaskboardState, TaskboardStore } from './store.ts'

/** Props handed to the view: injected store + the standard slot shares. */
export interface BoardPanelProps {
  /** The page-wide store (injected). */
  store: TaskboardStore
  /** Leave the view (unused by conversation.view; kept for compatibility). */
  onBack?: () => void
  /** Current session list state; the view follows the selected session. */
  useSessions?: (selector: (state: SessionListLike) => unknown) => unknown
}

interface SessionListLike {
  current?: string
  byId?: Record<string, { cwd?: string } | undefined>
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

// ------------------------------------------------------------------ theme

const FG = 'var(--dsw-alias-label-primary, #1f2328)'
const DIM = 'var(--dsw-alias-label-secondary, #6b7280)'
const FAINT = 'var(--dsw-alias-label-dimmed, #9ca3af)'
const BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
const BG_SUNK = 'var(--dsw-alias-bg-layer-1, #f5f7fa)'
const BG_RAISED = 'var(--dsw-alias-bg-layer-3, #ffffff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(28,35,51,0.12))'
const BORDER_STRONG = 'var(--dsw-alias-border-l2, rgba(28,35,51,0.20))'
const ACCENT = 'var(--dsw-alias-brand-primary, #2d66f7)'
const DANGER = 'var(--dsw-alias-state-error-primary, #dc2626)'
const HOVER_BG = 'var(--dsw-alias-interactive-bg-hover, rgba(28,35,51,0.06))'
/** Semantic amber for the medium priority dot — readable in both themes. */
const AMBER = '#d97706'

const PRIORITY_COLORS: Record<TaskPriority, string> = { high: DANGER, medium: AMBER, low: FAINT }

/** Interactive-state rules for the tb-* classes used across the panel. */
const TB_CSS = `
.tb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: transparent; color: inherit; padding: 5px 10px; font-size: 12px; font-family: inherit; line-height: 1.4; cursor: pointer; }
.tb-btn:hover { background: ${HOVER_BG}; }
.tb-btn:disabled { opacity: 0.55; cursor: default; }
.tb-btn:disabled:hover { background: transparent; }
.tb-btn-primary { background: ${ACCENT}; border-color: transparent; color: #fff; font-weight: 500; }
.tb-btn-primary:hover { background: ${ACCENT}; opacity: 0.88; }
.tb-btn-primary:disabled:hover { background: ${ACCENT}; opacity: 0.55; }
.tb-btn-danger { color: ${DANGER}; }
.tb-iconbtn { display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 6px; background: transparent; color: ${DIM}; padding: 4px 6px; font-size: 13px; font-family: inherit; line-height: 1; cursor: pointer; }
.tb-iconbtn:hover { background: ${HOVER_BG}; color: ${FG}; }
.tb-input, .tb-textarea { width: 100%; box-sizing: border-box; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: ${BG}; color: inherit; padding: 6px 9px; font-size: 12.5px; font-family: inherit; line-height: 1.5; }
.tb-input::placeholder, .tb-textarea::placeholder { color: ${DIM}; opacity: 0.7; }
.tb-input:focus, .tb-textarea:focus { outline: none; border-color: ${ACCENT}; box-shadow: 0 0 0 3px rgba(45,102,247,0.18); }
.tb-textarea { resize: vertical; }
.tb-card { display: block; width: 100%; box-sizing: border-box; text-align: left; border: 1px solid ${BORDER}; border-radius: 8px; background: ${BG_RAISED}; color: inherit; padding: 8px 10px; font-family: inherit; cursor: pointer; }
.tb-card:hover { border-color: ${ACCENT}; }
.tb-card.active { border-color: ${ACCENT}; box-shadow: 0 0 0 1px ${ACCENT}; }
.tb-chip { border: 1px solid ${BORDER}; border-radius: 999px; background: transparent; color: ${DIM}; padding: 3px 11px; font-size: 11px; font-family: inherit; cursor: pointer; }
.tb-chip:hover { color: ${FG}; border-color: ${BORDER_STRONG}; }
.tb-chip.active { background: ${HOVER_BG}; color: ${ACCENT}; border-color: ${ACCENT}; font-weight: 600; }
.tb-tag { font-size: 10px; color: ${DIM}; border: 1px solid ${BORDER}; border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
.tb-badge { display: inline-flex; align-items: center; font-size: 10px; color: ${ACCENT}; background: ${HOVER_BG}; border-radius: 999px; padding: 1px 7px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-badge-outline { display: inline-flex; align-items: center; font-size: 10px; color: ${DIM}; border: 1px dashed ${BORDER_STRONG}; border-radius: 999px; padding: 0 7px; white-space: nowrap; }
/* Drop-target highlight rides the injected stylesheet (inline styles cannot
   express state classes); !important beats the lane's inline background. */
.tb-column.dragover { box-shadow: inset 0 0 0 2px ${ACCENT} !important; background: ${HOVER_BG} !important; }
/* In-column assignee picker rows. */
.tb-picker-row { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 6px; border: none; border-radius: 6px; background: transparent; color: inherit; padding: 7px 10px; font-size: 12px; font-family: inherit; cursor: pointer; text-align: left; }
.tb-picker-row:hover { background: ${HOVER_BG}; }
/* Drawer tab strip. */
.tb-tab { border: none; border-bottom: 2px solid transparent; background: transparent; color: ${DIM}; padding: 6px 2px; font-size: 12px; font-family: inherit; cursor: pointer; }
.tb-tab:hover { color: ${FG}; }
.tb-tab.active { color: ${ACCENT}; border-bottom-color: ${ACCENT}; font-weight: 600; }
`

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

/** Read the selected session's directory out of the standard slot share. */
function useSessionCwd(props: BoardPanelProps): string | undefined {
  const selector = props.useSessions
  const read = useCallback((state: SessionListLike): unknown => {
    const current = state?.current
    if (!current) return undefined
    return state?.byId?.[current]?.cwd
  }, [])
  // `useSessions` is itself a hook when the host provides one: keep the call
  // unconditional in shape (no early return above it) so hook order stays
  // stable; the host keeps this prop stable for the panel's lifetime.
  const value = typeof selector === 'function' ? selector(read) : undefined
  return typeof value === 'string' ? value : undefined
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

/** Card age badge: 5m / 3h / 2d since creation. */
function ageText(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
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

function columnLabel(column: BoardColumn): string {
  switch (column) {
    case 'pool': return L('待认领', 'Pool')
    case 'assigned': return L('已指派', 'Assigned')
    case 'in_progress': return L('进行中', 'In progress')
    case 'done': return L('已完成', 'Done')
  }
}

function statusLabel(task: Task): string {
  if (task.status === 'cancelled') return L('已取消', 'Cancelled')
  return columnLabel(columnOf(task))
}

function priorityLabel(priority: TaskPriority): string {
  switch (priority) {
    case 'high': return L('高', 'high')
    case 'medium': return L('中', 'medium')
    case 'low': return L('低', 'low')
  }
}

const EVENT_LABELS: Record<TaskEvent, [string, string]> = {
  created: ['创建', 'created'],
  assigned: ['指派', 'assigned'],
  claimed: ['认领', 'claimed'],
  started: ['开始', 'started'],
  stopped: ['停止', 'stopped'],
  done: ['完成', 'done'],
  reopened: ['重开', 'reopened'],
  cancelled: ['取消', 'cancelled'],
  updated: ['更新', 'updated'],
}

function eventLabel(event: TaskEvent): string {
  const pair = EVENT_LABELS[event]
  return pair ? L(pair[0], pair[1]) : event
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

  // Follow the current session's workspace.
  useEffect(() => {
    store.setCwd(cwd ?? null)
  }, [store, cwd])

  // First paint / returning to the tab: make sure the board is fresh.
  useEffect(() => {
    void store.refresh()
  }, [store])

  // ESC aborts a pending assignment (no request fires).
  useEffect(() => {
    if (!assignPickerId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAssignPickerId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [assignPickerId])

  const board = state.board
  const tasks = useMemo(() => (board ? Object.values(board.tasks) : []), [board])
  const actors = useMemo(() => (board ? knownActors(board) : []), [board])
  const columns = useMemo(
    () =>
      BOARD_COLUMNS.map((column) => {
        let list = tasks.filter((task) => columnOf(task) === column)
        // Cancelled tasks land in the done column but hide behind the toggle.
        if (column === 'done' && !state.showCancelled) {
          list = list.filter((task) => task.status !== 'cancelled')
        }
        return { column, tasks: [...list].sort(compareTasks) }
      }),
    [tasks, state.showCancelled],
  )
  const selectedId = state.selectedId
  const selected: Task | null = selectedId && board ? board.tasks[selectedId] ?? null : null
  const pickerTask: Task | null = assignPickerId && board ? board.tasks[assignPickerId] ?? null : null
  const drawerOpen = createOpen || selected !== null
  const closeDrawer = (): void => {
    setCreateOpen(false)
    store.select(null)
  }

  /**
   * Execute one shared `planDrop` op sequence in order through the store
   * (claim → store.claim, update → store.update with the patch). An empty
   * plan is a no-op (no request); a failed step surfaces through the store's
   * error channel and stops the sequence.
   */
  const runPlan = async (task: Task, ops: DropOp[]): Promise<void> => {
    if (ops.length === 0) return
    for (const op of ops) {
      const ok = op.kind === 'claim'
        ? await store.claim(task.id)
        : await store.update({ id: task.id, ...op.patch })
      if (!ok) return
    }
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

  if (state.status === 'loading' && !board) {
    return (
      <div style={styles.root} ref={rootHeightRef}>
        <style>{TB_CSS}</style>
        <div style={styles.center}>
          <p style={styles.centerText}>{L('正在加载看板…', 'Loading the board…')}</p>
        </div>
      </div>
    )
  }

  if (state.status === 'error' && !board) {
    return (
      <div style={styles.root} ref={rootHeightRef}>
        <style>{TB_CSS}</style>
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
      <style>{TB_CSS}</style>
      <TopBar state={state} store={store} total={tasks.length} onCreate={() => setCreateOpen(true)} />
      {state.error && (
        <div style={styles.noticeError}>
          <span style={styles.noticeText}>{state.error}</span>
          <button type="button" className="tb-iconbtn" onClick={() => store.clearError()} title={L('关闭', 'Dismiss')}>
            ×
          </button>
        </div>
      )}
      {!state.cwd ? (
        <div style={styles.center}>
          <p style={styles.centerText}>
            {L('没有选中的会话。打开一个会话后，这里显示它所在 workspace 的看板。', 'No session selected. Open a session to see its workspace board here.')}
          </p>
        </div>
      ) : tasks.length === 0 ? (
        <div style={styles.center}>
          <p style={styles.centerText}>
            {L('还没有任务——让 Agent 用 taskboard_create 建一个，或点 + 新建。', 'No tasks yet — ask the agent to run taskboard_create, or hit + to create one.')}
          </p>
          <button type="button" className="tb-btn tb-btn-primary" onClick={() => setCreateOpen(true)}>
            {L('+ 新建任务', '+ New task')}
          </button>
        </div>
      ) : (
        <div style={styles.lanes}>
          {columns.map(({ column, tasks: list }) => (
            <ColumnView
              key={column}
              column={column}
              tasks={list}
              state={state}
              store={store}
              onCreate={() => setCreateOpen(true)}
              dnd={dnd}
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
          ))}
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
    </div>
  )
}

/** Top bar: title, workspace, count, refresh, cancelled toggle, new task. */
function TopBar({ state, store, total, onCreate }: { state: TaskboardState; store: TaskboardStore; total: number; onCreate(): void }): JSX.Element {
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
      <button
        type="button"
        className={state.showCancelled ? 'tb-chip active' : 'tb-chip'}
        onClick={() => store.setShowCancelled(!state.showCancelled)}
        title={L('在完成列里显示已取消的任务', 'Show cancelled tasks in the done column')}
      >
        {L('显示已取消', 'Show cancelled')}
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
}: {
  column: BoardColumn
  tasks: Task[]
  state: TaskboardState
  store: TaskboardStore
  onCreate(): void
  dnd: LaneDnd
  overlay?: ReactNode
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
        <button type="button" className="tb-iconbtn" onClick={onCreate} title={L('新建任务', 'New task')}>
          +
        </button>
      </div>
      <div style={styles.columnBody}>
        {tasks.length === 0 ? (
          <div style={styles.columnEmpty}>{L('（空）', '(empty)')}</div>
        ) : (
          tasks.map((task) => (
            <TaskCard key={task.id} task={task} selected={task.id === state.selectedId} onOpen={() => store.select(task.id)} dnd={dnd} />
          ))
        )}
      </div>
      {overlay}
    </section>
  )
}

/** One task card: priority dot, title, assignee badge, age, tag capsules.
 *  Cards are the drag source: the task id rides dataTransfer, and the card
 *  turns translucent while it is being dragged. */
function TaskCard({ task, selected, onOpen, dnd }: { task: Task; selected: boolean; onOpen(): void; dnd: LaneDnd }): JSX.Element {
  const cancelled = task.status === 'cancelled'
  const dragging = dnd.dragId === task.id
  return (
    <button
      type="button"
      className={selected ? 'tb-card active' : 'tb-card'}
      style={{ opacity: dragging ? 0.5 : cancelled ? 0.65 : 1 }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
        dnd.setDragId(task.id)
      }}
      onDragEnd={() => {
        dnd.setDragId(null)
        dnd.setOverColumn(null)
      }}
      onClick={onOpen}
    >
      <div style={styles.cardTop}>
        <span
          style={{ ...styles.dot, background: PRIORITY_COLORS[task.priority] ?? FAINT }}
          title={L('优先级：{p}', 'Priority: {p}', { p: priorityLabel(task.priority) })}
        />
        <span style={{ ...styles.cardTitle, ...(cancelled ? styles.cardTitleCancelled : {}) }}>{task.title}</span>
      </div>
      <div style={styles.cardMeta}>
        {task.assignee ? (
          <span className="tb-badge" title={task.assignee}>{task.assignee}</span>
        ) : (
          <span className="tb-badge-outline">{L('待认领', 'unclaimed')}</span>
        )}
        <span style={styles.cardAge} title={task.created_at}>{ageText(task.created_at)}</span>
      </div>
      {task.tags.length > 0 && (
        <div style={styles.cardTags}>
          {task.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="tb-tag">{tag}</span>
          ))}
          {task.tags.length > 3 && <span className="tb-tag">+{task.tags.length - 3}</span>}
        </div>
      )}
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
 */
function DetailDrawer({ task, state, store, actors, onClose }: { task: Task; state: TaskboardState; store: TaskboardStore; actors: string[]; onClose(): void }): JSX.Element {
  const [tab, setTab] = useState<'detail' | 'comments' | 'activity'>('detail')
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)
  const [detailDraft, setDetailDraft] = useState(task.detail)
  const [priorityDraft, setPriorityDraft] = useState<TaskPriority>(task.priority)
  const [tagsDraft, setTagsDraft] = useState(task.tags.join(', '))
  const [commentDraft, setCommentDraft] = useState('')
  const busy = state.busy
  const column = columnOf(task)
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
      tags: parseTags(tagsDraft),
    })
    // On failure the error strip explains it and the form stays open.
    if (ok) setEditing(false)
  }

  const editDirty =
    titleDraft.trim() !== task.title ||
    detailDraft !== task.detail ||
    priorityDraft !== task.priority ||
    parseTags(tagsDraft).join(' ') !== task.tags.join(' ')

  const submitComment = async (): Promise<void> => {
    const text = commentDraft.trim()
    if (!text || busy) return
    // On failure the store's error strip explains it and the draft survives.
    const ok = await store.comment({ id: task.id, text })
    if (ok) setCommentDraft('')
  }

  return (
    <aside style={styles.drawer}>
      <div style={styles.drawerHead}>
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
            <span>{task.assignee ?? L('待认领', 'unclaimed')}</span>
            {task.tags.map((tag) => (
              <span key={tag} className="tb-tag">{tag}</span>
            ))}
          </div>
          <div style={styles.drawerMeta}>
            <span>{L('由 {by} 创建', 'created by {by}', { by: task.created_by })}</span>
            <span>{relTime(task.created_at)}</span>
          </div>

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
              <button type="button" className="tb-btn tb-btn-primary" disabled={busy} onClick={() => update({ id: task.id, action: 'done' })}>
                {L('完成', 'Done')}
              </button>
            )}
            {column === 'done' && (
              <button type="button" className="tb-btn" disabled={busy} onClick={() => update({ id: task.id, action: 'reopen' })}>
                {L('重开', 'Reopen')}
              </button>
            )}
            {column !== 'done' && (
              <button type="button" className="tb-btn tb-btn-danger" disabled={busy} onClick={() => update({ id: task.id, action: 'cancel' })}>
                {L('取消', 'Cancel')}
              </button>
            )}
          </div>

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
              <div style={styles.detailBody}>{task.detail}</div>
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
                  <span style={styles.logMain}>
                    <span style={styles.logEvent}>{eventLabel(entry.event)}</span>
                    <span style={styles.logBy}>{entry.by}</span>
                    <span style={styles.logTime} title={entry.at}>{relTime(entry.at)}</span>
                    {entry.note ? <span style={styles.logNote}>{entry.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  )
}

/** One comment in the task's discussion thread (human and agent alike). */
function CommentRow({ comment }: { comment: TaskComment }): JSX.Element {
  return (
    <li style={styles.logRow}>
      <span style={styles.logDot} />
      <span style={styles.logMain}>
        <span style={styles.logEvent}>{comment.by}</span>
        <span style={styles.logTime} title={comment.at}>{relTime(comment.at)}</span>
        <span style={styles.commentText}>{comment.text}</span>
      </span>
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
 * The roster picker that floats inside the assigned lane after a card is
 * dropped on it: pick a name (the drop's planDrop runs with it), send the
 * card back to the pool, or cancel (backdrop / 取消 / ESC — no request).
 */
function AssignPicker({
  actors,
  current,
  onPick,
  onPool,
  onCancel,
}: {
  actors: string[]
  /** The task's assignee right now (marked, still re-pickable). */
  current: string | null
  onPick(name: string): void
  onPool(): void
  onCancel(): void
}): JSX.Element {
  return (
    <div style={styles.picker}>
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
  // No pick = into the claimable pool.
  const [assignee, setAssignee] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!title.trim() || state.busy) return
    const ok = await store.create({
      title: title.trim(),
      detail,
      priority,
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
    background: 'rgba(220,38,38,0.12)',
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
    width: 260,
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
  cardTop: { display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4, flexShrink: 0 },
  cardTitle: { flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500, lineHeight: 1.45, overflowWrap: 'anywhere' },
  cardTitleCancelled: { textDecoration: 'line-through', color: DIM },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, paddingLeft: 14 },
  cardAge: { marginLeft: 'auto', color: FAINT, fontSize: 10, flexShrink: 0 },
  cardTags: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6, paddingLeft: 14 },
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
  errorText: { color: DANGER, fontSize: 12, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
  backdrop: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 20 },
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
  drawerTitle: { fontSize: 14, fontWeight: 600, lineHeight: 1.45, overflowWrap: 'anywhere' },
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
  commentText: { flexBasis: '100%', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
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
  pickerCurrent: { fontSize: 10, color: ACCENT, flexShrink: 0 },
  pickerEmpty: { color: FAINT, fontSize: 11, padding: '6px 8px', lineHeight: 1.5 },
  pickerFoot: { display: 'flex', flexDirection: 'column', gap: 1, borderTop: `1px solid ${BORDER}`, paddingTop: 4 },
  pickerCancel: { color: DIM },
}
