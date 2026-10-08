/**
 * 客户端动作表 ↔ host 状态机：逐动作对照测试（T-42 第 1 条，源头是 T-29 ①）。
 *
 * 为什么需要这个文件：`BoardPanel.tsx` 的 `ACTION_FROM` 是 host `TRANSITIONS`
 * 在浏览器侧的**重述**（bundle 不能 import host 模块），注释里白纸黑字写着
 * 「a test pins this table against the host's, action by action」—— 而那个测试
 * **根本不存在**（`grep TRANSITIONS tests/*.mjs` 0 命中）。一条"注释承诺了不存在的
 * 护栏"比没有护栏更坏：下一个人会以为它有人看着（与 T-40 同族）。
 *
 * 这个测试不去比两张**表**的字面量，而是比两侧的**行为**：
 *   · host 侧：把一张卡放进每个状态，真的敲一次 `updateTask({ action })` ——
 *     成功 = 这个动作在这个状态可用；`invalid-transition` = 不可用；
 *   · 客户端侧：抽屉真正渲染时用的 `drawerActions()` 给出的 `disabledReason`
 *     （null = 可用）。
 * 两侧在 (7 个状态动作 × 5 个状态) 的每一格都必须一致。任何一侧的动作集合被改坏
 * （多一个 / 少一个 / 改了 from 集合）都会红 —— 变异证据见 T-42 卡。
 *
 * 范围说明：只对照两侧共同认的 **7 个状态动作**。`claim` / `unblock` 与状态正交
 * （`claim` 走 host 的 `claimTask()`，`unblock` 只动 `waiting_on`），所以它们进
 * `ACTION_FROM` 之外的两格，注释与代码都写明；本文件另外把这两件事各自钉住。
 *
 * Run: node tests/action-parity.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'

// ---- 浏览器面：和 shell 一样走 __ModuleLoader__ 信封（客户端动作表在 bundle 里）
let envelope
globalThis.window = { __ModuleLoader__: { load: (captured) => { envelope = captured } } }
await import('../lib/client.js')
assert.ok(envelope, 'client bundle must register itself with the module loader')
const client = envelope.factory((specifier) => createRequire(import.meta.url)(specifier))

// ---- host 面：同一份 domain 操作，测试直接对 lib/index.js 说话
const { StoreError, loadBoard, saveBoard, updateTask } = await import('../lib/index.js')

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

/** 客户端重述的那 7 个状态动作（顺序 = 抽屉里的顺序）。 */
const MACHINE_ACTIONS = ['start', 'submit', 'approve', 'reject', 'done', 'close', 'reopen']
const STATUSES = ['open', 'in_progress', 'review', 'done', 'closed']

/**
 * 每个动作由谁敲：approve / reject 只有**裁决人本人**（这里是 fixture 里的
 * `reviewer: 'kimi'`）能敲 —— 那是权限（`conflict`），不是状态机。把 by 选对，
 * 才能把"状态机说了不"（`invalid-transition`）从其它拒绝里隔离出来。
 */
const byFor = (action) => (action === 'approve' || action === 'reject' ? 'kimi' : 'dsh')

/** 一张字段齐全的卡：负责人 + 裁决人都在，唯一的自变量是 `status`。 */
function fixture(status, over = {}) {
  const at = '2026-10-07T00:00:00.000Z'
  return {
    id: 'T-1', title: 'parity', detail: '', status,
    assignee: 'dsh', reviewer: 'kimi', waiting_on: null,
    priority: 'medium', value: null, tags: [],
    created_by: 'dsh', created_at: at, updated_at: at,
    log: [], comments: [],
    ...over,
  }
}

/** 把这张卡原样种进一个干净的板（每个格子一格新棋盘，互不污染）。 */
async function plant(cwd, task) {
  const board = await loadBoard(cwd)
  board.tasks = { [task.id]: task }
  board.next_seq = 2
  await saveBoard(cwd, board)
}

const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-parity-'))

console.log('dsh-taskboard-kit action parity test (client drawer ↔ host state machine):')

