/**
 * The「统计」view of the board: a macro read on where the work stands and how
 * it is moving, built entirely from the board file (see `stats.ts`).
 *
 * Layout, top to bottom — each band answers one question, and every number is
 * either a count you can act on or a trend you can compare:
 *
 *   1. KPI tiles      — 现状: open / settled / unsettled / WIP / blocked, plus
 *                       median cycle time and rejection rate.
 *   2. 每日流量        — created vs settled per day, with the backlog line.
 *                       The one chart that says "are we keeping up".
 *   3. 分布            — status / priority donuts... expressed as stacked bars
 *                       (no SVG arcs to get wrong: a 100%-wide bar segment is
 *                       exact, and it reads at any width).
 *   4. 负责人          — load + throughput + cycle time per owner.
 *   5. 卡在哪          — cumulative dwell per column (where waiting piles up).
 *
 * Charts are plain divs with percentage widths — no chart library, no SVG
 * math, so it stays crisp in both themes and adds nothing to the bundle.
 *
 * @module dsh-taskboard-kit/client-stats-view
 */

import { useMemo } from 'react'
import type { Board, BoardColumn, TaskPriority } from '../shared/types.ts'
import { L } from './locale.ts'
import { columnLabel, priorityLabel } from './view.ts'
import {
  actionsByActor,
  byOwner,
  byPriority,
  byStatus,
  durationText,
  flow,
  headline,
  percentText,
  todayKey,
  totalValue,
  valueByOwner,
  dwellByColumn,
  type OwnerStat,
  type Slice,
} from './stats.ts'
import {
  ACCENT,
  BG_RAISED,
  BG_SUNK,
  BORDER,
  BORDER_STRONG,
  DANGER,
  DIM,
  FAINT,
  FG,
  LINK,
  TERTIARY,
  WARN,
} from './theme.ts'

/** How many days the trend charts cover. */
const WINDOW_DAYS = 14

const STATUS_COLORS: Record<BoardColumn, string> = {
  pool: FAINT,
  assigned: TERTIARY,
  in_progress: ACCENT,
  review: WARN,
  done: LINK,
  closed: DIM,
}

