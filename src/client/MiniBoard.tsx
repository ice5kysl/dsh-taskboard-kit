/**
 * The status-bar-side mini board of dsh-taskboard-kit.
 *
 * Two slot surfaces, one shared store:
 *
 *  1. `conversation.composer.dock` (list/session) — the entry. The shipped
 *     stats pills (「3 轮 73 步 · 262 tok/s · …」) occupy this dock as the
 *     order-0 entry id 'stats' — a CENTERED row whose right end is empty.
 *     We add a zero-height anchor right after it and float a quiet pill
 *     button up into the row's right end (absolute against our own anchor —
 *     no host class names, no measuring). Being resident in the composer,
 *     this button is also what drives `store.setCwd` from the session share
 *     when the 看板 tab never opens.
 *  2. `shell.overlay` (list/root) — the drawer: a full-height right-edge
 *     side drawer over the whole frame. The layer is portal'd to body,
 *     outside the --dsw-alias-* token scope (they're defined on
 *     `body[data-ds-dark-theme]` / `body`), so on open we copy every token
 *     the sheet uses from document.body onto the drawer root
 *     (`inheritThemeTokens`, the insights-kit pattern) and re-copy on theme
 *     flips via a MutationObserver on body's data-ds-dark-theme.
 *
 * Inside the drawer: six status blocks (待认领/已指派/进行中/待审核/已完成 +
 * 已关闭 collapsed to a toggle row), compact draggable rows (#N · title ·
 * assignee · priority dot · ◆value), drops compiled by the shared planDrop +
 * runPlanOps pipeline (a drop on 已指派 opens the shared roster picker), and
 * a row click stacks the shared DetailDrawer as layer 2. ESC and the backdrop
 * unwind one layer at a time: picker → detail → drawer.
 *
 * Selection is deliberately split: the mini drawer's open task is
 * component-local state (unmounted with the drawer, so closing leaves no
 * residue), while the board tab owns `store.selectedId` — a shared selection
 * rendered BOTH surfaces' detail drawers on top of each other.
 *
 * @module dsh-taskboard-kit/client-mini-board
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import {
  BOARD_COLUMNS,
  columnOf,
  compareTasks,
  type BoardColumn,
  type Task,
} from '../shared/types.ts'
import { planDrop } from '../shared/dnd.ts'
import { knownActors } from './actors.ts'
import { L } from './locale.ts'
import { AssignPicker, DetailDrawer } from './BoardPanel.tsx'
import type { TaskboardState, TaskboardStore } from './store.ts'
import { getTaskboardStore } from './store.ts'
import { BG, BG_RAISED, BORDER, BORDER_STRONG, DIM, FAINT, FG, LINK, ON_PRIMARY, PRIORITY_COLORS, TB_CSS } from './theme.ts'
import { columnLabel, openTaskCount, priorityLabel, runPlanOps, taskRef, useSessionCwd, valueText, type SessionListLike } from './view.ts'

/** Props handed by the slot: the injected store + the standard session share.
 *  store falls back to the singleton so a slot that ignores inject() still
 *  gets the same one. */
export interface MiniBoardProps {
  store?: TaskboardStore
  useSessions?: (selector: (state: SessionListLike) => unknown) => unknown
  /** Open the layer-2 detail for this task on first render (tests drive it). */
  initialSelectedId?: string
}

/** Drag wiring inside the mini drawer (same shape as the board's LaneDnd). */
interface MiniDnd {
  dragId: string | null
  overColumn: BoardColumn | null
  setDragId(id: string | null): void
  setOverColumn(column: BoardColumn | null): void
  onDropTask(id: string, column: BoardColumn): void
}

/**
 * The entry: a quiet pill floated into the stats row's empty right end.
 * The dock renders the shipped stats row (order 0, centered) then us — a
 * zero-height full-width anchor; the pill is absolutely positioned against
 * it, up into the row. Nothing blocks the pills: the row's right end is
 * empty space (its content is centered).
 */
