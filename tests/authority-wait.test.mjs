/**
 * T-62 · 提交的归属 + **拆除等待的唯一出口**（把 T-61 剩下的三条缝一起收口）。
 *
 * T-61（`a23c5c4`）给 `unblock` / `close` 加了 actor 校验，但同类缝还剩三条：
 *   ① `submit` **完全没有归属门** ⇒ 任何人都能把别人 in_progress 的卡提交去审核；
 *   ② `submit` / `approve` / `reject` / `done` / `close` / `reopen` 会**静默**清掉
 *      `waiting_on` ⇒ 一张挂人类的卡可以被人用 `done` 直接变成"已完"（绕过 `unblock`），
 *      而且 `log` 里没有 `unblocked` ⇒ 等待区间闭不上（T-60：走势图与当期值同屏矛盾）；
 *   ③ T-61 的新机制**引入锁死**：把卡挂成 `wait:agent(kimi)` 后，卡主/持卡人
 *      （T-13 的 dsh）自己也解不开 ⇒ 只能求人类或 kimi。
 *
 * 本文件的判定表：
 *   · `submit` × {持卡人 / 卡主 / 人类 / 别名 / 无关者 / 无持卡人 / 缺 created_by}
 *   · 清 `waiting_on` 的**每条路径** × {等人类 / 等具名 agent / 无等待}
 *   · ③「谁被等」是追加许可：卡主 / 持卡人 / 裁决人**始终**能解自己名下的卡；
 *     但「等人类」是**排他**的（T-61 §1 一步不让 —— 那正是越界 ①② 的缝）
 *   · 向后兼容：缺字段的老卡行为不变（真实板当夹具）
 *
 * 一句话口径（同 T-61）：这是**防误操作与防越权**，不是安全边界 ——
 * `by` 仍是记录值、可被伪造。
 *
 * Run: node tests/authority-wait.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

process.env.TASKBOARDKIT_LOCALE = 'en'
delete process.env.TASKBOARD_ACTOR
delete process.env.TASKBOARD_WATCH_NAMES
delete process.env.TASKBOARD_ACTOR_ALIASES
delete process.env.TASKBOARD_SIBLING_NAMES
process.env.TASKBOARD_HUMANS = 'iceskysl'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const bin = join(repo, 'bin', 'taskboard.mjs')
/** 本工作区的真实板（拿它当夹具；不存在时退回内置样本）。 */
const REAL_BOARD = join(repo, '..', '.dsh', 'taskboard.json')

const lib = await import('../lib/index.js')
const { StoreError, loadBoard, saveBoard, updateTask } = lib

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

console.log('dsh-taskboard-kit submit & wait-release authority test (T-62):')

const AT = '2026-10-07T00:00:00.000Z'
const HUMAN_WAIT = { kind: 'human', who: 'iceskysl', question: 'go/no-go?', since: AT }
const AGENT_WAIT = { kind: 'agent', who: 'kimi', question: 'are you done with T-3?', since: AT }
const EXTERNAL_WAIT = { kind: 'external', who: 'dsh@msg9.ice.msg9.io', question: 'did the publish land?', since: AT }
const UNNAMED_WAIT = { kind: 'agent', who: null, question: 'whoever owns T-3: done?', since: AT }

function makeTask(id, spec = {}) {
  const createdBy = spec.created_by ?? 'dsh'
  return {
    id,
    title: `card ${id}`,
    detail: '',
    status: 'in_progress',
    assignee: null,
    reviewer: null,
    waiting_on: null,
    priority: 'medium',
    value: null,
    tags: [],
    created_by: createdBy,
    created_at: AT,
    updated_at: AT,
    log: [{ at: AT, by: createdBy, event: 'created' }],
    comments: [],
    ...spec,
  }
}

/** 一块干净棋盘（名册留空 —— 见 T-61 的 `tests/authority.test.mjs`）。 */
async function boardWith(...specs) {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-wait-'))
  const board = await loadBoard(ws)
  board.tasks = {}
  board.actors = {}
  specs.forEach((spec, index) => {
    const id = `T-${index + 1}`
    const task = makeTask(id, spec)
    if (spec.omitCreatedBy) delete task.created_by
    if (spec.omitWaitingOn) delete task.waiting_on
    board.tasks[id] = task
  })
  board.next_seq = specs.length + 1
  await saveBoard(ws, board)
  return ws
}

