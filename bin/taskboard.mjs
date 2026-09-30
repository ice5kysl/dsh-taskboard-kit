#!/usr/bin/env node
/**
 * taskboard — shell entry to a workspace's task board.
 *
 * The same store the dsh plugin's model tools and the browser bridge use,
 * wrapped as a zero-dependency CLI so agents WITHOUT the dsh plugin (Kimi
 * Code, Claude Code, any shell) work the same board through the same lock
 * and the same atomic claim — never by hand-editing the JSON.
 *
 *   taskboard inbox [--by NAME] [--limit N] [--pool N] [--no-human]
 *   taskboard list [--status open|in_progress|review|done|closed] [--assignee NAME|none]
 *                  [--waiting human|agent|external|any]
 *   taskboard stale [--days N]
 *   taskboard roster
 *   taskboard get <id>
 *   taskboard create --title T [--detail D] [--assignee A] [--priority high|medium|low] [--value V] [--tags a,b]
 *   taskboard claim <id>
 *   taskboard update <id> [--action start|stop|submit|approve|reject|done|close|reopen|cancel|block|unblock]
 *                         [--assignee A|none] [--reviewer A|none] [--on human|agent|external]
 *                         [--who A] [--question Q] [--title T] [--detail D] [--priority P]
 *                         [--value V|none] [--tags a,b] [--note N]
 *   taskboard comment <id> --text TEXT
 *   taskboard path
 *
 * The rules the board enforces (long form: docs/COLLABORATION.md):
 *   · claim is atomic and refuses a card that is waiting on someone;
 *   · submit hands the card to a reviewer — never yourself;
 *   · approve/reject belong to that reviewer, the task's creator, or the human;
 *   · block/unblock record who a card is waiting on WITHOUT faking a status,
 *     and blocking on a human fires TASKBOARD_NOTIFY_CMD when one is wired.
 *
 * --value takes the Fibonacci value points 0.5 1 2 3 5 8 ("1/2" works for 0.5;
 * "none" on update clears back to unestimated).
 * Global flags: --cwd DIR (default: pwd) · --by NAME (default: $TASKBOARD_ACTOR
 * or "cli-agent") · --json (machine-readable output).
 * Exit codes: 0 ok · 1 usage/internal error · 2 not found / invalid · 3 claim conflict.
 *
 * @module dsh-taskboard-kit/bin
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'))
const {
  StoreError,
  TASK_VALUES,
  addComment,
  ageLabel,
  boardFilePath,
  claimTask,
  createTask,
  formatGet,
  formatInbox,
  getTask,
  health,
  inbox,
  listTasks,
  loadBoard,
  marksOf,
  notifyHuman,
  roster,
  updateTask,
} = lib

const EXIT = { ok: 0, error: 1, invalid: 2, conflict: 3 }

/** --value flag: "0.5"/"1/2"/"1"/"2"/"3"/"5"/"8" → the TaskValue; "none" → null (clear). */
function parseValueFlag(raw) {
  if (raw.trim().toLowerCase() === 'none') return null
  const num = Number(raw.trim() === '1/2' ? '0.5' : raw.trim())
  return TASK_VALUES.includes(num) ? num : undefined
}

/** Flags that take a value; a bare `--flag` for one of these is a usage error. */
const VALUE_FLAGS = new Set([
  'action', 'assignee', 'by', 'cwd', 'days', 'detail', 'limit', 'note', 'on', 'pool', 'priority', 'question',
  'reviewer', 'status', 'tags', 'text', 'title', 'value', 'waiting', 'who',
])
/** Switches; every other `--name` must be given a value. */
const BOOLEAN_FLAGS = new Set(['json'])

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    // `--key=value` is the unambiguous form — and the only one that can carry
    // a value starting with `--` (e.g. `--detail="--- 待办 ---"`). A bare
    // `--json` is a switch; any other bare `--key` takes the next token as its
    // value, whatever it looks like.
    const eq = arg.indexOf('=')
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined) {
      flags[key] = true // missing value: reported by checkFlags below
      continue
    }
    flags[key] = next
    i += 1
  }
  return { positional, flags }
}