export function MiniBoardButton(props: MiniBoardProps): JSX.Element {
  const store = props.store ?? getTaskboardStore()
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const cwd = useSessionCwd(props)

  // The composer is resident: this button is what makes the store follow the
  // session even when the 看板 tab never opens.
  useEffect(() => {
    store.setCwd(cwd ?? null)
  }, [store, cwd])

  const open = openTaskCount(state.board)
  return (
    <div style={styles.dockAnchor}>
      <style>{TB_CSS}</style>
      <button
        type="button"
        className="tb-mini-entry"
        style={styles.entryPill}
        onClick={() => store.setMiniOpen(!state.miniOpen)}
        title={state.miniOpen ? L('收起看板抽屉', 'Close the board drawer') : L('任务看板', 'Task board')}
      >
        <span aria-hidden style={styles.entryIcon}>▤</span>
        <span>{L('看板', 'Board')}</span>
        {open > 0 && <span style={styles.entryCount}>· {open}</span>}
      </button>
    </div>
  )
}

/** Tokens the drawer (and everything inside it) read — copied onto the
 *  drawer root because shell.overlay portals out of the themed subtree. */
const THEME_TOKENS = [
  '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-label-dimmed', '--dsw-alias-label-primary-foreground',
  '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-brand-primary', '--dsw-alias-link', '--dsw-alias-button-info-hover',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary',
  '--dsw-alias-bg-mask-1',
] as const

/** Copy the live token values from the themed body onto the drawer root. */
function inheritThemeTokens(root: HTMLElement): void {
  const body = typeof document !== 'undefined' ? document.body : null
  if (!body || typeof getComputedStyle !== 'function') return
  const computed = getComputedStyle(body)
  for (const name of THEME_TOKENS) {
    const value = computed.getPropertyValue(name).trim()
    if (value) root.style.setProperty(name, value)
  }
}

/** The full-height right-edge drawer (null while closed). The wrapper owns
 *  the open/closed gate; ALL interaction state lives in the content
 *  component, which unmounts on close — nothing survives into the next open. */
export function MiniBoardDrawer(props: MiniBoardProps): JSX.Element | null {
  const store = props.store ?? getTaskboardStore()
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  if (!state.miniOpen) return null
  return <MiniBoardDrawerContent store={store} state={state} initialSelectedId={props.initialSelectedId} />
}

