/**
 * The「统计」view of the board: a macro read on where the work stands, how it is
 * moving, and **who owes the next move** — built entirely from the board file
 * (see `stats.ts`; this file only renders).
 *
 * Layout, top to bottom — each band answers one question:
 *
 *   1. 时间窗        — 7 / 14 / 30 天。所有窗口相关的数字都吃它。
 *   2. KPI 分组      — 「要你动手的」与「背景数字」两组，每格带与上一等长
 *                      窗口的环比 + 迷你走势；样本不足时说"样本不足"。
 *   3. 现在该动什么  — 持球人排行（谁欠什么动作、欠了多久）+ 异常清单，
 *                      每条可点开该卡的详情抽屉。
 *   4. 每日流量      — 双轴：每天新建/结清（柱）+ 累计未结清（线），
 *                      带 y 轴刻度、网格与数值标签。
 *   5. 分布          — 状态环形图（中心是未结清数）/ 优先级条。
 *   6. 卡在哪一列    — 按**中位年龄**排序的停留条 + SLA 阈值线。
 *   7. 价值度        — 积压 ◆ vs 窗口内交付 ◆、吞吐、每卡均值。
 *   8. 里程碑        — 由 `v1.42.0` 这类 tag 派生，可点开看该里程碑的卡。
 *   9. 负责人        — 负载 + 周期（背景数字）。
 *
 * Charts are inline SVG plus plain divs — no chart library, host theme tokens
 * only. Every string is written in both languages at the call site.
 *
 * @module dsh-taskboard-kit/client-stats-view
 */

