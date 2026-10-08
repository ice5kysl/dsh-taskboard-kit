/**
 * dsh-taskboard-kit — single Loader entry (package name `dsh-taskboard-kit`).
 *
 * Two faces, one board:
 *
 *   • host  — the taskboard_* model tools, the `/dsh-taskboard/*` bridge the
 *             browser kanban calls, the collaboration protocol in the system
 *             prompt, a session-start digest of what is on YOU, an fs.watch
 *             board-change watcher, and a clock-driven self-audit that nudges
 *             when a card of yours goes stale (a file watcher can never see
 *             "nobody touched it for three days");
 *   • web   — the kanban tab itself (see `src/client`).
 *
 * Model: **one board per dsh workspace**, its only source of truth the JSON
 * file `<workspace>/.dsh/taskboard.json`. Tools resolve the workspace from the
 * calling session's cwd; the panel passes the same cwd as a query/body field.
 *
 * The collaboration protocol this file writes into the system prompt is the
 * normative text; `docs/COLLABORATION.md` is its long form — keep them in step.
 *
 * @module dsh-taskboard-kit
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BRIDGE_PREFIX, createTaskboardBridge, defaultBridgeDeps } from './http.ts'
import { L } from './locale.ts'
import { notifyHuman } from './notify.ts'
import { inbox, loadBoard } from './store.ts'
import { ageLabel, registerTaskboardTools } from './tools.ts'
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
  LOCK_TIMING,
  actorAliasGroups,
  actorNamesOf,
  addComment,
  boardFilePath,
  canonicalActor,
  claimTask,
  columnAgeMs,
  createTask,
  enableBoard,
  getTask,
  health,
  humanNames,
  inbox,
  listTasks,
  loadBoard,
  principalKey,
  roster,
  samePrincipal,
  saveBoard,
  taskStaleness,
  updateTask,
  withBoardLock,
} from './store.ts'
export { resolveCwd } from './workspace.ts'
export { L } from './locale.ts'
export { noticePayload, notifyHuman, notifyHookExample, msg9HookExample, type HumanNotice, type NotifyResult } from './notify.ts'
export {
  findOnPath,
  msg9AddressOf,
  noticeKey,
  notifyReviewer,
  reviewNoticeBody,
  reviewNoticeSubject,
  reviewNotifyHint,
  shellQuote,
  submitAnchor,
  type ReviewerNotice,
  type ReviewerNotifyDeps,
  type ReviewerNotifyReason,
  type ReviewerNotifyResult,
} from './review-notify.ts'
export { TASK_VALUES } from '../shared/types.ts'
export {
  HUMAN_ACTOR,
  actorKey,
  actorKeyOf,
  actorNames,
  actorSeenAt,
  ageInColumnMs,
  assigneeIsGone,
  boardHealth,
  columnSince,
  compareByValue,
  inboxFor,
  isStale,
  parseAliasConfig,
  parseWatchNames,
  resolveActor,
  sameActor,
  stalenessOf,
  waitingOnHuman,
  DEFAULT_COLUMN_SLA_MS,
  DEFAULT_QUIET_MS,
  DEFAULT_WAIT_SLA_MS,
  type BoardHealth,
  type HealthIssue,
  type InboxItem,
  type InboxKind,
  type InboxOptions,
  type Staleness,
  type StalenessOptions,
} from '../shared/board.ts'
export { ageLabel, formatGet, formatInbox, marksOf, registerTaskboardTools } from './tools.ts'
export { createBoardWatcher, diffBoards, type HumanWaitEscalation } from './watch.ts'

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
  /** v4 producer-owned source kind — dsh 0.1.7's persistence refuses the
   *  retired `kind: 'plugin'` wrapper; `plugin:<name>` is exactly what its
   *  v3→v4 migrator generates for this source. */
  source: { kind: 'plugin:taskboard-kit'; form: 'notice'; summary: string }
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
    source: { kind: 'plugin:taskboard-kit', form: 'notice', summary: summary.slice(0, 120) },
  }
}

/** Who this instance is on the board (same resolution as the tools). */
function selfActor(): string {
  return process.env.TASKBOARD_ACTOR?.trim()
    || process.env.TASKBOARD_WATCH_NAMES?.split(',')[0]?.trim()
    || 'dsh-agent'
}

/**
 * The collaboration protocol, in the system prompt: the agent should know how
 * this board works before any notice ever arrives. This is the normative text
 * (docs/COLLABORATION.md is its long form).
 */
