/**
 * 复核尾巴扫描器测试（T-44）。
 *
 * 为什么需要这个文件：T-40 的审计证明 38 张 closed 卡里至少 10 条复核遗留掉了地
 * （含"注释声称有测试、其实没有"这种假绿）。根因是机制缺失 —— 复核结论写在
 * note / comment 里，而 note **不改变列** ⇒ 没有载体、没有提醒、没有清单。
 * `shared/tails.ts` 是那个载体，本文件钉住它的三件事：
 *
 *   1. **判据逐类命中**（11 类逐句判据 + 1 类只在小节标题上放行，每类一个样本）
 *      与**逐类收窄**（什么样的句子
 *      *不*该被列出来 —— 误报同样是缺陷，只是方向不同）；
 *   2. **范围与归属**：只扫 closed/done、只把"复核意见"与"作者的承诺"算数、
 *      别名（dsh ≡ dsh-agent）要认得出、收口之后不再列；
 *   3. **接入两条既有路径**：`health()`（→ `stale`）与 `inboxFor()`（→ `inbox`）。
 *
 * 全部走包已经导出的 `health()` / `inboxFor()` 两个面，不为此新开导出面 ——
 * 这也是本卡 `src/host/**` 一行未动的原因。
 *
 * Run: npm test   (after npm run build)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const lib = await import('../lib/index.js')
const { addComment, boardFilePath, createTask, health, inbox, listTasks, loadBoard, saveBoard } = lib
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'taskboard.mjs')

process.env.TASKBOARDKIT_LOCALE = 'en'
delete process.env.TASKBOARD_ACTOR
delete process.env.TASKBOARD_WATCH_NAMES
delete process.env.TASKBOARD_ALLOW_SELF_REVIEW
process.env.TASKBOARD_HUMANS = 'iceskysl'

console.log('dsh-taskboard-kit review-tails test:')

let checks = 0
function ok(name) {
  checks += 1
  console.log(`  [ok] ${name}`)
}

const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-tails-'))

async function cli(...args) {
  const { stdout } = await run('node', [bin, '--cwd', ws, '--by', 'dsh', ...args])
  return stdout.trim()
}

async function cliFails(...args) {
  try {
    await run('node', [bin, '--cwd', ws, '--by', 'dsh', ...args])
  } catch (error) {
    return error
  }
  throw new Error(`expected failure: ${args.join(' ')}`)
}

/** 走完整流程把一张卡推到 closed，裁决 note 落在 approve / close 上。 */
async function closedCard(title, { verdict, closeNote = '结清。', assignee = 'dsh', approver = 'kimi' } = {}) {
  const task = await createTask(ws, { title, assignee }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'start' }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'submit', reviewer: approver }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'approve', note: verdict }, approver)
  await lib.updateTask(ws, task.id, { action: 'close', note: closeNote }, 'dsh')
  return task.id
}

/** 同一块板上所有未收口的尾巴。 */
async function openTails(options) {
  const result = await health(ws, options)
  return result.reviewTails.filter((tail) => tail.settlement === null)
}

/** 拿某张卡上的尾巴（裁决 note 落位 = log）。 */
async function tailsOf(taskId) {
  return (await openTails()).filter((tail) => tail.task_id === taskId && tail.source.kind === 'log')
}

// ---------------------------------------------------------------- 判据逐类

const RULE_SAMPLES = [
  ['ask', '请确认它排进了 0.7.2 清单。'],
  ['dont-drop', '请确认它排进了清单，别掉地上。'],
  ['deferral', '这条留给下一版一起改。'],
  ['deferred-ship', '随 T-31（taskboard-kit 0.7.2）发布。'],
  ['non-blocking', '两条同族残余边缘不阻塞，记录在案。'],
  ['suggest', '建议一并换 link 系。'],
  ['gap-fill', '请补一条 renderBoard 断言。'],
  ['handy', '测试 1091 与 1080 重复断言可顺手去重。'],
  ['claim-check', '注释声称有测试把两侧逐动作钉住，其实该测试不存在。'],
  ['still-there', '另 tests/client.test.mjs:1013 还有一处 iceskyls 错拼残留。'],
  ['inconsistency', 'isMilestoneTag 大小写敏感而 semverParts 容忍大写，口径不齐。'],
]

