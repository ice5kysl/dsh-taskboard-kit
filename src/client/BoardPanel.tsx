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
  TASK_VALUES,
  columnOf,
  compareTasks,
  type BoardColumn,
  type Task,
  type TaskComment,
  type TaskEvent,
  type TaskPriority,
  type TaskValue,
} from '../shared/types.ts'
import { planDrop, type DropOp } from '../shared/dnd.ts'
import { knownActors } from './actors.ts'
import { conventionSnippet, dispatchSnippet, guideProjectDir, hookSnippetClaude, hookSnippetKimi } from './guide.ts'
import { L } from './locale.ts'
import { renderMarkdown } from './markdown.ts'
import type { TaskboardState, TaskboardStore } from './store.ts'
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
  TB_CSS,
} from './theme.ts'
import { ageText, columnLabel, priorityLabel, runPlanOps, taskRef, useSessionCwd, valueText, type SessionListLike } from './view.ts'

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
  // The「? 指南」overlay.
  const [guideOpen, setGuideOpen] = useState(props.initialGuideOpen === true)

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

  // ESC closes the guide overlay.
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
      <TopBar state={state} store={store} total={tasks.length} onCreate={() => setCreateOpen(true)} onGuide={() => setGuideOpen(true)} />
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

/** Top bar: title, workspace, count, refresh, guide, new task. */
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
            <TaskCard key={task.id} task={task} selected={task.id === state.selectedId} onOpen={() => store.select(task.id)} dnd={dnd} />
          ))
        )}
      </div>
      {overlay}
    </section>
  )
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
 *  card turns translucent while it is being dragged. */
function TaskCard({ task, selected, onOpen, dnd }: { task: Task; selected: boolean; onOpen(): void; dnd: LaneDnd }): JSX.Element {
  const dragging = dnd.dragId === task.id
  return (
    <button
      type="button"
      className={selected ? 'tb-card active' : 'tb-card'}
      style={{ opacity: dragging ? 0.5 : 1 }}
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
      {/* Meta row: priority dot + value badge + #N ref (right end). The title
          gets its own full-width row below — nothing squeezes it anymore. */}
      <div style={styles.cardTop}>
        <span
          style={{ ...styles.dot, background: PRIORITY_COLORS[task.priority] ?? FAINT }}
          title={L('优先级：{p}', 'Priority: {p}', { p: priorityLabel(task.priority) })}
        />
        {task.value != null && (
          <span style={styles.valueBadge} title={L('价值度 {v}', 'Value {v}', { v: valueText(task.value) })}>
            ◆{valueText(task.value)}
          </span>
        )}
        <span style={styles.cardRef} title={task.id}>
          {taskRef(task.id)}
        </span>
      </div>
      <div style={styles.cardTitle}>{task.title}</div>
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
 *
 * Exported for the mini board (MiniBoard), which stacks it as the layer-2
 * drawer with a `style` override (its default positioning is the board
 * panel's right edge).
 */
export function DetailDrawer({ task, state, store, actors, onClose, style }: { task: Task; state: TaskboardState; store: TaskboardStore; actors: string[]; onClose(): void; style?: CSSProperties }): JSX.Element {
  const [tab, setTab] = useState<'detail' | 'comments' | 'activity'>('detail')
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
            {(column === 'done' || column === 'closed') && (
              <button type="button" className="tb-btn" disabled={busy} onClick={() => update({ id: task.id, action: 'reopen' })}>
                {L('重开', 'Reopen')}
              </button>
            )}
            {column !== 'closed' && (
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

/** One comment in the task's discussion thread (human and agent alike).
 *  The text renders as sanitized markdown, same pipeline as the detail. */
function CommentRow({ comment }: { comment: TaskComment }): JSX.Element {
  return (
    <li style={styles.logRow}>
      <span style={styles.logDot} />
      <span style={styles.logMain}>
        <span style={styles.logEvent}>{comment.by}</span>
        <span style={styles.logTime} title={comment.at}>{relTime(comment.at)}</span>
        <span className="tb-md" style={styles.commentText} dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.text) }} />
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
            <div style={styles.guideH}>{L('输入区的小看板', 'The mini board by the composer')}</div>
            <p style={styles.guideP}>
              {L('输入框右下角的 ▤ 按钮（带未完成任务数徽标）拉开一个迷你看板：六个状态块纵排，拖任务行改状态（拖到「已指派」出成员选择器），点行叠出完整详情抽屉；已关闭默认折叠成一行。', 'The ▤ button at the composer\'s right edge (badged with the open-task count) pulls up a mini board: six status blocks stacked vertically — drag a row to change its state (dropping on 已指派 opens the roster picker), click a row to stack the full detail drawer on top; 已关闭 stays collapsed into one row until expanded.')}
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
                <strong>{L('方式 B · msg9 邮件派活', 'B · Dispatch over msg9 mail')}</strong>
                <br />
                {L('切到「消息」页签，发给他们的 msg9 地址（形如 kimi@<项目pod>.ice.msg9.io / claude@<项目pod>.ice.msg9.io，真实地址在联系人/广场里查），正文用「派活模板」+ 任务 ID。', 'Switch to the 消息 tab and mail their msg9 address (of the form kimi@<project-pod>.ice.msg9.io / claude@<project-pod>.ice.msg9.io — look the real one up in Contacts or the Square), with the dispatch template below plus a task id.')}
              </li>
              <li>
                <strong>{L('方式 C · 直接粘进会话', 'C · Paste straight into a session')}</strong>
                <br />
                {L('复制「派活模板」，粘进他们会话的输入框即可。', 'Copy the dispatch template and paste it into their session input.')}
              </li>
            </ul>
            <SnippetBlock label={L('约定模板（存为 AGENTS.md）', 'Convention template (save as AGENTS.md)')} text={conventionSnippet(cli)} />
            <SnippetBlock label={L('派活模板（msg9 / 粘贴）', 'Dispatch template (msg9 / paste)')} text={dispatchSnippet(cli, cwd)} />
          </section>

          <section style={styles.guideSection}>
            <div style={styles.guideH}>{L('自监控 hook（不用 msg9 催）', 'Self-monitoring hooks (no msg9 nudging needed)')}</div>
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
  cardTop: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  // The title is its own full-width row below the meta row, clamped to 2 lines.
  cardTitle: {
    fontSize: 12.5,
    fontWeight: 500,
    lineHeight: 1.45,
    overflowWrap: 'anywhere',
    marginTop: 4,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  valueBadge: {
    flexShrink: 0,
    fontSize: 10,
    lineHeight: '14px',
    color: FAINT,
    border: `1px solid ${FAINT}`,
    borderRadius: 999,
    padding: '0 5px',
    whiteSpace: 'nowrap',
  },
  cardRef: { flexShrink: 0, marginLeft: 'auto', fontSize: 10.5, color: FAINT, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 },
  cardAge: { marginLeft: 'auto', color: FAINT, fontSize: 10, flexShrink: 0 },
  cardTags: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 },
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