/**
 * Reject the two silent-data-loss shapes: a value flag with no value
 * (`--note`), and a flag nobody implements (`--priorty high` used to be
 * ignored, so `create` quietly produced a medium-priority task).
 */
function checkFlags(flags) {
  for (const [key, value] of Object.entries(flags)) {
    if (!VALUE_FLAGS.has(key) && !BOOLEAN_FLAGS.has(key)) {
      console.error(`taskboard: unknown flag "--${key}"`)
      return false
    }
    if (value === true && VALUE_FLAGS.has(key)) {
      console.error(`taskboard: --${key} requires a value`)
      return false
    }
  }
  return true
}

function line(task) {
  const who = task.assignee ?? '·pool·'
  const value = task.value != null ? ` · v${task.value}` : ''
  return `${task.id} · ${task.status} · ${who} · ${task.priority}${value}${marksOf(task, Date.now())} · ${task.title}`
}

function print(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2))
  else if (typeof value === 'string') console.log(value)
}

function fail(error) {
  if (error instanceof StoreError) {
    console.error(error.message)
    if (error.code === 'conflict') return EXIT.conflict
    if (error.code === 'not-found' || error.code === 'invalid-input' || error.code === 'invalid-transition') return EXIT.invalid
    return EXIT.error
  }
  console.error(`taskboard: ${error?.message ?? String(error)}`)
  return EXIT.error
}