for (const [rule, sample] of RULE_SAMPLES) {
  const id = await closedCard(`判据样本 · ${rule}`, { verdict: sample })
  const tails = await tailsOf(id)
  const hit = tails.find((tail) => tail.rules.includes(rule))
  assert.ok(hit, `判据 ${rule} 必须命中样本：${sample}`)
  assert.ok(hit.reasons.length > 0, `命中的判据必须带"为什么"（人读的关键词清单）`)
  assert.ok(hit.snippet.length > 0, '每条尾巴必须带原文片段')
  assert.match(hit.id, new RegExp(`^${id}#log:\\d+:\\d+$`), 'tail id 要能定位到卡 + 位置 + 句')
}
ok('11 类判据逐类命中样本，且都带判据说明 + 原文片段 + 可定位的 id')

// 变异基线：把这 11 个样本一次性扫一遍，计数必须等于样本数（不多不少）。
{
  const ids = RULE_SAMPLES.map(([, sample]) => sample)
  const found = (await openTails()).filter((tail) => ids.includes(tail.snippet))
  assert.equal(found.length, RULE_SAMPLES.length, '每个样本恰好一条尾巴（没有重复计数）')
}
ok('每个样本恰好产出一条尾巴（不多不少）')

// ---------------------------------------------------------------- 判据收窄
// 每一条都对应一次真实误报（T-44 的误报复核），是"怎么收窄"的机器护栏。

const FALSE_POSITIVES = [
  ['请出现在「请求」里', '任何合并进来的对象都会凭空多出这些属性，同时该请求必然 500。'],
  ['已随 X 发布 = 既成事实', '三处修复早已落地并随 0.6.0/0.6.1 发布。'],
  ['零残留 = 验收结论', '指令性文案零残留（grep 命中 0）；样式残留为 0。'],
  ['「修法建议见留言」是元话', '其余内容无误，修法建议见留言，与我建议一致。'],
  ['「顺手挖出」是叙述', '它还顺手挖出同套件另外 4 处假绿。'],
  ['「无遗留动作」是结清语', '无遗留动作，结清。'],
]

for (const [why, sample] of FALSE_POSITIVES) {
  const id = await closedCard(`误报样本 · ${why}`, { verdict: sample })
  const tails = await tailsOf(id)
  assert.equal(tails.length, 0, `不该被列出（${why}）：${sample}`)
}
ok('6 类已收窄的误报不再被列出（每条都有对应的判据改动）')

// ------------------------------------------------------------- 范围与作者
{
  const open = await createTask(ws, { title: '还开着的卡', assignee: 'dsh' }, 'dsh')
  await lib.updateTask(ws, open.id, { action: 'start' }, 'dsh')
  await lib.updateTask(ws, open.id, { action: 'submit', reviewer: 'kimi' }, 'dsh')
  await lib.updateTask(ws, open.id, { action: 'approve', note: '这条别掉地上，请确认。' }, 'kimi')
  // approved → done：done 也在扫描范围内
  const doneTails = (await openTails()).filter((tail) => tail.task_id === open.id)
  assert.ok(doneTails.length > 0, 'done 卡（审核过了、还没收口）要扫 —— 尾巴正是在这里开始掉的')
  await lib.updateTask(ws, open.id, { action: 'reopen' }, 'dsh')
  const afterReopen = (await openTails()).filter((tail) => tail.task_id === open.id)
  assert.equal(afterReopen.length, 0, 'reopen 回到 open 之后就不再是"已结清卡的尾巴"')
}
ok('只扫 closed / done：done 会扫，reopen 回 open 后不再扫')

{
  // 切句口径：全角「；」**不切**（成串的待办就是靠它串起来的，切开会让后半句
  // 丢掉前半句的判据 —— 实测漏掉 T-21 的"daemon.log 无轮转"），裸「?」也不切
  // （代码 / 路径 / 「? 指南」这种字面量里满地都是 —— 实测把 T-27 那句话劈成
  // "非阻塞建议两条：a) 「"）。这条是那次修复的回归护栏。
  const id = await closedCard('切句样本', {
    verdict: '非阻塞建议两条：a) 「? 指南」收录记号图例（新手不 hover 没有面板内自查入口）；b) #93 的 tooltip 可补「任务编号」字样。',
  })
  const tails = await tailsOf(id)
  assert.equal(tails.length, 1, '分号串起来的枚举 + 字面量 ? ⇒ 只该产出一条尾巴')
  assert.match(tails[0].snippet, /图例/, '前半句（a) 记号图例）在片段里')
  assert.match(tails[0].snippet, /任务编号/, '后半句（b) 任务编号）也在片段里')
}
ok('切句：；与裸 ? 不切断一句话（成串的待办保持在一起）')

