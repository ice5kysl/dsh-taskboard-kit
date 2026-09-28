/**
 * The composer-side mini board of dsh-taskboard-kit.
 *
 * Two slot surfaces, one shared store:
 *
 *  1. `conversation.input.right` — a quiet icon button before the composer's
 *     submit action, carrying a badge with the count of not-yet-final tasks
 *     (open + assigned + in_progress + review; hidden at zero). It also
 *     drives `store.setCwd` from the standard session share, so the board is
 *     known even if the 看板 tab was never opened.
 *  2. `conversation.input.overlay` — the mini board drawer. The shell mounts
 *     overlay entries inside an absolutely-positioned zero-height anchor at
 *     the composer card's top edge (verified in dsh-client-ui-conversation:
 *     `overlayAnchor { height:0; position:absolute; inset:0 0 auto }`), so
 *     the sheet anchors `right:0; bottom:8px` and floats upward over the
 *     conversation — no measuring, no clipping (the slot exists for floating
 *     entries, e.g. the shipped slash-command popup).
 *
 * Inside the drawer: six status blocks (待认领/已指派/进行中/待审核/已完成 +
 * 已关闭 collapsed to a toggle row), compact draggable rows (#N · title ·
 * assignee · priority dot · ◆value), drops compiled by the shared planDrop +
 * runPlanOps pipeline (a drop on 已指派 opens the shared roster picker), and
 * a row click stacks the shared DetailDrawer as layer 2.
 *
 * @module dsh-taskboard-kit/client-mini-board
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
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
import type { TaskboardStore } from './store.ts'
import { BG, BORDER, BORDER_STRONG, DIM, FAINT, FG, LINK, ON_PRIMARY, PRIORITY_COLORS, TB_CSS } from './theme.ts'
import { columnLabel, openTaskCount, priorityLabel, runPlanOps, taskRef, useSessionCwd, valueText, type SessionListLike } from './view.ts'

/** Props handed by the slot: the injected store + the standard session share. */
export interface MiniBoardProps {
  store: TaskboardStore
  useSessions?: (selector: (state: SessionListLike) => unknown) => unknown
}

/** Drag wiring inside the mini sheet (same shape as the board's LaneDnd). */
interface MiniDnd {
  dragId: string | null
  overColumn: BoardColumn | null
  setDragId(id: string | null): void
  setOverColumn(column: BoardColumn | null): void
  onDropTask(id: string, column: BoardColumn): void
}

/** The entry button before the composer submit action. */
export function MiniBoardButton(props: MiniBoardProps): JSX.Element {
  const { store } = props
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const cwd = useSessionCwd(props)

  // The composer is resident: this button is what makes the store follow the
  // session even when the 看板 tab never opens.
  useEffect(() => {
    store.setCwd(cwd ?? null)
  }, [store, cwd])

  const open = openTaskCount(state.board)
  return (
    <>
      <style>{TB_CSS}</style>
      <button
        type="button"
        className="tb-iconbtn"
        style={styles.entryButton}
        onClick={() => store.setMiniOpen(!state.miniOpen)}
        title={state.miniOpen ? L('收起迷你看板', 'Close the mini board') : L('任务看板', 'Task board')}
      >
        <span style={styles.entryIcon}>▤</span>
        {open > 0 && <span style={styles.entryBadge}>{open}</span>}
      </button>
    </>
  )
}

/** The floating mini board sheet (null while closed). */
export function MiniBoardOverlay(props: MiniBoardProps): JSX.Element | null {
  const { store } = props
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<BoardColumn | null>(null)
  const [pickerId, setPickerId] = useState<string | null>(null)
  const [closedOpen, setClosedOpen] = useState(false)

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
  const selectedId = state.selectedId
  const selected: Task | null = selectedId && board ? board.tasks[selectedId] ?? null : null
  const pickerTask: Task | null = pickerId && board ? board.tasks[pickerId] ?? null : null

  // A fresh open shows fresh data.
  useEffect(() => {
    if (state.miniOpen) void store.refresh()
  }, [state.miniOpen, store])

  // ESC unwinds one layer at a time: picker → detail drawer → sheet.
  useEffect(() => {
    if (!state.miniOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (pickerId) setPickerId(null)
      else if (selected) store.select(null)
      else store.setMiniOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.miniOpen, pickerId, selected, store])

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

  if (!state.miniOpen) return null

  return (
    <>
      <style>{TB_CSS}</style>
      <aside style={styles.sheet}>
        <div style={styles.sheetHead}>
          <span style={styles.sheetTitle}>{L('看板', 'Board')}</span>
          <span style={styles.sheetCount}>{L('{n} 个进行中', '{n} open', { n: openTaskCount(board) })}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="tb-iconbtn" onClick={() => store.setMiniOpen(false)} title={L('关闭', 'Close')}>
            ×
          </button>
        </div>
        <div style={styles.sheetBody}>
          {!state.cwd ? (
            <div style={styles.sheetEmpty}>{L('没有选中的会话。', 'No session selected.')}</div>
          ) : !board ? (
            <div style={styles.sheetEmpty}>{L('正在加载看板…', 'Loading the board…')}</div>
          ) : tasks.length === 0 ? (
            <div style={styles.sheetEmpty}>
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
                  onOpenTask={(id) => store.select(id)}
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
          onClose={() => store.select(null)}
          style={styles.detailOverlay}
        />
      )}
    </>
  )
}

/** One status block in the sheet: header + compact rows + drop target. */
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
  entryButton: { position: 'relative' },
  entryIcon: { fontSize: 14, lineHeight: 1 },
  entryBadge: {
    position: 'absolute',
    top: -5,
    right: -6,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    background: LINK,
    color: ON_PRIMARY,
    fontSize: 9,
    fontWeight: 600,
    lineHeight: '14px',
    padding: '0 4px',
    textAlign: 'center',
  },
  // The overlay entry's parent is the shell's zero-height absolute anchor at
  // the composer card's top edge: bottom:8 floats the sheet just above it.
  sheet: {
    position: 'absolute',
    right: 0,
    bottom: 8,
    width: 400,
    maxWidth: '96vw',
    maxHeight: 'min(72vh, 640px)',
    display: 'flex',
    flexDirection: 'column',
    background: BG,
    border: `1px solid ${BORDER_STRONG}`,
    borderRadius: 12,
    boxShadow: '0 12px 32px rgba(0,0,0,0.24)',
    overflow: 'hidden',
    zIndex: 40,
    color: FG,
    fontSize: 13,
  },
  sheetHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom: `1px solid ${BORDER}`,
    flexShrink: 0,
  },
  sheetTitle: { fontSize: 13, fontWeight: 600 },
  sheetCount: { fontSize: 11, color: DIM },
  sheetBody: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 },
  sheetEmpty: { color: DIM, fontSize: 12, lineHeight: 1.6, padding: 12, textAlign: 'center' },
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
  // Layer 2: the shared DetailDrawer stacked over the sheet, nudged up-left
  // so the layer underneath still peeks out.
  detailOverlay: {
    top: 'auto',
    left: 'auto',
    right: 8,
    bottom: 16,
    width: 420,
    maxWidth: '96vw',
    maxHeight: 'min(76vh, 680px)',
    border: `1px solid ${BORDER_STRONG}`,
    borderRadius: 12,
    boxShadow: '0 16px 40px rgba(0,0,0,0.28)',
    zIndex: 41,
  },
}
