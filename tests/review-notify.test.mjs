/**
 * Reviewer-notification test for dsh-taskboard-kit (T-56).
 *
 * 现场（2026-10-07 实测）：9 张卡挂在 review 列、`reviewer=kimi`，板是对的
 * （`inbox --by kimi` 能列出 13 条），但**没有任何东西会主动告诉他** ——
 * 他 cwd 不在这个工作区，于是那 9 张卡在他那里等于不存在。
 *
 * 这个文件覆盖三件必须成立的事：
 *   ① 有 msg9 ⇒ 调用一次，且参数正确（收件人 / 主题 / 正文 / 幂等键）；
 *   ② 没有 msg9 ⇒ 降级成"只打印可复制提示"，`submit` 照常成功；
 *   ③ 发送失败（退出码非 0）⇒ **`submit` 仍然成功**（通知是附属动作）。
 * 外加：幂等（重放不重复轰炸）、地址只从板里已有信息解析（绝不构造）、
 * 以及 `stale` 的「欠谁审核」按 reviewer 分组。
 *
 * **本文件绝不真的发信**：单元级把 findBinary / runSend 注入成假的（连进程都不起）；
 * CLI 级用一个**假 msg9 可执行文件 + PATH 注入**，把它的 argv 记进文件再断言。
 * 每个 CLI 用例都显式覆盖 PATH，绝不继承本机那支真的 msg9。
 *
 * Run: npm test   (or: node tests/review-notify.test.mjs  —— 需要先 npm run build)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const lib = await import('../lib/index.js')
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'taskboard.mjs')

process.env.TASKBOARDKIT_LOCALE = 'zh'
delete process.env.TASKBOARD_ACTOR
delete process.env.TASKBOARD_REVIEW_NOTIFY
delete process.env.TASKBOARD_MSG9_BIN
delete process.env.TASKBOARD_NOTIFY_CMD

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

/** 假的 msg9：把 argv 逐行写进 log，按需失败。真进程，但**不是**那支真的 msg9。 */
async function makeFakeMsg9(dir, { exitCode = 0, stderr = '', log = join(dir, 'argv.txt') } = {}) {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'msg9')
  const script = [
    '#!/bin/sh',
    `printf '#CALL#\\n' >> '${log}'`,
    `printf '%s\\n' "$@" >> '${log}'`,
    stderr === '' ? '' : `printf '%s\\n' '${stderr}' >&2`,
    `exit ${exitCode}`,
    '',
  ].join('\n')
  await writeFile(file, script)
  await chmod(file, 0o755)
  return { dir, file, log }
}

/** 假 msg9 被调用了几次、每次的 argv 是什么。 */
async function readCalls(log) {
  const raw = await readFile(log, 'utf8').catch(() => '')
  return raw
    .split('#CALL#\n')
    .map((chunk) => chunk.split('\n').filter((line) => line !== ''))
    .filter((args) => args.length > 0)
}

function argAfter(args, flag) {
  const index = args.indexOf(flag)
  return index < 0 ? null : args[index + 1]
}

