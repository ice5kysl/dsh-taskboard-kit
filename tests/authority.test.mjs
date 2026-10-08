/**
 * T-61 · actor 校验矩阵：`unblock` / `close` / `reopen` / `cancel` 到底谁能敲。
 *
 * 为什么有这个文件：一天内 4 次同类越界都用同一条缝 —— `unblock` / `close`
 * 过去**只有状态校验、没有归属校验**（④ 那次主人明说"还要等等"，卡还是被
 * publish 并关闭）。主人 2026-10-07 拍板：**从"约定"变成"机制"**。
 * 这个文件就是那道机制的判定表，逐格钉住：
 *
 *   · `unblock` × {本人 / 别人 / 人类 / 别名等价名} × {human | agent | external | 未指名}
 *   · `close` / `reopen` / `cancel` × {卡主 / 持卡人 / 裁决人 / 无关者 / 人类 / 别名}
 *   · 别名等价：`dsh ≡ dsh-agent`，以及 TASKBOARD_ACTOR_ALIASES / WATCH_NAMES /
 *     SIBLING_NAMES 声明的等价名（**没有这层 dsh 会拒绝自己** —— 见「自锁」那条）
 *   · 向后兼容：缺 `created_by` / `waiting_on` 的老卡行为与改前逐字一致（真实板当夹具）
 *   · 顺序：状态先于归属（"没人在等"比"不归你管"更具体，而且改前就是那个码）
 *
 * 一句话口径：这是**防误操作与防越权**，不是安全边界 —— `by` 仍是记录值、可被伪造。
 *
 * Run: node tests/authority.test.mjs   (after npm run build)
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
// 一个实名人类：`TASKBOARD_HUMANS` 里的名字与 `human` 同权（与 approve/reject 同口径）。
process.env.TASKBOARD_HUMANS = 'iceskysl'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const bin = join(repo, 'bin', 'taskboard.mjs')
/** 本工作区的真实板（拿它当夹具；不存在时退回内置样本）。 */
const REAL_BOARD = join(repo, '..', '.dsh', 'taskboard.json')

const lib = await import('../lib/index.js')
const {
  HUMAN_ACTOR,
  StoreError,
  loadBoard,
  principalKey,
  sameActor,
  samePrincipal,
  saveBoard,
  updateTask,
} = lib

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

console.log('dsh-taskboard-kit actor authority test (T-61):')

const AT = '2026-10-07T00:00:00.000Z'

/** 四种等待形态（+ 指名/未指名两种写法）。 */
const WAIT = {
  human: { kind: 'human', who: null, question: 'ship it now?', since: AT },
  humanNamed: { kind: 'human', who: 'iceskysl', question: 'ship it now?', since: AT },
  agentNamed: { kind: 'agent', who: 'kimi', question: 'are you done with T-3?', since: AT },
  agentUnnamed: { kind: 'agent', who: null, question: 'whoever owns T-3: done?', since: AT },
  external: { kind: 'external', who: 'dsh@msg9.ice.msg9.io', question: 'did the publish land?', since: AT },
}

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

/**
 * 一块干净棋盘。名册**故意留空**：旧条目由 loadBoard 从 log 回填（`aliases: []`），
 * 正是"老卡的名册里没有别名信息"的真实形态 —— 别名折叠必须靠配置层兜住。
 */