const USAGE = `commands:
  inbox [--by NAME] [--limit N] [--pool N] [--no-human]     现在该你处理的事（按急迫度，带该敲的命令）
  list  [--status S] [--assignee NAME|none] [--waiting K]   全板（含 reviewer / 等谁 / 陈旧标记）
  stale [--days N]                                          协作健康：在等人类 / 审核没人认领 / 交接断了 / 列陈旧
  roster                                                    名册：谁还在场（别名 dsh ≡ dsh-agent）
  get <id>                                                  单卡全文（时间线 + 留言 + SLA）
  create --title T [--detail D] [--assignee A] [--priority P] [--value V] [--tags a,b]
  claim <id>                                                原子认领（冲突退出码 3）
  update <id> [--action start|stop|submit|approve|reject|done|close|reopen|cancel|block|unblock]
              [--assignee A|none] [--reviewer A|none] [--on human|agent|external]
              [--who A] [--question Q] [--title T] [--detail D] [--priority P]
              [--value V|none] [--tags a,b] [--note N]
  comment <id> --text TEXT                                  留言（不改状态）
  path                                                      板文件路径
global: --cwd DIR · --by NAME · --json`

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [command, ...rest] = positional
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd()
  // An empty actor must never claim/attribute anything: `--by ""` (or an empty
  // TASKBOARD_ACTOR) used to produce an in_progress task owned by nobody.
  const by = (typeof flags.by === 'string' ? flags.by : process.env.TASKBOARD_ACTOR ?? 'cli-agent').trim() || 'cli-agent'
  const asJson = flags.json === true
  if (command !== undefined && !checkFlags(flags)) return EXIT.invalid

  switch (command) {
    case 'path':
      print(boardFilePath(cwd), asJson)
      return EXIT.ok
    case 'inbox': {
      const poolRaw = typeof flags.pool === 'string' ? Number(flags.pool) : undefined
      const items = await inbox(cwd, by, {
        ...(poolRaw !== undefined && Number.isFinite(poolRaw) ? { poolLimit: poolRaw } : {}),
        ...(flags['no-human'] === true ? { includeHumanBlocked: false } : {}),
      })
      const limitRaw = typeof flags.limit === 'string' ? Number(flags.limit) : 0
      const shown = Number.isFinite(limitRaw) && limitRaw > 0 ? items.slice(0, limitRaw) : items
      if (asJson) print(shown, true)
      else print(formatInbox(shown, by, Date.now()), false)
      return EXIT.ok
    }
    case 'list': {
      const filter = {}
      if (typeof flags.status === 'string') filter.status = flags.status
      if (typeof flags.assignee === 'string') filter.assignee = flags.assignee
      if (typeof flags.waiting === 'string') filter.waiting = flags.waiting
      const tasks = await listTasks(cwd, filter)
      if (asJson) print(tasks, true)
      else print(tasks.length ? tasks.map(line).join('\n') : '(board is empty)', false)
      return EXIT.ok
    }
    case 'roster': {
      const entries = await roster(cwd)
      if (asJson) print(entries, true)
      else if (entries.length === 0) console.log('(roster is empty)')
      else console.log(entries.map(({ name, entry, quietMs }) => {
        const aliases = entry.aliases?.length ? ` ≡ ${entry.aliases.join(' / ')}` : ''
        const seen = entry.last_seen_at === null || quietMs === null
          ? 'never acted'
          : `last active ${ageLabel(quietMs)} ago`
        return `· ${name}${aliases} · ${entry.kind} · ${seen}`
      }).join('\n'))
      return EXIT.ok
    }
    case 'stale': {
      const daysRaw = typeof flags.days === 'string' ? Number(flags.days) : undefined
      const override = daysRaw !== undefined && Number.isFinite(daysRaw) ? daysRaw * 86_400_000 : undefined
      const options = override === undefined
        ? {}
        : {
          columnSla: { pool: override, assigned: override, in_progress: override, review: override },
          waitSla: { human: override, agent: override },
        }
      const result = await health(cwd, options)
      if (asJson) {
        print(Object.fromEntries(Object.entries(result).map(([kind, issues]) => [
          kind,
          issues.map((issue) => ({
            id: issue.task.id,
            title: issue.task.title,
            status: issue.task.status,
            actor: issue.actor,
            age_ms: issue.ageMs,
            detail: issue.detail,
          })),
        ])), true)
        return EXIT.ok
      }
      const sections = [
        ['⏳ 在等人类决定（面板顶部可见；不看面板就用你的通知通道叫人）', result.waitingHuman],
        ['🔗 在等另一个 Agent / 外部（去催那个人，别干等）', result.waitingOther],
        ['🔍 在 review 但没有审核人（改派或 comment 说明）', result.unownedReview],
        ['👻 派给了久未/从未出现的 Agent（改派或收回池子）', result.orphaned],
        ['🕰 列陈旧（超过该列阈值）', result.stale],
      ]
      let printed = 0
      for (const [title, issues] of sections) {
        if (issues.length === 0) continue
        printed += 1
        console.log(title)
        for (const issue of issues) {
          const who = issue.actor ? ` · ${issue.actor}` : ''
          console.log(`  ${issue.task.id} · ${issue.task.status} · ${issue.task.priority} · 已 ${ageLabel(issue.ageMs)}${who} · ${issue.task.title}`)
          if (issue.detail && !['quiet', 'never-seen', 'unknown-actor'].includes(issue.detail)) {
            console.log(`      ↳ ${issue.detail}`)
          }
        }
      }
      if (printed === 0) console.log('(no health issues — board is clean)')
      return EXIT.ok
    }
    case 'get': {
      const board = await loadBoard(cwd)
      const task = await getTask(cwd, rest[0])
      print(asJson ? task : formatGet(task, board, Date.now()), asJson)
      return EXIT.ok
    }
    case 'create': {
      if (typeof flags.title !== 'string') {
        console.error('create: --title is required')
        return EXIT.invalid
      }
      const input = { title: flags.title }
      if (typeof flags.detail === 'string') input.detail = flags.detail
      if (typeof flags.assignee === 'string') input.assignee = flags.assignee
      if (typeof flags.priority === 'string') input.priority = flags.priority
      if (typeof flags.value === 'string') {
        const parsed = parseValueFlag(flags.value)
        if (parsed === undefined) {
          console.error(`create: --value must be one of ${TASK_VALUES.join(' ')} ("1/2" = 0.5)`)
          return EXIT.invalid
        }
        input.value = parsed
      }
      if (typeof flags.tags === 'string') input.tags = flags.tags.split(',').map((t) => t.trim()).filter(Boolean)
      const task = await createTask(cwd, input, by)
      print(asJson ? task : `created ${line(task)}`, asJson)
      return EXIT.ok
    }
    case 'claim': {
      const task = await claimTask(cwd, rest[0], by)
      print(asJson ? task : `claimed ${line(task)}`, asJson)
      return EXIT.ok
    }
    case 'update': {
      const patch = {}
      if (typeof flags.action === 'string') patch.action = flags.action
      if (typeof flags.assignee === 'string') patch.assignee = flags.assignee === 'none' ? null : flags.assignee
      if (typeof flags.reviewer === 'string') patch.reviewer = flags.reviewer === 'none' ? null : flags.reviewer
      if (typeof flags.on === 'string') patch.wait_kind = flags.on
      if (typeof flags['wait-kind'] === 'string') patch.wait_kind = flags['wait-kind']
      if (typeof flags.who === 'string') patch.wait_who = flags.who === 'none' ? null : flags.who
      if (typeof flags['wait-who'] === 'string') patch.wait_who = flags['wait-who']
      if (typeof flags.question === 'string') patch.wait_question = flags.question
      if (typeof flags['wait-question'] === 'string') patch.wait_question = flags['wait-question']
      if (typeof flags.title === 'string') patch.title = flags.title
      if (typeof flags.detail === 'string') patch.detail = flags.detail
      if (typeof flags.priority === 'string') patch.priority = flags.priority
      if (typeof flags.value === 'string') {
        const parsed = parseValueFlag(flags.value)
        if (parsed === undefined) {
          console.error(`update: --value must be one of ${TASK_VALUES.join(' ')} ("1/2" = 0.5, "none" clears)`)
          return EXIT.invalid
        }
        patch.value = parsed
      }
      if (typeof flags.tags === 'string') patch.tags = flags.tags.split(',').map((t) => t.trim()).filter(Boolean)
      if (typeof flags.note === 'string') patch.note = flags.note
      const { task, events } = await updateTask(cwd, rest[0], patch, by)
      print(asJson ? task : `updated ${line(task)}  (${events.join(', ')})`, asJson)
      // Parking a card on the human must actually reach the human: same
      // out-of-band hook the model tool fires, so the CLI is not a second-class
      // path into the board.
      if (patch.action === 'block' && task.waiting_on?.kind === 'human') {
        const result = await notifyHuman({
          cwd,
          task,
          question: task.waiting_on.question,
          reason: 'blocked',
          waitingBy: by,
          waitedMs: 0,
        }, { log: (message) => console.error(`taskboard: ${message}`) })
        if (!asJson) {
          console.log(result.delivered
            ? 'notified the human via TASKBOARD_NOTIFY_CMD'
            : 'parked on the human — visible in the panel; ping them via your notify channel if they may not be looking')
        }
      }
      return EXIT.ok
    }
    case 'comment': {
      if (typeof flags.text !== 'string') {
        console.error('comment: --text is required')
        return EXIT.invalid
      }
      const task = await addComment(cwd, rest[0], flags.text, by)
      print(asJson ? task : `commented ${task.id} · by ${by}`, asJson)
      return EXIT.ok
    }
    case 'help': {
      console.error(USAGE)
      return EXIT.ok
    }
    default: {
      console.error(command ? `taskboard: unknown command "${command}"` : 'taskboard: a command is required')
      console.error(USAGE)
      return EXIT.error
    }
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error) => { process.exitCode = fail(error) },
)