/** 跑一次 CLI；PATH 一律显式给（绝不继承本机真的 msg9）。 */
async function cli(ws, args, env = {}, by = 'kimi') {
  const options = { env: { ...process.env, ...env } }
  try {
    const result = await run(process.execPath, [bin, '--cwd', ws, '--by', by, ...args], options)
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** 一张已经 claim、可以 submit 的新卡。 */
async function claimableCard(ws, title) {
  const created = JSON.parse((await cli(ws, ['create', '--title', title, '--json'], { PATH: '/usr/bin:/bin' })).stdout)
  await cli(ws, ['claim', created.id], { PATH: '/usr/bin:/bin' })
  return created.id
}

/** 往名册里塞一条 msg9 地址（模拟"板里已有的地址信息"）。 */
async function seedAddress(ws, name, address) {
  const board = await lib.loadBoard(ws)
  board.actors[address] = board.actors[address]
    ?? { kind: 'agent', aliases: name && name !== address ? [name] : [], first_seen_at: new Date().toISOString(), last_seen_at: null }
  await lib.saveBoard(ws, board)
}

// ------------------------------------------------------------ 地址解析（不猜）
await check('地址只从板里已有信息解析：名册里的地址 / 名字本身是地址 / 没有就是 null', () => {
  const board = {
    version: 1,
    workspace: '/tmp/x',
    next_seq: 1,
    tasks: {},
    actors: {
      kimi: { kind: 'agent', aliases: [], first_seen_at: '', last_seen_at: null },
      dsh: { kind: 'agent', aliases: ['dsh-agent'], first_seen_at: '', last_seen_at: null },
      'dsh@msg9.ice.msg9.io': { kind: 'agent', aliases: [], first_seen_at: '', last_seen_at: null },
      'msg9 平台（PO 信箱 cc@msg9.ice.msg9.io）': { kind: 'agent', aliases: [], first_seen_at: '', last_seen_at: null },
    },
  }
  assert.equal(lib.msg9AddressOf(board, 'dsh'), 'dsh@msg9.ice.msg9.io', '本地部分认人')
  assert.equal(lib.msg9AddressOf(board, 'DSH'), 'dsh@msg9.ice.msg9.io', '大小写不敏感')
  assert.equal(lib.msg9AddressOf(board, 'dsh-agent'), 'dsh@msg9.ice.msg9.io', '别名走名册（dsh ≡ dsh-agent）')
  assert.equal(lib.msg9AddressOf(board, 'cc'), 'cc@msg9.ice.msg9.io', '地址嵌在名册标签里也能取出来')
  assert.equal(lib.msg9AddressOf(board, 'kimi'), null, '名册里没有就是 null —— 绝不构造一个看起来像的地址')
  assert.equal(lib.msg9AddressOf(board, 'kimi@kimi-code.ice.msg9.io'), 'kimi@kimi-code.ice.msg9.io', '名字本身就是地址时原样用')
  // 不是"整个字符串就是一个地址"的绝不当地址用：返回的地址里不能夹着「（旧）」这类尾巴。
  const messy = ['cc@msg9.ice.msg9.io（旧）', 'cc@msg9.ice.msg9.io ', '  cc  '].map((who) => lib.msg9AddressOf(board, who))
  assert.ok(messy.every((addr) => addr === null || !/[（）\s]/.test(addr)), `地址必须干净：${JSON.stringify(messy)}`)
})

// -------------------------------------------------- ① 有 msg9：调用一次且参数正确
const unitWs = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-unit-'))
{
  const created = await lib.createTask(unitWs, { title: '通知参数验证' }, 'kimi')
  await lib.claimTask(unitWs, created.id, 'kimi')
  const { task } = await lib.updateTask(unitWs, created.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  await seedAddress(unitWs, 'dsh', 'dsh@msg9.ice.msg9.io')

  const calls = []
  const logs = []
  const deps = {
    findBinary: (name) => (name === 'msg9' ? '/fake/bin/msg9' : null),
    runSend: async (binary, args, cwd) => { calls.push({ binary, args, cwd }) },
    log: (message) => logs.push(message),
  }
  const result = await lib.notifyReviewer(
    { cwd: unitWs, task, reviewer: task.reviewer, submittedBy: 'kimi' },
    deps,
  )

  await check('① 有 msg9：发送一次，参数正确（to / subject / body / 幂等键 / cwd）', async () => {
    assert.equal(result.how, 'msg9')
    assert.equal(result.address, 'dsh@msg9.ice.msg9.io')
    assert.equal(calls.length, 1, '只发一次')
    const { binary, args, cwd } = calls[0]
    assert.equal(binary, '/fake/bin/msg9')
    assert.equal(cwd, unitWs, '在他自己的工作区里发（凭据解析跟着 cwd 走）')
    assert.deepEqual(args.slice(0, 1), ['send'])
    assert.equal(argAfter(args, '--to'), 'dsh@msg9.ice.msg9.io')
    assert.match(argAfter(args, '--subject'), new RegExp(`${task.id}`), '主题带卡号')
    const body = argAfter(args, '--body')
    assert.match(body, new RegExp(task.id), '正文带卡号')
    assert.match(body, /通知参数验证/, '正文带标题')
    assert.match(body, /taskboard inbox --by dsh/, '正文带他该敲的命令')
    assert.ok(body.includes(unitWs), '正文带 --cwd：他可能不在这个工作区')
    assert.match(argAfter(args, '--idempotency-key') ?? '', /^taskboard-review-/, '服务端幂等键')
    assert.ok(logs.some((line) => /已通知/.test(line)), '发出去也要有日志（可见）')
  })

  await check('幂等：同一轮提交重放 ⇒ skipped，且不再发第二封', async () => {
    const again = []
    const second = await lib.notifyReviewer(
      { cwd: unitWs, task, reviewer: task.reviewer, submittedBy: 'kimi' },
      { ...deps, runSend: async (binary, args, cwd) => { again.push({ binary, args, cwd }) } },
    )
    assert.equal(second.how, 'skipped')
    assert.equal(again.length, 0, '重放不再轰炸')
    assert.equal(second.hint, '', '重放也不重复刷屏')
    const board = await lib.loadBoard(unitWs)
    assert.equal(Object.keys(board.review_notices ?? {}).length, 1, '幂等记录落进板里')
    const record = Object.values(board.review_notices)[0]
    assert.equal(record.how, 'msg9')
    assert.equal(record.reviewer, 'dsh')
    assert.match(record.anchor, new RegExp(`^${task.id}#log:`), '锚点是本轮 submitted 事件')
  })
}

// --------------------------------------------------- ② 没有 msg9：降级打印不抛
await check('② 没有 msg9：降级成可复制提示（不抛、不发送）', async () => {
  const created = await lib.createTask(unitWs, { title: '无 msg9 降级' }, 'kimi')
  await lib.claimTask(unitWs, created.id, 'kimi')
  const { task } = await lib.updateTask(unitWs, created.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  const logs = []
  const result = await lib.notifyReviewer(
    { cwd: unitWs, task, reviewer: task.reviewer, submittedBy: 'kimi' },
    { findBinary: () => null, runSend: async () => { throw new Error('不该走到这里') }, log: (m) => logs.push(m) },
  )
  assert.equal(result.how, 'printed')
  assert.equal(result.reason, 'no-msg9')
  assert.match(result.hint, /msg9 send --to 'dsh@msg9\.ice\.msg9\.io'/, '提示里是可原样复制的命令')
  assert.match(result.hint, new RegExp(task.id))
  assert.match(result.hint, /未自动发送/, '并说明没自动发出去')
  assert.ok(logs.some((line) => /未自动发送|没有 msg9/.test(line)), '没发出去也要有日志')
  const board = await lib.loadBoard(unitWs)
  const record = Object.values(board.review_notices).find((item) => item.task === task.id)
  assert.equal(record.how, 'printed')
  assert.equal(record.reason, 'no-msg9')
})

// -------------------------------------------------------- ③ 发送失败：不阻断、不抛
await check('意外错误（通知这条链自己炸了）也降级：绝不抛错', async () => {
  const created = await lib.createTask(unitWs, { title: '意外错误也要降级' }, 'kimi')
  await lib.claimTask(unitWs, created.id, 'kimi')
  const { task } = await lib.updateTask(unitWs, created.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  const logs = []
  const result = await lib.notifyReviewer(
    { cwd: unitWs, task, reviewer: task.reviewer, submittedBy: 'kimi' },
    {
      // 这不是"发送失败"，是通知这条链自己的 bug：外层那层 catch-all 是
      // "绝不阻断提交"的最后一道保险，它必须真的有人在守（否则就是死代码）。
      findBinary: () => { throw new Error('内部 bug：findBinary 炸了') },
      runSend: async () => {},
      log: (m) => logs.push(m),
    },
  )
  assert.equal(result.how, 'printed', '意外错误也降级，不冒泡')
  assert.match(result.error, /内部 bug/)
  assert.ok(logs.some((line) => /出错/.test(line)), '意外错误要留痕')
})

// -------------------------------------------------------- ③ 发送失败：不阻断、不抛
await check('③ 发送失败（退出码非 0）：成果降到 printed，绝不抛错', async () => {
  const created = await lib.createTask(unitWs, { title: '发送失败不阻断' }, 'kimi')
  await lib.claimTask(unitWs, created.id, 'kimi')
  const { task } = await lib.updateTask(unitWs, created.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  const logs = []
  const result = await lib.notifyReviewer(
    { cwd: unitWs, task, reviewer: task.reviewer, submittedBy: 'kimi' },
    {
      findBinary: () => '/fake/bin/msg9',
      runSend: async () => { throw new Error('msg9 send exited 7: no credential') },
      log: (m) => logs.push(m),
    },
  )
  assert.equal(result.how, 'printed')
  assert.equal(result.reason, 'send-failed')
  assert.match(result.error, /exited 7/)
  assert.match(result.hint, /未自动发送/, '失败也要把提示交到手上')
  assert.ok(logs.some((line) => /失败/.test(line)), '失败要留痕（可见）')
})

// ------------------------------------------------------------- 地址未知：不猜
await check('地址未知：只打印，占位符而不是编出来的地址', async () => {
  const created = await lib.createTask(unitWs, { title: '地址未知' }, 'kimi')
  await lib.claimTask(unitWs, created.id, 'kimi')
  const { task } = await lib.updateTask(unitWs, created.id, { action: 'submit', reviewer: 'cc' }, 'kimi')
  let sent = 0
  const result = await lib.notifyReviewer(
    { cwd: unitWs, task, reviewer: task.reviewer, submittedBy: 'kimi' },
    { findBinary: () => '/fake/bin/msg9', runSend: async () => { sent += 1 }, log: () => {} },
  )
  assert.equal(result.address, null)
  assert.equal(result.reason, 'no-address')
  assert.equal(sent, 0, '地址未知时**不调用**发送')
  assert.match(result.hint, /地址未知/)
  assert.ok(!/cc@/.test(result.hint), '绝不构造 cc@… 这种猜出来的地址')
})

// ------------------------------------------------------------- 关掉自动发送
await check('TASKBOARD_REVIEW_NOTIFY=off：即使有 msg9 与地址也不发（留打印）', async () => {
  const created = await lib.createTask(unitWs, { title: '开关' }, 'kimi')
  await lib.claimTask(unitWs, created.id, 'kimi')
  const { task } = await lib.updateTask(unitWs, created.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  process.env.TASKBOARD_REVIEW_NOTIFY = 'off'
  let sent = 0
  try {
    const result = await lib.notifyReviewer(
      { cwd: unitWs, task, reviewer: task.reviewer, submittedBy: 'kimi' },
      { findBinary: () => '/fake/bin/msg9', runSend: async () => { sent += 1 }, log: () => {} },
    )
    assert.equal(result.how, 'printed')
    assert.equal(result.reason, 'disabled')
    assert.equal(sent, 0)
  } finally {
    delete process.env.TASKBOARD_REVIEW_NOTIFY
  }
})

// ----------------------------------------------------------- CLI：真发货一次
{
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-cli-'))
  const fake = await makeFakeMsg9(join(ws, 'fake-bin'))
  const env = { PATH: `${fake.dir}:/usr/bin:/bin` }
  const id = await claimableCard(ws, 'CLI 通知验证')
  await seedAddress(ws, 'dsh', 'dsh@msg9.ice.msg9.io')

  const submitted = await cli(ws, ['update', id, '--action', 'submit', '--reviewer', 'dsh'], env)

  await check('CLI：假 msg9 在 PATH 上 ⇒ submit 成功、真发一次、参数正确、板里有幂等记录', async () => {
    assert.equal(submitted.code, 0, `submit 应成功：${submitted.stderr}`)
    const calls = await readCalls(fake.log)
    assert.equal(calls.length, 1, '只发一次')
    assert.equal(argAfter(calls[0], '--to'), 'dsh@msg9.ice.msg9.io')
    assert.match(argAfter(calls[0], '--subject'), new RegExp(id))
    assert.match(argAfter(calls[0], '--body'), new RegExp(id))
    assert.match(submitted.stdout, /updated/, '人类可读输出仍在')
    assert.match(submitted.stdout, new RegExp(id))
    assert.match(submitted.stderr, /已通知/, '日志说清发给了谁')
    const board = await lib.loadBoard(ws)
    assert.equal(board.tasks[id].status, 'review')
    assert.equal(board.tasks[id].reviewer, 'dsh')
    assert.equal(Object.keys(board.review_notices ?? {}).length, 1)
  })

  await check('CLI：--json 时 stdout 仍是可解析 JSON（提示走 stderr）', async () => {
    const id2 = await claimableCard(ws, 'CLI --json')
    const result = await cli(ws, ['update', id2, '--action', 'submit', '--reviewer', 'dsh', '--json'], env)
    assert.equal(result.code, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.status, 'review')
    assert.match(result.stderr, /已通知/, '提示没有被吞掉，只是走了 stderr')
    assert.ok((await readCalls(fake.log)).length === 2, '第二张卡各发一封')
  })

  await check('CLI：同一张卡重放 submit ⇒ 卡不变、通知不重发（幂等）', async () => {
    const before = (await readCalls(fake.log)).length
    const again = await cli(ws, ['update', id, '--action', 'submit', '--reviewer', 'dsh'], env)
    assert.equal(again.code, 2, 'review 列不能再 submit（非法流转）')
    assert.equal((await readCalls(fake.log)).length, before, '重放没有第二封信')
  })
}

// ------------------------------------------------- CLI：发送失败不阻断提交
await check('CLI：假 msg9 退出码非 0 ⇒ submit 仍然成功（核心约束）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-fail-'))
  const fake = await makeFakeMsg9(join(ws, 'fake-bin'), { exitCode: 7, stderr: 'no credential for this workspace' })
  const env = { PATH: `${fake.dir}:/usr/bin:/bin` }
  const id = await claimableCard(ws, '发送失败也要提交成功')
  await seedAddress(ws, 'dsh', 'dsh@msg9.ice.msg9.io')

  const result = await cli(ws, ['update', id, '--action', 'submit', '--reviewer', 'dsh'], env)
  assert.equal(result.code, 0, `submit 必须成功，实际 stderr：${result.stderr}`)
  const board = await lib.loadBoard(ws)
  assert.equal(board.tasks[id].status, 'review', '状态真的流转到 review 了')
  assert.equal(board.tasks[id].reviewer, 'dsh')
  assert.equal((await readCalls(fake.log)).length, 1, '确实尝试发过')
  assert.match(result.stderr, /发送失败|失败/, '失败要说出来（可见）')
  assert.match(result.stdout, /msg9 send --to 'dsh@msg9\.ice\.msg9\.io'/, '降级成可复制的提示')
  assert.equal(Object.values(board.review_notices)[0].reason, 'send-failed')
})

// ----------------------------------------------------- CLI：没有 msg9 只打印
await check('CLI：PATH 里没有 msg9 ⇒ 只打印提示，submit 照常成功', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-nomsg9-'))
  const empty = join(ws, 'empty-bin')
  await mkdir(empty, { recursive: true })
  const id = await claimableCard(ws, '没有 msg9 也要提交成功')
  await seedAddress(ws, 'dsh', 'dsh@msg9.ice.msg9.io')

  const result = await cli(ws, ['update', id, '--action', 'submit', '--reviewer', 'dsh'], { PATH: empty })
  assert.equal(result.code, 0, `submit 必须成功：${result.stderr}`)
  assert.match(result.stdout, /msg9 send --to 'dsh@msg9\.ice\.msg9\.io'/, '提示可原样复制')
  assert.match(result.stdout, new RegExp(id))
  assert.match(result.stderr, /没有 msg9|未自动发送/, '说清为什么没发出去')
  const board = await lib.loadBoard(ws)
  assert.equal(board.tasks[id].status, 'review')
  assert.equal(Object.values(board.review_notices)[0].reason, 'no-msg9')
})

// -------------------------------------------------- CLI：地址未知不猜、不发
await check('CLI：板里没有他的地址 ⇒ 只打印占位符，且一个进程都没起', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-noaddr-'))
  const fake = await makeFakeMsg9(join(ws, 'fake-bin'))
  const env = { PATH: `${fake.dir}:/usr/bin:/bin` }
  const id = await claimableCard(ws, '地址未知')
  const result = await cli(ws, ['update', id, '--action', 'submit', '--reviewer', 'cc'], env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal((await readCalls(fake.log)).length, 0, '地址未知时绝不发信')
  assert.match(result.stdout, /地址未知/)
  assert.ok(!/cc@/.test(result.stdout), '绝不构造 cc@… ')
})

// ------------------------------- 模型工具路径（T-56 真实现场走的就是这条）
await check('模型工具 taskboard_update 的 submit 也会通知 reviewer（实测 8/10 张静默卡是 dsh 提交的）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-tool-'))
  const fake = await makeFakeMsg9(join(ws, 'fake-bin'))
  const id = await claimableCard(ws, '模型工具路径')
  await seedAddress(ws, 'kimi', 'kimi@kimi-code.ice.msg9.io')

  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    sessions: { get: () => ({ header: { cwd: ws } }) },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  }
  lib.registerTaskboardTools(ctx)
  const update = registered.find((tool) => tool.name === 'taskboard_update')
  assert.ok(update, 'taskboard_update 注册上了')

  process.env.TASKBOARD_MSG9_BIN = fake.file // 测试里只认这支假 msg9
  try {
    const text = await update.execute({ id, action: 'submit', reviewer: 'kimi', by: 'dsh' }, { agent: 's1' })
    assert.match(text, /已交给 kimi 审核/, '工具输出仍说清交给了谁')
    const calls = await readCalls(fake.log)
    assert.equal(calls.length, 1, '模型工具这条路径也真的发了一封')
    assert.equal(argAfter(calls[0], '--to'), 'kimi@kimi-code.ice.msg9.io')
    assert.match(argAfter(calls[0], '--body'), new RegExp(id))
    assert.match(text, /已通知 kimi/, '提示也回给提交的人')
  } finally {
    delete process.env.TASKBOARD_MSG9_BIN
  }
  const board = await lib.loadBoard(ws)
  assert.equal(board.tasks[id].status, 'review')
  assert.equal(board.tasks[id].reviewer, 'kimi')
  assert.equal(Object.keys(board.review_notices ?? {}).length, 1, '与 CLI 共用同一条幂等记录')
})