import { useMemo, useState } from 'react'
import type { Board, BoardColumn, Task, TaskPriority } from '../shared/types.ts'
import { L } from './locale.ts'
import { columnLabel, priorityLabel } from './view.ts'
import { holderActionLabel } from './BoardPanel.tsx'
import {
  DEFAULT_WINDOW_DAYS,
  WINDOW_CHOICES,
  anomalies,
  byOwner,
  byPriority,
  byStatus,
  dayKey,
  durationText,
  dwellByColumn,
  flow,
  headline,
  kpis,
  milestones,
  niceAxis,
  percentText,
  valueView,
  holderGroups,
  actionsByActor,
  valueByOwner,
  type Anomaly,
  type AnomalyKind,
  type DayFlow,
  type HolderGroup,
  type Kpi,
  type KpiKey,
  type Metric,
  type Milestone,
  type OwnerStat,
  type Slice,
  type WindowDays,
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

/** 每列一个记号，与看板列头同一套语义（见下方 SERIES_* 关于 ACCENT 的说明）。 */
const STATUS_COLORS: Record<BoardColumn, string> = {
  pool: FAINT,
  assigned: TERTIARY,
  in_progress: LINK,
  review: WARN,
  done: ACCENT,
  closed: DIM,
}

// --------------------------------------------------------------- flow chart

/** 流量图的像素常量：柱子区 + 数值标签留白 + 日期行。 */
const FLOW_SCALE_PX = 104 // 坐标轴顶（= 最大柱高）到基线的像素
const FLOW_BAR_PX = 118 // 柱子行高：比 scale 多 14px，留给柱子顶上的数值标签
const FLOW_DAY_PX = 16 // x 轴日期行

/**
 * 图表系列的取色（全部是宿主 token，不自造配色）。
 *
 * 为什么「新建」用 `LINK` 而不是 `ACCENT`：这块 shell 的
 * `--dsw-alias-brand-primary` 在两个主题里都**不是彩色**（light = bluish-1000
 * ≈ #0f1115 近黑，dark = bluish-50 近白），拿它画两条柱子等于只靠明度区分，
 * 在深色主题下几乎读不出来。`--dsw-alias-link` 两个主题都是同一个蓝，
 * 才是图表系列该用的强调色。
 */
const SERIES_CREATED = LINK
const SERIES_SETTLED = TERTIARY
const SERIES_BACKLOG = WARN

export interface StatsViewProps {
  board: Board | null
  /** 「现在」的时刻（测试与截图里可固定）；默认取真实时间。 */
  now?: number
  /** 点开一张卡的详情抽屉 —— 由 BoardPanel 注入 `store.select(id)`。 */
  onOpenTask?: (id: string) => void
}

export function StatsView({ board, now = Date.now(), onOpenTask }: StatsViewProps): JSX.Element {
  const [days, setDays] = useState<WindowDays>(DEFAULT_WINDOW_DAYS)
  const [openMilestone, setOpenMilestone] = useState<string | null>(null)

  const head = useMemo(() => headline(board, now), [board, now])
  const metrics = useMemo(() => kpis(board, { days, now }), [board, days, now])
  const dayRows = useMemo(() => flow(board, { days, now }), [board, days, now])
  const status = useMemo(() => byStatus(board), [board])
  const priority = useMemo(() => byPriority(board), [board])
  const owners = useMemo(() => byOwner(board, { days, now }), [board, days, now])
  const dwell = useMemo(() => dwellByColumn(board, now), [board, now])
  const actors = useMemo(() => actionsByActor(board, { days, now }), [board, days, now])
  const value = useMemo(() => valueByOwner(board), [board])
  const holders = useMemo(() => holderGroups(board, { now }), [board, now])
  const problems = useMemo(() => anomalies(board, { days, now }), [board, days, now])
  const valueRows = useMemo(() => valueView(board, { days, now }), [board, days, now])
  const stones = useMemo(() => milestones(board), [board])

  if (!board || head.total === 0) {
    return (
      <div style={styles.center}>
        <p style={styles.centerText}>{L('这个板还没有任务，暂时没有可统计的东西。', 'No tasks on this board yet — nothing to measure.')}</p>
      </div>
    )
  }

  const settledShare = head.total === 0 ? 0 : head.settled / head.total
  const tasks = board.tasks

  return (
    <div style={styles.root} className="tb-stats">
      {/* ------------------------------------------------------- 时间窗 */}
      <div style={styles.windowBar}>
        <span style={styles.windowLabel}>{L('时间窗', 'Window')}</span>
        {WINDOW_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            className={choice === days ? 'tb-chip active' : 'tb-chip'}
            style={choice === days ? { ...styles.chip, ...styles.chipActive } : styles.chip}
            aria-pressed={choice === days}
            onClick={() => setDays(choice)}
            title={L('近 {n} 天（所有窗口相关的数字都按它算）', 'Last {n} days (every windowed number follows it)', { n: choice })}
          >
            {L('近 {n} 天', '{n} days', { n: choice })}
          </button>
        ))}
        <span style={styles.windowNote}>
          {L('环比 = 与它前面那个等长窗口比（近 {n} 天 vs 前 {n} 天）', 'Deltas compare with the equal-length window before it ({n}d vs previous {n}d)', { n: days })}
        </span>
      </div>

      {/* --------------------------------------------------------- KPI 分组 */}
      <section style={styles.section}>
        <SectionTitle
          title={L('现状', 'At a glance')}
          hint={L('只有 closed 算结清；done 是「干完了还没收口」，仍算未结清。', 'Only `closed` is settled; `done` finished but still owes a close, so it counts as open.')}
        />
        <div style={styles.kpiGroups}>
          <KpiGroup
            title={L('要你动手的', 'Needs you')}
            hint={L('这些数字变大 = 有人欠动作', 'when these climb, somebody owes a move')}
            specs={ACTION_KPIS}
            metrics={metrics}
            days={days}
          />
          <KpiGroup
            title={L('背景数字', 'Background')}
            hint={L('看板整体的体量与节奏', 'the board\'s overall size and pace')}
            specs={BACKGROUND_KPIS}
            metrics={metrics}
            days={days}
            extra={<span style={styles.groupExtra}>{L('已结清 {p}', '{p} of all cards settled', { p: percentText(settledShare) })}</span>}
          />
        </div>
      </section>

      {/* --------------------------------------------------- 现在该动什么 */}
      <section style={styles.section}>
        <SectionTitle
          title={L('现在该动什么', 'What to do now')}
          hint={L('球在谁手上、欠什么动作、欠了多久；下面每一条都能点开那张卡。', 'Who holds the ball, what they owe and for how long — every row below opens that card.')}
        />
        <div style={styles.nowSplit}>
          <div style={styles.nowCol}>
            <h4 style={styles.subTitle}>{L('持球人排行', 'Ball holders')}</h4>
            <HolderRanking groups={holders} onOpenTask={onOpenTask} />
          </div>
          <div style={styles.nowCol}>
            <h4 style={styles.subTitle}>
              {L('异常清单', 'Anomalies')}
              <span style={styles.subCount}>{problems.length === 0 ? L('（无）', '(none)') : ` ${problems.length}`}</span>
            </h4>
            <AnomalyList rows={problems} tasks={tasks} onOpenTask={onOpenTask} />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- 每日流量（整行） */}
      <section style={{ ...styles.section, gridColumn: '1 / -1' }}>
        <SectionTitle
          title={L('每日流量（近 {n} 天）', 'Daily flow (last {n} days)', { n: days })}
          hint={L('左轴 = 当天新建 / 结清（柱），右轴 = 累计未结清（线，只涨不跌说明做得没来得快）。', 'Left axis = created / settled per day (bars); right axis = running backlog (line — a line that only climbs means work arrives faster than it closes).')}
        />
        <FlowChart rows={dayRows} now={now} />
      </section>

      <div className="tb-stats-grid">
        {/* ------------------------------------------------- 分布：状态环形图 */}
        <section style={styles.section}>
          <SectionTitle title={L('按状态', 'By status')} hint={L('环中心 = 未结清；每段是一列里的卡数。', 'The ring\'s centre is the open count; each arc is one column.')} />
          <Donut
            slices={status.map((slice) => ({ ...slice, tone: STATUS_COLORS[slice.key as BoardColumn] ?? DIM }))}
            labelOf={(key) => columnLabel(key as BoardColumn)}
            center={String(head.open)}
            centerLabel={L('未结清', 'open')}
          />
        </section>

        {/* ------------------------------------------------------ 卡在哪一列 */}
        <section style={styles.section}>
          <SectionTitle title={L('卡在哪一列', 'Where time piles up')} hint={L('按该列卡的「中位」年龄排序；竖线是该列的陈旧阈值（SLA），条形越过它就该有人管了。', 'Sorted by the MEDIAN age in each column; the vertical rule is that column\'s staleness threshold (SLA) — a bar past it means somebody should act.')} />
          <DwellTable rows={dwell} />
          <p style={styles.note}>
            {L('近 {n} 天动作最多的人：', 'Most active in the last {n} days: ', { n: days })}
            {actors.length === 0
              ? L('（无）', '(none)')
              : actors.slice(0, 4).map((row) => `${row.key || L('（无主）', '(unowned)')} ${row.count}`).join(' · ')}
          </p>
        </section>

        {/* -------------------------------------------------------- 价值度 */}
        <section style={styles.section}>
          <SectionTitle title={L('价值度', 'Value')} hint={L('积压的 ◆ 与这段时间交付的 ◆ 是两回事，分开看。', 'Points sitting in the backlog and points delivered in the window are two different numbers — shown apart.')} />
          <ValuePanel view={valueRows} days={days} />
          {value.unestimated > 0 && (
            <p style={styles.note}>{L('另有 {n} 张卡未评估价值度（不计入任何 ◆ 数字）。', '{n} card(s) carry no value estimate (excluded from every ◆ figure).', { n: value.unestimated })}</p>
          )}
        </section>

        {/* -------------------------------------------------------- 里程碑 */}
        {stones.length > 0 && (
          <section style={styles.section}>
            <SectionTitle title={L('里程碑进度', 'Milestones')} hint={L('把 `v1.42.0` 这类 tag 当里程碑：已结清/总数、◆ 已交付/总；点开看这一版还剩哪些卡。', 'Tags shaped like `v1.42.0` are milestones: settled/total and ◆ delivered/total; open one to see which cards are left.')} />
            <MilestoneList
              rows={stones}
              tasks={tasks}
              openTag={openMilestone}
              onToggle={(tag) => setOpenMilestone(openMilestone === tag ? null : tag)}
              onOpenTask={onOpenTask}
            />
          </section>
        )}

        {/* -------------------------------------------------------- 负责人 */}
        <section style={styles.section}>
          <SectionTitle title={L('负责人', 'Owners')} hint={L('谁头上挂着最多、谁推得最多。', 'Who carries the most, who moves the most.')} />
          <OwnerTable owners={owners} />
        </section>

        {/* --------------------------------------------------- 优先级分布 */}
        <section style={styles.section}>
          <SectionTitle title={L('按优先级 / 价值度', 'By priority / value')} hint={L('高优先级是否堆积。', 'Whether the urgent stuff piles up.')} />
          <StackedBar
            slices={priority.map((slice) => ({
              ...slice,
              tone: slice.key === 'high' ? DANGER : slice.key === 'medium' ? WARN : FAINT,
            }))}
            labelOf={(key) => priorityLabel(key as TaskPriority)}
          />
        </section>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ KPI 分组

