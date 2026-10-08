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
 *   taskboard tails [--all] [--status ...]
 *   taskboard tails --file <tailId> --card T-42
 *   taskboard tails --waive <tailId> --reason "…"
 *   taskboard tails --reset <tailId>
 *   taskboard path
 *
 * The rules the board enforces (long form: docs/COLLABORATION.md):
 *   · claim is atomic and refuses a card that is waiting on someone;
 *   · submit hands the card to a reviewer — never yourself — and is the HOLDER's
 *     act: only the holder, the creator or the human may submit a card (T-62);
 *   · approve/reject belong to that reviewer, the task's creator, or the human;
 *   · close/cancel/reopen belong to the card's creator, its owner, its reviewer,
 *     or the human (T-61);
 *   · ending a wait — unblock, and every action that would clear a waiting card
 *     (submit/approve/reject/done/close/reopen) — belongs to whoever the card
 *     waits on PLUS the card's creator/owner/reviewer or the human; a card
 *     parked on the human can be released by the HUMAN ONLY, never by an agent
 *     (T-61 + T-62). Each of those paths also records an explicit `unblocked`
 *     event, so a wait is never dropped silently (T-62 ② / T-60);
 *   · block/unblock record who a card is waiting on WITHOUT faking a status,
 *     and blocking on a human fires TASKBOARD_NOTIFY_CMD when one is wired.
 *   These actor checks stop mistakes and overreach, NOT forgery: `--by` is a
 *   recorded value, so the board is still not a security boundary.
 *   · submit 成功后**主动通知 reviewer**（T-56）：板里名册里有他的 msg9 地址、
 *     且环境里有 msg9 二进制时才真发一封；否则只打印一条可直接复制发送的提示。
 *     通知是附属动作 —— 没有 msg9 / 地址未知 / 发送失败都不影响提交成功。
 *
 * --value takes the Fibonacci value points 0.5 1 2 3 5 8 ("1/2" works for 0.5;
 * "none" on update clears back to unestimated).
 * Global flags: --cwd DIR (default: pwd) · --by NAME (default: $TASKBOARD_ACTOR
 * or "cli-agent") · --json (machine-readable output).
 * Exit codes: 0 ok · 1 usage/internal error · 2 not found / invalid · 3 claim conflict.
 *
 * @module dsh-taskboard-kit/bin
 */

import { existsSync } from 'node:fs'
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
  columnAgeMs,
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
  notifyReviewer,
  roster,
  saveBoard,
  updateTask,
  withBoardLock,
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
  'action', 'assignee', 'by', 'card', 'cwd', 'days', 'detail', 'file', 'limit', 'note', 'on', 'pool', 'priority',
  'question', 'reason', 'reset', 'reviewer', 'status', 'tags', 'text', 'title', 'value', 'waiting', 'waive', 'who',
])
/** Switches; every other `--name` must be given a value. */
const BOOLEAN_FLAGS = new Set(['all', 'json'])

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
  stale [--days N] [--limit N]                              协作健康：在等人类 / 审核没人认领 / 欠谁审核（按 reviewer 分组）/ 交接断了 / 列陈旧 / 复核尾巴
  roster                                                    名册：谁还在场（别名 dsh ≡ dsh-agent）
  get <id>                                                  单卡全文（时间线 + 留言 + SLA）
  create --title T [--detail D] [--assignee A] [--priority P] [--value V] [--tags a,b]
  claim <id>                                                原子认领（冲突退出码 3）
  update <id> [--action start|stop|submit|approve|reject|done|close|reopen|cancel|block|unblock]
              [--assignee A|none] [--reviewer A|none] [--on human|agent|external]
              [--who A] [--question Q] [--title T] [--detail D] [--priority P]
              [--value V|none] [--tags a,b] [--note N]
                                                            提交（submit）成功后**主动通知 reviewer**：
                                                            环境里有 msg9 就顺手发一封，否则只打印一条
                                                            可直接复制发送的提示 —— 发不出去绝不影响提交
                                                            权限：submit 只有持卡人 / 卡主 / 人类；
                                                            close/reopen 只有卡主 / 持卡人 / 裁决人 /
                                                            人类；解挂（含任何会清掉等待的动作）
                                                            等人类的卡只有人类能敲，等某个 agent 的
                                                            卡被等的人 + 卡主 / 持卡人 / 裁决人都能敲
  comment <id> --text TEXT                                  留言（不改状态）
  tails [--all] [--status S]                                复核尾巴：已结清的卡上，复核留言里还没消化的待办
  tails --file <tailId> --card T-42                         把一条尾巴落成卡（收口）
  tails --waive <tailId> --reason "…"                       显式作废一条尾巴（必须给理由）
  tails --reset <tailId>                                    撤掉收口记录（它又回到未收口清单）
  path                                                      板文件路径
