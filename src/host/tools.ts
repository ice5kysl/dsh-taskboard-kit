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
 * @module dsh-taskboard-kit/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { columnOf, type Task } from '../shared/types.ts'
import { L } from './locale.ts'
import {
  StoreError,
  claimTask,
  createTask,
  getTask,
  listTasks,
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

function summaryLine(task: Task): string {
  return `${task.id} · ${task.status} · ${whoLabel(task.assignee)} · ${task.priority} · ${task.title}`
}

function formatGet(task: Task): string {
  const lines = [
    `${task.id} · ${task.status} · ${task.priority}`,
    task.title,
    L('负责人：{who} · 创建：{creator} {created} · 更新：{updated}', 'assignee: {who} · created by {creator} {created} · updated {updated}', {
      who: whoLabel(task.assignee),
      creator: task.created_by,
      created: task.created_at,
      updated: task.updated_at,
    }),
  ]
  if (task.tags.length > 0) lines.push(`tags: ${task.tags.join(', ')}`)
  if (task.detail) lines.push('', task.detail)
  lines.push('', L('时间线：', 'timeline:'))
  for (const entry of task.log) {
    lines.push(`${entry.at} · ${entry.by} · ${entry.event}${entry.note ? ` — ${entry.note}` : ''}`)
  }
  return lines.join('\n')
}

/** Register all taskboard tools on `ctx.tools`. */
export function registerTaskboardTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'taskboard_list',
    description:
      'List tasks on this workspace\'s shared task board (the same board the human sees in the kanban tab). ' +
      'Call it at session start to see what is claimable, delegated to you, or in progress. ' +
      'One summary line per task; use taskboard_get for a task\'s full detail and timeline.',
    parameters: {
      status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'], description: 'Keep only this status.' },
      column: { type: 'string', enum: ['pool', 'assigned', 'in_progress', 'done'], description: 'Keep only this kanban column (pool = open and unassigned, i.e. claimable).' },
      assignee: { type: 'string', description: 'Keep only tasks owned by this actor; pass "none" for unassigned (claimable) tasks.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const all = await listTasks(cwd)
        const listed = all.filter((task) => {
          if (args.status && task.status !== args.status) return false
          if (args.column && columnOf(task) !== args.column) return false
          if (args.assignee === 'none') return task.assignee === null
          if (args.assignee !== undefined && task.assignee !== args.assignee) return false
          return true
        })
        const totals = L(
          '看板合计：open {open} · in_progress {ip} · done {done} · cancelled {cx}',
          'board totals: open {open} · in_progress {ip} · done {done} · cancelled {cx}',
          {
            open: all.filter((task) => task.status === 'open').length,
            ip: all.filter((task) => task.status === 'in_progress').length,
            done: all.filter((task) => task.status === 'done').length,
            cx: all.filter((task) => task.status === 'cancelled').length,
          },
        )
        if (listed.length === 0) {
          const empty = all.length === 0
            ? L('看板是空的——用 taskboard_create 建第一个任务。', 'The board is empty — use taskboard_create to add the first task.')
            : L('没有匹配的任务（放宽过滤条件试试）。', 'No tasks match these filters (try loosening them).')
          return `${empty}\n${totals}`
        }
        const head = L('{count} 条任务：', '{count} task(s):', { count: listed.length })
        return `${head}\n${listed.map(summaryLine).join('\n')}\n${totals}`
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
      'Returns the allocated id (T-<n>).',
    parameters: {
      title: { type: 'string', required: true, description: 'One-line task title.' },
      detail: { type: 'string', description: 'Markdown body with the full context (rendered as plain text in the panel).' },
      assignee: { type: 'string', description: 'Delegate to this actor; omit for the claimable pool.' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Default: medium.' },
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
      'Atomically claim a pool task for yourself: succeeds only while it is open AND unassigned, ' +
      'then it is yours and in_progress. ALWAYS claim before starting work on a pool task — if the claim ' +
      'conflicts, someone else got there first; pick another task instead of working in parallel by accident.',
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
          '已认领 {id}（in_progress · {by}）：{title}\n完成后用 taskboard_update（action=done）收尾。',
          'Claimed {id} (in_progress · {by}): {title}\nClose it with taskboard_update (action=done) when finished.',
          { id: task.id, by: actor, title: task.title },
        )
      } catch (error) {
        if (error instanceof StoreError && error.code === 'conflict') {
          // Friendly conflict, no stack: say who holds it now and what to do.
          const task = await getTask(cwd, args.id).catch(() => undefined)
          if (task) {
            return L(
              '{id} 认领失败：现在由 {who} 持有，状态 {status}。用 taskboard_list 挑别的待认领任务，或向人类请示。',
              'Cannot claim {id}: now held by {who}, status {status}. Pick another pool task via taskboard_list, or ask the human.',
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
      'Update a task you own: move it through its lifecycle (action start/done/reopen/cancel), reassign it, ' +
      'edit title/detail/priority/tags, and attach a note to the log entry. ' +
      'Report progress as you go — the human watches the same board in the kanban tab.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id, e.g. T-1.' },
      action: { type: 'string', enum: ['start', 'done', 'reopen', 'cancel'], description: 'start: open→in_progress; done: open|in_progress→done; reopen: done|cancelled→open; cancel: open|in_progress→cancelled.' },
      assignee: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'New owner while open/in_progress; null unassigns back to the pool.' },
      title: { type: 'string', description: 'New title.' },
      detail: { type: 'string', description: 'New markdown body.' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'New priority.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replace the tag list.' },
      note: { type: 'string', description: 'Progress note appended to the log entry this update produces.' },
      by: { type: 'string', description: 'Acting identity recorded in the task log (default: TASKBOARD_ACTOR or dsh-agent).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        const { task, events } = await updateTask(cwd, args.id, {
          ...(args.action !== undefined ? { action: args.action } : {}),
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.detail !== undefined ? { detail: args.detail } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.note !== undefined ? { note: args.note } : {}),
        }, actorOf(args.by))
        return L(
          '已更新 {id}：{events}。当前 {status} · {who}',
          'Updated {id}: {events}. Now {status} · {who}',
          { id: task.id, events: events.join(' · '), status: task.status, who: whoLabel(task.assignee) },
        )
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'taskboard_get',
    description:
      'Read ONE task in full: title, detail body, owner, priority, tags, and the complete log timeline ' +
      '(who did what, when, with notes). taskboard_list only shows summary lines.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id, e.g. T-1 (from taskboard_list).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec)
        return formatGet(await getTask(cwd, args.id))
      } catch (error) {
        return errorText(error)
      }
    },
  }))
}
