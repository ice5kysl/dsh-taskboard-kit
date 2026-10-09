/**
 * T-69 · 闸门上的**侧门**：`block` 能静默替换 `wait:human`。
 *
 * T-61/T-62 把「结束一段等待」变成机制（`assertCanUnblock` / `assertCanSettle` /
 * `assertCanSubmit` + 别名折叠），并宣称「**每条**会清掉等待的路径都过同一道门」
 * —— 但当时漏了 `block`：
 *
 *   `src/host/store.ts` 的 `block` 分支直接 `task.waiting_on = {...}`，
 *   既不问归属、也不记 `unblocked` ⇒ 任何 agent 都能把一张 `wait:human` 的卡
 *   改挂成 `wait:agent(自己)`：**人类的问题无声消失**，账目上还看不出发生过什么。
 *   2026-10-09 平台 PO 真的被口头指引走这条路（他还回头问了"合不合规矩"）——
 *   结论是"能走通，但那正是机制要防的"。
 *
 * 本文件的判定表：
 *   · `block` × {无等待 / wait:human / wait:agent(别人) / wait:agent(自己) /
 *     wait:agent(未指名) / wait:external} × {被等的人 / 卡主 / 持卡人 / 裁决人 /
 *     无关者 / 别名等价名 / 人类}
 *   · 回归本洞：agent 替换 `wait:human` ⇒ **必须 conflict**，拒信说清"只有人类
 *     能结束这个等待"（与 `unblock` 同口径）；
 *   · 静默覆盖变成**显式事件**：替换 ⇒ 先 `unblocked`（带 "wait replaced by X → …"
 *     的 note）再 `blocked`；被拒 ⇒ 原封不动、一条 log 都不多；
 *   · 向后兼容：**没有等待**的卡首次 `block` 行为不变（谁都能挂、事件恰好 `blocked`），
 *     拿真实板（69 张卡）当夹具；
 *   · 别名等价：`dsh ≡ dsh-agent` 仍要折叠（否则自己会被自己拒）。
 *
 * 一句话口径（同 T-61/T-62）：这是**防误操作与防越权**，不是安全边界 ——
 * `by` 仍是记录值、可被伪造。
 *
 * Run: node tests/authority-block.test.mjs   (after npm run build)
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
/** 本工作区的真实板（只读拿它当夹具；不存在时退回内置样本）。 */
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

console.log('dsh-taskboard-kit block-replacement authority test (T-69):')

const AT = '2026-10-07T00:00:00.000Z'

/**
 * 一张**每个角色都不同人**的卡，这样一格判定只能有一个解释：
 *   卡主 created_by = cc · 持卡人 assignee = nova · 裁决人 reviewer = kimi
 *   被等的人 = dsh（别名 dsh-agent）· 无关者 = claude · 人类 = human / iceskysl
 */
const BASE = { status: 'in_progress', created_by: 'cc', assignee: 'nova', reviewer: 'kimi' }
const HUMAN_WAIT = { kind: 'human', who: 'iceskysl', question: 'go/no-go?', since: AT }
const AGENT_WAIT = { kind: 'agent', who: 'dsh', question: 'T-3 审计结论能给我吗？', since: AT }
const UNNAMED_WAIT = { kind: 'agent', who: null, question: '谁拿着 T-3？', since: AT }
const EXTERNAL_WAIT = { kind: 'external', who: 'dsh@msg9.ice.msg9.io', question: '发布落了吗？', since: AT }
/** 矩阵里"这一格要挂到谁身上"——统一挂第三方，好让"替换"这件事真的发生了。 */
const NEW_WAIT = { wait_kind: 'agent', wait_who: 'claude', wait_question: '你那边做完了吗？' }