async function boardWith(...specs) {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-authority-'))
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

/** 敲一次动作：只回答"能不能"，拒绝必须是 StoreError（带 code + 文案）。 */
async function attempt(ws, id, patch, by) {
  try {
    const { task } = await updateTask(ws, id, patch, by)
    return { allowed: true, task }
  } catch (error) {
    assert.ok(error instanceof StoreError, `expected StoreError, got ${error}`)
    return { allowed: false, code: error.code, message: error.message }
  }
}

const label = (wait) => `${wait.kind}${wait.who ? `(${wait.who})` : '(未指名)'}`

/** 一格 unblock 判定：`blockedBy` 只影响文案里的"由谁挂起"。 */
async function unblockCell(wait, blockedBy, by, expected) {
  const ws = await boardWith({
    status: 'in_progress',
    waiting_on: wait,
    log: [
      { at: AT, by: blockedBy, event: 'created' },
      { at: AT, by: blockedBy, event: 'blocked' },
    ],
  })
  try {
    const result = await attempt(ws, 'T-1', { action: 'unblock' }, by)
    const what = `unblock ${label(wait)}（由 ${blockedBy} 挂起）× "${by}"`
    if (expected) {
      assert.ok(result.allowed, `${what}: 本该允许，实际被拒 ${result.code} — ${result.message}`)
      assert.equal(result.task.waiting_on, null, `${what}: 解挂后 waiting_on 应为 null`)
    } else {
      assert.ok(!result.allowed, `${what}: 本该被拒，实际放行了`)
      assert.equal(result.code, 'conflict', `${what}: 归属拒绝应是 conflict，实际 ${result.code}`)
      assert.ok(/T-1 is waiting on/.test(result.message) && /"/.test(result.message), `${what}: 文案要说清谁被拒/在等谁 — ${result.message}`)
    }
    return result
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

/** 一格 close/reopen 判定。 */
async function settleCell(spec, action, by, expected) {
  const ws = await boardWith(spec)
  try {
    const result = await attempt(ws, 'T-1', { action }, by)
    const what = `${action} ${JSON.stringify({
      created_by: spec.created_by ?? '(缺)',
      assignee: spec.assignee ?? null,
      reviewer: spec.reviewer ?? null,
    })} × "${by}"`
    if (expected) {
      assert.ok(result.allowed, `${what}: 本该允许，实际被拒 ${result.code} — ${result.message}`)
      assert.equal(result.task.status, action === 'reopen' ? 'open' : 'closed', `${what}: 状态应落地`)
    } else {
      assert.ok(!result.allowed, `${what}: 本该被拒，实际放行了`)
      assert.equal(result.code, 'conflict', `${what}: 归属拒绝应是 conflict，实际 ${result.code}`)
    }
    return result
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- unblock 矩阵

await check('unblock × 等人类：**只有人类**（human / TASKBOARD_HUMANS 实名），agent 一律被拒', async () => {
  for (const [key, wait] of [['未指名', WAIT.human], ['指名 iceskysl', WAIT.humanNamed]]) {
    for (const by of ['human', 'iceskysl']) {
      await unblockCell(wait, 'dsh', by, true)
    }
    for (const by of ['kimi', 'dsh', 'dsh-agent', 'claude', 'cc']) {
      const result = await unblockCell(wait, 'dsh', by, false)
      assert.match(result.message, /only the human can unblock it/, `等人类（${key}）× ${by}: 文案要说明"只有人类能解"`)
      assert.match(result.message, /blocked by dsh/, `等人类（${key}）× ${by}: 文案要点出当初是谁挂起的`)
    }
  }
})

await check('unblock × 等具名 Agent：只有那个 Agent（或其别名等价名）或人类', async () => {
  for (const by of ['human', 'iceskysl', 'kimi']) {
    await unblockCell(WAIT.agentNamed, 'dsh', by, true)
  }
  for (const by of ['dsh', 'dsh-agent', 'claude']) {
    const result = await unblockCell(WAIT.agentNamed, 'dsh', by, false)
    assert.match(result.message, /only kimi \(or the human\) can unblock it/, `等 kimi × ${by}: 文案要指名该找谁`)
  }
})

await check('unblock × who 为空（未指名）：放宽为任何在场 agent 或人类 —— 不把卡锁死', async () => {
  for (const by of ['human', 'iceskysl', 'dsh-agent', 'dsh', 'kimi', 'claude']) {
    await unblockCell(WAIT.agentUnnamed, 'dsh', by, true)
  }
})

await check('unblock × external：挂的是板外对方（它永远不会来敲板子）⇒ 放宽，同上口径', async () => {
  for (const by of ['human', 'iceskysl', 'dsh', 'dsh-agent', 'kimi', 'claude']) {
    await unblockCell(WAIT.external, 'dsh', by, true)
  }
})

await check('unblock × 别名等价：等 dsh 的卡，dsh-agent 解得开；当初挂起的人（kimi）反而解不开', async () => {
  const wait = { ...WAIT.agentNamed, who: 'dsh' }
  for (const by of ['human', 'dsh', 'dsh-agent']) {
    await unblockCell(wait, 'kimi', by, true)
  }
  for (const by of ['kimi', 'claude']) {
    await unblockCell(wait, 'kimi', by, false)
  }
})

await check('unblock × 拒绝的文案：谁被拒 / 在等谁 / 由谁挂起 / 该找谁，一个都不能少', async () => {
  const ws = await boardWith({
    status: 'in_progress',
    waiting_on: WAIT.humanNamed,
    log: [
      { at: AT, by: 'dsh', event: 'created' },
      { at: AT, by: 'dsh', event: 'blocked' },
    ],
  })
  try {
    const result = await attempt(ws, 'T-1', { action: 'unblock' }, 'cc')
    assert.equal(result.code, 'conflict')
    assert.match(result.message, /T-1 is waiting on human \(iceskysl\)/, '在等谁')
    assert.match(result.message, /blocked by dsh/, '由谁挂起')
    assert.match(result.message, /only the human can unblock it/, '为什么被拒')
    assert.match(result.message, /"cc" is an agent/, '谁被拒')
    assert.match(result.message, /Ask the human/, '该找谁')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ close / reopen 矩阵

await check('close × 卡主 / 持卡人 / 裁决人 / 人类 / 别名可以，无关者被拒', async () => {
  const spec = { status: 'done', created_by: 'dsh', assignee: 'kimi', reviewer: 'claude' }
  for (const by of ['dsh', 'kimi', 'claude', 'human', 'iceskysl', 'dsh-agent']) {
    await settleCell(spec, 'close', by, true)
  }
  for (const by of ['nova', 'cc']) {
    const result = await settleCell(spec, 'close', by, false)
    assert.match(result.message, /T-1 is not yours to close/, `close × ${by}: 文案要说清"不归你收口"`)
    assert.match(result.message, /creator dsh/, '文案要列出有权的人：卡主')
    assert.match(result.message, /owner kimi/, '文案要列出有权的人：持卡人')
    assert.match(result.message, /reviewer claude/, '文案要列出有权的人：裁决人')
    assert.match(result.message, /or the human can/, '文案要给出该找谁')
  }
})

await check('close × 只有卡主的卡：持卡人/裁决人都没有时，别人收不了口', async () => {
  const spec = { status: 'open', created_by: 'dsh' }
  for (const by of ['dsh', 'human', 'dsh-agent']) await settleCell(spec, 'close', by, true)
  for (const by of ['kimi', 'claude', 'nova']) await settleCell(spec, 'close', by, false)
})

await check('reopen × 与 close 同一批人（结清错了必须退得回来）', async () => {
  const spec = { status: 'closed', created_by: 'dsh', assignee: 'kimi' }
  for (const by of ['dsh', 'kimi', 'human', 'dsh-agent']) await settleCell(spec, 'reopen', by, true)
  for (const by of ['claude', 'nova']) {
    const result = await settleCell(spec, 'reopen', by, false)
    assert.match(result.message, /T-1 is not yours to reopen/, 'reopen 的文案说的是 reopen')
  }
})

await check('cancel（close 的旧别名）走同一道闸门', async () => {
  const spec = { status: 'open', created_by: 'dsh' }
  for (const by of ['dsh', 'human']) await settleCell(spec, 'cancel', by, true)
  for (const by of ['nova']) {
    const result = await settleCell(spec, 'cancel', by, false)
    assert.match(result.message, /is not yours to close/, 'cancel 的文案仍说 close（那是它的本名）')
  }
})

await check('close × 浏览器面板那条路（bridge 把每个变更都盖成 human）照样能收口', async () => {
  await settleCell({ status: 'done', created_by: 'dsh', assignee: 'kimi' }, 'close', HUMAN_ACTOR, true)
})

// -------------------------------------------------------------------- 别名等价

await check('别名等价 · 自锁：名册没有别名信息时，dsh-agent 仍必须能收 dsh 的卡', async () => {
  const ws = await boardWith({ status: 'open', created_by: 'dsh' })
  try {
    const board = await loadBoard(ws)
    assert.deepEqual(board.actors['dsh']?.aliases ?? [], [], '这块板的名册里确实没有任何别名信息（老卡形态）')
    assert.equal(sameActor(board, 'dsh', 'dsh-agent'), false, '**光靠名册 fold 不了** —— 这正是必须有配置层兜底的原因')
    assert.equal(samePrincipal(board, 'dsh', 'dsh-agent'), true, '两个方向都要折叠')
    assert.equal(samePrincipal(board, 'dsh-agent', 'dsh'), true)
    assert.equal(principalKey('DSH-Agent'), 'dsh', '大小写与空白也要规范化')
    const result = await attempt(ws, 'T-1', { action: 'close' }, 'dsh-agent')
    assert.ok(result.allowed, 'dsh 自己的会话必须能收口 dsh 开的卡（否则 dsh 会拒绝自己）')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

await check('别名等价 · TASKBOARD_ACTOR_ALIASES / WATCH_NAMES / SIBLING_NAMES 声明的名字都折叠（可传递）', async () => {
  const saved = {
    aliases: process.env.TASKBOARD_ACTOR_ALIASES,
    watch: process.env.TASKBOARD_WATCH_NAMES,
    siblings: process.env.TASKBOARD_SIBLING_NAMES,
  }
  try {
    // ① ACTOR_ALIASES：kimi ≡ kimi-code ≡ kimi-cli
    process.env.TASKBOARD_ACTOR_ALIASES = 'kimi:kimi-code|kimi-cli'
    await settleCell({ status: 'open', created_by: 'kimi' }, 'close', 'kimi-code', true)
    await settleCell({ status: 'open', created_by: 'kimi-cli' }, 'close', 'kimi', true)
    await settleCell({ status: 'open', created_by: 'kimi' }, 'close', 'kimi-code', true)

    // ② WATCH_NAMES：第一位是规范名，其余是别名（cc ≡ claude-code）
    delete process.env.TASKBOARD_ACTOR_ALIASES
    process.env.TASKBOARD_WATCH_NAMES = 'cc,claude-code'
    await settleCell({ status: 'open', created_by: 'cc' }, 'close', 'claude-code', true)
    await settleCell({ status: 'open', created_by: 'claude-code' }, 'close', 'cc', true)
    delete process.env.TASKBOARD_WATCH_NAMES

    // ③ SIBLING_NAMES：同实例的其他会话算"我"（双向）
    process.env.TASKBOARD_SIBLING_NAMES = 'dsh-audit'
    await settleCell({ status: 'open', created_by: 'dsh' }, 'close', 'dsh-audit', true)
    await settleCell({ status: 'open', created_by: 'dsh-audit' }, 'close', 'dsh', true)
    assert.equal(principalKey('dsh-audit'), 'dsh', 'sibling 折叠到规范名')

    // ④ 传递：别名组与 siblings 分两处声明也要合并成同一主体
    process.env.TASKBOARD_ACTOR_ALIASES = 'dsh:dsh-web'
    process.env.TASKBOARD_SIBLING_NAMES = 'dsh-web,dsh-audit'
    assert.equal(principalKey('dsh-audit'), 'dsh', 'dsh ≡ dsh-web ≡ dsh-audit（组必须传递合并）')
    await settleCell({ status: 'open', created_by: 'dsh-audit' }, 'close', 'dsh-agent', true)
  } finally {
    if (saved.aliases === undefined) delete process.env.TASKBOARD_ACTOR_ALIASES
    else process.env.TASKBOARD_ACTOR_ALIASES = saved.aliases
    if (saved.watch === undefined) delete process.env.TASKBOARD_WATCH_NAMES
    else process.env.TASKBOARD_WATCH_NAMES = saved.watch
    if (saved.siblings === undefined) delete process.env.TASKBOARD_SIBLING_NAMES
    else process.env.TASKBOARD_SIBLING_NAMES = saved.siblings
  }
})

// ---------------------------------------------------------------- 顺序 / 兼容性

await check('顺序 · 状态先于归属：没人在等 = invalid-transition（改前就是这个码）', async () => {
  const ws = await boardWith({ status: 'open', created_by: 'dsh' })
  try {
    const result = await attempt(ws, 'T-1', { action: 'unblock' }, 'nova')
    assert.equal(result.code, 'invalid-transition', `陌生人来解一个没在等的卡：应是 invalid-transition，实际 ${result.code} — ${result.message}`)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

await check('顺序 · 状态先于归属：非法转移仍是 invalid-transition，不是 conflict', async () => {
  // 两种"状态机先说不行"的格子：open 上 reopen、closed 上 close。
  for (const [status, action] of [['open', 'reopen'], ['closed', 'close']]) {
    const ws = await boardWith({ status, created_by: 'dsh' })
    try {
      const result = await attempt(ws, 'T-1', { action }, 'nova')
      assert.ok(!result.allowed, `${status} 卡上 ${action}（陌生人）：本就不合法`)
      assert.equal(
        result.code, 'invalid-transition',
        `${status} 卡上 ${action}：状态机该先说话，实际 ${result.code} — ${result.message}`,
      )
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }
})

await check('向后兼容 · 缺 created_by 的老卡：退回改前行为（谁都能收口，不锁死老卡）', async () => {
  const spec = { status: 'open', assignee: 'kimi', omitCreatedBy: true }
  for (const by of ['nova', 'cc', 'claude', 'kimi', 'dsh', 'dsh-agent', 'human']) {
    await settleCell(spec, 'close', by, true)
  }
})

await check('向后兼容 · 缺 waiting_on 的老卡：unblock 仍是 invalid-transition（与改前逐字一致）', async () => {
  const ws = await boardWith({ status: 'in_progress', created_by: 'dsh', omitWaitingOn: true })
  try {
    for (const by of ['nova', 'dsh-agent', 'human']) {
      const result = await attempt(ws, 'T-1', { action: 'unblock' }, by)
      assert.ok(!result.allowed, `缺 waiting_on 的老卡 × ${by}: 改前就解不了，现在也必须解不了`)
      assert.equal(result.code, 'invalid-transition', `缺 waiting_on 的老卡 × ${by}: 码必须与改前一致，实际 ${result.code}`)
    }
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

await check('向后兼容 · 真实板夹具：有 created_by 的卡挡得住陌生人；抹掉 created_by 后逐字回到改前', async () => {
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
        'T-1': makeTask('T-1', { status: 'open', created_by: 'dsh', assignee: 'kimi' }),
        'T-2': makeTask('T-2', { status: 'done', created_by: 'kimi', assignee: 'dsh', reviewer: 'claude' }),
        'T-3': makeTask('T-3', { status: 'closed', created_by: 'claude', assignee: null }),
      },
    }
  }
  console.log(`      · 夹具来源：${origin}`)
  const cards = Object.values(source.tasks ?? {})
  assert.ok(cards.length > 0, '夹具里必须有卡')

  /** 把夹具写进一个临时 workspace（真实板只读，绝不在原地动）。 */
  const importBoard = async (raw) => {
    const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-authority-real-'))
    await mkdir(join(ws, '.dsh'), { recursive: true })
    await writeFile(join(ws, '.dsh', 'taskboard.json'), JSON.stringify(raw, null, 2))
    return { ws, board: await loadBoard(ws) }
  }

  /** 每张卡上"合法的那一步"（close 还是 reopen）。 */
  const stepFor = (task) => (task.status === 'closed' || task.status === 'done' ? 'reopen' : 'close')

  // ① 真实板原样：每一张有卡主的卡，陌生人都敲不动（新机制生效）
  {
    const { ws, board } = await importBoard(source)
    try {
      const all = Object.values(board.tasks)
      const missing = all.filter((task) => !task.created_by)
      assert.deepEqual(missing.map((task) => task.id), [], '夹具里不应有缺 created_by 的卡 —— 否则它走的是兼容分支')
      let refused = 0
      for (const task of all) {
        const result = await attempt(ws, task.id, { action: stepFor(task) }, 'zzz-stranger')
        assert.ok(!result.allowed, `${task.id}: 陌生人居然收了口（${stepFor(task)}）`)
        assert.equal(result.code, 'conflict', `${task.id}: 拒因应为 conflict，实际 ${result.code} — ${result.message}`)
        refused += 1
      }
      assert.equal(refused, all.length, `真实板 ${all.length} 张卡全部挡住了陌生人`)
      console.log(`      · 原样：${refused}/${all.length} 张卡的"陌生人收口"被拒（conflict）`)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // ② 同一批卡抹掉 created_by：归属校验必须**完全不生效**（改前行为逐字保留）
  {
    const legacy = JSON.parse(JSON.stringify(source))
    for (const task of Object.values(legacy.tasks ?? {})) {
      delete task.created_by
      delete task.waiting_on
    }
    const { ws, board } = await importBoard(legacy)
    try {
      const all = Object.values(board.tasks)
      let allowed = 0
      for (const task of all) {
        assert.equal(task.created_by, undefined, `${task.id}: created_by 已抹掉`)
        const result = await attempt(ws, task.id, { action: stepFor(task) }, 'zzz-stranger')
        assert.ok(result.allowed, `${task.id}: 老卡被新闸门锁死了 —— 兼容分支没兜住（${result.code} — ${result.message}）`)
        allowed += 1
      }
      assert.equal(allowed, all.length, `老卡 ${all.length} 张全部能按改前行为收口`)
      console.log(`      · 抹掉 created_by：${allowed}/${all.length} 张卡对陌生人放行（= 改前行为）`)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }
})

// ------------------------------------------------------------------ CLI 同一道闸门

await check('CLI 走同一道闸门：无关者 close 退出码 3 + 可读拒信；卡主照常成功', async () => {
  const ws = await boardWith({ status: 'done', created_by: 'dsh', assignee: 'kimi' })
  try {
    const refused = await run('node', [bin, '--cwd', ws, '--by', 'nova', 'update', 'T-1', '--action', 'close'])
      .then(() => null, (error) => error)
    assert.ok(refused, '无关者 close 必须失败')
    assert.equal(refused.code, 3, 'conflict 的退出码是 3')
    assert.match(refused.stderr, /not yours to close/)
    assert.match(refused.stderr, /or the human can/)

    const settled = JSON.parse(
      await run('node', [bin, '--cwd', ws, '--by', 'dsh', 'update', 'T-1', '--action', 'close', '--json'])
        .then(({ stdout }) => stdout.trim()),
    )
    assert.equal(settled.status, 'closed', '卡主照样收得了口')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall actor authority checks passed')
}
