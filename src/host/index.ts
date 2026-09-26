/**
 * dsh-taskboard-kit — single Loader entry (package name `dsh-taskboard-kit`).
 *
 * Two faces, one board:
 *
 *   • host  — the taskboard_* model tools, the `/dsh-taskboard/*` bridge the
 *             browser kanban calls, a session-start notice when the board has
 *             work waiting, and an fs.watch board-change watcher that pushes
 *             changes into live sessions (context only, never a wakeup);
 *   • web   — the kanban tab itself (see `src/client`).
 *
 * Model: **one board per dsh workspace**, its only source of truth the JSON
 * file `<workspace>/.dsh/taskboard.json`. Tools resolve the workspace from the
 * calling session's cwd; the panel passes the same cwd as a query/body field.
 *
 * @module dsh-taskboard-kit
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BRIDGE_PREFIX, createTaskboardBridge, defaultBridgeDeps } from './http.ts'
import { L } from './locale.ts'
import { listTasks, loadBoard } from './store.ts'
import { registerTaskboardTools } from './tools.ts'
import { createBoardWatcher } from './watch.ts'
import { resolveCwd } from './workspace.ts'

export const name = 'taskboard-kit'
export const inject = ['tools', 'sessions'] as const

// Testable seams: the store, the browser bridge and the workspace resolution
// are part of the package's public surface, so they can be driven without a
// cordis host.
export { BRIDGE_PREFIX, createTaskboardBridge, defaultBridgeDeps, isTrustedRequest } from './http.ts'
export {
  StoreError,
  addComment,
  boardFilePath,
  claimTask,
  createTask,
  getTask,
  listTasks,
  loadBoard,
  saveBoard,
  updateTask,
  withBoardLock,
} from './store.ts'
export { resolveCwd } from './workspace.ts'
export { L } from './locale.ts'
export { TASK_VALUES } from '../shared/types.ts'
export { createBoardWatcher, diffBoards } from './watch.ts'

/** The slice of `@deepseek-ai/dsh-host-webserver` this plugin uses. */
interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

interface SystemPromptLike {
  section(options: { name: string; order: number; text: string }): () => void
}

/** A model-facing plugin notice (the UserMessage shape dsh expects). */
interface PluginNotice {
  role: 'user'
  id: string
  content: { type: 'text'; text: string }[]
  source: { kind: 'plugin'; plugin: string; form: 'notice'; summary: string }
}

/** The live-agent slice the session-start hook delivers to. */
interface AgentLike {
  readonly id: string
  inject(message: PluginNotice): void
}

interface SessionStartPayload {
  agent: AgentLike
}

/** The slice of the agents service the board watcher consumes. */
interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
}

/** Build the plugin notice dsh's agent contract expects (UserMessage). */
function pluginNotice(uuid: string, text: string, summary: string): PluginNotice {
  return {
    role: 'user',
    id: uuid,
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'taskboard-kit', form: 'notice', summary: summary.slice(0, 120) },
  }
}

