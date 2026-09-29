/**
 * Model-facing tools of dsh-taskboard-kit.
 *
 * Every tool resolves the calling session's workspace (`exec.agent` → session
 * cwd, see workspace.ts) and operates on `<cwd>/.dsh/taskboard.json` through
 * the lock-guarded domain operations in store.ts — the same file the browser
 * kanban drives through the `/dsh-taskboard/*` bridge.
 *
 * Tool metadata (descriptions/parameters) is English — the model consumes it;
 * output text is bilingual via `L()`. The acting identity is the `by`
 * argument, else `TASKBOARD_ACTOR`, else `dsh-agent`.
 *
 * v0.5.4 adds `taskboard_inbox` — the "what do I do right now" call that makes
 * the board push work at the agent instead of waiting to be polled — the
 * `block` / `unblock` actions that record "this card is waiting on someone
 * else" without faking a status, and a reviewer the board actually enforces.
 *
 * @module dsh-taskboard-kit/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { actorSeenAt, boardHealth, stalenessOf, type InboxItem } from '../shared/board.ts'
import { columnOf, type Board, type Task } from '../shared/types.ts'
import { L } from './locale.ts'
import { notifyHuman } from './notify.ts'
import {
  StoreError,
  addComment,
  boardFilePath,
  claimTask,
  createTask,
  getTask,
  inbox,
  listTasks,
  loadBoard,
  updateTask,
} from './store.ts'
import { resolveCwd } from './workspace.ts'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Who acts: the explicit `by` argument wins, then the env, then the default. */
function actorOf(by: string | undefined): string {
  if (typeof by === 'string' && by.trim() !== '') return by.trim()
  return process.env.TASKBOARD_ACTOR?.trim() || 'dsh-agent'
}

function whoLabel(assignee: string | null): string {
  return assignee ?? L('待认领', 'unassigned')
}

function errorText(error: unknown): string {
  if (error instanceof StoreError) {
    switch (error.code) {
      case 'not-found':
        return L('没有找到任务：{message}（用 taskboard_list 看现有任务）', 'Task not found: {message} (see taskboard_list for existing tasks)', { message: error.message })
      case 'invalid-input':
        return L('参数不对：{message}', 'Invalid input: {message}', { message: error.message })
      case 'invalid-transition':
        return L('现在不允许这样流转：{message}', 'That transition is not allowed right now: {message}', { message: error.message })
      case 'conflict':
        return L('冲突：{message}', 'Conflict: {message}', { message: error.message })
      default:
        return L('看板存储错误：{message}', 'Taskboard storage error: {message}', { message: error.message })
    }
  }
  return L('taskboard 工具失败：{message}', 'taskboard tool failed: {message}', { message: (error as Error).message })
}

function valueLabel(task: Task): string {
  return task.value !== null ? ` · v${task.value}` : ''
}