function makeTask(id, spec = {}) {
  const createdBy = spec.created_by ?? 'cc'
  // 一张"已经在等"的卡，log 里必然先有一条 `blocked` —— `blockerOf()` 就是靠它
  // 把"这张卡当初是谁挂起的"说清楚的，夹具缺了它，拒信文案就不完整。
  const log = [{ at: AT, by: createdBy, event: 'created' }]
  if (spec.waiting_on) log.push({ at: AT, by: spec.blocked_by ?? createdBy, event: 'blocked' })
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
    log,
    comments: [],
    ...spec,
  }
}

/** 一块干净棋盘（名册留空 —— 与 T-61/T-62 的 `authority.test.mjs` 同口径）。 */
async function boardWith(...specs) {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-block-'))
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

/** 跑一格判定，返回结果（**只断言在 `expected` 明确给出时**）。 */
async function probe(spec, patch, by, expected) {
  const ws = await boardWith(spec)
  try {
    const result = await attempt(ws, 'T-1', patch, by)
    const what = `${JSON.stringify(patch)} on waiting=${spec.waiting_on ? `${spec.waiting_on.kind}(${spec.waiting_on.who ?? '未指名'})` : 'null'} × "${by}"`
    if (expected === true) {
      assert.ok(result.allowed, `${what}: 本该允许，实际被拒 ${result.code} — ${result.message}`)
    } else if (expected === false) {
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

/** 矩阵的一行：`✓` / `✗`，逐格跑真板逻辑并顺带断言。 */
const matrixRows = []
async function matrixRow(label, waitingOn, actors) {
  const cells = []
  for (const [who, expected] of actors) {
    const result = await probe({ ...BASE, waiting_on: waitingOn }, { action: 'block', ...NEW_WAIT }, who, expected)
    cells.push(result.allowed ? '✓' : '✗')
  }
  matrixRows.push([label, cells])
}

/** 矩阵的列（每一行都用同一批 actor，判定结果逐格写死）。 */
const COLUMNS = ['被等的人 dsh', '别名 dsh-agent', '卡主 cc', '持卡人 nova', '裁决人 kimi', '无关者 claude', '人类 human', '人类 iceskysl']

// ═══════════════════════════════════════════════ ① 判定矩阵

await check('① 无等待（首次挂起）：**谁都能挂**，行为与改前逐字一致（事件恰好 blocked）', async () => {
  await matrixRow('无等待', null, [
    ['dsh', true], ['dsh-agent', true], ['cc', true], ['nova', true],
    ['kimi', true], ['claude', true], ['human', true], ['iceskysl', true],
  ])
  // 不是"能挂"就算：必须**没有**多出来的 unblocked（首次挂起不是"结束别人的等待"）。
  for (const by of ['claude', 'dsh', 'human']) {
    const result = await probe({ ...BASE, waiting_on: null }, { action: 'block', ...NEW_WAIT }, by, true)
    assert.deepEqual(result.events, ['blocked'], `${by}: 首次挂起只该有一条 blocked`)
    assert.deepEqual(tail(result.task, 1), ['blocked'])
    assert.ok(!result.task.log.some((entry) => entry.event === 'unblocked'), `${by}: 首次挂起不得凭空写 unblocked`)
    assert.equal(result.task.waiting_on.who, 'claude', `${by}: 新等待写对了`)
  }
})

await check('① wait:human ⇒ **只有人类**能替换；agent 一律 conflict（与 unblock 同口径）', async () => {
  await matrixRow('human(iceskysl)', HUMAN_WAIT, [
    ['dsh', false], ['dsh-agent', false], ['cc', false], ['nova', false],
    ['kimi', false], ['claude', false], ['human', true], ['iceskysl', true],
  ])
})

await check('① wait:agent(别人) ⇒ 被等的人 + **追加许可**（卡主/持卡人/裁决人）+ 人类', async () => {
  await matrixRow('agent(dsh)', AGENT_WAIT, [
    ['dsh', true], ['dsh-agent', true], ['cc', true], ['nova', true],
    ['kimi', true], ['claude', false], ['human', true], ['iceskysl', true],
  ])
})

await check('① wait:agent(自己) ⇒ 被等的人本人也能替换（"自己"不是例外，是同一格）', async () => {
  const self = { kind: 'agent', who: 'claude', question: '你那边做完了吗？', since: AT }
  await matrixRow('agent(claude=本人)', self, [
    ['dsh', false], ['dsh-agent', false], ['cc', true], ['nova', true],
    ['kimi', true], ['claude', true], ['human', true], ['iceskysl', true],
  ])
})

await check('① wait:agent(未指名) / wait:external ⇒ 照旧放宽为任何在场 agent（板外对方不会来敲板子）', async () => {
  for (const [label, wait] of [['agent(未指名)', UNNAMED_WAIT], ['external(地址)', EXTERNAL_WAIT]]) {
    await matrixRow(label, wait, [
      ['dsh', true], ['dsh-agent', true], ['cc', true], ['nova', true],
      ['kimi', true], ['claude', true], ['human', true], ['iceskysl', true],
    ])
  }
})

await check('① 别名等价 `dsh ≡ dsh-agent`：卡主/持卡人/被等的人以别名出现时照样放行（否则自己会被自己拒）', async () => {
  // 被等的人以别名写：dsh-agent 被等，dsh 来替换
  await probe({ ...BASE, waiting_on: { ...AGENT_WAIT, who: 'dsh-agent' } }, { action: 'block', ...NEW_WAIT }, 'dsh', true)
  // 卡主以别名写
  await probe({ ...BASE, created_by: 'dsh-agent', waiting_on: AGENT_WAIT }, { action: 'block', ...NEW_WAIT }, 'dsh', true)
  // 持卡人以别名写
  await probe({ ...BASE, assignee: 'dsh-agent', waiting_on: AGENT_WAIT }, { action: 'block', ...NEW_WAIT }, 'dsh', true)
  // 裁决人以别名写
  await probe({ ...BASE, reviewer: 'dsh-agent', waiting_on: AGENT_WAIT }, { action: 'block', ...NEW_WAIT }, 'dsh', true)
  // 等价的名字**不**等于人类：等人类的卡上，别名也解不开
  await probe({ ...BASE, waiting_on: HUMAN_WAIT }, { action: 'block', ...NEW_WAIT }, 'dsh-agent', false)
})

// ═══════════════════════════════════════════════ ② 回归本洞（T-69 的正题）

await check('② 回归：agent 把 wait:human 改挂 ⇒ conflict + 拒信说清"只有人类能结束这个等待"', async () => {
  for (const by of ['cc', 'nova', 'kimi', 'claude', 'dsh']) {
    const result = await probe({ ...BASE, waiting_on: HUMAN_WAIT }, { action: 'block', ...NEW_WAIT }, by, false)
    assert.match(result.message, /is waiting on human \(iceskysl\)/, `${by}: 文案要说清卡在等人类`)
    assert.match(result.message, /only the human can end that wait/, `${by}: 文案要说"只有人类能结束这个等待"（与 unblock 同口径）`)
    assert.match(result.message, /block would replace that wait/, `${by}: 文案要说清 block 是**替换**、不是"再挂一次"`)
    assert.match(result.message, /drop the human's question without an answer/, `${by}: 文案要说清人类的问题会掉地（那条路径会丢掉答案）`)
    assert.match(result.message, /blocked by cc/, `${by}: 文案要指出这张卡是谁挂起的`)
    assert.match(result.message, new RegExp(`"${by}" is an agent`), `${by}: 文案要点名谁被拒`)
    assert.match(result.message, /do not unblock, replace or settle it yourself/, `${by}: 文案要给出正确做法`)
  }
})

await check('② 被拒时卡**原封不动**：waiting_on 不变、log 一条都不多、名册不被写脏（原子性）', async () => {
  const spec = { ...BASE, waiting_on: HUMAN_WAIT }
  const ws = await boardWith(spec)
  try {
    const before = await loadBoard(ws)
    const logBefore = before.tasks['T-1'].log.length
    const result = await attempt(ws, 'T-1', { action: 'block', ...NEW_WAIT }, 'claude')
    assert.ok(!result.allowed, 'agent 替换 wait:human 必须被拒')
    const after = await loadBoard(ws)
    assert.deepEqual(after.tasks['T-1'].waiting_on, HUMAN_WAIT, '被拒后旧等待必须原封不动（人没被换掉）')
    assert.equal(after.tasks['T-1'].log.length, logBefore, '被拒后不得写任何 log（尤其不得写 unblocked）')
    assert.ok(!Object.keys(after.actors).includes('claude'), '被拒的 actor 不该被写进名册')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

await check('② 静默覆盖变成**显式事件**：替换 ⇒ 先 unblocked（带 note）再 blocked', async () => {
  const result = await probe({ ...BASE, waiting_on: AGENT_WAIT }, { action: 'block', ...NEW_WAIT }, 'dsh', true)
  assert.deepEqual(result.events, ['unblocked', 'blocked'], '替换必须显式记 unblocked，再记 blocked')
  const [ended, started] = result.task.log.slice(-2)
  assert.equal(ended.event, 'unblocked', '前一条是结束旧等待')
  assert.match(ended.note ?? '', /wait replaced by dsh → agent\(claude\)/, 'unblocked 的 note 要写清"由谁替换成了什么"')
  assert.equal(started.event, 'blocked', '后一条是新的挂起')
  assert.deepEqual(result.task.waiting_on, { kind: 'agent', who: 'claude', question: '你那边做完了吗？', since: result.task.waiting_on.since })
  assert.notEqual(result.task.waiting_on.since, AT, '新等待的 since 要刷新（等待区间从这一刻起）')
  // 替换成新的人类等待也要记全
  const toHuman = await probe({ ...BASE, waiting_on: AGENT_WAIT }, { action: 'block', wait_kind: 'human', wait_who: 'iceskysl', wait_question: '要发吗？' }, 'dsh', true)
  assert.deepEqual(toHuman.events, ['unblocked', 'blocked'])
  assert.match(toHuman.task.log.slice(-2)[0].note ?? '', /wait replaced by dsh → human\(iceskysl\)/)
})

await check('② 补丁自己的 `note` 仍然贴在**最后**一条上（旧行为不受事件自带的 note 影响）', async () => {
  const result = await probe({ ...BASE, waiting_on: AGENT_WAIT }, { action: 'block', ...NEW_WAIT, note: '改挂给 claude' }, 'dsh', true)
  const [ended, started] = result.task.log.slice(-2)
  assert.match(ended.note ?? '', /wait replaced by dsh/, 'unblocked 带自己的替换说明')
  assert.equal(started.note, '改挂给 claude', '调用方的 note 仍贴在最后一条（blocked）上')
})

await check('② 首次挂起与显式 unblock 的事件序列**不因这次改动而变**', async () => {
  const first = await probe({ ...BASE, waiting_on: null }, { action: 'block', ...NEW_WAIT }, 'claude', true)
  assert.deepEqual(first.events, ['blocked'], '首次挂起：恰好 blocked')
  const released = await probe({ ...BASE, waiting_on: AGENT_WAIT }, { action: 'unblock' }, 'dsh', true)
  assert.deepEqual(released.events, ['unblocked'], 'unblock：恰好 unblocked（没有多出 blocked/updated）')
  assert.equal(released.task.log.at(-1).note, undefined, 'unblock 不该被塞进替换说明')
})

// ═══════════════════════════════════════════════ ③ 真实板夹具 · 向后兼容

await check('③ 向后兼容 · 真实板（69 张卡）当夹具：首次 block 一如既往，谁都能挂', async () => {
  let source
  let origin
  if (existsSync(REAL_BOARD)) {
    source = JSON.parse(await readFile(REAL_BOARD, 'utf8'))
    origin = REAL_BOARD
  } else {
    origin = '(本机没有真实板，退回内置样本)'
    source = {
      version: 1, workspace: '', next_seq: 4, actors: {},
      tasks: {
        'T-1': makeTask('T-1', { status: 'in_progress', created_by: 'cc', assignee: 'nova' }),
        'T-2': makeTask('T-2', { status: 'open', created_by: 'dsh', assignee: null }),
        'T-3': makeTask('T-3', { status: 'done', created_by: 'kimi', assignee: 'cc' }),
      },
    }
  }
  console.log(`      · 夹具来源：${origin}`)
  const raw = Object.values(source.tasks ?? {})
  assert.ok(raw.length > 0, '夹具里必须有卡')

  /** 把真实板克隆成"在推进中、且**没有等待**"的卡（首次 block 的合法场景）。 */
  const clone = (mutate) => {
    const copy = JSON.parse(JSON.stringify(source))
    const tasks = {}
    let seq = 1
    for (const task of Object.values(copy.tasks ?? {})) {
      const id = `T-${seq++}`
      const one = {
        ...task, id, status: 'in_progress', assignee: null, reviewer: null, waiting_on: null,
        log: [{ at: AT, by: task.created_by ?? 'dsh', event: 'created' }],
      }
      tasks[id] = mutate ? mutate(one, task) : one
    }
    copy.tasks = tasks
    copy.next_seq = seq
    copy.actors = {}
    return copy
  }

  const importBoard = async (board) => {
    const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-block-real-'))
    await mkdir(join(ws, '.dsh'), { recursive: true })
    await writeFile(join(ws, '.dsh', 'taskboard.json'), JSON.stringify(board, null, 2))
    return { ws, board: await loadBoard(ws) }
  }

  // ① 首挂：真实板 69 张卡，随便谁来挂都成功，且事件恰好 ['blocked']（= 改前行为）
  //    —— 每个 actor 用一块**新导入**的板：一张卡挂过一次就有等待了，再挂就是
  //       "替换"，混在一起会让这条向后兼容断言失真。
  {
    const all = Object.values((await importBoard(clone(null))).board.tasks)
    for (const by of ['claude', 'zzz-stranger', 'dsh']) {
      const { ws, board } = await importBoard(clone(null))
      try {
        let allowed = 0
        for (const task of Object.values(board.tasks)) {
          const result = await attempt(ws, task.id, { action: 'block', ...NEW_WAIT }, by)
          assert.ok(result.allowed, `${task.id} × ${by}: 首次 block 本该放行（${result.code} — ${result.message}）`)
          assert.deepEqual(result.events, ['blocked'], `${task.id} × ${by}: 首次挂起事件序列必须是 ['blocked']`)
          assert.equal(result.task.waiting_on.who, 'claude', `${task.id}: 等待写对了`)
          allowed += 1
        }
        assert.equal(allowed, all.length, `${by}: ${all.length} 张卡全部可首挂`)
      } finally {
        await rm(ws, { recursive: true, force: true })
      }
    }
    console.log(`      · 首挂（waiting_on=null）：${all.length} 张真实卡 × 3 个 actor 全部放行，事件恒为 ['blocked']`)
  }

  // ② 侧门：把真实板每张卡克隆成 `wait:human` ⇒ 再没人能替人类改挂；人类本人可以
  {
    const armed = clone((one, task) => ({
      ...one,
      waiting_on: { kind: 'human', who: 'iceskysl', question: `${task.id} 要不要继续？`, since: AT },
    }))
    const { ws, board } = await importBoard(armed)
    try {
      const all = Object.values(board.tasks)
      for (const by of ['claude', 'zzz-stranger']) {
        for (const task of all) {
          const result = await attempt(ws, task.id, { action: 'block', ...NEW_WAIT }, by)
          assert.ok(!result.allowed, `${task.id} × ${by}: agent 竟然把 wait:human 改挂了（侧门又开了）`)
          assert.equal(result.code, 'conflict', `${task.id}: 应为 conflict，实际 ${result.code}`)
        }
      }
      const human = await attempt(ws, all[0].id, { action: 'block', ...NEW_WAIT }, 'iceskysl')
      assert.ok(human.allowed, `人类本人替换 wait:human 必须放行（${human.code} — ${human.message}）`)
      assert.deepEqual(human.events, ['unblocked', 'blocked'], '人类的替换同样要记 unblocked + blocked')
      console.log(`      · 侧门（waiting_on=human）：${all.length} 张真实卡全部挡住 agent 的替换；人类本人放行`)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // ③ 老卡形态（缺 created_by / reviewer）：等具名 agent 时，无关者仍被拒、被等的人仍能换
  {
    const armed = clone((one) => {
      delete one.created_by
      one.waiting_on = { kind: 'agent', who: 'dsh', question: '还在吗？', since: AT }
      return one
    })
    const { ws, board } = await importBoard(armed)
    try {
      const all = Object.values(board.tasks)
      const first = all[0]
      const waited = await attempt(ws, first.id, { action: 'block', ...NEW_WAIT }, 'dsh')
      assert.ok(waited.allowed, `缺 created_by 的老卡：被等的人仍能替换（${waited.code} — ${waited.message}）`)
      // 换一张**还没被动过**的卡：上面那次成功之后 first 已经在等 claude 了，
      // 无关者的那格必须是"等 dsh"的形状，否则测的就不是同一件事。
      const stranger = await attempt(ws, all[1].id, { action: 'block', ...NEW_WAIT }, 'claude')
      assert.ok(!stranger.allowed, '缺 created_by 的老卡：无关者替换 wait:agent 仍应被拒')
      assert.equal(stranger.code, 'conflict')
      console.log(`      · 老卡（缺 created_by）：被等的人可换、无关者仍被拒（T-62 ③ 的"追加许可"口径不变）`)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }
})

// ═══════════════════════════════════════════════ ④ CLI 面同一道闸门

await check('④ CLI · 把 wait:human 的卡改挂：agent 退出码 3 + 可读拒信；人类本人成功', async () => {
  const ws = await boardWith({ ...BASE, waiting_on: HUMAN_WAIT })
  try {
    const refused = await run('node', [
      bin, '--cwd', ws, '--by', 'claude',
      'update', 'T-1', '--action', 'block', '--on', 'agent', '--who', 'claude', '--question', '你那边做完了吗？',
    ]).then(() => null, (error) => error)
    assert.ok(refused, 'agent 改挂 wait:human 必须失败')
    assert.equal(refused.code, 3, 'conflict 的退出码是 3')
    assert.match(refused.stderr, /only the human can end that wait/)
    assert.match(refused.stderr, /block would replace that wait/)

    const swapped = JSON.parse(await run('node', [
      bin, '--cwd', ws, '--by', 'iceskysl', '--json',
      'update', 'T-1', '--action', 'block', '--on', 'agent', '--who', 'claude', '--question', '你那边做完了吗？',
    ]).then(({ stdout }) => stdout.trim()))
    assert.equal(swapped.waiting_on.who, 'claude', '人类本人换得动')
    assert.deepEqual(tail(swapped, 2), ['unblocked', 'blocked'], 'CLI 面上替换同样记 unblocked + blocked')
    assert.match(swapped.log.at(-2).note ?? '', /wait replaced by iceskysl → agent\(claude\)/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════ 矩阵打印（交付证据）

if (matrixRows.length > 0) {
  console.log('\n  判定矩阵（`block` 替换一张**已经在等**的卡 · ✓ 放行 / ✗ conflict）：')
  console.log(`  | ${'现状等待'.padEnd(20)} | ${COLUMNS.map((c) => c.padEnd(15)).join(' | ')} |`)
  console.log(`  |${'-'.repeat(22)}|${COLUMNS.map(() => '-'.repeat(17)).join('|')}|`)
  for (const [label, cells] of matrixRows) {
    console.log(`  | ${label.padEnd(20)} | ${cells.map((c) => c.padEnd(15)).join(' | ')} |`)
  }
  console.log('  （每一格都断言了"该放行的真放行、该拒的真是 conflict"，不是只打印）\n')
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('all block-replacement authority checks passed')
}