async function attempt(ws, id, patch, by) {
  try {
    const { task, events } = await updateTask(ws, id, patch, by)
    return { allowed: true, task, events }
  } catch (error) {
    assert.ok(error instanceof StoreError, `expected StoreError, got ${error}`)
    return { allowed: false, code: error.code, message: error.message }
  }
}

/** 一格判定：`spec` 是卡，`patch` 是要敲的动作。 */
async function cell(spec, patch, by, expected) {
  const ws = await boardWith(spec)
  try {
    const result = await attempt(ws, 'T-1', patch, by)
    const what = `${JSON.stringify(patch)} on ${JSON.stringify({
      status: spec.status,
      created_by: spec.created_by ?? '(缺)',
      assignee: spec.assignee ?? null,
      reviewer: spec.reviewer ?? null,
      waiting: spec.waiting_on ? `${spec.waiting_on.kind}(${spec.waiting_on.who ?? '未指名'})` : null,
    })} × "${by}"`
    if (expected) {
      assert.ok(result.allowed, `${what}: 本该允许，实际被拒 ${result.code} — ${result.message}`)
    } else {
      assert.ok(!result.allowed, `${what}: 本该被拒，实际放行了`)
      assert.equal(result.code, 'conflict', `${what}: 归属拒绝应是 conflict，实际 ${result.code}`)
    }
    return result
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

/** 卡的事件序列（取最后 n 条）。 */
const tail = (task, n) => task.log.slice(-n).map((entry) => entry.event)

// ═══════════════════════════════════════════════ ① submit 的归属门

await check('① submit × 持卡人 / 卡主 / 人类 / 别名可以，无关者被拒（别人的卡不得替交）', async () => {
  const spec = { status: 'in_progress', created_by: 'dsh', assignee: 'kimi', reviewer: 'nova' }
  for (const by of ['kimi', 'dsh', 'human', 'iceskysl', 'dsh-agent']) {
    const result = await cell(spec, { action: 'submit' }, by, true)
    assert.equal(result.task.status, 'review', `${by}: submit 之后应进 review`)
  }
  // 裁决人**不是**提交人（交作业是作者的动作——reviewer 只决定，不代交）。
  for (const by of ['nova', 'claude', 'cc']) {
    const result = await cell(spec, { action: 'submit' }, by, false)
    assert.match(result.message, /is not yours to submit/, `${by}: 文案要说清"不归你提交"`)
    assert.match(result.message, /its holder \(kimi\)/, '文案要列出持卡人')
    assert.match(result.message, /its creator \(dsh\)/, '文案要列出卡主')
    assert.match(result.message, /or the human/, '文案要给出该找谁')
    assert.match(result.message, new RegExp(`"${by}" is none of them`), '文案要点名谁被拒')
  }
})

await check('① submit × 别名等价：卡主是 dsh-agent 时 dsh 交得了（否则会自锁）', async () => {
  await cell({ status: 'in_progress', created_by: 'dsh-agent', assignee: 'kimi' }, { action: 'submit' }, 'dsh', true)
  await cell({ status: 'in_progress', created_by: 'kimi', assignee: 'dsh-agent' }, { action: 'submit' }, 'dsh', true)
})

await check('① submit × 没有持卡人的卡：不锁死（没有"别人"可替；与改前逐字一致）', async () => {
  // `start` 不会把人写成持卡人，而 in_progress 的卡也 claim 不了 ⇒
  // 若在这里拦住，除了人类谁都推不动 —— 又造一个 T-62 ③ 那类锁死。
  for (const by of ['claude', 'nova', 'kimi']) {
    await cell({ status: 'in_progress', created_by: 'dsh', assignee: null }, { action: 'submit' }, by, true)
  }
})

await check('① submit × 缺 created_by 的老卡：退回改前行为', async () => {
  for (const by of ['claude', 'nova']) {
    await cell({ status: 'in_progress', assignee: 'kimi', omitCreatedBy: true }, { action: 'submit' }, by, true)
  }
})

await check('① submit × 顺序：状态机先说话（open / review 上是 invalid-transition，不是归属拒绝）', async () => {
  for (const [status, reason] of [['open', 'not started yet'], ['review', 'already in review']]) {
    const ws = await boardWith({ status, created_by: 'dsh', assignee: 'kimi' })
    try {
      const result = await attempt(ws, 'T-1', { action: 'submit' }, 'claude')
      assert.ok(!result.allowed, `${status}: 陌生人的 submit 本就不该成立（${reason}）`)
      assert.equal(result.code, 'invalid-transition', `${status} 上 submit：状态机该先说话，实际 ${result.code} — ${result.message}`)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }
})

// ═══════════════════════════════════════════════ ② 拆除等待的唯一出口

await check('② 等人类的卡：submit / approve / reject / done / close / unblock **六条路径一律被拒**（agent）', async () => {
  // 每一格都选一个"能过它自己那道门"的人，好证明拒绝来自**等待归属**而非别的门。
  const cases = [
    [{ status: 'in_progress', created_by: 'cc', assignee: 'cc', waiting_on: HUMAN_WAIT }, { action: 'submit' }, 'cc'],
    [{ status: 'review', created_by: 'dsh', assignee: 'cc', reviewer: 'cc', waiting_on: HUMAN_WAIT }, { action: 'approve' }, 'cc'],
    [{ status: 'review', created_by: 'dsh', assignee: 'cc', reviewer: 'cc', waiting_on: HUMAN_WAIT }, { action: 'reject', note: 'no' }, 'cc'],
    [{ status: 'in_progress', created_by: 'cc', assignee: 'cc', waiting_on: HUMAN_WAIT }, { action: 'done' }, 'cc'],
    [{ status: 'done', created_by: 'cc', assignee: 'cc', waiting_on: HUMAN_WAIT }, { action: 'close' }, 'cc'],
    [{ status: 'in_progress', created_by: 'cc', assignee: 'cc', waiting_on: HUMAN_WAIT }, { action: 'unblock' }, 'cc'],
  ]
  for (const [spec, patch, by] of cases) {
    const result = await cell(spec, patch, by, false)
    assert.match(result.message, /waiting on human/, `${patch.action}: 文案要说清在等人类`)
    assert.match(result.message, /only the human can/, `${patch.action}: 文案要说"只有人类"`)
    if (patch.action !== 'unblock') {
      assert.match(result.message, new RegExp(`${patch.action} would drop the human's question`), `${patch.action}: 文案要说清这条路径会丢掉人类的问题`)
    }
  }
})

await check('② 等 Agent 的卡：能过该动作自己门的人都能拆，且**必然写下 unblocked 事件**', async () => {
  const cases = [
    [{ status: 'in_progress', created_by: 'dsh', assignee: 'cc', waiting_on: AGENT_WAIT }, { action: 'submit' }, 'cc', ['unblocked', 'submitted']],
    [{ status: 'review', created_by: 'dsh', assignee: 'cc', reviewer: 'cc', waiting_on: AGENT_WAIT }, { action: 'approve' }, 'cc', ['unblocked', 'approved']],
    [{ status: 'review', created_by: 'dsh', assignee: 'cc', reviewer: 'cc', waiting_on: AGENT_WAIT }, { action: 'reject', note: 'no' }, 'cc', ['unblocked', 'rejected']],
    [{ status: 'in_progress', created_by: 'dsh', assignee: 'cc', waiting_on: AGENT_WAIT }, { action: 'done' }, 'cc', ['unblocked', 'done']],
    [{ status: 'done', created_by: 'dsh', assignee: 'cc', waiting_on: AGENT_WAIT }, { action: 'close' }, 'cc', ['unblocked', 'closed']],
  ]
  for (const [spec, patch, by, events] of cases) {
    const result = await cell(spec, patch, by, true)
    assert.deepEqual(result.events, events, `${patch.action}: 拆等待必须显式记一条 unblocked（T-60 的写侧）`)
    assert.equal(result.task.waiting_on, null, `${patch.action}: 等待已结束`)
    // 落到 log 上：blocked → unblocked → <动作>，不是静默消失。
    const ws = await boardWith({ ...spec, log: [{ at: AT, by: 'dsh', event: 'created' }, { at: AT, by: 'dsh', event: 'blocked' }] })
    try {
      const live = await attempt(ws, 'T-1', patch, by)
      assert.ok(live.allowed, `${patch.action}: 重跑也应放行`)
      assert.deepEqual(tail(live.task, 3), ['blocked', 'unblocked', events[1]], `${patch.action}: log 里 blocked 与动作之间必须有 unblocked`)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }
})

await check('② `done` 没有自己的门 ⇒ 陌生人 done 一张等 agent 的卡**被拒**（T-61 的旁路关掉）', async () => {
  const result = await cell(
    { status: 'in_progress', created_by: 'dsh', assignee: 'cc', waiting_on: AGENT_WAIT },
    { action: 'done' }, 'claude', false,
  )
  assert.match(result.message, /waiting on agent \(kimi\)/, '文案要说清在等谁')
  assert.match(result.message, /only kimi \(the agent it waits on\)/, '文案要指名被等的人')
  assert.match(result.message, /or the human can end that wait/, '文案要给出还有谁')
})

await check('② 等 Agent 的卡 + submit：陌生人在**归属门**就被拒（先说你没资格，再说等待）', async () => {
  const result = await cell(
    { status: 'in_progress', created_by: 'dsh', assignee: 'cc', waiting_on: AGENT_WAIT },
    { action: 'submit' }, 'claude', false,
  )
  assert.match(result.message, /is not yours to submit/, '第一道门是 submit 归属')
})

await check('② 显式 unblock：事件序列不变（恰好一条 unblocked，不多不少）', async () => {
  const result = await cell(
    { status: 'in_progress', created_by: 'dsh', assignee: 'cc', waiting_on: AGENT_WAIT },
    { action: 'unblock' }, 'cc', true,
  )
  assert.deepEqual(result.events, ['unblocked'])
})

await check('② 没有等待时：**不产生**多余的 unblocked（事件与改前逐字一致）', async () => {
  const cases = [
    [{ status: 'in_progress', created_by: 'cc', assignee: 'cc' }, { action: 'submit' }, 'cc', ['submitted']],
    [{ status: 'in_progress', created_by: 'cc', assignee: 'cc' }, { action: 'done' }, 'cc', ['done']],
    [{ status: 'review', created_by: 'dsh', assignee: 'cc', reviewer: 'cc' }, { action: 'approve' }, 'cc', ['approved']],
    [{ status: 'done', created_by: 'cc', assignee: 'cc' }, { action: 'close' }, 'cc', ['closed']],
  ]
  for (const [spec, patch, by, events] of cases) {
    const result = await cell(spec, patch, by, true)
    assert.deepEqual(result.events, events, `${patch.action}（无等待）: 事件序列不得被改动`)
    assert.ok(!result.task.log.some((entry) => entry.event === 'unblocked'), `${patch.action}: 不该凭空写 unblocked`)
  }
})

// ═══════════════════════════════════════════════ ③ 修锁死（但不回退 T-61 §1）

await check('③ 等 Agent 的卡：**卡主 / 持卡人 / 裁决人始终能解**（T-13 那种锁死修掉）', async () => {
  const shapes = [
    ['卡主', { created_by: 'cc', assignee: 'nova', reviewer: 'nova' }, 'cc'],
    ['持卡人', { created_by: 'dsh', assignee: 'cc', reviewer: 'nova' }, 'cc'],
    ['裁决人', { created_by: 'dsh', assignee: 'nova', reviewer: 'cc' }, 'cc'],
    ['被等的人', { created_by: 'dsh', assignee: 'nova', reviewer: 'nova' }, 'kimi'],
    ['人类', { created_by: 'dsh', assignee: 'nova', reviewer: 'nova' }, 'human'],
  ]
  for (const [role, base, by] of shapes) {
    const result = await cell({ status: 'in_progress', ...base, waiting_on: AGENT_WAIT }, { action: 'unblock' }, by, true)
    assert.equal(result.task.waiting_on, null, `${role} ${by} 应能解开 wait:agent(kimi)`)
    // 同一个人也能通过别的路径结束等待（同一道门）
    await cell({ status: 'in_progress', ...base, waiting_on: AGENT_WAIT }, { action: 'done' }, by, true)
  }
  // 无关者仍然不行
  await cell({ status: 'in_progress', created_by: 'dsh', assignee: 'nova', reviewer: 'nova', waiting_on: AGENT_WAIT }, { action: 'unblock' }, 'claude', false)
})

await check('③ 等人类的卡：卡主 / 持卡人 / 裁决人**也解不开** —— 人类是排他的（T-61 §1 一步不让）', async () => {
  for (const by of ['cc', 'dsh', 'nova']) {
    await cell(
      { status: 'in_progress', created_by: 'cc', assignee: 'cc', reviewer: 'cc', waiting_on: HUMAN_WAIT },
      { action: 'unblock' }, by, false,
    )
  }
  await cell(
    { status: 'in_progress', created_by: 'cc', assignee: 'cc', reviewer: 'cc', waiting_on: HUMAN_WAIT },
    { action: 'unblock' }, 'human', true,
  )
})

await check('③ external / 未指名：照旧放宽为任何在场 agent（板外对方不会来敲板子）', async () => {
  for (const wait of [EXTERNAL_WAIT, UNNAMED_WAIT]) {
    for (const by of ['claude', 'nova']) {
      await cell({ status: 'in_progress', created_by: 'dsh', assignee: 'cc', waiting_on: wait }, { action: 'unblock' }, by, true)
    }
  }
})

await check('③ 别名等价：卡主 / 持卡人以别名出现时照样解得开', async () => {
  await cell({ status: 'in_progress', created_by: 'dsh-agent', assignee: 'nova', waiting_on: AGENT_WAIT }, { action: 'unblock' }, 'dsh', true)
  await cell({ status: 'in_progress', created_by: 'dsh', assignee: 'dsh-agent', waiting_on: AGENT_WAIT }, { action: 'unblock' }, 'dsh', true)
})

await check('③ 缺 created_by 的老卡：③ 只**追加**许可，不新增拒绝（与 T-61 口径逐字一致）', async () => {
  // 老卡（无 created_by）等一个具名 agent：被等的人/人类能解（T-61 口径），
  // 无关者仍被拒 —— ③ 没有把老卡放宽，也没有把它锁得更死。
  await cell({ status: 'in_progress', assignee: 'nova', omitCreatedBy: true, waiting_on: AGENT_WAIT }, { action: 'unblock' }, 'kimi', true)
  await cell({ status: 'in_progress', assignee: 'nova', omitCreatedBy: true, waiting_on: AGENT_WAIT }, { action: 'unblock' }, 'human', true)
  await cell({ status: 'in_progress', assignee: 'nova', omitCreatedBy: true, waiting_on: AGENT_WAIT }, { action: 'unblock' }, 'claude', false)
})

// ═══════════════════════════════════════════════ 真实板夹具 · 向后兼容

await check('向后兼容 · 真实板当夹具：陌生人一张也提交不了；抹掉 created_by 后回到改前', async () => {
  let source
  let origin
  if (existsSync(REAL_BOARD)) {
    source = JSON.parse(await readFile(REAL_BOARD, 'utf8'))
    origin = REAL_BOARD
  } else {
    origin = '(本机没有真实板，退回内置样本)'
    source = {
      version: 1,
      workspace: '',
      next_seq: 4,
      actors: {},
      tasks: {
        'T-1': makeTask('T-1', { status: 'in_progress', created_by: 'dsh', assignee: 'kimi' }),
        'T-2': makeTask('T-2', { status: 'open', created_by: 'kimi', assignee: null }),
        'T-3': makeTask('T-3', { status: 'done', created_by: 'claude', assignee: 'cc' }),
      },
    }
  }
  console.log(`      · 夹具来源：${origin}`)
  const cards = Object.values(source.tasks ?? {})
  assert.ok(cards.length > 0, '夹具里必须有卡')

  const importBoard = async (raw) => {
    const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-wait-real-'))
    await mkdir(join(ws, '.dsh'), { recursive: true })
    await writeFile(join(ws, '.dsh', 'taskboard.json'), JSON.stringify(raw, null, 2))
    return { ws, board: await loadBoard(ws) }
  }

  // ① 原样：对每一张卡敲 submit，陌生人**没有一次**得手
  {
    const { ws, board } = await importBoard(source)
    try {
      const all = Object.values(board.tasks)
      let refusedConflict = 0
      let refusedState = 0
      for (const task of all) {
        const result = await attempt(ws, task.id, { action: 'submit' }, 'zzz-stranger')
        assert.ok(!result.allowed, `${task.id}: 陌生人居然提交了（status=${task.status}）`)
        if (result.code === 'conflict') refusedConflict += 1
        else {
          assert.equal(result.code, 'invalid-transition', `${task.id}: 拒因应是 conflict 或 invalid-transition，实际 ${result.code}`)
          refusedState += 1
        }
      }
      assert.equal(refusedConflict + refusedState, all.length, `真实板 ${all.length} 张卡全部挡住了陌生人`)
      console.log(`      · 原样：${all.length}/${all.length} 张卡挡住了陌生人（conflict ${refusedConflict} · 状态机 ${refusedState}）`)
      assert.ok(refusedConflict > 0, '至少要有一张卡是被**归属门**（conflict）挡住的，而不只是状态机')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // ② 老卡形态：把真实板每张卡克隆成 in_progress 并保持 created_by/assignee，
  //    —— 有 created_by 时陌生人被拒（新机制），抹掉 created_by 后全部放行（改前行为）
  {
    const build = (strip) => {
      const clone = JSON.parse(JSON.stringify(source))
      const tasks = {}
      let seq = 1
      for (const task of Object.values(clone.tasks ?? {})) {
        const id = `T-${seq++}`
        const copy = { ...task, id, status: 'in_progress', waiting_on: null, reviewer: null, log: [{ at: AT, by: task.created_by ?? 'dsh', event: 'created' }] }
        if (strip) delete copy.created_by
        tasks[id] = copy
      }
      clone.tasks = tasks
      clone.next_seq = seq
      clone.actors = {}
      return clone
    }

    const guarded = await importBoard(build(false))
    try {
      const all = Object.values(guarded.board.tasks)
      const held = all.filter((task) => task.assignee)
      assert.ok(held.length > 0, '真实板里必须有带持卡人的卡才谈得上"替别人交作业"')
      for (const task of all) {
        const result = await attempt(guarded.ws, task.id, { action: 'submit' }, 'zzz-stranger')
        if (task.assignee) {
          assert.ok(!result.allowed, `${task.id}: 有持卡人（${task.assignee}）的卡被陌生人提交了`)
          assert.equal(result.code, 'conflict', `${task.id}: 应为 conflict，实际 ${result.code}`)
        } else {
          assert.ok(result.allowed, `${task.id}: 没有持卡人的卡不该被锁死（${result.code} — ${result.message}）`)
        }
      }
      console.log(`      · 原样（克隆成 in_progress）：${held.length} 张有持卡人的卡全部拒绝陌生人，${all.length - held.length} 张无持卡人的卡照旧放行`)
    } finally {
      await rm(guarded.ws, { recursive: true, force: true })
    }

    const legacy = await importBoard(build(true))
    try {
      const all = Object.values(legacy.board.tasks)
      let allowed = 0
      for (const task of all) {
        const result = await attempt(legacy.ws, task.id, { action: 'submit' }, 'zzz-stranger')
        assert.ok(result.allowed, `${task.id}: 缺 created_by 的老卡被新门锁死了（${result.code} — ${result.message}）`)
        allowed += 1
      }
      console.log(`      · 抹掉 created_by：${allowed}/${all.length} 张卡对陌生人放行（= 改前行为）`)
    } finally {
      await rm(legacy.ws, { recursive: true, force: true })
    }
  }
})

// ═══════════════════════════════════════════════ CLI 面同一道闸门

await check('CLI · submit 别人的卡：退出码 3 + 可读拒信；持卡人照常成功', async () => {
  const ws = await boardWith({ status: 'in_progress', created_by: 'dsh', assignee: 'kimi' })
  try {
    const refused = await run('node', [bin, '--cwd', ws, '--by', 'claude', 'update', 'T-1', '--action', 'submit'])
      .then(() => null, (error) => error)
    assert.ok(refused, '无关者 submit 必须失败')
    assert.equal(refused.code, 3, 'conflict 的退出码是 3')
    assert.match(refused.stderr, /not yours to submit/)
    assert.match(refused.stderr, /its holder \(kimi\)/)

    const submitted = JSON.parse(
      await run('node', [bin, '--cwd', ws, '--by', 'kimi', 'update', 'T-1', '--action', 'submit', '--json'])
        .then(({ stdout }) => stdout.trim()),
    )
    assert.equal(submitted.status, 'review', '持卡人照样交得了作业')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall submit & wait-release authority checks passed')
}