{
  // 作者自己的交付说明（建议/请）不是待办；他的"承诺"才是。
  const id = await closedCard('作者留言的门', { verdict: '复核通过。' })
  await addComment(ws, id, '交付说明：建议用 trim+lowercase 归一，请复核这一笔。', 'dsh') // 作者 = dsh
  await addComment(ws, id, '这条随下一笔一起改。', 'dsh')
  await addComment(ws, id, '建议补一条断言。', 'kimi') // 复核人
  const tails = (await openTails()).filter((tail) => tail.task_id === id && tail.source.kind === 'comment')
  const snippets = tails.map((tail) => tail.snippet)
  assert.ok(!snippets.some((text) => text.includes('trim+lowercase')), '作者自己的交付说明不算待办')
  assert.ok(snippets.some((text) => text.includes('随下一笔')), '作者自己写下的承诺必须收（尾巴就是这么丢的）')
  assert.ok(snippets.some((text) => text.includes('补一条断言')), '复核人（非作者）的留言整条扫')
}
ok('作者交付说明不进清单；作者的承诺与复核人的留言进清单')

{
  // ---------------------------------------------------- 「明确没做」小节（T-50）
  // T-40 的教训是「**说没做、然后没人跟**」：作者的交付说明里常有一节
  // 「### 明确没做」/「### 没做的部分与原因」，标题下的条目正是"这件事我知道
  // 我没做"的**结构性自陈** —— 它既不是"推迟"也不是"别掉"，所以过去**一条都不成
  // 尾巴**（实证：T-8#c:1:29 的标题被列出、标题下 4 条一条都没；T-23 的
  // 「没做的部分与原因」整节 0 条）。
  //
  // 夹具是 **T-23 的真实交接留言**：逐字节取自工作区板 `.dsh/taskboard.json`
  // （`tasks['T-23'].comments[0].text`），落在 `tests/fixtures/t23-comment.md`。
  // 它是**作者自己写的** —— 所以这条同时钉住"要穿过 `PROMISE_RULES` 那道门"。
  const id = await closedCard('没做小节夹具（T-23 真实留言）', { verdict: '复核通过。' })
  const t23 = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 't23-comment.md'),
    'utf8',
  )
  await addComment(ws, id, t23.trimEnd(), 'dsh') // 作者 = dsh = assignee ⇒ ownerAuthored

  const tails = (await openTails()).filter((tail) => tail.task_id === id)
  const section = tails.filter((tail) => tail.rules.includes('not-done'))

  assert.ok(section.length > 0, '「### 没做的部分与原因」这一节必须被扫出来')
  assert.ok(
    section.some((tail) => tail.snippet.includes('没做的部分与原因')),
    '小节标题本身要被列出 —— 它是"这里有一摊没做的事"的指针',
  )
  // T-48 点名要看的 3 条实体条目：逐条都得在。
  for (const must of ['onlyUnprocessed', 'T-13 二期', 'daemon 的 WS 帧不带未读']) {
    assert.ok(section.some((tail) => tail.snippet.includes(must)), `「没做」小节下的条目必须被列出：${must}`)
  }
  assert.equal(
    section.filter((tail) => /^\d+\./.test(tail.snippet)).length,
    5,
    '标题下的 5 个编号条目**逐条**都要列出来（不是只列标题）',
  )
  // 小节边界：下一个标题之后的内容不许继承 not-done。
  assert.ok(
    !tails.some((tail) => tail.snippet.includes('两个必须知情的环境事实')),
    '下一个标题不该被算进"没做"小节',
  )
  assert.ok(
    !tails.some((tail) => tail.snippet.includes('会整体替换')),
    '「没做」小节在下一个标题处结束，后面的正文不许被牵连',
  )

  // **只在小节标题层面放行**：正文里说"没做 / 不在本卡范围"**不算** ——
  // 否则交付说明的正文（满地都是这类话）会一夜之间变成墙纸。
  const noise = await closedCard('正文里的"没做"', { verdict: '复核通过。' })
  await addComment(ws, noise, '交付说明：这件事我明确没做，也不在本卡范围，请审核人知悉。', 'dsh')
  assert.equal(
    (await openTails()).filter((tail) => tail.task_id === noise && tail.rules.includes('not-done')).length,
    0,
    '没有「没做」小节标题时，正文里的"没做 / 不在本卡范围"不进清单（控噪声）',
  )

  // T-8 的措辞（「### 明确没做（留给下一轮，理由在手）」）同样要带出条目；
  // 标题自己仍可同时命中 `deferral`（判据并存，不是二选一）。
  const t8 = await closedCard('明确没做小节', { verdict: '复核通过。' })
  await addComment(ws, t8, [
    '### 明确没做（留给下一轮，理由在手）',
    '1. **客户端那几个 minor**：都在 `src/client/*`，是别人正在动的文件，我没碰。',
    '2. **m8 的一半**：只做了 tmp 清理，没加 fsync。',
    '',
    '### 请审核人看三点',
    '1. 这件事我明确没做。',
  ].join('\n'), 'dsh')
  const t8Tails = (await openTails()).filter((tail) => tail.task_id === t8)
  const t8Section = t8Tails.filter((tail) => tail.rules.includes('not-done'))
  const t8Head = t8Section.find((tail) => tail.snippet.includes('明确没做'))
  assert.ok(t8Head, '「明确没做」标题要列出来')
  assert.ok(t8Head.rules.includes('deferral'), '标题上原有的判据（留给下一轮）不许被顶掉')
  assert.equal(
    t8Section.filter((tail) => /^\d+\./.test(tail.snippet)).length,
    2,
    '标题下的 2 条逐条列出来',
  )
  assert.ok(
    !t8Tails.some((tail) => tail.snippet.includes('这件事我明确没做')),
    '「请审核人看三点」那一节的正文不许被牵连',
  )
}
ok('「明确没做 / 没做的部分与原因」：标题与标题下的条目逐条列出（正文里的"没做"不算）')