global: --cwd DIR · --by NAME · --json`

/**
 * Read-only commands must not let a mistyped `--cwd` pass as an empty board:
 * a missing file and an empty board print the same "(board is empty)" — so say
 * the path out loud on stderr (stdout stays clean, `--json` stays parseable).
 */
function warnMissingBoard(cwd) {
  const file = boardFilePath(cwd)
  if (existsSync(file)) return
  process.stderr.write(`taskboard: no board file at ${file}\n`)
  process.stderr.write(
    'taskboard: an empty board and a mistyped --cwd look identical here — check the path, or create the first card\n',
  )
}

/**
 * 复核尾巴的一行人类可读输出（`stale` 与 `tails` 共用一份，避免两处措辞漂移）。
 * 每条都带**卡号 + 位置 + 命中的判据 + 原文片段** —— 没有原文就没法判真假。
 * 判据说明在这里截短（全量在 `--json` 的 `reasons` 里）：它是"为什么被列出来"
 * 的提示，不是要背下来的文本。
 */
function tailLine(tail, indent = '  ') {
  const where = tail.source.kind === 'log'
    ? `log:${tail.source.index} ${tail.source.event}`
    : `comment:${tail.source.index}`
  const mark = tail.settlement
    ? (tail.settlement.status === 'filed' ? `✅ 已落卡 ${tail.settlement.card}` : `🚫 已作废：${tail.settlement.reason}`)
    : '⚠ 未收口'
  const reasons = tail.reasons.map((why) => (why.length > 56 ? `${why.slice(0, 55)}…` : why)).join('｜')
  return [
    `${indent}${tail.id} · ${tail.task_id} · ${tail.source.by} @ ${tail.source.at} · ${where} · ${mark}`,
    `${indent}  判据：${reasons}`,
    `${indent}  原文：${tail.snippet}`,
  ]
}

function tailCommand(tail) {
  return `taskboard tails --file ${tail.id} --card T-新卡号   （或 --waive ${tail.id} --reason "…"）`
}

/**
 * 「欠谁审核」按 reviewer 分组（T-56 次要项）。
 *
 * `stale` 原来只列卡，回答不了 PO 最想问的那句话——**我该催谁**。只算
 * review 列里**有审核人、且没在等别人**的卡：在等别人的卡不是欠审核，
 * 是欠那个人一条答复（那属于「在等另一个 Agent」那一节）。
 */
function groupReviewOwed(tasks, now) {
  const groups = new Map()
  for (const task of tasks) {
    if (!task.reviewer || task.waiting_on) continue
    const group = groups.get(task.reviewer) ?? { reviewer: task.reviewer, cards: [], oldestMs: 0 }
    group.cards.push(task)
    group.oldestMs = Math.max(group.oldestMs, columnAgeMs(task, now))
    groups.set(task.reviewer, group)
  }
  // 欠得最多的人排最前；一样多时看谁压得最久，再看名字（输出稳定，方便贴进信里）。
  return [...groups.values()].sort((a, b) =>
    b.cards.length - a.cards.length || b.oldestMs - a.oldestMs || a.reviewer.localeCompare(b.reviewer))
}

/** `tails` 命令的收口动作：--file / --waive / --reset 三者其一。 */
async function settleTail(cwd, by, flags) {
  const modes = [
    typeof flags.file === 'string' ? 'filed' : null,
    typeof flags.waive === 'string' ? 'waived' : null,
    typeof flags.reset === 'string' ? 'reset' : null,
  ].filter(Boolean)
  if (modes.length !== 1) {
    console.error('tails: pass exactly one of --file <id> [--card T-n] / --waive <id> --reason "…" / --reset <id>')
    return EXIT.invalid
  }
  const mode = modes[0]
  const id = (mode === 'filed' ? flags.file : mode === 'waived' ? flags.waive : flags.reset).trim()
  if (id === '') {
    console.error('tails: the tail id is empty')
    return EXIT.invalid
  }
  const card = typeof flags.card === 'string' ? flags.card.trim() : ''
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''
  if (mode === 'filed' && !/^T-\d+$/.test(card)) {
    console.error('tails: --file needs --card T-<n> — 落卡必须给出承接它的卡号（否则只是把尾巴换个地方丢）')
    return EXIT.invalid
  }
  if (mode === 'waived' && reason === '') {
    console.error('tails: --waive needs --reason "…" — 作废必须给理由，否则没人分得清"做完了"和"放弃了"')
    return EXIT.invalid
  }

  const report = await health(cwd, {})
  const known = report.reviewTails.some((tail) => tail.id === id)
  const boardBefore = await loadBoard(cwd)
  const existing = (boardBefore.tails ?? {})[id]
  if (!known && !existing) {
    console.error(`tails: no review tail with id "${id}" — 复制清单里的 id 原样用（判据或原文变过的话，用 --reset 清掉旧的收口记录）`)
    return EXIT.invalid
  }
  if (mode === 'filed' && !Object.hasOwn(boardBefore.tasks, card)) {
    console.error(`tails: no such card: ${card} — 落卡必须落到真实存在的卡上`)
    return EXIT.invalid
  }

  const saved = await withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd)
    const tails = (board.tails ??= {})
    if (mode === 'reset') {
      delete tails[id]
    } else {
      tails[id] = {
        status: mode,
        card: mode === 'filed' ? card : null,
        reason: mode === 'waived' ? reason : null,
        by,
        at: new Date().toISOString(),
      }
    }
    await saveBoard(cwd, board)
    return tails[id] ?? null
  })

  if (flags.json === true) {
    print({ id, settlement: saved }, true)
    return EXIT.ok
  }
  if (mode === 'reset') {
    console.log(`↩ ${id} 的收口记录已清除 —— 它重新回到未收口清单`)
  } else if (mode === 'filed') {
    const target = boardBefore.tasks[card]
    console.log(`✅ ${id} → 已落卡 ${card}（${target.status}）· ${target.title}`)
  } else {
    console.log(`🚫 ${id} → 已作废：${reason}`)
  }
  return EXIT.ok
}

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
      warnMissingBoard(cwd)
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
      warnMissingBoard(cwd)
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
      warnMissingBoard(cwd)
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
      warnMissingBoard(cwd)
      const daysRaw = typeof flags.days === 'string' ? Number(flags.days) : undefined
      const override = daysRaw !== undefined && Number.isFinite(daysRaw) ? daysRaw * 86_400_000 : undefined
      const options = override === undefined
        ? {}
        : {
          columnSla: { pool: override, assigned: override, in_progress: override, review: override },
          waitSla: { human: override, agent: override },
        }
      const result = await health(cwd, options)
      const openTails = result.reviewTails.filter((tail) => !tail.settlement)
      // 「欠谁审核」按 reviewer 分组（T-56 次要项）：只列卡回答不了 PO 最想问的
      // 那句话——**该催谁**。review 列有审核人的卡，审核人就是他该被催的理由。
      const reviewOwed = groupReviewOwed(await listTasks(cwd, { status: 'review' }), Date.now())
      if (asJson) {
        const json = Object.fromEntries(Object.entries(result)
          .filter(([kind]) => kind !== 'reviewTails' && kind !== 'reviewTailOrphans')
          .map(([kind, issues]) => [
            kind,
            issues.map((issue) => ({
              id: issue.task.id,
              title: issue.task.title,
              status: issue.task.status,
              actor: issue.actor,
              age_ms: issue.ageMs,
              detail: issue.detail,
            })),
          ]))
        json.review_owed = reviewOwed.map((group) => ({
          reviewer: group.reviewer,
          count: group.cards.length,
          oldest_ms: group.oldestMs,
          cards: group.cards.map((card) => card.id),
        }))
        json.review_tails = openTails.map((tail) => ({
          id: tail.id,
          task: tail.task_id,
          status: tail.task_status,
          by: tail.source.by,
          at: tail.source.at,
          where: tail.source.kind === 'log' ? `log:${tail.source.index}` : `comment:${tail.source.index}`,
          event: tail.source.event,
          rules: tail.rules,
          reasons: tail.reasons,
          snippet: tail.snippet,
          offset: tail.offset,
          responsibles: tail.responsibles,
        }))
        print(json, true)
        return EXIT.ok
      }
      const sections = [
        ['⏳ 在等人类决定（面板顶部可见；不看面板就用你的通知通道叫人）', result.waitingHuman],
        ['🔗 在等另一个 Agent / 外部（去催那个人，别干等）', result.waitingOther],
        ['🔍 在 review 但没有审核人（改派或 comment 说明）', result.unownedReview],
        [`🕵 欠审核：${reviewOwed.length} 个 reviewer 手里压着 ${reviewOwed.reduce((sum, group) => sum + group.cards.length, 0)} 张卡（他不看就等于没有——先催人，再谈改派）`, reviewOwed, 'review'],
        ['👻 派给了久未/从未出现的 Agent（改派或收回池子）', result.orphaned],
        ['🕰 列陈旧（超过该列阈值）', result.stale],
      ]
      let printed = 0
      for (const [title, issues, kind] of sections) {
        if (issues.length === 0) continue
        printed += 1
        console.log(title)
        // 「欠审核」按人分组：一行一个人（他欠几张、最久多久、哪几张卡 + 他该敲的命令）。
        if (kind === 'review') {
          for (const group of issues) {
            console.log(`  ${group.reviewer} · ${group.cards.length} 张 · 最久 ${ageLabel(group.oldestMs)} · ${group.cards.map((card) => card.id).join(' ')}`)
            console.log(`      → taskboard inbox --by ${group.reviewer} --cwd ${cwd}`)
          }
          continue
        }
        for (const issue of issues) {
          const who = issue.actor ? ` · ${issue.actor}` : ''
          console.log(`  ${issue.task.id} · ${issue.task.status} · ${issue.task.priority} · 已 ${ageLabel(issue.ageMs)}${who} · ${issue.task.title}`)
          if (issue.detail && !['quiet', 'never-seen', 'unknown-actor'].includes(issue.detail)) {
            console.log(`      ↳ ${issue.detail}`)
          }
        }
      }
      // 复核尾巴单独一节：它查的是**已经结清的卡**，别的自检一律不看那里。
      // 默认只列最老的 10 条 —— 全量在 `taskboard tails`（那才是报告，这里是点名）。
      if (openTails.length > 0) {
        printed += 1
        const limitRaw = typeof flags.limit === 'string' ? Number(flags.limit) : 10
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10
        const oldest = [...openTails].sort((a, b) => (Date.parse(a.source.at) || 0) - (Date.parse(b.source.at) || 0))
        console.log(`🔻 复核尾巴（${openTails.length} 条）——已结清的卡上，复核留言里的待办还没落卡/作废`)
        for (const tail of oldest.slice(0, limit)) {
          console.log(...tailLine(tail))
          console.log(`      → ${tailCommand(tail)}`)
        }
        if (oldest.length > limit) {
          console.log(`  …另有 ${oldest.length - limit} 条（这里只列最老的 ${limit} 条，--limit N 可调）：taskboard tails`)
        }
      }
      if (printed === 0) console.log('(no health issues — board is clean)')
      return EXIT.ok
    }
    case 'tails': {
      warnMissingBoard(cwd)
      if (flags.file !== undefined || flags.waive !== undefined || flags.reset !== undefined) {
        return settleTail(cwd, by, flags)
      }
      const result = await health(cwd, {})
      const openTails = result.reviewTails.filter((tail) => !tail.settlement)
      const settled = result.reviewTails.filter((tail) => tail.settlement)
      const shown = flags.all === true ? result.reviewTails : openTails
      const status = typeof flags.status === 'string' ? flags.status : null
      const listed = status ? shown.filter((tail) => tail.task_status === status) : shown
      if (asJson) {
        print({
          stats: {
            cards: new Set(result.reviewTails.map((tail) => tail.task_id)).size,
            tails: result.reviewTails.length,
            open: openTails.length,
            filed: settled.filter((tail) => tail.settlement.status === 'filed').length,
            waived: settled.filter((tail) => tail.settlement.status === 'waived').length,
          },
          orphans: result.reviewTailOrphans,
          tails: listed.map((tail) => ({
            id: tail.id,
            task: tail.task_id,
            status: tail.task_status,
            by: tail.source.by,
            at: tail.source.at,
            where: tail.source.kind === 'log' ? `log:${tail.source.index}` : `comment:${tail.source.index}`,
            event: tail.source.event,
            rules: tail.rules,
            reasons: tail.reasons,
            snippet: tail.snippet,
            offset: tail.offset,
            responsibles: tail.responsibles,
            settlement: tail.settlement,
          })),
        }, true)
        return EXIT.ok
      }
      const filed = settled.filter((tail) => tail.settlement.status === 'filed').length
      const waived = settled.length - filed
      console.log(`复核尾巴：${openTails.length} 条未收口 · ${filed} 条已落卡 · ${waived} 条已作废（扫了 ${new Set(result.reviewTails.map((t) => t.task_id)).size} 张有尾巴的 closed/done 卡）`)
      if (result.reviewTailOrphans.length > 0) {
        console.log(`⚠ ${result.reviewTailOrphans.length} 条收口记录已对不上任何尾巴（判据/原文变过）：${result.reviewTailOrphans.join(', ')}`)
        console.log('  清掉用：taskboard tails --reset <tailId>')
      }
      if (listed.length === 0) {
        console.log(flags.all === true
          ? '(没有复核尾巴)'
          : '(没有未收口的复核尾巴 —— 用 --all 看已收口的)')
        return EXIT.ok
      }
      for (const tail of listed) {
        console.log(...tailLine(tail, ''))
        if (!tail.settlement) console.log(`  → ${tailCommand(tail)}`)
        console.log('')
      }
      return EXIT.ok
    }
    case 'get': {
      warnMissingBoard(cwd)
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
      // 把卡交给某个人审核 ≠ 他知道这件事（T-56：kimi 那 9 张卡就是这么静默的）。
      // 通知**绝不阻断提交**：notifyReviewer 自己承诺不抛错（没有 msg9 / 地址未知 /
      // 发送失败 ⇒ 只打印一条可复制的提示）。这里不套 try/catch 是刻意的 ——
      // 保证"不阻断"只有一个责任人，变异测试改坏它就必须红。
      if (patch.action === 'submit' && events.includes('submitted') && task.reviewer) {
        const notice = await notifyReviewer(
          { cwd, task, reviewer: task.reviewer, submittedBy: by },
          { log: (message) => console.error(`taskboard: ${message}`) },
        )
        // --json 时 stdout 必须保持可解析（有测试盯着），提示走 stderr。
        if (notice.hint) {
          if (asJson) console.error(notice.hint)
          else console.log(notice.hint)
        }
      }
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