await check('模型工具路径：发送失败也只降级，工具照样成功（不阻断）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-tool-fail-'))
  const fake = await makeFakeMsg9(join(ws, 'fake-bin'), { exitCode: 9, stderr: 'boom' })
  const id = await claimableCard(ws, '工具路径发送失败')
  await seedAddress(ws, 'kimi', 'kimi@kimi-code.ice.msg9.io')
  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    sessions: { get: () => ({ header: { cwd: ws } }) },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  }
  lib.registerTaskboardTools(ctx)
  const update = registered.find((tool) => tool.name === 'taskboard_update')
  process.env.TASKBOARD_MSG9_BIN = fake.file
  try {
    const text = await update.execute({ id, action: 'submit', reviewer: 'kimi', by: 'dsh' }, { agent: 's1' })
    assert.match(text, /Updated|已更新/, '工具正常返回，没有把异常抛给模型')
    assert.match(text, /msg9 send --to 'kimi@kimi-code\.ice\.msg9\.io'/, '把可复制提示交给提交的人')
  } finally {
    delete process.env.TASKBOARD_MSG9_BIN
  }
  const board = await lib.loadBoard(ws)
  assert.equal(board.tasks[id].status, 'review', '状态照常流转')
  assert.equal(Object.values(board.review_notices)[0].reason, 'send-failed')
})