{
  // 别名：dsh ≡ dsh-agent。少了名册判断，dsh-agent 写的交付说明会被当成"别人
  // 给的复核意见"（真实数据：T-3 一篇审计报告一个人刷出 29 条）。
  const id = await closedCard('别名判定', { verdict: '复核通过。' })
  await addComment(ws, id, '建议给会话级身份留个位。', 'dsh-agent')
  const tails = (await openTails()).filter((tail) => tail.task_id === id && tail.source.kind === 'comment')
  assert.equal(tails.length, 0, 'dsh-agent 就是 dsh（别名）⇒ 他的交付说明不算复核意见')
}
ok('名册别名生效：dsh-agent 的留言按"作者自己"对待')

{
  // 调用点**总是**注入名册版判断，且外部改不掉它 —— 这是防"忘了注入"的护栏：
  // 一旦某天有人从别处调用扫描器而没给名册，T-3 那种一篇审计报告刷 29 条的
  // 误报会立刻回来。这里传一个"谁都不同"的判断，别名仍然要被认出来。
  const aliasId = await closedCard('名册注入', { verdict: '复核通过。' })
  await addComment(ws, aliasId, '交付说明：建议给会话标识留个位，请复核这一笔。', 'dsh-agent')
  const forced = await openTails({ tails: { sameActor: () => false } })
  assert.ok(
    !forced.some((tail) => tail.task_id === aliasId && tail.source.kind === 'comment'),
    'health() 一律用名册版判断，外部传进来的 sameActor 覆盖不掉',
  )
}
ok('别名判断由调用点强制注入（boardHealth 不接受外部替换）')