interface KpiSpec {
  key: KpiKey
  label: string
  hint: string
  /** `up` = 涨是好事（已结清、价值）；`down` = 涨是坏事（欠的动作变多）。 */
  goodWhen: 'up' | 'down'
  tone: string
}

const ACTION_KPIS: KpiSpec[] = [
  { key: 'open', label: L('未结清', 'Open'), hint: L('全部还没收口的卡（含 done）', 'every card not settled yet (done included)'), goodWhen: 'down', tone: ACCENT },
  { key: 'unsettled', label: L('待收口', 'To settle'), hint: L('done 了但没人 close', 'done, waiting on a close'), goodWhen: 'down', tone: LINK },
  { key: 'blocked', label: L('被卡住', 'Blocked'), hint: L('在等某人回复', 'waiting on someone'), goodWhen: 'down', tone: DANGER },
  { key: 'rejectRate', label: L('打回率', 'Reject rate'), hint: L('进了审核的卡里被打回过的比例', 'of the cards that reached review'), goodWhen: 'down', tone: WARN },
]

const BACKGROUND_KPIS: KpiSpec[] = [
  { key: 'settled', label: L('已结清', 'Settled'), hint: L('窗口内被 close 的卡数', 'cards closed inside the window'), goodWhen: 'up', tone: LINK },
  { key: 'cycle', label: L('中位周期', 'Median cycle'), hint: L('窗口内干完的卡：建卡 → 干完（done/approved）', 'cards finished in the window: created → done'), goodWhen: 'down', tone: FG },
  { key: 'settleLag', label: L('收口延迟', 'Settle lag'), hint: L('窗口内收口的卡：干完 → 收口（done → closed）', 'cards closed in the window: done → closed'), goodWhen: 'down', tone: FG },
  { key: 'wip', label: L('进行中', 'WIP'), hint: L('进行中 + 待审核', 'in progress + in review'), goodWhen: 'down', tone: WARN },
  { key: 'value', label: L('价值合计', 'Total value'), hint: L('板上已评估卡片的点数之和（含历史）', 'sum of estimated points on the board'), goodWhen: 'up', tone: ACCENT },
]

function KpiGroup({ title, hint, specs, metrics, days, extra }: {
  title: string
  hint: string
  specs: KpiSpec[]
  metrics: ReturnType<typeof kpis>
  days: number
  extra?: JSX.Element
}): JSX.Element {
  return (
    <div style={styles.kpiGroup}>
      <div style={styles.kpiGroupHead}>
        <h4 style={styles.subTitle}>{title}</h4>
        <span style={styles.kpiGroupHint}>{hint}</span>
        {extra}
      </div>
      <div className="tb-kpi-grid">
        {specs.map((spec) => (
          <KpiTile key={spec.key} spec={spec} kpi={metrics[spec.key]} days={days} />
        ))}
      </div>
    </div>
  )
}

/**
 * 一个 KPI 格：大数字 + 与上一等长窗口的环比 + 迷你走势。
 *
 * 三件事刻意分开表达：`value`（现在是多少）、`DeltaChip`（比上期好还是坏）、
 * `Sparkline`（这几天的形状）。样本不足时不画箭头 —— 一个 n=1 的中位数配上
 * 「↑40%」看起来像趋势，其实只是两张卡换了顺序。
 */
function KpiTile({ spec, kpi, days }: { spec: KpiSpec; kpi: Kpi; days: number }): JSX.Element {
  const title = [
    spec.hint,
    kpi.value === null
      ? L('本期没有样本', 'no samples in this window')
      : L('近 {n} 天 {v} · 前 {n} 天 {p}', 'last {n}d {v} · previous {n}d {p}', {
        n: days, v: formatKpi(kpi, kpi.value), p: kpi.previous === null ? '—' : formatKpi(kpi, kpi.previous),
      }),
    kpi.n > 0 ? L('样本 n={n}', 'n={n}', { n: kpi.n }) : '',
  ].filter(Boolean).join(' — ')
  return (
    <div style={styles.tile} title={title}>
      <span style={styles.tileLabel}>{spec.label}</span>
      <span style={{ ...styles.tileValue, color: kpi.value === null ? DIM : spec.tone }}>{formatKpi(kpi, kpi.value)}</span>
      <div style={styles.tileFoot}>
        <DeltaChip kpi={kpi} goodWhen={spec.goodWhen} days={days} />
        <Sparkline series={kpi.series} tone={spec.tone} />
      </div>
    </div>
  )
}

/** 按单位格式化：计数/点数原样，时长走 durationText，比率走 percentText。 */
function formatKpi(kpi: Kpi, value: number | null): string {
  if (value === null) return '—'
  switch (kpi.unit) {
    case 'ms': return durationText(value)
    case 'ratio': return percentText(value)
    case 'points': return `◆${Number.isInteger(value) ? value : value.toFixed(1)}`
    default: return String(value)
  }
}

/**
 * 环比徽章。三档，绝不混为一谈：
 *   • 样本够 → 箭头 + 变化幅度（颜色表示"这是好事还是坏事"）；
 *   • 样本不够（中位数/比率两侧 n < 3）→ 明确写「样本不足」，不画箭头；
 *   • 上期是 0 → 百分比没有定义，改说绝对差值（+3）。
 */