// -------------------------------------------------- stale：欠谁审核（分组）
await check('CLI stale：把「欠谁审核」按 reviewer 分组（一行一个人 + 他该敲的命令）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-review-stale-'))
  const env = { PATH: '/usr/bin:/bin' }
  for (const [title, reviewer] of [['欠甲一', 'kimi'], ['欠甲二', 'kimi'], ['欠乙一', 'cc']]) {
    const id = await claimableCard(ws, title)
    // 交出去的人是 claude（by=kimi 会撞上"不能审自己的活"那条板规）。
    const result = await cli(ws, ['update', id, '--action', 'submit', '--reviewer', reviewer], env, 'claude')
    assert.equal(result.code, 0, result.stderr)
  }
  const human = await cli(ws, ['stale'], env)
  assert.match(human.stdout, /欠审核/)
  assert.match(human.stdout, /kimi · 2 张/)
  assert.match(human.stdout, /cc · 1 张/)
  assert.match(human.stdout, /taskboard inbox --by kimi --cwd/)
  const json = JSON.parse((await cli(ws, ['stale', '--json'], env)).stdout)
  assert.equal(json.review_owed.length, 2, '按人分组两条')
  assert.equal(json.review_owed[0].reviewer, 'kimi', '欠得最多的排最前')
  assert.equal(json.review_owed[0].count, 2)
  assert.equal(json.review_owed[0].cards.length, 2)
})

await rm(unitWs, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall reviewer-notify checks passed')
}