/** `3d2h` / `5h30m` / `12m` — short, sortable, language-neutral. */
export function ageLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}d${restHours}h` : `${days}d`
}

/**
 * The machine-readable marks that make every line self-explanatory:
 * `reviewer:kimi` (who owes the verdict), `wait:human(iceskysl)`,
 * `stale:3d` (over its column SLA), `col:2d` (age in the current column —
 * shown only once a card is halfway to its SLA, so a fresh card stays quiet).
 */
export function marksOf(task: Task, now: number): string {
  const parts: string[] = []
  const staleness = stalenessOf(task, now)
  if (task.reviewer) parts.push(`reviewer:${task.reviewer}`)
  if (task.waiting_on) {
    const who = task.waiting_on.who ? `(${task.waiting_on.who})` : ''
    parts.push(`wait:${task.waiting_on.kind}${who}`)
  }
  const halfway = staleness.slaMs !== null && staleness.ageMs >= staleness.slaMs / 2
  if (staleness.stale) parts.push(`stale:${ageLabel(staleness.ageMs)}`)
  else if (halfway && task.status !== 'done' && task.status !== 'closed') parts.push(`col:${ageLabel(staleness.ageMs)}`)
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
}

function summaryLine(task: Task, now: number): string {
  return `${task.id} · ${task.status} · ${whoLabel(task.assignee)} · ${task.priority}${valueLabel(task)}${marksOf(task, now)} · ${task.title}`
}

/** 「最近活动」/「久未活动」——把"派给一个消失的 Agent"变成看得见的事实。 */
function seenLabel(board: Board, name: string | null, now: number): string {
  const seenAt = actorSeenAt(board, name)
  if (seenAt === undefined) return L('（名册里没有：从未动手）', '(not on the roster: never acted)')
  if (seenAt === null) return L('（从未动手）', '(never acted)')
  const parsed = Date.parse(seenAt)
  if (Number.isNaN(parsed)) return ''
  return L('（最近活动 {age} 前）', '(last active {age} ago)', { age: ageLabel(Math.max(0, now - parsed)) })
}

/** The full single-task view shared by the tool and the CLI. */
export function formatGet(task: Task, board: Board, now: number): string {
  const staleness = stalenessOf(task, now)
  const lines = [
    `${task.id} · ${task.status} · ${task.priority}${valueLabel(task)}`,
    task.title,
    L('负责人：{who}{seen} · 创建：{creator} {created} · 更新：{updated}', 'assignee: {who}{seen} · created by {creator} {created} · updated {updated}', {
      who: whoLabel(task.assignee),
      seen: task.assignee ? ` ${seenLabel(board, task.assignee, now)}` : '',
      creator: task.created_by,
      created: task.created_at,
      updated: task.updated_at,
    }),
    L('当前列：{column} · 已停留 {age}', 'column: {column} · age {age}', {
      column: columnOf(task),
      age: ageLabel(staleness.ageMs),
    }),
  ]
  if (staleness.stale) {
    lines.push(L('⚠ 陈旧：超过该列 {sla} 的阈值', '⚠ stale: past this column\'s {sla} SLA', { sla: ageLabel(staleness.slaMs ?? 0) }))
  }
  if (task.reviewer) {
    lines.push(L('审核人：{who}{seen}', 'reviewer: {who}{seen}', { who: task.reviewer, seen: ` ${seenLabel(board, task.reviewer, now)}` }))
  }
  if (task.waiting_on) {
    const waited = Math.max(0, now - (Date.parse(task.waiting_on.since) || now))
    lines.push(L(
      '⏳ 在等 {kind}{who}，已 {waited}：{question}',
      '⏳ waiting on {kind}{who} for {waited}: {question}',
      {
        kind: task.waiting_on.kind,
        who: task.waiting_on.who ? `(${task.waiting_on.who})` : '',
        waited: ageLabel(waited),
        question: task.waiting_on.question,
      },
    ))
  }
  if (task.tags.length > 0) lines.push(`tags: ${task.tags.join(', ')}`)
  if (task.detail) lines.push('', task.detail)
  lines.push('', L('时间线：', 'timeline:'))
  for (const entry of task.log) {
    lines.push(`${entry.at} · ${entry.by} · ${entry.event}${entry.note ? ` — ${entry.note}` : ''}`)
  }
  if (task.comments.length > 0) {
    lines.push('', L('留言：', 'comments:'))
    for (const comment of task.comments) {
      lines.push(`${comment.at} · ${comment.by} · ${comment.text}`)
    }
  }
  return lines.join('\n')
}

function inboxKindLabel(item: InboxItem): string {
  switch (item.kind) {
    case 'review_owed':
      return L('等你审核', 'review owed by you')
    case 'unblock_me':
      return L('有人在等你', 'someone is blocked on you')
    case 'returned':
      return L('你的卡被打回', 'your task was rejected')
    case 'stalled_mine':
      return L('你的卡陈旧了', 'your task went stale')
    case 'orphaned_mine':
      return L('你派的卡，接的人不见了', 'your delegate went quiet')
    case 'start_assigned':
      return L('指派给你但没开工', 'assigned to you, not started')
    case 'human_blocked':
      return L('在等人类（去叫人）', 'waiting on the human (go ping them)')
    case 'pool_pick':
      return L('池子里值得拿', 'worth claiming from the pool')
    default:
      return item.kind
  }
}

/** 把 inbox 渲染成 agent 能直接照着做的一段话。 */
export function formatInbox(items: InboxItem[], actor: string, now: number): string {
  if (items.length === 0) {
    return L('{actor}：现在没有该你处理的事（看板干净）。', '{actor}: nothing is on you right now (board is clean).', { actor })
  }
  const lines = [L(
    '{actor} 现在该处理的 {count} 件事（已按急迫度排序）：',
    '{count} thing(s) on {actor}, most urgent first:',
    { actor, count: items.length },
  )]
  items.forEach((item, index) => {
    const flags = item.actor ? ` · ${item.actor}` : ''
    lines.push(
      `${index + 1}. [${inboxKindLabel(item)}] ${item.task.id} · ${item.task.priority}${valueLabel(item.task)} · 已 ${ageLabel(item.ageMs)}${flags}`,
      `   ${item.task.title}`,
      `   → ${item.suggest}`,
    )
  })
  return lines.join('\n')
}

/** Register all taskboard tools on `ctx.tools`. */
export function registerTaskboardTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'taskboard_list',
    description:
      'List tasks on this workspace\'s shared task board (the same board the human sees in the kanban tab). ' +
      'One summary line per task with its reviewer / waiting-on / staleness marks. ' +
      'For "what should I do right now", prefer taskboard_inbox.',
    parameters: {
      status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done', 'closed'], description: 'Keep only this status.' },
      column: { type: 'string', enum: ['pool', 'assigned', 'in_progress', 'review', 'done', 'closed'], description: 'Keep only this kanban column (pool = open and unassigned, i.e. claimable; review = submitted, awaiting approval).' },
      assignee: { type: 'string', description: 'Keep only tasks owned by this actor; pass "none" for unassigned (claimable) tasks.' },
      waiting: { type: 'string', enum: ['human', 'agent', 'external', 'any'], description: 'Keep only tasks parked on someone: human / agent / external, or "any" for all waiting tasks.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const all = await listTasks(cwd)
        const now = Date.now()
        const listed = all.filter((task) => {
          if (args.status && task.status !== args.status) return false
          if (args.column && columnOf(task) !== args.column) return false
          if (args.assignee === 'none') return task.assignee === null
          if (args.assignee !== undefined && task.assignee !== args.assignee) return false
          if (args.waiting === 'any') return task.waiting_on !== null
          if (args.waiting !== undefined) return task.waiting_on?.kind === args.waiting
          return true
        })
        const totals = L(
          '看板合计：open {open} · in_progress {ip} · review {rv} · done {done} · closed {cx}',
          'board totals: open {open} · in_progress {ip} · review {rv} · done {done} · closed {cx}',
          {
            open: all.filter((task) => task.status === 'open').length,
            ip: all.filter((task) => task.status === 'in_progress').length,
            rv: all.filter((task) => task.status === 'review').length,
            done: all.filter((task) => task.status === 'done').length,
            cx: all.filter((task) => task.status === 'closed').length,
          },
        )
        const board = await loadBoard(cwd)
        const health = boardHealth(board, { now })
        const healthLine = health.orphaned.length + health.unownedReview.length > 0
          ? L(
            '\n⚠ 协作健康：{orphaned} 张派给了久未/从未出现的 Agent，{unowned} 张在 review 但没有审核人（用 taskboard_update 改派，或 comment 说明）',
            '\n⚠ collaboration health: {orphaned} delegated to an actor that has gone quiet/never acted, {unowned} in review with nobody named (reassign with taskboard_update, or comment)',
            { orphaned: health.orphaned.length, unowned: health.unownedReview.length },
          )
          : ''
        const waitingLine = health.waitingHuman.length > 0
          ? L(
            '\n⏳ 在等人类决定：{list}（用 taskboard_inbox 看详情，再用 msg9 叫人）',
            '\n⏳ waiting on the human: {list} (taskboard_inbox has the detail, then ping them via msg9)',
            { list: health.waitingHuman.map((issue) => issue.task.id).join(', ') },
          )
          : ''
        if (listed.length === 0) {
          const empty = all.length === 0
            ? L('看板是空的——用 taskboard_create 建第一个任务。', 'The board is empty — use taskboard_create to add the first task.')
            : L('没有匹配的任务（放宽过滤条件试试）。', 'No tasks match these filters (try loosening them).')
          return `${empty}\n${totals}${healthLine}${waitingLine}`
        }
        const head = L('{count} 条任务：', '{count} task(s):', { count: listed.length })
        return `${head}\n${listed.map((task) => summaryLine(task, now)).join('\n')}\n${totals}${healthLine}${waitingLine}`
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_inbox',
    description:
      'THE call to make at session start: what is on YOU right now, most urgent first — reviews you owe, ' +
      'people blocked on you, tasks returned to you after a rejection, your own cards that went stale, ' +
      'cards you delegated to an actor that has gone quiet, work assigned to you but not started, and the ' +
      'best pool tasks to claim. Every item comes with the command that moves it. ' +
      'Cards waiting on the human are listed too: pinging the human is your job, not the board\'s.',
    parameters: {
      by: { type: 'string', description: 'Acting identity (default: TASKBOARD_ACTOR or dsh-agent). Aliases like dsh/dsh-agent resolve to one owner.' },
      limit: { type: 'number', description: 'Max items to return (default 12; 0 = no cap).' },
      pool_limit: { type: 'number', description: 'How many claimable pool tasks to suggest (default 3; 0 = none).' },
      include_human: { type: 'boolean', description: 'Include cards waiting on the human (default true) — so you can go ping them.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const actor = actorOf(args.by)
        const items = await inbox(cwd, actor, {
          ...(args.pool_limit !== undefined ? { poolLimit: args.pool_limit } : {}),
          ...(args.include_human !== undefined ? { includeHumanBlocked: args.include_human } : {}),
        })
        const limited = args.limit !== undefined && args.limit > 0 ? items.slice(0, args.limit) : items
        const rendered = formatInbox(limited, actor, Date.now())
        const more = limited.length < items.length
          ? L('\n（还有 {rest} 条，调大 limit 看全）', '\n({rest} more — raise limit to see them)', { rest: items.length - limited.length })
          : ''
        return `${rendered}${more}`
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_create',
    description:
      'Create a task on this workspace\'s shared task board. Omit assignee to put it in the claimable pool ' +
      '(anyone — you, a sibling agent, or the human — can then taskboard_claim it); set assignee to delegate it. ' +
      'If the work cannot start without a human decision, create it and then park it (taskboard_update action=block) ' +
      'instead of leaving it looking claimable. Returns the allocated id (T-<n>).',
    parameters: {
      title: { type: 'string', required: true, description: 'One-line task title.' },
      detail: { type: 'string', description: 'Markdown body with the full context — the panel renders it (GFM: headings, lists, code blocks, quotes, tables, --- rules).' },
      assignee: { type: 'string', description: 'Delegate to this actor; omit for the claimable pool.' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Default: medium.' },
      value: { type: 'number', enum: [0.5, 1, 2, 3, 5, 8], description: 'Value points — one of 0.5 1 2 3 5 8; omit if unestimated.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Free-form grouping labels.' },
      by: { type: 'string', description: 'Acting identity recorded in the task log (default: TASKBOARD_ACTOR or dsh-agent).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const task = await createTask(cwd, {
          title: args.title,
          ...(args.detail !== undefined ? { detail: args.detail } : {}),
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.value !== undefined ? { value: args.value } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
        }, actorOf(args.by))
        const placement = task.assignee
          ? L('已指派给 {who}', 'assigned to {who}', { who: task.assignee })
          : L('在待认领池里，可用 taskboard_claim 认领', 'in the claimable pool — claim it with taskboard_claim')
        return L('已创建 {id}：{title}（open · {priority} · {placement}）', 'Created {id}: {title} (open · {priority} · {placement})', {
          id: task.id,
          title: task.title,
          priority: task.priority,
          placement,
        })
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_claim',
    description:
      'Atomically claim a pool task for yourself: succeeds only while it is open, unassigned AND not waiting ' +
      'on someone, then it is yours and in_progress. ALWAYS claim before starting work on a pool task — if the ' +
      'claim conflicts, someone else got there first; pick another task instead of working in parallel by accident.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id, e.g. T-1 (from taskboard_list).' },
      by: { type: 'string', description: 'Acting identity recorded in the task log (default: TASKBOARD_ACTOR or dsh-agent).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = resolveCwd(ctx, exec)
      const actor = actorOf(args.by)
      try {
        const task = await claimTask(cwd, args.id, actor)
        return L(
          '已认领 {id}（in_progress · {by}）：{title}\n干完用 taskboard_update（action=submit --reviewer <审核人>）交审核；中途卡住了用 action=block 说明在等谁。',
          'Claimed {id} (in_progress · {by}): {title}\nWhen done, hand it off with taskboard_update (action=submit --reviewer <name>); if you get stuck, action=block and say who you are waiting on.',
          { id: task.id, by: actor, title: task.title },
        )
      } catch (error) {
        if (error instanceof StoreError && error.code === 'conflict') {
          // Friendly conflict, no stack: say who holds it now and what to do.
          const task = await getTask(cwd, args.id).catch(() => undefined)
          if (task) {
            if (task.waiting_on) {
              return L(
                '{id} 认领失败：它在等 {kind}{who} —— {question}。等对方回复后先 unblock，再认领。',
                'Cannot claim {id}: it is waiting on {kind}{who} — {question}. Unblock it once the answer lands, then claim.',
                {
                  id: args.id,
                  kind: task.waiting_on.kind,
                  who: task.waiting_on.who ? ` ${task.waiting_on.who}` : '',
                  question: task.waiting_on.question,
                },
              )
            }
            return L(
              '{id} 认领失败：现在由 {who} 持有，状态 {status}。用 taskboard_inbox 看你还能拿什么，或向人类请示。',
              'Cannot claim {id}: now held by {who}, status {status}. See taskboard_inbox for what else is yours, or ask the human.',
              { id: args.id, who: whoLabel(task.assignee), status: task.status },
            )
          }
        }
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_update',
    description:
      'Update a task: move it through its lifecycle ' +
      '(action start/stop/submit/approve/reject/done/close/reopen), park it on someone with action=block / ' +
      'action=unblock, reassign it, name the reviewer with reviewer=, edit title/detail/priority/value/tags, ' +
      'and attach a note to the log entry. Report progress as you go — the human watches the same board in the ' +
      'kanban tab. Rules the board enforces: submit hands the card to a named reviewer (never yourself); ' +
      'approve/reject are reserved for that reviewer, the task\'s creator or the human; a card waiting on ' +
      'someone cannot be claimed. Everything else is advisory — \`by\` is only recorded, so the human or a lead ' +
      'agent can always override; still, prefer acting on the task you hold. ' +
      'To leave information without changing state, use taskboard_comment instead.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id, e.g. T-1.' },
      action: { type: 'string', enum: ['start', 'stop', 'submit', 'approve', 'reject', 'done', 'close', 'reopen', 'cancel', 'block', 'unblock'], description: 'start: open→in_progress; stop: in_progress→open; submit: in_progress→review (names a reviewer); approve: review→done; reject: review→in_progress (say why in note); done: open|in_progress|review→done; close: open|in_progress|review|done→closed (cancel is its legacy alias); reopen: done|closed→open; block: record that the card is waiting on someone (status unchanged); unblock: the wait is over.' },
      assignee: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'New owner while open/in_progress; null unassigns back to the pool.' },
      reviewer: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Who owes the review. Set it on submit; the board also accepts it while open/in_progress to pre-delegate. You cannot review your own work.' },
      wait_kind: { type: 'string', enum: ['human', 'agent', 'external'], description: 'For action=block: who the card is waiting on. Inferred from wait_who when omitted.' },
      wait_who: { type: 'string', description: 'For action=block: the specific human or agent whose answer is needed.' },
      wait_question: { type: 'string', description: 'For action=block: exactly what must be decided — a one-liner that can be forwarded to that person as-is.' },
      title: { type: 'string', description: 'New title.' },
      detail: { type: 'string', description: 'New markdown body.' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'New priority.' },
      value: { oneOf: [{ type: 'number', enum: [0.5, 1, 2, 3, 5, 8] }, { type: 'null' }], description: 'Value points — one of 0.5 1 2 3 5 8; null clears back to unestimated.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replace the tag list.' },
      note: { type: 'string', description: 'Progress note appended to the log entry this update produces.' },
      by: { type: 'string', description: 'Acting identity recorded in the task log (default: TASKBOARD_ACTOR or dsh-agent).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const actor = actorOf(args.by)
        const { task, events } = await updateTask(cwd, args.id, {
          ...(args.action !== undefined ? { action: args.action } : {}),
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}),
          ...(args.wait_kind !== undefined ? { wait_kind: args.wait_kind } : {}),
          ...(args.wait_who !== undefined ? { wait_who: args.wait_who } : {}),
          ...(args.wait_question !== undefined ? { wait_question: args.wait_question } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.detail !== undefined ? { detail: args.detail } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.value !== undefined ? { value: args.value } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.note !== undefined ? { note: args.note } : {}),
        }, actor)
        const extra: string[] = []
        if (args.action === 'submit' && task.reviewer) {
          extra.push(L(
            '已交给 {who} 审核（会出现在他的 taskboard_inbox 里）',
            'handed to {who} for review (it now shows up in their taskboard_inbox)',
            { who: task.reviewer },
          ))
        }
        if (args.action === 'block' && task.waiting_on?.kind === 'human') {
          const result = await notifyHuman({
            cwd,
            task,
            question: task.waiting_on.question,
            reason: 'blocked',
            waitingBy: actor,
            waitedMs: 0,
          }, {
            log: (message) => {
              try {
                ctx.logger('taskboard-kit').info(message)
              } catch {
                /* logger is best-effort */
              }
            },
          })
          extra.push(result.delivered
            ? L('已通过 TASKBOARD_NOTIFY_CMD 外发通知人类', 'the human was notified out-of-band via TASKBOARD_NOTIFY_CMD')
            : L('已进入「等人类」清单（面板可见）；若人类不看面板，用 msg9 主动告一声', 'parked on the human (visible in the panel); if they may not look, ping them via msg9'))
        }
        const tail = extra.length > 0 ? `\n${extra.join('\n')}` : ''
        return L(
          '已更新 {id}：{events}。当前 {status} · {who}{marks}',
          'Updated {id}: {events}. Now {status} · {who}{marks}',
          { id: task.id, events: events.join(' · '), status: task.status, who: whoLabel(task.assignee), marks: marksOf(task, Date.now()) },
        ) + tail
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_comment',
    description:
      'Add an information comment to a task WITHOUT changing its state: implementation findings, ' +
      'handoff notes for the next agent, or test feedback. The next agent reads them in taskboard_get. ' +
      'A submission with no handoff comment is a submission the reviewer cannot verify — say what you did, ' +
      'what you verified, and what is still open.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id, e.g. T-1.' },
      text: { type: 'string', required: true, description: 'The comment body (findings, handoff notes, test feedback).' },
      by: { type: 'string', description: 'Acting identity recorded on the comment (default: TASKBOARD_ACTOR or dsh-agent).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const task = await addComment(cwd, args.id, args.text, actorOf(args.by))
        return L(
          '已在 {id} 留言（共 {count} 条）：{title}',
          'Commented on {id} ({count} comment(s) so far): {title}',
          { id: task.id, count: task.comments.length, title: task.title },
        )
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_get',
    description:
      'Read ONE task in full: title, detail body, owner, reviewer, who it is waiting on, how long it has ' +
      'been in its column (and whether that is over the SLA), the complete log timeline (who did what, when, ' +
      'with notes), and the information comments other agents left (findings / handoffs / test feedback). ' +
      'taskboard_list only shows summary lines.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id, e.g. T-1 (from taskboard_list).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const task = await getTask(cwd, args.id)
        const board = await loadBoard(cwd)
        return formatGet(task, board, Date.now())
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_roster',
    description:
      'Who is actually here: every actor that has ever acted on this board, when it was last seen, and its ' +
      'aliases (dsh ≡ dsh-agent). Use it before delegating — handing work to an actor that has gone quiet ' +
      '(or never acted) is how a card gets orphaned. Also reports the board file path.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const board = await loadBoard(cwd)
        const now = Date.now()
        const entries = Object.entries(board.actors ?? {})
        const lines = [L('看板文件：{file}', 'board file: {file}', { file: boardFilePath(cwd) })]
        if (entries.length === 0) {
          lines.push(L('名册是空的——还没有人在这块板上动过手。', 'The roster is empty — nobody has acted on this board yet.'))
          return lines.join('\n')
        }
        lines.push(L('名册（{count} 个 Actor）：', 'roster ({count} actor(s)):', { count: entries.length }))
        for (const [name, entry] of entries) {
          const aliases = entry.aliases.length > 0 ? ` ≡ ${entry.aliases.join(' / ')}` : ''
          const seen = entry.last_seen_at
            ? L('最近活动 {age} 前', 'last active {age} ago', { age: ageLabel(Math.max(0, now - (Date.parse(entry.last_seen_at) || now))) })
            : L('从未动手', 'never acted')
          lines.push(`· ${name}${aliases} · ${entry.kind} · ${seen}`)
        }
        return lines.join('\n')
      } catch (error) {
        return errorText(error)
      }
    },
  }))
}