function DeltaChip({ kpi, goodWhen, days }: { kpi: Kpi; goodWhen: 'up' | 'down'; days: number }): JSX.Element {
  if (!kpi.comparable) {
    return (
      <span
        className="tb-badge-outline"
        title={L('两侧样本都不足 3 个，这点变化当不了趋势看', 'Fewer than 3 samples on either side — not enough to call this a trend')}
      >
        {L('样本不足', 'low sample')}
      </span>
    )
  }
  if (kpi.diff === null) return <span style={{ ...styles.delta, color: FAINT }}>—</span>
  const diff = kpi.diff
  const good = diff === 0 ? null : (diff > 0) === (goodWhen === 'up')
  const color = good === null ? DIM : good ? LINK : DANGER
  const arrow = diff === 0 ? '·' : diff > 0 ? '▲' : '▼'
  const magnitude = kpi.delta === null ? null : Math.abs(kpi.delta)
  const text = magnitude === null
    ? (diff > 0 ? `+${trim(diff)}` : trim(diff))
    : magnitude > 0 && magnitude < 0.005 ? L('<1%', '<1%') : percentText(magnitude)
  return (
    <span
      style={{ ...styles.delta, color }}
      title={L('对比前 {n} 天：{v}（{sign}{text}）', 'vs the previous {n}d: {v} ({sign}{text})', {
        n: days, v: kpi.previous === null ? '—' : String(kpi.previous), sign: diff > 0 ? '+' : '', text,
      })}
    >
      <span style={styles.deltaArrow}>{arrow}</span>{text}
    </span>
  )
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * 迷你走势：窗口内每个窗口日一个点。只有 1 个点时**不画线** —— 两个点之间
 * 才叫走势，一个点是"就这一个数"。
 */
function Sparkline({ series, tone }: { series: Array<number | null>; tone: string }): JSX.Element {
  const points = series
    .map((value, index) => ({ value, index }))
    .filter((point): point is { value: number; index: number } => point.value !== null)
  if (points.length < 2) return <span style={styles.sparkEmpty}>{L('单点', 'single')}</span>
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (index: number): number => (series.length <= 1 ? 50 : (index / (series.length - 1)) * 100)
  // 0…1 压到 8…92：线头永远不会贴着边框被切掉。
  const y = (value: number): number => 92 - ((value - min) / span) * 84
  const polyline = points.map((point) => `${x(point.index).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ')
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={styles.spark} aria-hidden>
      <polyline
        points={polyline}
        fill="none"
        style={{ stroke: tone }}
        strokeWidth={1.6}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
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

/**
 * A median and the sample size behind it: `1.2h (n=5)`.
 *
 * The `n` is not decoration. A median over one card IS that card, and rendering
 * it bare is how "10.3h" looked like a trend when it was a single sample.
 */
function metricText(metric: Metric): string {
  if (metric.value === null) return '—'
  return metric.n <= 1 ? durationText(metric.value) : `${durationText(metric.value)} (n=${metric.n})`
}

/** Tooltip for a metric: explains what it measures and over how many. */
function metricHint(metric: Metric, what: string): string {
  if (metric.value === null) return L('{what}（还没有样本）', '{what} (no samples yet)', { what })
  if (metric.n <= 1) return L('{what}（只有 1 张卡，不足以当中位数看）', '{what} (only 1 card — not a median)', { what })
  return L('{what}，基于 {n} 张卡', '{what}, over {n} cards', { what, n: metric.n })
}

/**
 * Created vs settled per day, with the backlog as a line on its own axis.
 *
 * Readability (T-28) comes from three things being drawn explicitly instead of
 * implied: a **y axis with ticks on both sides** (left = daily counts, right =
 * backlog), **gridlines** at those ticks, and **value labels** on the bars.
 * The bars scale to the top gridline, so a bar can never poke out of the plot.
 */
function FlowChart({ rows, now }: { rows: DayFlow[]; now: number }): JSX.Element {
  // Trim leading dead days: a board that started three days ago rendered
  // eleven empty columns and squeezed the real data into a sliver. Keep at
  // least a week (a quiet week should read as quiet) and never more than asked.
  const firstActive = rows.findIndex((row) => row.created > 0 || row.settled > 0 || row.backlog > 0)
  const from = firstActive < 0 ? Math.max(0, rows.length - 7) : Math.max(0, Math.min(firstActive, rows.length - 7))
  const shown = rows.slice(from)

  const barAxis = niceAxis(Math.max(1, ...shown.map((row) => Math.max(row.created, row.settled))), 4)
  const lineAxis = niceAxis(Math.max(1, ...shown.map((row) => row.backlog)), 4)
  const today = dayKey(now)
  const total = Math.max(1, shown.length)
  const labelStep = shown.length > 20 ? 3 : shown.length > 12 ? 2 : 1
  const lastBacklog = shown.length > 0 ? shown[shown.length - 1]!.backlog : 0

  // x 用 (i + 0.5) / n：正好落在每个柱组的中心（柱子是 flex:1 等分的）。
  const points = shown
    .map((row, index) => {
      const x = ((index + 0.5) / total) * 100
      const y = FLOW_SCALE_PX - (row.backlog / lineAxis.max) * FLOW_SCALE_PX
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  // 刻度相对"轴自己那个盒子"定位：轴盒与绘图盒同高、底边对齐，所以左右两侧
  // 的刻度天然落在同一条网格线上。
  const tickBottom = (value: number, axisMax: number): number => FLOW_DAY_PX + (value / axisMax) * FLOW_SCALE_PX

  return (
    <div style={styles.chart}>
      <div style={styles.legend}>
        <LegendKey color={SERIES_CREATED} label={L('新建', 'created')} />
        <LegendKey color={SERIES_SETTLED} label={L('结清', 'settled')} />
        <LegendKey color={SERIES_BACKLOG} label={L('未结清累计', 'backlog')} />
      </div>
      <div style={styles.chartRow}>
        {/* 左轴：日流量 */}
        <div style={styles.axis}>
          {barAxis.ticks.map((tick) => (
            <span key={`l${tick}`} style={{ ...styles.axisTick, bottom: tickBottom(tick, barAxis.max) }}>
              {tick}
            </span>
          ))}
        </div>
        <div style={styles.plotWrap}>
          <div style={{ position: 'relative', height: FLOW_BAR_PX + FLOW_DAY_PX }}>
            {/* 网格线 */}
            {barAxis.ticks.map((tick) => (
              <div
                key={`g${tick}`}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: tickBottom(tick, barAxis.max),
                  height: 0,
                  borderTop: `1px ${tick === 0 ? 'solid' : 'dashed'} ${tick === 0 ? BORDER_STRONG : BORDER}`,
                }}
              />
            ))}
            {/* 柱 */}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: FLOW_DAY_PX, height: FLOW_BAR_PX, display: 'flex', alignItems: 'flex-end', gap: 4 }}>
              {shown.map((row) => (
                <div
                  key={row.day}
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 1, height: '100%' }}
                  title={`${row.day}${row.day === today ? L('（今天）', ' (today)') : ''}\n${L('新建', 'created')}: ${row.created}\n${L('结清', 'settled')}: ${row.settled}\n${L('未结清累计', 'backlog')}: ${row.backlog}`}
                >
                  <div style={{ flex: 1, minWidth: 0, maxWidth: 12, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                    {row.created > 0 && <span style={styles.barValue}>{row.created}</span>}
                    <span style={{ width: '100%', height: Math.round((row.created / barAxis.max) * FLOW_SCALE_PX), background: SERIES_CREATED, borderRadius: '2px 2px 0 0', display: 'block' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0, maxWidth: 12, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                    {row.settled > 0 && <span style={{ ...styles.barValue, color: SERIES_SETTLED }}>{row.settled}</span>}
                    <span style={{ width: '100%', height: Math.round((row.settled / barAxis.max) * FLOW_SCALE_PX), background: SERIES_SETTLED, borderRadius: '2px 2px 0 0', display: 'block' }} />
                  </div>
                </div>
              ))}
            </div>
            {/* 累计未结清：一条真正的折线，横坐标与柱组中心对齐 */}
            <svg
              viewBox={`0 0 ${total} ${FLOW_SCALE_PX}`}
              preserveAspectRatio="none"
              style={{ position: 'absolute', left: 0, right: 0, bottom: FLOW_DAY_PX, height: FLOW_SCALE_PX, width: '100%', overflow: 'visible', pointerEvents: 'none' }}
              aria-hidden
            >
              <polyline
                points={points}
                fill="none"
                style={{ stroke: SERIES_BACKLOG }}
                strokeWidth={1.6}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            {/* 末端数值标签：当前积压 */}
            {shown.length > 0 && (
              <span style={{ ...styles.lineValue, bottom: FLOW_DAY_PX + (lastBacklog / lineAxis.max) * FLOW_SCALE_PX + 2 }}>
                {lastBacklog}
              </span>
            )}
            {/* x 轴日期 */}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: FLOW_DAY_PX, display: 'flex', gap: 4 }}>
              {shown.map((row, index) => (
                <span key={row.day} style={{ ...styles.dayLabel, color: row.day === today ? FG : FAINT }}>
                  {index % labelStep === 0 || index === shown.length - 1 ? row.day.slice(5) : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
        {/* 右轴：累计未结清 */}
        <div style={styles.axis}>
          {lineAxis.ticks.map((tick) => (
            <span key={`r${tick}`} style={{ ...styles.axisTick, ...styles.axisTickRight, bottom: tickBottom(tick, lineAxis.max) }}>
              {tick}
            </span>
          ))}
        </div>
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

/**
 * 状态环形图（inline SVG，`stroke-dasharray` 画弧 —— 比手写 arc path 少一个
 * 出错的地方），中心是未结清数。
 */
function Donut({ slices, labelOf, center, centerLabel }: {
  slices: Array<Slice & { tone: string }>
  labelOf(key: string): string
  center: string
  centerLabel: string
}): JSX.Element {
  if (slices.length === 0) return <p style={styles.note}>{L('（空）', '(empty)')}</p>
  const size = 132
  const radius = 48
  const width = 15
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <div style={styles.donutWrap}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size, flexShrink: 0 }} role="img">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" style={{ stroke: BORDER }} strokeWidth={width} />
        {slices.map((slice) => {
          const length = slice.share * circumference
          const dash = `${length} ${circumference - length}`
          const node = (
            <circle
              key={slice.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              style={{ stroke: slice.tone }}
              strokeWidth={width}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            >
              <title>{`${labelOf(slice.key)}: ${slice.count} (${percentText(slice.share)})`}</title>
            </circle>
          )
          offset += length
          return node
        })}
        <text x={size / 2} y={size / 2 - 2} textAnchor="middle" style={{ fill: FG, fontSize: 24, fontWeight: 600 }}>{center}</text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" style={{ fill: DIM, fontSize: 10 }}>{centerLabel}</text>
      </svg>
      <ul style={styles.donutList}>
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

/**
 * 持球人排行：谁欠什么动作、欠了多久。派生来自 `currentHolder`，所以一张
 * 未结清卡**必然**出现在某一行里（没认领的出现在「待认领池」那一行）。
 */
function HolderRanking({ groups, onOpenTask }: {
  groups: HolderGroup[]
  onOpenTask?: (id: string) => void
}): JSX.Element {
  if (groups.length === 0) return <p style={styles.note}>{L('没有未结清的卡 —— 球都在地上。', 'No open cards — nobody is holding anything.')}</p>
  return (
    <ul style={styles.plainList}>
      {groups.slice(0, 8).map((group) => (
        <li key={group.key || '(pool)'} style={styles.holderRow}>
          <span style={styles.holderName}>
            {group.who ?? L('（待认领池）', '(pool)')}
            {group.quiet && (
              <span className="tb-badge-outline" style={styles.quietBadge} title={L('名册里这个人已经久未活动（36h 内没动过手）', 'The roster has not seen this actor act in 36h')}>
                {L('久未活动', 'quiet')}
              </span>
            )}
          </span>
          <span style={styles.holderTotal}>{L('{n} 张', '{n} cards', { n: group.total })}</span>
          <span style={styles.holderActions}>
            {group.actions.map((bucket) => {
              const oldest = bucket.ids[0]
              return (
                <button
                  key={bucket.action}
                  type="button"
                  className="tb-tag"
                  style={{ ...styles.actionChip, cursor: onOpenTask ? 'pointer' : 'default' }}
                  disabled={!onOpenTask}
                  onClick={() => oldest && onOpenTask?.(oldest)}
                  title={L('{who} 欠 {what}：{ids}（最久的一张已 {age}）', '{who} owes {what}: {ids} (oldest {age})', {
                    who: group.who ?? L('没人', 'nobody'),
                    what: holderActionLabel(bucket.action),
                    ids: bucket.ids.join(' '),
                    age: durationText(bucket.maxAgeMs),
                  })}
                >
                  {holderActionLabel(bucket.action)} <b style={styles.chipCount}>{bucket.count}</b>
                  {bucket.maxAgeMs !== null && <span style={styles.chipAge}>· {durationText(bucket.maxAgeMs)}</span>}
                </button>
              )
            })}
          </span>
        </li>
      ))}
    </ul>
  )
}

const ANOMALY_LABEL: Record<AnomalyKind, [string, string]> = {
  wait_overdue: ['等待超时', 'wait overdue'],
  review_overdue: ['评审超时', 'review overdue'],
  holder_quiet: ['持卡人失联', 'holder quiet'],
  recent_reject: ['近期被打回', 'sent back'],
  idle: ['久未推动', 'idle'],
}

const ANOMALY_TONE: Record<AnomalyKind, string> = {
  wait_overdue: DANGER,
  review_overdue: WARN,
  holder_quiet: WARN,
  recent_reject: LINK,
  idle: TERTIARY,
}

/** 异常清单：一行一张卡，主因在前，其余原因列在后面 —— 点开就是那张卡。 */
function AnomalyList({ rows, tasks, onOpenTask }: {
  rows: Anomaly[]
  tasks: Record<string, Task>
  onOpenTask?: (id: string) => void
}): JSX.Element {
  if (rows.length === 0) {
    return <p style={styles.note}>{L('没有发现异常：没有超时的等待、没有超期的审核、没人失联。', 'No anomalies: no overdue waits, no overdue reviews, nobody gone quiet.')}</p>
  }
  const shown = rows.slice(0, 8)
  return (
    <div>
      {shown.map((row) => {
        const task = tasks[row.taskId]
        return (
          <button
            key={row.taskId}
            type="button"
            className="tb-stats-row"
            disabled={!onOpenTask}
            data-flat={onOpenTask ? '0' : '1'}
            onClick={() => onOpenTask?.(row.taskId)}
            title={L('打开 {id} 的详情', 'Open {id}', { id: row.taskId })}
          >
            <span style={{ ...styles.severity, background: ANOMALY_TONE[row.kind] }} />
            <span style={styles.anomId}>{row.taskId}</span>
            <span style={styles.anomTitle}>{task?.title ?? ''}</span>
            <span style={styles.anomKind}>
              {L(ANOMALY_LABEL[row.kind][0], ANOMALY_LABEL[row.kind][1])}
              {row.also.length > 0 && <span style={styles.alsoMark}> +{row.also.length}</span>}
            </span>
            <span style={styles.anomWho}>{row.who ?? L('池子', 'pool')}</span>
            <span style={styles.anomAge}>{durationText(row.ageMs)}</span>
          </button>
        )
      })}
      {rows.length > shown.length && (
        <p style={styles.note}>{L('还有 {n} 条未列出（先处理上面这些）。', '{n} more not listed — handle the ones above first.', { n: rows.length - shown.length })}</p>
      )}
    </div>
  )
}

/** 价值度视角：积压 ◆ vs 窗口内交付 ◆、吞吐、每卡平均。 */
function ValuePanel({ view, days }: { view: ReturnType<typeof valueView>; days: number }): JSX.Element {
  const total = view.backlogValue + view.deliveredValue
  const backlogShare = total === 0 ? 0 : view.backlogValue / total
  const points = (value: number): string => `◆${Number.isInteger(value) ? value : value.toFixed(1)}`
  return (
    <div style={styles.valueWrap}>
      <div style={styles.valueBar} title={L('积压 {b} ◆ / 近 {n} 天交付 {d} ◆', 'backlog {b} ◆ / delivered in the last {n}d {d} ◆', { b: view.backlogValue, d: view.deliveredValue, n: days })}>
        <span style={{ ...styles.fill, width: `${backlogShare * 100}%`, background: SERIES_BACKLOG }} />
        <span style={{ ...styles.fill, width: `${(1 - backlogShare) * 100}%`, background: SERIES_CREATED }} />
      </div>
      <div style={styles.valueRows}>
        <ValueCell label={L('积压价值', 'Backlog value')} value={points(view.backlogValue)} tone={WARN} hint={L('{n} 张未结清卡的点数之和', 'sum over {n} open cards', { n: view.backlogTasks })} />
        <ValueCell label={L('窗口内交付', 'Delivered in window')} value={points(view.deliveredValue)} tone={LINK} hint={L('近 {n} 天结清的 {m} 张卡', '{m} cards settled in the last {n}d', { n: days, m: view.deliveredTasks })} />
        <ValueCell label={L('价值吞吐', 'Throughput')} value={`◆${view.throughputPerDay.toFixed(1)}`} tone={FG} hint={L('平均每天交付的价值点数', 'value points delivered per day, averaged over the window')} />
        <ValueCell
          label={L('每卡平均', 'Per card')}
          value={view.avgValue === null ? '—' : points(view.avgValue)}
          tone={FG}
          hint={L('已评估卡的平均价值点数（未评估的不计入）', 'mean value over estimated cards (unestimated excluded)')}
        />
        <ValueCell
          label={L('平均周期', 'Mean cycle')}
          value={view.avgCycleMs === null ? '—' : durationText(view.avgCycleMs)}
          tone={FG}
          hint={view.cycleN === 0
            ? L('还没有干完的卡', 'no finished cards yet')
            : L('已结清卡的平均建卡 → 干完时长（n={n}）', 'mean created → done over settled cards (n={n})', { n: view.cycleN })}
        />
      </div>
    </div>
  )
}

function ValueCell({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: string }): JSX.Element {
  return (
    <div style={styles.valueCell} title={hint}>
      <span style={{ ...styles.valueNumber, color: tone }}>{value}</span>
      <span style={styles.valueLabel}>{label}</span>
    </div>
  )
}

/** 里程碑进度：tag → 已结清/总数、◆ 已交付/总、剩余；点开列出该里程碑的卡。 */
function MilestoneList({ rows, tasks, openTag, onToggle, onOpenTask }: {
  rows: Milestone[]
  tasks: Record<string, Task>
  openTag: string | null
  onToggle(tag: string): void
  onOpenTask?: (id: string) => void
}): JSX.Element {
  return (
    <ul style={styles.plainList}>
      {rows.map((row) => {
        const share = row.total === 0 ? 0 : row.settled / row.total
        const open = openTag === row.tag
        return (
          <li key={row.tag} style={styles.milestone}>
            <button type="button" className="tb-stats-row" onClick={() => onToggle(row.tag)} title={L('点开看这一版还剩哪些卡', 'Open to see which cards are left')}>
              <span style={styles.milestoneTag}>{open ? '▾' : '▸'} {row.tag}</span>
              <span style={styles.track}>
                <span style={{ ...styles.fill, width: `${share * 100}%`, background: share === 1 ? LINK : ACCENT }} />
              </span>
              <span style={styles.milestoneNum}>{row.settled}/{row.total}</span>
              <span style={styles.milestoneValue}>{L('◆{a}/{b}', '◆{a}/{b}', { a: row.valueDelivered, b: row.valueTotal })}</span>
              <span style={styles.milestoneLeft}>
                {row.remaining === 0 ? L('已结清', 'settled') : L('剩 {n} 张', '{n} left', { n: row.remaining })}
              </span>
            </button>
            {open && (
              <div style={styles.milestoneCards}>
                {row.ids.map((id) => {
                  const task = tasks[id]
                  if (!task) return null
                  return (
                    <button key={id} type="button" className="tb-mstone-card" disabled={!onOpenTask} onClick={() => onOpenTask?.(id)} title={L('打开 {id} 的详情', 'Open {id}', { id })}>
                      <span style={{ ...styles.severity, background: STATUS_COLORS[statusColumn(task)] }} />
                      <span style={styles.anomId}>{id}</span>
                      <span style={styles.anomTitle}>{task.title}</span>
                      <span style={styles.anomWho}>{columnLabel(statusColumn(task))}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function statusColumn(task: Task): BoardColumn {
  if (task.status === 'open') return task.assignee ? 'assigned' : 'pool'
  return task.status
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
            <td style={styles.tdNum} title={metricHint(row.cycle, L('该负责人的周期', 'this owner\'s cycle'))}>{metricText(row.cycle)}</td>
            <td style={styles.tdNum}>{row.actions}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * 列停留条：按中位年龄排序，长度就是中位年龄，竖线是该列自己的陈旧阈值 ——
 * 条形越过竖线 = 这列大多数卡都该有人管了。单位写在右边（「中位 3.8h · 2 张」）。
 */
function DwellTable({ rows }: { rows: ReturnType<typeof dwellByColumn> }): JSX.Element {
  if (rows.length === 0) return <p style={styles.note}>{L('没有未结清的卡。', 'No open cards.')}</p>
  const scale = Math.max(1, ...rows.map((row) => Math.max(row.medianMs, row.slaMs ?? 0)))
  return (
    <ul style={styles.dwellList}>
      {rows.map((row) => (
        <li key={row.column} style={styles.dwellRow}>
          <span style={styles.dwellLabel}>{columnLabel(row.column as BoardColumn)}</span>
          <span style={{ ...styles.track, position: 'relative' }}>
            <span style={{ ...styles.fill, width: `${(row.medianMs / scale) * 100}%`, background: STATUS_COLORS[row.column as BoardColumn] ?? DIM }} />
            {row.slaMs !== null && (
              <span
                style={{ ...styles.slaLine, left: `${(row.slaMs / scale) * 100}%` }}
                title={L('该列的陈旧阈值 {age}', 'column SLA {age}', { age: durationText(row.slaMs) })}
              />
            )}
          </span>
          <span style={styles.dwellValue}>{L('中位 {age}', 'med {age}', { age: durationText(row.medianMs) })}</span>
          <span style={styles.dwellMeta} title={L('{n} 张卡；最久的一张 {age}', '{n} cards; oldest {age}', { n: row.tasks, age: durationText(row.longestMs) })}>
            {row.tasks} {L('张', 'cards')} · {L('最久', 'max')} {durationText(row.longestMs)}
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
  subTitle: { margin: 0, fontSize: 11.5, fontWeight: 600, color: FG, display: 'inline-flex', alignItems: 'center', gap: 4 },
  subCount: { color: DIM, fontWeight: 500, fontSize: 10.5 },

  // 时间窗开关
  windowBar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  windowLabel: { fontSize: 11.5, color: DIM },
  chip: { padding: '3px 11px' },
  chipActive: { fontWeight: 600 },
  windowNote: { fontSize: 10.5, color: FAINT, lineHeight: 1.5 },

  // KPI
  kpiGroups: { display: 'flex', flexDirection: 'column', gap: 12 },
  kpiGroup: { display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 },
  kpiGroupHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  kpiGroupHint: { fontSize: 10.5, color: DIM },
  groupExtra: { marginLeft: 'auto', fontSize: 10.5, color: FAINT },
  tile: {
    background: BG_RAISED,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    minWidth: 0,
  },
  tileLabel: { fontSize: 10.5, color: DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tileValue: { fontSize: 20, fontWeight: 600, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' },
  tileFoot: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 },
  delta: { fontSize: 10.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  deltaArrow: { marginRight: 2 },
  spark: { marginLeft: 'auto', width: 58, height: 20, display: 'block', overflow: 'visible' },
  sparkEmpty: { marginLeft: 'auto', fontSize: 9.5, color: FAINT },

  // 现在该动什么
  nowSplit: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' },
  nowCol: { flex: '1 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  plainList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  holderRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '3px 0', minWidth: 0 },
  holderName: { fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 },
  quietBadge: { fontSize: 9.5, padding: '0 5px' },
  holderTotal: { fontSize: 10.5, color: DIM },
  holderActions: { display: 'inline-flex', gap: 5, flexWrap: 'wrap', marginLeft: 'auto' },
  // `.tb-tag` 只给了边框和字色：button 的 UA 默认底色（ButtonFace）在深色主题下
  // 是一块浅灰，会把 chip 里的字糊掉 —— 这里显式抹掉底色。
  actionChip: { display: 'inline-flex', alignItems: 'center', gap: 4, font: 'inherit', fontFamily: 'inherit', fontSize: 10.5, background: 'transparent', color: DIM },
  chipCount: { fontWeight: 600, color: FG },
  chipAge: { color: FAINT },
  severity: { width: 6, height: 6, borderRadius: 3, display: 'inline-block', flexShrink: 0 },
  anomId: { fontSize: 10.5, color: DIM, fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  anomTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  anomKind: { fontSize: 10.5, flexShrink: 0 },
  alsoMark: { color: FAINT },
  anomWho: { fontSize: 10.5, color: DIM, flexShrink: 0, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  anomAge: { fontSize: 10.5, color: DIM, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 34, textAlign: 'right' },

  // 流量图
  chart: { display: 'flex', flexDirection: 'column', gap: 6 },
  chartRow: { display: 'flex', alignItems: 'flex-end', gap: 6 },
  plotWrap: { flex: 1, minWidth: 0 },
  // 轴盒与绘图盒同高并底边对齐：刻度的 bottom 百分比才对得上网格线。
  axis: { position: 'relative', width: 24, flexShrink: 0, height: FLOW_BAR_PX + FLOW_DAY_PX },
  axisTick: { position: 'absolute', right: 2, fontSize: 9, color: FAINT, fontVariantNumeric: 'tabular-nums', transform: 'translateY(50%)' },
  axisTickRight: { right: 'auto', left: 3 },
  barValue: { fontSize: 8.5, lineHeight: '10px', color: SERIES_CREATED, fontVariantNumeric: 'tabular-nums' },
  lineValue: { position: 'absolute', right: 0, fontSize: 9, color: SERIES_BACKLOG, fontVariantNumeric: 'tabular-nums', transform: 'translateY(50%)' },
  dayLabel: { flex: 1, minWidth: 0, textAlign: 'center', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden' },
  legend: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  legendKey: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: DIM },
  legendDot: { width: 8, height: 8, borderRadius: 2, display: 'inline-block', flexShrink: 0 },

  // 环形图
  donutWrap: { display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, flexWrap: 'wrap' },
  donutList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 150px', minWidth: 0 },

  // 分布条
  stackWrap: { display: 'flex', flexDirection: 'column', gap: 7 },
  stackBar: { display: 'flex', alignItems: 'stretch', height: 10, borderRadius: 5, overflow: 'hidden', background: BG_RAISED, border: `1px solid ${BORDER}` },
  stackList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  stackItem: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 },
  stackLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stackValue: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
  stackShare: { color: DIM, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' },

  // 价值度
  valueWrap: { display: 'flex', flexDirection: 'column', gap: 9 },
  valueBar: { display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: BG_RAISED, border: `1px solid ${BORDER}` },
  valueRows: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 8 },
  valueCell: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  valueNumber: { fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  valueLabel: { fontSize: 10, color: DIM },

  // 里程碑
  milestone: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
  milestoneTag: { fontSize: 11.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 74 },
  milestoneNum: { fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 40, textAlign: 'right' },
  milestoneValue: { fontSize: 11, color: ACCENT, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 44, textAlign: 'right' },
  milestoneLeft: { fontSize: 10.5, color: DIM, flexShrink: 0, minWidth: 46, textAlign: 'right' },
  milestoneCards: { display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 10, minWidth: 0 },

  // 表格
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 },
  th: { textAlign: 'left', color: DIM, fontWeight: 500, fontSize: 10.5, padding: '2px 6px 4px 0', borderBottom: `1px solid ${BORDER}` },
  thNum: { textAlign: 'right', color: DIM, fontWeight: 500, fontSize: 10.5, padding: '2px 0 4px 6px', borderBottom: `1px solid ${BORDER}` },
  td: { padding: '5px 6px 5px 0', borderBottom: `1px solid ${BORDER}`, verticalAlign: 'middle' },
  tdNum: { textAlign: 'right', padding: '5px 0 5px 6px', borderBottom: `1px solid ${BORDER}`, fontVariantNumeric: 'tabular-nums' },
  ownerName: { display: 'inline-block', minWidth: 0, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' },
  loadBar: { display: 'inline-block', width: 46, height: 4, marginLeft: 6, borderRadius: 2, background: BORDER_STRONG, overflow: 'hidden', verticalAlign: 'middle' },

  // 停留条
  dwellList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  dwellRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, minWidth: 0 },
  dwellLabel: { minWidth: 62, color: FG, flexShrink: 0 },
  dwellValue: { minWidth: 74, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  dwellMeta: { minWidth: 96, textAlign: 'right', color: DIM, fontSize: 10.5, flexShrink: 0 },
  slaLine: { position: 'absolute', top: -2, bottom: -2, width: 0, borderLeft: `1px dashed ${DANGER}`, opacity: 0.75 },

  note: { margin: 0, fontSize: 10.5, color: DIM, lineHeight: 1.6 },
  // Shared bar primitives. The fill MUST be block-level: an inline span inside
  // these tracks collapses to zero height (width alone does not size an inline
  // box vertically), which silently emptied every bar chart.
  track: { flex: 1, height: 7, borderRadius: 4, background: BORDER_STRONG, overflow: 'hidden', minWidth: 40, display: 'block' },
  fill: { display: 'block', height: '100%' },
}