function MiniBoardDrawerContent({ store, state, initialSelectedId }: { store: TaskboardStore; state: TaskboardState; initialSelectedId?: string }): JSX.Element {  const [dragId, setDragId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<BoardColumn | null>(null)
  const [pickerId, setPickerId] = useState<string | null>(null)
  const [closedOpen, setClosedOpen] = useState(false)
  // The mini drawer's open task is LOCAL — the board tab owns store.selectedId
  // (the shared-store selection rendered both drawers on top of each other).
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const backdropRef = useRef<HTMLDivElement>(null)

  const board = state.board
  const tasks = useMemo(() => (board ? Object.values(board.tasks) : []), [board])
  const actors = useMemo(() => (board ? knownActors(board) : []), [board])
  const sections = useMemo(
    () =>
      BOARD_COLUMNS.map((column) => ({
        column,
        tasks: tasks.filter((task) => columnOf(task) === column).sort(compareTasks),
      })),
    [tasks],
  )
  const selected: Task | null = selectedId && board ? board.tasks[selectedId] ?? null : null
  const pickerTask: Task | null = pickerId && board ? board.tasks[pickerId] ?? null : null

  // A fresh open shows fresh data.
  useEffect(() => {
    void store.refresh()
  }, [store])

  // Portal'd out of the themed subtree: copy the tokens onto the backdrop
  // (the shared ancestor of both drawer layers) on open, and re-copy if the
  // theme flips while the drawer is open.
  useEffect(() => {
    const root = backdropRef.current
    if (!root) return
    inheritThemeTokens(root)
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
    const observer = new MutationObserver(() => inheritThemeTokens(root))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
    return () => observer.disconnect()
  }, [])

  const unwind = (): void => {
    if (pickerId) setPickerId(null)
    else if (selected) setSelectedId(null)
    else store.setMiniOpen(false)
  }

  // ESC unwinds one layer at a time: picker → detail drawer → drawer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') unwind()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const runDrop = async (id: string, target: BoardColumn): Promise<void> => {
    const task = tasks.find((row) => row.id === id)
    if (!task) return
    if (target === 'assigned') {
      // Same interaction as the board tab: pick from the roster, never type.
      setPickerId(id)
      return
    }
    await runPlanOps(store, task.id, planDrop(task, target))
  }

  const dnd: MiniDnd = {
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

  return (
    <div ref={backdropRef} style={styles.backdrop}>
      {/* Click catcher below both drawer layers (no stopPropagation games). */}
      <div style={styles.catcher} onClick={unwind} />
      <style>{TB_CSS}</style>
      <aside style={styles.drawer}>
        <div style={styles.drawerHead}>
          <span style={styles.drawerTitle}>{L('看板', 'Board')}</span>
          <span style={styles.drawerCount}>{L('{n} 个进行中', '{n} open', { n: openTaskCount(board) })}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="tb-iconbtn" onClick={() => store.setMiniOpen(false)} title={L('关闭', 'Close')}>
            ×
          </button>
        </div>
        <div style={styles.drawerBody}>
          {!state.cwd ? (
            <div style={styles.drawerEmpty}>{L('进入一个会话后，这里显示该工作区的看板。', 'Open a session to see its workspace board here.')}</div>
          ) : !board ? (
            state.status === 'error' ? (
              <div style={styles.drawerEmpty}>
                <p>{L('无法读取看板：{error}', 'Cannot read the board: {error}', { error: state.error ?? '?' })}</p>
                <button type="button" className="tb-btn tb-btn-primary" onClick={() => void store.refresh()}>
                  {L('重试', 'Retry')}
                </button>
              </div>
            ) : (
              <div style={styles.drawerEmpty}>{L('正在加载看板…', 'Loading the board…')}</div>
            )
          ) : tasks.length === 0 ? (
            <div style={styles.drawerEmpty}>
              {L('还没有任务——到「看板」页签新建，或让 Agent 用 taskboard_create 建一个。', 'No tasks yet — create one in the 看板 tab, or ask the agent to run taskboard_create.')}
            </div>
          ) : (
            sections.map(({ column, tasks: list }) =>
              column === 'closed' && !closedOpen ? (
                <ClosedRow key={column} count={list.length} dnd={dnd} onExpand={() => setClosedOpen(true)} />
              ) : (
                <MiniSection
                  key={column}
                  column={column}
                  tasks={list}
                  dnd={dnd}
                  onOpenTask={(id) => setSelectedId(id)}
                  onCollapse={column === 'closed' ? () => setClosedOpen(false) : undefined}
                  picker={
                    column === 'assigned' && pickerTask ? (
                      <AssignPicker
                        actors={actors}
                        current={pickerTask.assignee}
                        style={styles.miniPicker}
                        onPick={(name) => {
                          const task = pickerTask
                          setPickerId(null)
                          void runPlanOps(store, task.id, planDrop(task, 'assigned', name))
                        }}
                        onPool={() => {
                          const task = pickerTask
                          setPickerId(null)
                          void runPlanOps(store, task.id, planDrop(task, 'pool'))
                        }}
                        onCancel={() => setPickerId(null)}
                      />
                    ) : undefined
                  }
                />
              ),
            )
          )}
        </div>
      </aside>
      {selected && (
        <DetailDrawer
          key={selected.id}
          task={selected}
          state={state}
          store={store}
          actors={actors}
          onClose={() => setSelectedId(null)}
          style={styles.detailOverlay}
        />
      )}
    </div>
  )
}

/** One status block in the drawer: header + compact rows + drop target. */
function MiniSection({
  column,
  tasks,
  dnd,
  onOpenTask,
  onCollapse,
  picker,
}: {
  column: BoardColumn
  tasks: Task[]
  dnd: MiniDnd
  onOpenTask(id: string): void
  /** Given only for the expanded closed block: folds it back into the row. */
  onCollapse?: () => void
  /** The roster picker floats inside the assigned block after a drop. */
  picker?: JSX.Element
}): JSX.Element {
  return (
    <section
      style={styles.miniSec}
      className={dnd.overColumn === column ? 'tb-mini-sec dragover' : 'tb-mini-sec'}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (dnd.overColumn !== column) dnd.setOverColumn(column)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        dnd.setOverColumn(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        const id = event.dataTransfer.getData('text/plain')
        if (id) dnd.onDropTask(id, column)
      }}
    >
      <div style={styles.miniSecHead}>
        <span style={styles.miniSecTitle}>{columnLabel(column)}</span>
        <span style={styles.miniSecCount}>{tasks.length}</span>
        <span style={{ flex: 1 }} />
        {onCollapse && (
          <button type="button" className="tb-iconbtn" onClick={onCollapse} title={L('收起已关闭', 'Collapse closed')}>
            ⇥
          </button>
        )}
      </div>
      {tasks.length === 0 ? (
        <div style={styles.miniEmpty}>{L('（空）', '(empty)')}</div>
      ) : (
        tasks.map((task) => (
          <MiniRow key={task.id} task={task} dragging={dnd.dragId === task.id} dnd={dnd} onOpen={() => onOpenTask(task.id)} />
        ))
      )}
      {picker}
    </section>
  )
}