export function StatsView({ board, now = Date.now() }: { board: Board | null; now?: number }): JSX.Element {
  const head = useMemo(() => headline(board, now), [board, now])
  const days = useMemo(() => flow(board, { days: WINDOW_DAYS, now }), [board, now])
  const status = useMemo(() => byStatus(board), [board])
  const priority = useMemo(() => byPriority(board), [board])
  const owners = useMemo(() => byOwner(board, { days: WINDOW_DAYS, now }), [board, now])
  const dwell = useMemo(() => dwellByColumn(board, now), [board, now])
  const actors = useMemo(() => actionsByActor(board, { days: WINDOW_DAYS, now }), [board, now])
  const value = useMemo(() => valueByOwner(board), [board])
  const total = useMemo(() => totalValue(board), [board])

  if (!board || head.total === 0) {
    return (
      <div style={styles.center}>
        <p style={styles.centerText}>{L('这个板还没有任务，暂时没有可统计的东西。', 'No tasks on this board yet — nothing to measure.')}</p>
      </div>
    )
  }

  const settledShare = head.total === 0 ? 0 : head.settled / head.total

  return (
    <div style={styles.root} className="tb-stats">
      {/* ---------------------------------------------------------- KPI tiles */}
      <section style={styles.section}>
        <SectionTitle
          title={L('现状', 'At a glance')}
          hint={L('只有 closed 算结清；done 是「干完了还没收口」，仍算未结清。', 'Only `closed` is settled; `done` finished but still owes a close, so it counts as open.')}
        />
        <div style={styles.tiles}>
          <Tile label={L('未结清', 'Open')} value={String(head.open)} tone={ACCENT} hint={L('全部还没收口的卡', 'everything not settled')} />
          <Tile label={L('待收口', 'To settle')} value={String(head.unsettled)} tone={LINK} hint={L('done 了但没人 close', 'done, waiting on a close')} />
          <Tile label={L('进行中', 'WIP')} value={String(head.wip)} tone={WARN} hint={L('进行中 + 待审核', 'in progress + in review')} />
          <Tile label={L('被卡住', 'Blocked')} value={String(head.blocked)} tone={head.blocked > 0 ? DANGER : DIM} hint={L('在等某人回复', 'waiting on someone')} />
          <Tile label={L('已结清', 'Settled')} value={String(head.settled)} tone={DIM} hint={percentText(settledShare) + L(' 的卡', ' of all cards')} />
          <Tile
            label={L('中位周期', 'Median cycle')}
            value={durationText(head.medianCycleMs)}
            tone={FG}
            hint={L('从建卡到结清', 'created → settled')}
          />
          <Tile
            label={L('打回率', 'Reject rate')}
            value={percentText(head.rejectRate)}
            tone={head.rejectRate !== null && head.rejectRate > 0.4 ? WARN : DIM}
            hint={L('进了审核的卡里被打回过的比例', 'of cards that reached review')}
          />
          <Tile label={L('价值度合计', 'Total value')} value={String(total)} tone={ACCENT} hint={L('已评估卡片的点数之和', 'sum of estimated points')} />
        </div>
      </section>

      {/* ------------------------------------------------------- daily flow */}
      <section style={styles.section}>
        <SectionTitle
          title={L('每日流量（近 {n} 天）', 'Daily flow (last {n} days)', { n: WINDOW_DAYS })}
          hint={L('柱高 = 当天新建 / 结清；折线 = 累计未结清（只涨不跌说明做得没来得快）。', 'Bars = created / settled per day; the line is the running backlog (a line that only climbs means work arrives faster than it closes).')}
        />
        <FlowChart days={days} />
      </section>

      <div style={styles.twoUp}>
        {/* --------------------------------------------------- distributions */}
        <section style={styles.section}>
          <SectionTitle title={L('按状态', 'By status')} hint={L('卡现在都在哪一列。', 'Where the cards sit right now.')} />
          <StackedBar
            slices={status.map((slice) => ({ ...slice, tone: STATUS_COLORS[slice.key as BoardColumn] ?? DIM }))}
            labelOf={(key) => columnLabel(key as BoardColumn)}
          />
        </section>

        <section style={styles.section}>
          <SectionTitle title={L('按优先级 / 价值度', 'By priority / value')} hint={L('高优先级是否堆积。', 'Whether the urgent stuff piles up.')} />
          <StackedBar
            slices={priority.map((slice) => ({
              ...slice,
              tone: slice.key === 'high' ? DANGER : slice.key === 'medium' ? WARN : FAINT,
            }))}
            labelOf={(key) => priorityLabel(key as TaskPriority)}
          />
          {value.unestimated > 0 && (
            <p style={styles.note}>
              {L('另有 {n} 张卡未评估价值度。', '{n} card(s) carry no value estimate.', { n: value.unestimated })}
            </p>
          )}
        </section>
      </div>

      <div style={styles.twoUp}>
        {/* ------------------------------------------------------------ owners */}
        <section style={styles.section}>
          <SectionTitle title={L('负责人', 'Owners')} hint={L('谁头上挂着最多、谁推得最多。', 'Who carries the most, who moves the most.')} />
          <OwnerTable owners={owners} />
        </section>

        {/* ------------------------------------------------------- where it stalls */}
        <section style={styles.section}>
          <SectionTitle title={L('卡在哪一列', 'Where time piles up')} hint={L('当前未结清卡片在各列的累计停留时长。', 'Cumulative time the open cards have spent in each column.')} />
          <DwellTable rows={dwell} />
          <p style={styles.note}>
            {L('近 {n} 天动作最多的人：', 'Most active in the last {n} days: ', { n: WINDOW_DAYS })}
            {actors.length === 0
              ? L('（无）', '(none)')
              : actors.slice(0, 4).map((row) => `${row.key || L('（无主）', '(unowned)')} ${row.count}`).join(' · ')}
          </p>
        </section>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ pieces

function SectionTitle({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <div style={styles.sectionHead}>
      <h3 style={styles.sectionTitle}>{title}</h3>
      {hint && <span style={styles.sectionHint}>{hint}</span>}
    </div>
  )
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone: string }): JSX.Element {
  return (
    <div style={styles.tile} title={hint}>
      <span style={{ ...styles.tileValue, color: tone }}>{value}</span>
      <span style={styles.tileLabel}>{label}</span>
    </div>
  )
}

/**
 * Created vs settled per day, with the backlog as a line underneath.
 *
 * Bars share one scale (the tallest bar sets it) so the two series compare
 * directly. The backlog is drawn as a real SVG polyline on its own scale —
 * a rotated-div "line" cannot express a polyline, and hand-rolled trig here
 * produced spikes.
 */
function FlowChart({ days }: { days: ReturnType<typeof flow> }): JSX.Element {
  // Trim leading dead days: a board that started three days ago rendered
  // eleven empty columns and squeezed the real data into a sliver. Keep at
  // least a week (a quiet week should read as quiet) and never more than asked.
  const firstActive = days.findIndex((day) => day.created > 0 || day.settled > 0 || day.backlog > 0)
  const from = firstActive < 0 ? Math.max(0, days.length - 7) : Math.max(0, Math.min(firstActive, days.length - 7))
  const shown = days.slice(from)

  const maxBar = Math.max(1, ...shown.map((day) => Math.max(day.created, day.settled)))
  const maxBacklog = Math.max(1, ...shown.map((day) => day.backlog))
  const today = todayKey()

  // One polyline point per day, in a 0…100 viewBox (x) × 0…100 (y, y=100 at 0).
  const points = shown
    .map((day, position) => {
      const x = shown.length === 1 ? 50 : (position / (shown.length - 1)) * 100
      const y = 100 - (day.backlog / maxBacklog) * 100
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <div style={styles.chart}>
      <div style={styles.legend}>
        <LegendKey color={ACCENT} label={L('新建', 'created')} />
        <LegendKey color={DIM} label={L('结清', 'settled')} />
        <LegendKey color={WARN} label={L('未结清累计', 'backlog')} />
      </div>
      <div style={styles.chartBody}>
        <div style={styles.bars}>
          {shown.map((day) => (
            <div
              key={day.day}
              style={styles.barGroup}
              title={`${day.day}\n${L('新建', 'created')}: ${day.created}\n${L('结清', 'settled')}: ${day.settled}\n${L('未结清累计', 'backlog')}: ${day.backlog}`}
            >
              <div style={styles.barStack}>
                <div style={{ ...styles.bar, height: `${(day.created / maxBar) * 100}%`, background: ACCENT }} />
                <div style={{ ...styles.bar, height: `${(day.settled / maxBar) * 100}%`, background: DIM }} />
              </div>
              <span style={styles.barLabel}>{day.day.slice(5)}</span>
            </div>
          ))}
        </div>
        {/* The backlog overlay spans the full plot width so the line lines up
            with the bar centres (each bar is `flex: 1`; the polyline uses the
            same even spacing). */}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={styles.sparkline} aria-hidden>
          <polyline
            points={points}
            fill="none"
            stroke={WARN}
            strokeWidth={1.4}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  )
}

function LegendKey({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span style={styles.legendKey}>
      <span style={{ ...styles.legendDot, background: color }} />
      {label}
    </span>
  )
}

/** A 100%-wide segmented bar: every slice is exact, no arc math. */
function StackedBar({ slices, labelOf }: { slices: Array<Slice & { tone: string }>; labelOf(key: string): string }): JSX.Element {
  if (slices.length === 0) return <p style={styles.note}>{L('（空）', '(empty)')}</p>
  return (
    <div style={styles.stackWrap}>
      <div style={styles.stackBar}>
        {slices.map((slice) => (
          <span
            key={slice.key}
            style={{ ...styles.fill, width: `${slice.share * 100}%`, background: slice.tone }}
            title={`${labelOf(slice.key)}: ${slice.count} (${percentText(slice.share)})`}
          />
        ))}
      </div>
      <ul style={styles.stackList}>
        {slices.map((slice) => (
          <li key={slice.key} style={styles.stackItem}>
            <span style={{ ...styles.legendDot, background: slice.tone }} />
            <span style={styles.stackLabel}>{labelOf(slice.key)}</span>
            <span style={styles.stackValue}>{slice.count}</span>
            <span style={styles.stackShare}>{percentText(slice.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function OwnerTable({ owners }: { owners: OwnerStat[] }): JSX.Element {
  const top = owners.slice(0, 8)
  const maxOpen = Math.max(1, ...top.map((row) => row.open))
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>{L('负责人', 'Owner')}</th>
          <th style={styles.thNum}>{L('未结清', 'Open')}</th>
          <th style={styles.thNum}>{L('待收口', 'Settle')}</th>
          <th style={styles.thNum}>{L('点数', 'Value')}</th>
          <th style={styles.thNum}>{L('中位周期', 'Cycle')}</th>
          <th style={styles.thNum}>{L('动作', 'Actions')}</th>
        </tr>
      </thead>
      <tbody>
        {top.map((row) => (
          <tr key={row.owner || '(none)'}>
            <td style={styles.td}>
              <span style={styles.ownerName}>{row.owner || L('（待认领）', '(pool)')}</span>
              {/* A little inline bar makes the load column scannable. */}
              <span style={styles.loadBar}>
                <span style={{ ...styles.fill, width: `${(row.open / maxOpen) * 100}%`, background: ACCENT }} />
              </span>
            </td>
            <td style={styles.tdNum}>{row.open}</td>
            <td style={{ ...styles.tdNum, color: row.unsettled > 0 ? LINK : DIM }}>{row.unsettled}</td>
            <td style={styles.tdNum}>{row.value}</td>
            <td style={styles.tdNum}>{durationText(row.medianCycleMs)}</td>
            <td style={styles.tdNum}>{row.actions}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DwellTable({ rows }: { rows: ReturnType<typeof dwellByColumn> }): JSX.Element {
  if (rows.length === 0) return <p style={styles.note}>{L('没有未结清的卡。', 'No open cards.')}</p>
  const max = Math.max(1, ...rows.map((row) => row.totalMs))
  return (
    <ul style={styles.dwellList}>
      {rows.map((row) => (
        <li key={row.column} style={styles.dwellRow}>
          <span style={styles.dwellLabel}>{columnLabel(row.column as BoardColumn)}</span>
          <span style={styles.track}>
            <span style={{ ...styles.fill, width: `${(row.totalMs / max) * 100}%`, background: STATUS_COLORS[row.column as BoardColumn] ?? DIM }} />
          </span>
          <span style={styles.dwellValue}>{durationText(row.totalMs)}</span>
          <span style={styles.dwellMeta} title={L('该列最久的一张卡', 'longest single card in this column')}>
            {row.tasks} · {durationText(row.longestMs)}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------ styles

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 },
  center: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerText: { color: DIM, fontSize: 12.5, textAlign: 'center' },
  section: {
    background: BG_SUNK,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '10px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
    minWidth: 0,
  },
  sectionHead: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  sectionTitle: { margin: 0, fontSize: 12.5, fontWeight: 600 },
  sectionHint: { fontSize: 10.5, color: DIM, lineHeight: 1.5 },
  twoUp: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  tiles: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  tile: {
    flex: '1 1 104px',
    minWidth: 104,
    background: BG_RAISED,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  tileValue: { fontSize: 20, fontWeight: 600, lineHeight: 1.15 },
  tileLabel: { fontSize: 11, color: DIM },
  note: { margin: 0, fontSize: 10.5, color: DIM, lineHeight: 1.6 },
  chart: { display: 'flex', flexDirection: 'column', gap: 8 },
  // The plot area: bars on top, the backlog polyline overlaid across the whole
  // width so its x positions match the bar centres.
  chartBody: { position: 'relative' },
  sparkline: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 'calc(100% - 18px)',
    width: '100%',
    overflow: 'visible',
    pointerEvents: 'none',
  },
  legend: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  legendKey: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: DIM },
  legendDot: { width: 8, height: 8, borderRadius: 2, display: 'inline-block', flexShrink: 0 },
  bars: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 132, minWidth: 0, position: 'relative', zIndex: 1 },
  barGroup: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', gap: 2 },
  barStack: { flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 1, minHeight: 0 },
  bar: { flex: 1, maxWidth: 12, borderRadius: '2px 2px 0 0', minHeight: 2 },
  barLabel: { fontSize: 9, color: FAINT, whiteSpace: 'nowrap' },
  stackWrap: { display: 'flex', flexDirection: 'column', gap: 7 },
  stackBar: { display: 'flex', alignItems: 'stretch', height: 10, borderRadius: 5, overflow: 'hidden', background: BG_RAISED, border: `1px solid ${BORDER}` },
  stackList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  stackItem: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 },
  stackLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stackValue: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
  stackShare: { color: DIM, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 },
  th: { textAlign: 'left', color: DIM, fontWeight: 500, fontSize: 10.5, padding: '2px 6px 4px 0', borderBottom: `1px solid ${BORDER}` },
  thNum: { textAlign: 'right', color: DIM, fontWeight: 500, fontSize: 10.5, padding: '2px 0 4px 6px', borderBottom: `1px solid ${BORDER}` },
  td: { padding: '5px 6px 5px 0', borderBottom: `1px solid ${BORDER}`, verticalAlign: 'middle' },
  tdNum: { textAlign: 'right', padding: '5px 0 5px 6px', borderBottom: `1px solid ${BORDER}`, fontVariantNumeric: 'tabular-nums' },
  ownerName: { display: 'inline-block', minWidth: 0, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' },
  loadBar: { display: 'inline-block', width: 46, height: 4, marginLeft: 6, borderRadius: 2, background: BORDER_STRONG, overflow: 'hidden', verticalAlign: 'middle' },
  // Shared bar primitives. The fill MUST be block-level: an inline span inside
  // these tracks collapses to zero height (width alone does not size an inline
  // box vertically), which silently emptied every bar chart.
  track: { flex: 1, height: 7, borderRadius: 4, background: BORDER_STRONG, overflow: 'hidden', minWidth: 40, display: 'block' },
  fill: { display: 'block', height: '100%' },
  dwellList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  dwellRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 },
  dwellLabel: { minWidth: 62, color: FG },
  dwellValue: { minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  dwellMeta: { minWidth: 62, textAlign: 'right', color: DIM, fontSize: 10.5 },
}