// ------------------------------------------------------------ 收口 + 持久化
{
  const id = await closedCard('收口样本', { verdict: '请确认这条别掉地上。' })
  const before = await openTails()
  const target = before.find((tail) => tail.task_id === id)
  assert.ok(target, '样本尾巴先要被扫出来')

  // 落卡：卡号必须真实存在
  const bad = await cliFails('tails', '--file', target.id, '--card', 'T-999')
  assert.match(String(bad.stderr), /no such card/)
  const noCard = await cliFails('tails', '--file', target.id)
  assert.match(String(noCard.stderr), /--card/)
  // 作废：理由必填
  const noReason = await cliFails('tails', '--waive', target.id)
  assert.match(String(noReason.stderr), /--reason/)

  const holder = await createTask(ws, { title: '承接尾巴的卡' }, 'dsh')
  const filed = await cli('tails', '--file', target.id, '--card', holder.id)
  assert.match(filed, /已落卡/)

  const afterFile = await openTails()
  assert.ok(!afterFile.some((tail) => tail.id === target.id), '已落卡的尾巴不再出现在未收口清单里')

  const board = await loadBoard(ws)
  assert.equal(board.tails[target.id].status, 'filed', '收口记录落在板文件的新字段里')
  assert.equal(board.tails[target.id].card, holder.id)
  assert.equal(board.tails[target.id].by, 'dsh')
  assert.ok(board.tails[target.id].at, '收口记录带时间戳')

  // 撤掉收口 ⇒ 它又回到未收口清单（收口错了可以退回来）
  const reset = await cli('tails', '--reset', target.id)
  assert.match(reset, /已清除/)
  assert.ok((await openTails()).some((tail) => tail.id === target.id), 'reset 之后重新回到未收口清单')

  // 作废
  const waived = await cli('tails', '--waive', target.id, '--reason', '与 T-9 重复，不再跟踪')
  assert.match(waived, /已作废/)
  const board2 = await loadBoard(ws)
  assert.equal(board2.tails[target.id].status, 'waived')
  assert.equal(board2.tails[target.id].card, null)
  assert.equal(board2.tails[target.id].reason, '与 T-9 重复，不再跟踪')
  assert.ok(!(await openTails()).some((tail) => tail.id === target.id), '作废之后也不再列')
}
ok('落卡 / 作废 / 撤销三种收口都能持久化，且已收口的不再列出来')

{
  // 收口记录变孤儿（判据或原文变过）不许静默吞掉。
  const board = await loadBoard(ws)
  board.tails['T-1#log:99:0'] = { status: 'filed', card: null, reason: null, by: 'dsh', at: new Date().toISOString() }
  await saveBoard(ws, board)
  const result = await health(ws, {})
  assert.deepEqual(result.reviewTailOrphans, ['T-1#log:99:0'])
  const out = await cli('tails')
  assert.match(out, /对不上任何尾巴/)
  await cli('tails', '--reset', 'T-1#log:99:0')
  assert.deepEqual((await health(ws, {})).reviewTailOrphans, [], '孤儿的收口记录可以被清掉')
}
ok('收口记录变成孤儿时会被报告出来（可 reset 清掉），不静默')

// ------------------------------------------------------------------- inbox
{
  const id = await closedCard('inbox 归属样本', { verdict: '请确认这条别掉地上。' })
  const mine = await inbox(ws, 'kimi', { poolLimit: 0, tailLimit: 999 })
  assert.ok(mine.some((item) => item.kind === 'review_tail' && item.task.id === id), '写过这条复核的人看得到')
  const owner = await inbox(ws, 'dsh', { poolLimit: 0, tailLimit: 999 })
  assert.ok(owner.some((item) => item.kind === 'review_tail' && item.task.id === id), '卡主也看得到（他欠一次收口）')
  const theirs = await inbox(ws, 'nobody-here', { poolLimit: 0, tailLimit: 0 })
  assert.ok(!theirs.some((item) => item.kind === 'review_tail'), '与此无关的人不被推')

  const capped = await inbox(ws, 'kimi', { poolLimit: 0, tailLimit: 1 })
  const tailItems = capped.filter((item) => item.kind === 'review_tail')
  assert.equal(tailItems.length, 1, 'tailLimit 生效：inbox 是点名清单，不是报告')
  assert.match(tailItems[0].suggest, /同类还有 \d+ 条/, '被截掉的条数要说出来，别静默')
  assert.match(tailItems[0].suggest, /taskboard tails --file /, '每条都要带能直接敲的收口命令')
  assert.equal(tailItems[0].task.id, (await openTails())[0].task_id, '截取时先给最老的（最可能已经烂了）')

  const none = await inbox(ws, 'kimi', { poolLimit: 0, includeReviewTails: false })
  assert.ok(!none.some((item) => item.kind === 'review_tail'), 'includeReviewTails:false 可以关掉')
}
ok('inbox 推给相关责任人（卡主 / 复核人），带上限与"还有 N 条"，且可关')