/** One compact task row: #N · title (truncated) · assignee · dot · ◆value. */
function MiniRow({ task, dragging, dnd, onOpen }: { task: Task; dragging: boolean; dnd: MiniDnd; onOpen(): void }): JSX.Element {
  return (
    <button
      type="button"
      className={dragging ? 'tb-mini-row dragging' : 'tb-mini-row'}
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
      title={task.title}
    >
      <span style={styles.miniRef}>{taskRef(task.id)}</span>
      <span style={styles.miniTitle}>{task.title}</span>
      {task.assignee ? (
        <span className="tb-badge" style={styles.miniAssignee} title={task.assignee}>{task.assignee}</span>
      ) : (
        <span className="tb-badge-outline" style={styles.miniAssignee}>{L('待认领', 'unclaimed')}</span>
      )}
      <span
        style={{ ...styles.miniDot, background: PRIORITY_COLORS[task.priority] ?? FAINT }}
        title={L('优先级：{p}', 'Priority: {p}', { p: priorityLabel(task.priority) })}
      />
      {task.value != null && (
        <span style={styles.miniValue} title={L('价值度 {v}', 'Value {v}', { v: valueText(task.value) })}>
          ◆{valueText(task.value)}
        </span>
      )}
    </button>
  )
}

/** The collapsed 已关闭 row: a one-line toggle that stays a live drop target. */
function ClosedRow({ count, dnd, onExpand }: { count: number; dnd: MiniDnd; onExpand(): void }): JSX.Element {
  return (
    <button
      type="button"
      style={styles.miniClosedBar}
      className={dnd.overColumn === 'closed' ? 'tb-mini-closed tb-mini-sec dragover' : 'tb-mini-closed'}
      onClick={onExpand}
      title={L('展开已关闭', 'Expand closed')}
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
      <span style={styles.miniSecTitle}>{L('已关闭 ({n})', 'Closed ({n})', { n: count })}</span>
      <span style={{ flex: 1 }} />
      <span style={styles.miniClosedHint}>{L('展开', 'show')}</span>
    </button>
  )
}

// ------------------------------------------------------------------ styles