export function apply(ctx: Context): void {
  const log = ctx.logger('taskboard-kit')
  log.info('taskboard-kit loaded')

  registerTaskboardTools(ctx)
  log.info('taskboard tools registered (list, create, claim, update, comment, get)')

  // The browser face drives the same board through the local web server. A
  // headless profile has no webServer: the tools still work, the kanban tab
  // simply has nothing to call.
  const bridge = createTaskboardBridge(defaultBridgeDeps(ctx))
  ctx.inject(['webServer'], (child) => {
    const server = (child as unknown as { webServer?: WebServerLike }).webServer
    if (!server) return
    child.effect(() => server.register({
      kind: 'prefix',
      path: BRIDGE_PREFIX,
      handler: (req, res) => void bridge.handle(
        req as Parameters<typeof bridge.handle>[0],
        res as Parameters<typeof bridge.handle>[1],
      ),
    }), 'taskboard-kit: browser bridge')
    log.info(`taskboard browser bridge mounted at ${BRIDGE_PREFIX}`)
  })

  // The board rules, in the system prompt: the agent should know it shares a
  // board with the human before any notice ever arrives. Soft dependency — a
  // profile without dsh-system-prompt simply skips the section.
  ctx.inject(['systemPrompt'], (child) => {
    const systemPrompt = (child as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
    if (!systemPrompt) return
    systemPrompt.section({
      name: 'taskboard:rules',
      order: 5000,
      text: L(
        '## 任务看板\n' +
        '本 workspace 有一块共享任务看板（taskboard_* 工具），人类在界面的看板标签页里看到的是同一块板。规则：\n' +
        '- 会话开始先调用 taskboard_list：看待认领池（column=pool）、指派给你的、进行中的、以及待审核（column=review）的任务；\n' +
        '- 动手做一件事之前先占位：池里的任务用 taskboard_claim 认领；指派给你的任务用 taskboard_update（action=start）开工。\n' +
        '  认领/开工之前不要直接干活——板子存在的意义就是避免撞车；\n' +
        '- 做完用 taskboard_update（action=submit）提交审核，不要直接 done；审核者 approve 通过、reject 打回' +
        '（打回时用 taskboard_comment 写明原因）；被打回（回到 in_progress）改完再 submit；\n' +
        '- 进展/完成即时 taskboard_update（note 记进展）；实现发现、交接说明、测试反馈用 taskboard_comment（不改状态），' +
        '接手任务前先 taskboard_get 看留言和时间线；\n' +
        '- 不要的任务用 action=close（旧名 cancel 是它的别名）；claim 冲突 = 别人已经占了：换别的待认领任务，或向人类请示，不要硬做同一个。\n' +
        '- 看板变化（新指派给你的任务、审核结果、新留言）会自动通知你，无需轮询。',
        '## Task board\n' +
        'This workspace has a shared task board (taskboard_* tools); the human watches the SAME board in the kanban tab. Rules:\n' +
        '- At session start, call taskboard_list: check the claimable pool (column=pool), tasks delegated to you, work in progress, and the review queue (column=review);\n' +
        '- Before working on anything, take ownership first: taskboard_claim a pool task, or taskboard_update (action=start) ' +
        'a task delegated to you. Never just start working — the board exists to prevent collisions;\n' +
        '- When finished, taskboard_update (action=submit) to hand the task to review instead of marking it done yourself; ' +
        'the reviewer approves (→ done) or rejects (→ in_progress, with a taskboard_comment explaining why); after a rejection, fix and submit again;\n' +
        '- Report progress as it happens with taskboard_update (note to log progress); leave findings, handoff notes or test feedback ' +
        'with taskboard_comment (state untouched); before picking up a task, taskboard_get first to read its comments and timeline;\n' +
        '- Close unwanted tasks with action=close (cancel is its legacy alias); a claim conflict means someone else got there first: ' +
        'pick another pool task or ask the human — never work the same task anyway.\n' +
        '- Board changes (tasks assigned to you, review verdicts, new comments) are pushed to you automatically — no polling needed.',
      ),
    })
    log.info('taskboard rules added to the system prompt')
  })

  // Every new session starts with one concrete pointer when the board has work
  // waiting: how many pool tasks are claimable and how many are in progress.
  // Context only (agent.inject) — never a wakeup.
  ctx.on('agent/session-start', (payload) => {
    const { agent } = payload as unknown as SessionStartPayload
    void (async () => {
      const cwd = resolveCwd(ctx, { agent: agent.id })
      // loadBoard never creates the file; a workspace without a board gets an
      // empty one back, whose zero counts skip the notice naturally.
      const tasks = await listTasks(cwd)
      const pool = tasks.filter((task) => task.status === 'open' && !task.assignee).length
      const assigned = tasks.filter((task) => task.status === 'open' && task.assignee).length
      const inProgress = tasks.filter((task) => task.status === 'in_progress').length
      if (pool + assigned + inProgress === 0) return
      const delegated = assigned > 0
        ? L('、已指派 {assigned} 条', ', {assigned} delegated', { assigned })
        : ''
      agent.inject(pluginNotice(
        randomUUID(),
        L(
          '本 workspace 的任务看板有待认领 {pool} 条{delegated}、进行中 {ip} 条任务。用 taskboard_list 查看；动手前记得先 claim / start。',
          'This workspace\'s task board has {pool} claimable{delegated} and {ip} in-progress task(s). See taskboard_list; claim / start before working.',
          { pool, delegated, ip: inProgress },
        ),
        `taskboard: ${pool} claimable, ${inProgress} in progress`,
      ))
    })().catch((error) => log.info(`session-start board notice failed: ${(error as Error)?.message ?? String(error)}`))
  })

  // The board-change watcher: one fs.watch per live session's .dsh/ directory,
  // diffs on change, and context-only notices merged under a per-workspace
  // storm window. TASKBOARD_WATCH=0 disables the whole thing (tools and the
  // bridge keep working either way).
  ctx.inject(['agents'], (child) => {
    const agents = (child as unknown as { agents?: AgentsLike }).agents
    if (!agents) return
    if (process.env.TASKBOARD_WATCH === '0') return
    const watcher = createBoardWatcher({
      loadBoard,
      resolveAgents: () => agents.list().map((agent) => ({ id: agent.id, cwd: cwdOfAgentSession(child, agent.id) })),
      injectNotice: (agentId, text) => {
        const agent = agents.get(agentId)
        agent?.inject(pluginNotice(randomUUID(), text, text.split('\n')[1] ?? 'board change'))
      },
      log: (message) => log.info(message),
    })
    child.effect(() => watcher.start(), 'taskboard-kit: board watcher')
    log.info('taskboard board watcher started (fs.watch on live sessions\' boards)')
  })
}

/** The session's cwd, or undefined — the watcher must NOT inherit the
 * process-cwd fallback resolveCwd applies (that would watch the wrong board). */
function cwdOfAgentSession(ctx: Context, agentId: string): string | undefined {
  try {
    const sessions = (ctx as unknown as { sessions?: { get(id: string): { header?: { cwd?: string } } | undefined } }).sessions
    return sessions?.get(agentId)?.header?.cwd
  } catch {
    return undefined
  }
}