await check('T-42 · 逐动作对照：host 状态机接受的动作，正是抽屉不禁用的动作（7 × 5 全格）', async () => {
  let cases = 0
  for (const status of STATUSES) {
    for (const action of MACHINE_ACTIONS) {
      const task = fixture(status)
      await plant(ws, task)

      // 客户端：面板真正渲染抽屉用的那一条路径（不是另抄一份表）。
      const row = client.drawerActions(task, null).find((candidate) => candidate.action === action)
      assert.ok(row, `抽屉里必须有 ${action} 这一行`)
      const clientAllows = row.disabledReason === null

      // host：真的敲一次。除了 invalid-transition，别的拒绝码都意味着这个 fixture
      // 没能把"非状态机条件"隔离掉 —— 那本身就是需要人看一眼的信号，直接失败。
      const hostAllows = await updateTask(ws, 'T-1', { action }, byFor(action)).then(
        () => true,
        (error) => {
          assert.ok(error instanceof StoreError, `${status} × ${action}: 期望 StoreError，实际 ${error}`)
          assert.equal(
            error.code, 'invalid-transition',
            `${status} × ${action}: 状态机只该用 invalid-transition 说"不"，实际 ${error.code} —— ${error.message}`,
          )
          return false
        },
      )

      assert.equal(
        hostAllows, clientAllows,
        `${status} × ${action}: host ${hostAllows ? '接受' : '拒绝'}，客户端却${clientAllows ? '可用' : '禁用'}了` +
        (clientAllows ? `（抽屉说可以，host 会拒）` : `（抽屉置灰，host 其实会接受）`),
      )
      cases += 1
    }
  }
  assert.equal(cases, MACHINE_ACTIONS.length * STATUSES.length, `覆盖 ${MACHINE_ACTIONS.length} × ${STATUSES.length} 格`)
})

await check('T-42 · 抽屉的动作集合 = 状态机 7 个 + 状态机之外的 claim / unblock', () => {
  const drawer = client.drawerActions(fixture('open'), null).map((row) => row.action)
  assert.deepEqual(
    drawer, ['claim', 'unblock', ...MACHINE_ACTIONS],
    '抽屉多一个或漏一个动作都必须在这里被点出来（顺序也钉住）',
  )
})

await check('T-42 · claim 不走状态机（host 的 updateTask 根本不认它），unblock 只动 waiting_on', async () => {
  // ① claim：认领是 host 的另一条路（claimTask），updateTask 的 ACTIONS 里没有它 ——
  //    这正是 ACTION_FROM 的类型要把 claim / unblock 排除掉的原因。
  await plant(ws, fixture('open'))
  const claimError = await updateTask(ws, 'T-1', { action: 'claim' }, 'dsh').then(() => null, (error) => error)
  assert.ok(claimError, 'claim 不是 updateTask 的动作')
  assert.equal(claimError.code, 'invalid-input')
  assert.match(claimError.message, /action must be one of/, 'claim 被当成未知动作拒绝')

  // ② unblock 与状态**正交**：没有等待时状态机拒绝，有等待时它成功且状态不变。
  await plant(ws, fixture('in_progress'))
  const notWaiting = await updateTask(ws, 'T-1', { action: 'unblock' }, 'dsh').then(() => null, (error) => error)
  assert.ok(notWaiting, '没在等谁 ⇒ unblock 被拒')
  assert.equal(notWaiting.code, 'invalid-transition')

  const waiting = fixture('in_progress', { waiting_on: { kind: 'human', who: 'iceskysl', question: 'q', since: '2026-10-01T00:00:00.000Z' } })
  await plant(ws, waiting)
  // T-61：挂人类的卡**只有人类能解**（agent 会被 conflict 拒）。这里由 `human`
  // 来敲 —— 也正是浏览器面板的真实路径（bridge 的所有变更都盖 `human`）。
  const released = await updateTask(ws, 'T-1', { action: 'unblock' }, 'human')
  assert.equal(released.task.status, 'in_progress', 'unblock 不改状态（它只解除等待）')
  assert.equal(released.task.waiting_on, null)
  // 客户端同口径：有等待才可用。
  assert.equal(client.drawerActions(waiting, null).find((row) => row.action === 'unblock').disabledReason, null)
  assert.notEqual(client.drawerActions(fixture('in_progress'), null).find((row) => row.action === 'unblock').disabledReason, null)
})

await rm(ws, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