const styles: Record<string, CSSProperties> = {
  // Zero-height anchor right after the stats row in the composer dock; the
  // pill floats UP into the row's empty right end. Same width cap as the row.
  dockAnchor: {
    position: 'relative',
    width: '100%',
    maxWidth: 'var(--dsh-chat-content-width)',
    height: 0,
    overflow: 'visible',
    margin: '0 auto',
    fontSize: 'var(--dsh-content-font-size-secondary, 12px)',
    lineHeight: '20px',
    zIndex: 5,
  },
  // The pill: right end of the stats row (the row's content is centered, so
  // the right end is empty space). bottom:1 floats it up off the anchor line
  // into the row band.
  entryPill: {
    position: 'absolute',
    right: 'calc(var(--dsh-composer-side-clearance, 0px) + 16px)',
    bottom: 1,
  },
  entryIcon: { fontSize: 13, lineHeight: 1 },
  entryCount: { color: DIM, fontVariantNumeric: 'tabular-nums' },
  // The overlay frame: fixed full-viewport dimmer (plain alpha like every
  // shell overlay backdrop — no token needed), the drawer pinned right.
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    justifyContent: 'flex-end',
    background: 'rgba(15,18,26,0.42)',
    // The shell.overlay layer is click-through; entries opt back in.
    pointerEvents: 'auto',
  },
  // Click-outside catcher: a plain layer under both drawers (they are
  // positioned siblings painted later, so their clicks never reach it).
  catcher: { position: 'absolute', inset: 0 },
  drawer: {
    position: 'relative', // paints above the absolute catcher
    width: 560,
    // Never wider than ~45% of the conversation area (vw ≈ 会话区 + 侧栏，
    // 这个近似足够): long task titles get the room, narrow windows stay sane.
    maxWidth: 'min(560px, 45vw)',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: BG,
    color: FG,
    borderLeft: `1px solid ${BORDER_STRONG}`,
    boxShadow: '-24px 0 64px rgba(15,18,26,0.35)',
    fontSize: 13,
  },
  drawerHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderBottom: `1px solid ${BORDER}`,
    flexShrink: 0,
  },
  drawerTitle: { fontSize: 13, fontWeight: 600 },
  drawerCount: { fontSize: 11, color: DIM },
  drawerBody: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  drawerEmpty: { color: DIM, fontSize: 12, lineHeight: 1.6, padding: 16, textAlign: 'center' },
  miniSec: {
    position: 'relative', // anchors the roster picker
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  miniSecHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px' },
  miniSecTitle: { fontSize: 11, fontWeight: 600, color: DIM },
  miniSecCount: {
    fontSize: 10,
    color: DIM,
    border: `1px solid ${BORDER}`,
    borderRadius: 999,
    padding: '0 6px',
  },
  miniEmpty: { color: FAINT, fontSize: 11, padding: '2px 8px 6px' },
  miniRef: { flexShrink: 0, fontSize: 10.5, color: FAINT, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  miniTitle: { flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  miniAssignee: { flexShrink: 0 },
  miniDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  miniValue: { flexShrink: 0, fontSize: 10, color: FAINT, border: `1px solid ${FAINT}`, borderRadius: 999, padding: '0 5px', lineHeight: '14px' },
  miniClosedBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    background: 'transparent',
    color: DIM,
    padding: '6px 10px',
    fontSize: 11,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  miniClosedHint: { fontSize: 10, color: FAINT },
  miniPicker: { top: 26, left: 4, right: 4 },
  // Layer 2: the shared DetailDrawer stacked over the drawer. Both layers keep
  // the right edge flush to the frame; the stack reads through the OFFSETS —
  // the detail is 40px narrower (its left edge exposes a strip of the board
  // drawer) and floats 12px off the top and bottom (the board drawer's
  // corners peek out). Its own full border + raised bg (layer-3 over the
  // drawer's layer-2) keep the two layers legible in BOTH themes.
  detailOverlay: {
    top: 12,
    left: 'auto',
    right: 0,
    bottom: 12,
    width: 520,
    maxWidth: 'min(520px, calc(45vw - 40px))',
    background: BG_RAISED,
    border: `1px solid ${BORDER_STRONG}`,
    borderRadius: '10px 0 0 10px',
    zIndex: 2,
    boxShadow: '-24px 0 64px rgba(15,18,26,0.42)',
  },
}