function protocolText(): string {
  return L(
    [
      '## 任务看板（多 Agent 协作，必读）',
      '本 workspace 有一块共享任务看板；人类在「看板」页签看的是同一块板，唯一真实来源是 `.dsh/taskboard.json`。',
      '一切操作走 taskboard_* 工具（没有插件的 Agent 走 `bin/taskboard.mjs` CLI），**永远不要手改 JSON**。',
      '（完整规范：本插件 `docs/COLLABORATION.md`；下面是必须遵守的那部分。）',
      '',
      '### 会话开始先看自己那一份',
      '- `taskboard_inbox` —— 现在压在你身上的事，按急迫度排好，每条都带该敲的命令。**这是第一步**。',
      '- 需要细节用 `taskboard_get <id>`（时间线 + 留言）；不熟这块板先 `taskboard_roster`（谁还在场）。',
      '',
      '### 状态怎么走：**只有 closed 是终点**',
      '- 正常路径：`open → in_progress → review → done`，再由卡主 / PO 收口 `close`。',
      '- `done` = 干完且审核通过，**但还没结清**：卡仍在看板上，仍计入「未结清」。',
      '  审核通过 ≠ 这件事了了（可能还要部署、等上游、补文档），所以 done 之后必须有人收口。',
      '- `close` = 结清。**这是唯一的终态**，结清后卡不再出现在活跃计数里。',
      '- 收口**有归属**（板子会拒）：只有**卡主 / 持卡人 / 裁决人 / 人类**能 `close`；',
      '  轮不到你收的卡，去 comment 说清现状 + 催该收口的人，**不要替他收口**。',
      '- 真要"这事不做了"也用 close，但**必须在 note / comment 里写清为什么不做** ——',
      '  否则没人分得清"做完了收口"和"放弃了"。',
      '- `reopen` 可以从 done 或 closed 回到 open（结清错了就退回来，同一批人有权）。',
      '',
      '### 动手之前先占位（否则两个 Agent 会撞车）',
      '- 池里的卡用 `taskboard_claim`（原子；冲突 = 别人抢到了，换一张，别硬做）。',
      '- 指派给你的卡用 `taskboard_update`（action=start）。没占位就不开工。',
      '',
      '### 做完交审核，不要自己 done',
      '- `taskboard_update`（action=submit, reviewer=<名字>），并用 `taskboard_comment` 写清：做了什么、验证了什么、还差什么。',
      '  没有交接留言的提交，审核人无法验收。',
      '- 只有 reviewer 本人、卡主、人类可以裁决；**不能审自己的活**（板子会拒）。',
      '- 通过用 `--action approve`；打回用 `--action reject --note "原因"`（必须写原因），卡回到作者手上，改完再 submit。',
      '',
      '### 卡住了：说清在等谁（action=block / unblock）',
      '- 等人类决定：`--action block --on human --question "一句能直接转发给我主人的问句"`。',
      '  它会进「等人类」清单，人类在面板顶部就能看到并当场回复；**同时你有责任主动叫人**',
      '  （用你自己的通知通道：msg9 / 桌面通知 / webhook / 邮件，或让运维配 `TASKBOARD_NOTIFY_CMD`）。',
      '- 等另一个 Agent：`--action block --on agent --who <名字> --question "..."`。',
      '- 对方答复后用 `--action unblock`（答复写进 comment），然后接着干。',
      '- **解除等待有归属**（板子会拒）：等人类的卡**只有人类能 unblock**，agent 一律不得代解；',
      '  等某个 Agent 的卡只有那个 Agent（或人类）能解。挂起是**人类的**等待，你只能催、不能替。',
      '- 等谁的卡**不能被认领**：在等决定 ≠ 没人要。',
      '',
      '### 跟进要及时（这块板最容易烂的地方）',
      '- 状态一变就更新：开工 start、卡住 block、干完 submit、审核过后收口 close。别让卡停在旧状态里。',
      '- 进展即时用 `--note`；发现 / 交接 / 测试反馈用 `taskboard_comment`（不改状态）。',
      '- 看板会**自检并主动推给你**：你的卡陈旧了（review 超 24h / in_progress 超 72h / 指派未开工超 48h）、',
      '  被打回后再无动静、你派出去的活接的人久未出现 —— 自检会点名，并给出该敲的命令。',
      '',
      '### 能自己推进的，不要等人',
      '- 池子里的活自己认领；能自测的自己测；发现卡派给了不在场的 Agent，**改派是你的责任**。',
      '- 只有真需要人类拍板（对外动作、资源、方向取舍）才 block --on human，问句要具体到能一句话回答。',
      '- 等人类超过 24h 会被升级催办（面板 + 可选外发通知），别让卡烂在自己手里。',
      '',
      '### 变化会自动推给你，无需轮询',
      '- 指派给你、审核结论、新留言、有人把审核 hand off 给你、有人开始等你 —— 都会注入 context。收到就处理。',
    ].join('\n'),
    [
      '## Task board (multi-agent collaboration, required reading)',
      'This workspace has a shared task board; the human watches the SAME board in the kanban tab. Its only source of',
      'truth is `.dsh/taskboard.json`. Drive it with the taskboard_* tools (agents without the plugin use the',
      '`bin/taskboard.mjs` CLI) — **never edit the JSON by hand**.',
      '(Full spec: the plugin\'s `docs/COLLABORATION.md`; the rules below are the part you must follow.)',
      '',
      '### Start every session with your own slice',
      '- `taskboard_inbox` — what is on YOU right now, most urgent first, each item with the command that moves it. **Do this first.**',
      '- `taskboard_get <id>` for detail (timeline + comments); `taskboard_roster` to see who is actually around.',
      '',
      '### The status model: **only `closed` is terminal**',
      '- Normal path: `open → in_progress → review → done`, then an owner/PO settles it with `close`.',
      '- `done` = work finished and approved, **but NOT settled**: the card stays on the board and still counts as',
      '  open work. Approval is not the same as the matter being closed out (deploys, upstream sign-off, docs may',
      '  still follow), so a `done` card still needs someone to close it.',
      '- `close` = settled. **This is the ONE terminal status**; a settled card leaves the active counts.',
      '- Settling **has an owner** (the board refuses otherwise): only the **card\'s creator / owner / reviewer / the',
      '  human** can `close`. If a card is not yours to settle, comment the state and ping whoever owes it — do not settle it for them.',
      '- "We are not doing this after all" is also a `close`, but you **must say why** in the note/comment — otherwise',
      '  nobody can tell "finished and settled" from "abandoned".',
      '- `reopen` takes a card from `done` or `closed` back to `open` (settled by mistake? undo it — same people).',
      '',
      '### Take ownership before working (otherwise two agents collide)',
      '- Pool task → `taskboard_claim` (atomic; a conflict means someone got there first — pick another).',
      '- Task assigned to you → `taskboard_update` (action=start). Never start work without claiming it.',
      '',
      '### Hand off for review instead of marking it done yourself',
      '- `taskboard_update` (action=submit, reviewer=<name>) plus a `taskboard_comment` saying what you did, what you',
      '  verified, and what is still open. A submission without a handoff note cannot be reviewed.',
      '- Only the named reviewer, the task creator or the human can decide; **you cannot review your own work** (the board refuses).',
      '- `--action approve` to pass; `--action reject --note "why"` to send it back (a reason is mandatory).',
      '',
      '### Stuck? Say who you are waiting on (action=block / unblock)',
      '- Waiting on a human: `--action block --on human --question "a one-liner that can be forwarded as-is"`.',
      '  It lands in the「waiting on you」list the human sees at the top of the panel — and **it is your job to ping them**',
      '  (via whatever channel you have: msg9 / a desktop notification / a webhook / mail, or `TASKBOARD_NOTIFY_CMD`).',
      '- Waiting on another agent: `--action block --on agent --who <name> --question "..."`.',
      '- When the answer lands: `--action unblock` (put the answer in a comment), then carry on.',
      '- **Releasing a wait has an owner** (the board refuses otherwise): a card parked on the human can be',
      '  unblocked **only by the human** — never by an agent; a card parked on a named agent only by that agent',
      '  (or the human). A human wait is the HUMAN\'s wait: you may ping, never answer it for them.',
      '- A card waiting on someone **cannot be claimed**: parked ≠ unowned.',
      '',
      '### Keep the board current (this is where boards rot)',
      '- Update on every state change: start, block, submit, and close once approved. Never leave a card stale.',
      '- Progress notes with `--note`; findings / handoffs / test feedback with `taskboard_comment` (state untouched).',
      '- The board **self-audits and pushes to you**: your cards going stale (review > 24h, in_progress > 72h,',
      '  assigned-but-unstarted > 48h), a rejection you never answered, work you delegated to an actor that went',
      '  quiet — all named in the audit, with the command to run.',
      '',
      '### Advance what you can without a human',
      '- Claim from the pool; verify your own work; if a card sits with an actor that is not around, **reassigning it is your job**.',
      '- Only park on a human for real decisions (external actions, resources, direction) — and ask a one-line question.',
      '- A human wait over 24h escalates (panel + optional out-of-band notify); do not let a card rot in your hands.',
      '',
      '### Changes are pushed to you — no polling',
      '- Assignments, verdicts, new comments, a review handed to you, someone starting to wait on you — all injected as context.',
    ].join('\n'),
  )
}