// ------------------------------------------------------------------- stale
{
  const result = await health(ws, {})
  assert.ok(Array.isArray(result.reviewTails), 'boardHealth 带出复核尾巴')
  assert.ok(result.reviewTails.length > 0)
  // 尾巴挂在 closed 卡上，而那些卡不会出现在别的自检里 —— 这正是它们静默的原因。
  const closedIds = new Set((await listTasks(ws, { status: 'closed' })).map((task) => task.id))
  assert.ok(result.reviewTails.every((tail) => closedIds.has(tail.task_id) || tail.task_status === 'done'))
}
ok('boardHealth 的复核尾巴挂在 closed / done 卡上（别的自检看不到那里）')

{
  // 为了让浏览器 bundle 不带扫描器，`waitingOnHuman` 不再走 boardHealth（那条路
  // 会把整个扫描器拖进客户端）。代价是同一派生写了两遍 —— 这条等价断言就是那个
  // 代价的护栏：两边只要漂开就红。
  const now = Date.now()
  const board = await loadBoard(ws)
  const direct = lib.waitingOnHuman(board, now)
  const viaHealth = lib.boardHealth(board, { now }).waitingHuman
  assert.deepEqual(
    direct.map((issue) => [issue.task.id, issue.actor, issue.ageMs, issue.detail]),
    viaHealth.map((issue) => [issue.task.id, issue.actor, issue.ageMs, issue.detail]),
    'waitingOnHuman 与 boardHealth().waitingHuman 必须是同一条派生',
  )
}
ok('waitingOnHuman 与 boardHealth().waitingHuman 等价（重复实现的护栏）')

// --------------------------------------------------------------- 兼容旧板
{
  const raw = JSON.parse(await readFile(boardFilePath(ws), 'utf8'))
  assert.ok(raw.tails && Object.keys(raw.tails).length > 0, '新字段确实写进了板文件')
  const ids = Object.keys(raw.tails)
  delete raw.tails
  await writeFile(boardFilePath(ws), `${JSON.stringify(raw, null, 2)}\n`)
  const result = await health(ws, {}) // 不许抛
  assert.ok(result.reviewTails.length > 0, '没有 tails 字段的旧板照样能扫（读到的是空收口表）')
  assert.deepEqual(result.reviewTailOrphans, [])
  raw.tails = Object.fromEntries(ids.map((id) => [id, { status: 'waived', card: null, reason: '测试用', by: 'dsh', at: new Date().toISOString() }]))
  await writeFile(boardFilePath(ws), `${JSON.stringify(raw, null, 2)}\n`)
}
ok('向后兼容：没有 tails 字段的旧板照常扫（读端容忍缺失）')

// ------------------------------------------------------------------- CLI
{
  const text = await cli('tails')
  assert.match(text, /复核尾巴：\d+ 条未收口/)
  const json = JSON.parse(await cli('tails', '--json'))
  assert.ok(json.stats.tails >= json.stats.open, 'stats 自洽')
  assert.ok(Array.isArray(json.tails) && json.tails.length > 0)
  assert.ok(json.tails[0].rules.length > 0 && json.tails[0].reasons.length > 0)
  assert.ok(Number.isInteger(json.tails[0].offset), 'JSON 里带原文偏移，便于回原文核对')
  assert.ok(Array.isArray(json.tails[0].responsibles))

  const all = JSON.parse(await cli('tails', '--all', '--json'))
  assert.ok(all.stats.filed + all.stats.waived > 0, '--all 能看到已收口的')
  assert.ok(all.tails.some((tail) => tail.settlement), '--all 的每条带 settlement')

  const stale = await cli('stale')
  assert.match(stale, /复核尾巴/, 'stale 里有独立一节')
  const staleJson = JSON.parse(await cli('stale', '--json'))
  assert.ok(Array.isArray(staleJson.review_tails), 'stale --json 带 review_tails')
  assert.ok(staleJson.orphaned && Array.isArray(staleJson.orphaned), '既有键一个不少')

  const unknown = await cliFails('tails', '--nope', 'x')
  assert.match(String(unknown.stderr), /unknown flag/)
}
ok('CLI：tails / --all / --json / stale 一节 / 未知 flag 依旧报错')

await rm(ws, { recursive: true, force: true })
console.log(`\nall review-tail checks passed (${checks} checks)`)