export function apply(ctx: Context): void {
  const log = ctx.logger('taskboard-kit')
  log.info('taskboard-kit loaded')

  registerTaskboardTools(ctx)
  log.info('taskboard tools registered (inbox, list, create, claim, update, comment, get, roster)')

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

  // The board rules, in the system prompt: the agent should know how this board
  // works before any notice ever arrives. Soft dependency — a profile without
  // dsh-system-prompt simply skips the section.
  ctx.inject(['systemPrompt'], (child) => {
    const systemPrompt = (child as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
    if (!systemPrompt) return
    systemPrompt.section({ name: 'taskboard:rules', order: 5000, text: protocolText() })
    log.info('taskboard collaboration protocol added to the system prompt')
  })

  // Every new session starts with its own actionable slice — not a bare count.
  // Context only (agent.inject) — never a wakeup.
  ctx.on('agent/session-start', (payload) => {
    const { agent } = payload as unknown as SessionStartPayload
    void (async () => {
      const cwd = resolveCwd(ctx, { agent: agent.id })
      const actor = selfActor()
      // loadBoard never creates the file; a workspace without a board gets an
      // empty one back, whose empty inbox skips the notice naturally.
      const items = await inbox(cwd, actor, { poolLimit: 3 })
      if (items.length === 0) return
      const head = L(
        '本 workspace 的任务看板上有 {count} 件事压着你（{actor}）——用 taskboard_inbox 看全（每条都带该敲的命令）：',
        'This workspace\'s task board has {count} item(s) on you ({actor}) — taskboard_inbox has them all, each with the command to run:',
        { count: items.length, actor },
      )
      const lines = items.slice(0, 5).map((item) => `· ${item.task.id} ${item.task.title} — ${item.suggest}`)
      const more = items.length > 5 ? L('\n…还有 {rest} 条', '\n…and {rest} more', { rest: items.length - 5 }) : ''
      agent.inject(pluginNotice(
        randomUUID(),
        `${head}\n${lines.join('\n')}${more}`,
        `taskboard: ${items.length} item(s) on you`,
      ))
    })().catch((error) => log.info(`session-start board notice failed: ${(error as Error)?.message ?? String(error)}`))
  })

  // The board watcher, two halves:
  //   • change-driven — one fs.watch per live session's .dsh/ directory, diffs
  //     on change, context-only notices merged under a per-workspace storm window;
  //   • clock-driven — a periodic self-audit, because the failure mode that
  //     matters most (nobody touched the card for three days) never writes a file.
  // TASKBOARD_WATCH=0 disables both (tools and the bridge keep working).
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
      // A card parked on the human past its wait SLA: push it out-of-band (via
      // the hook the operator wired) and tell the agents to chase it.
      onHumanWaitOverdue: (escalation) => {
        const { task, question, waitedMs } = escalation
        void notifyHuman(
          { cwd: escalation.cwd, task, question, reason: 'overdue', waitingBy: task.assignee ?? '', waitedMs },
          { log: (message) => log.info(message) },
        ).then((result) => {
          if (!result.delivered) log.info(`human wait overdue on ${task.id} (no TASKBOARD_NOTIFY_CMD wired; panel only)`)
        })
        const text = L(
          '[看板催办] {id} 已经等在人类身上 {age} 了：「{question}」\n再叫一次人（你的通知通道：msg9 / 桌面通知 / webhook）；或者把不依赖他的部分拆出来先做掉（不要空等）。',
          '[board escalation] {id} has been waiting on the human for {age}: "{question}"\nPing them again via your notify channel (msg9 / desktop notification / webhook), or split off the part you can advance (do not idle on it).',
          { id: task.id, age: ageLabel(waitedMs), question },
        )
        for (const agent of agents.list()) {
          if (cwdOfAgentSession(child, agent.id) !== escalation.cwd) continue
          try {
            agent.inject(pluginNotice(randomUUID(), text, `taskboard: ${task.id} waiting on the human`))
          } catch (error) {
            log.info(`escalation injection failed for ${agent.id}: ${(error as Error)?.message ?? String(error)}`)
          }
        }
      },
      log: (message) => log.info(message),
    })
    child.effect(() => watcher.start(), 'taskboard-kit: board watcher')
    log.info('taskboard board watcher started (fs.watch + periodic self-audit)')
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
