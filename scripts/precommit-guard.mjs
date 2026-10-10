#!/usr/bin/env node
/**
 * 提交前守卫（T-79）—— 把两起真实事故变成机制，而不是注意事项。
 *
 * ## 它拦的是哪两起
 *
 * **事故 ①（构建退出码被吞）**：跑变异实验时 `npm run build` 失败，`lib/` 从未被替换，
 * 测试跑的是**旧代码**，据此在提交信息里写下了一个不可复现的断言 ✗。
 * ⇒ 守卫 1 的第一条：**构建必须检查退出码**，失败即拒绝。
 *
 * **事故 ②（提交内部自相矛盾）**：在别人**正在改同一个工作区**时提交 ⇒ 一个提交里
 * `src/` 是 T-77 的、`lib/` 还是 T-75 的构建 ⇒ 谁从这个提交打包，就发出去一份
 * 「行为 ≠ 源码」的产物 ✗。
 * ⇒ 守卫 1 的第二条（源码↔产物一致）+ 守卫 2（有人在写时不许提交）。
 *
 * ## ⚠️ 一致性判据的**方向**（PO 手工跑守卫时栽在这，这是本卡最值钱的一条）
 *
 * **错的**：`build` ⇒ 断言 `git diff --exit-code -- lib/` 为空 ✗
 *   —— `git diff` 比的是**工作区 vs 索引/HEAD**，而 `lib/` 此时**本来就是待提交的改动**
 *   ⇒ **必然非空** ⇒ 假红 ✗（而且假红会训练人绕过它 ✗）。
 * **对的**：判据是「**build 没有产生新的改动**」：
 *   `构建前的工作区 lib/` ≡ `构建后的工作区 lib/`（内容哈希，逐字节）
 *   并且——**当 lib/ 已有暂存内容时**——还要 `git diff --exit-code -- lib/` 为空
 *   （工作区 = 索引 ⇒ 提交里那份 blob 就是刚构建出来的那份，而不是"手一抖先 add 了旧产物"）。
 * 这直接对上「产物 = 这份源码的构建」，而且**在"有未提交改动"的正常状态下是绿的** ✓
 * （方向用例见 tests/precommit-guard.test.mjs）。
 *
 * ## 它必须真的阻断
 *
 * 失败 ⇒ **非零退出**（2/3/4）⇒ `scripts/guarded-commit.sh` **不执行 commit** ✓。
 * "打印一句警告然后照旧提交"是本卡明确要消灭的东西 ✗ —— 有测试证明「守卫红时 git log 不增长」✓。
 *
 * 用法：
 *   node scripts/precommit-guard.mjs [--cwd DIR] [--build-cmd "npm run build"] [--settle-ms 5000] [--json]
 * 退出码：
 *   0 = 通过 · 2 = 检测到有人正在写 · 3 = 构建失败 · 4 = 源码与产物不一致 · 1 = 守卫自身出错
 *
 * @module dsh-taskboard-kit/precommit-guard
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 退出码（调用方按它决定要不要提交）。 */
export const EXIT = { ok: 0, usage: 1, writer: 2, build: 3, drift: 4 }

/**
 * 一棵目录树的内容指纹：逐字节（路径 + 内容），与 mtime 无关。
 *
 * 为什么不用 mtime/size：`touch` 会改 mtime 而不改内容（写入守卫自己就 touch 文件），
 * 而"内容一样但 mtime 变了"**不是**不一致 —— 用 mtime 判会假红。反过来，
 * 只用 size 会漏掉"同样长度、不同内容"。
 *
 * @param {string} dir 目录
 * @returns {string} sha256 十六进制；目录不存在 ⇒ 空树的哈希（不是 undefined，便于比较）
 */
export function hashTree(dir) {
  const files = []
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  try {
    walk(dir)
  } catch {
    return createHash('sha256').update('missing').digest('hex')
  }
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(dir, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * 守卫 1 的**判据**（纯函数，可单测、可注入）。
 *
 * @param {{ buildOk: boolean, before: string, after: string, indexMatchesWorktree: boolean }} input
 * @returns {{ ok: boolean, code: number, reason: string }}
 */
export function decideConsistency({ buildOk, before, after, indexMatchesWorktree }) {
  if (!buildOk) {
    return { ok: false, code: EXIT.build, reason: '构建失败（退出码非 0）—— lib/ 很可能没被替换，绝不能提交' }
  }
  if (before !== after) {
    return {
      ok: false,
      code: EXIT.drift,
      reason: '构建产生了新的改动 ⇒ 提交里的 lib/ 不是这份源码构建的（先 build 再提交，别提交陈产物）',
    }
  }
  // ⚠️ 这一条必须**总是**成立、而且只能与**索引**比（不是 HEAD ✗）：
  //   · commit 提交的是**索引**，所以"索引里的 lib/ = 刚构建出来的 lib/"才是要守的东西；
  //   · 与 HEAD 比会**假红**（lib/ 本身就是待提交的改动 ⇒ 必然非空 ✗，PO 手工跑守卫就栽在这）；
  //   · 而"工作区 ≠ 索引"在提交时刻是**真的**问题：commit 出去的是索引里那份旧产物 ✗
  //     （正是事故②的产物面：`git add -A` 时 lib 还是旧的，随后才 rebuild）。
  if (!indexMatchesWorktree) {
    return {
      ok: false,
      code: EXIT.drift,
      reason: '暂存区里的 lib/ 与刚构建出来的不一样（常见原因：git add 时 lib 还是旧的，之后才 rebuild）⇒ 提交出去的会是旧的那份',
    }
  }
  return { ok: true, code: EXIT.ok, reason: '源码与产物一致（构建是幂等的，且暂存的产物 = 刚构建的那份）' }
}

/**
 * 守卫 2 的**判据**（纯函数）：两次 `git status --porcelain` 必须逐字节相同。
 *
 * 判据选的是"两次采样是否一致"，而不是"有没有未提交改动" —— 后者在有改动的正常
 * 状态下永远为真，会把守卫变成噪声（同 T-79 那条方向教训）。
 *
 * @param {{ first: string, second: string }} input
 * @returns {{ ok: boolean, code: number, reason: string }}
 */
export function decideWriter({ first, second }) {
  if (first !== second) {
    return { ok: false, code: EXIT.writer, reason: '工作区在两次采样之间被改写了（有人正在写）⇒ 拒绝提交' }
  }
  return { ok: true, code: EXIT.ok, reason: '两次采样一致：没有并发写入' }
}

/**
 * **被跟踪文件的内容指纹**（T-79，比 `git status --porcelain` 更强的那一半）。
 *
 * ⚠️ 为什么不能只用 `git status --porcelain`：它的输出只回答"**哪些**文件与索引不同"。
 * 一个**已经处于修改态**的文件被继续追加内容时，porcelain 输出**一个字节都不变**
 * （` M src/a.ts` 还是 ` M src/a.ts`）⇒ 只用 porcelain 的写入守卫**根本拦不住事故②**：
 * 当时实现者正在改的 `src/client/BoardPanel.tsx` 本来就是"已修改"状态 ✗。
 * ⇒ 所以采样 = porcelain（增删改文件名）+ **被跟踪文件的内容哈希**（内容churn）✓。
 *
 * @param {string} cwd 仓库根
 * @returns {string} sha256
 */
export function hashTracked(cwd) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
  if (listed.status !== 0) return 'no-git'
  const hash = createHash('sha256')
  for (const rel of String(listed.stdout ?? '').split('\0').filter(Boolean).sort()) {
    hash.update(rel)
    hash.update('\0')
    try {
      hash.update(readFileSync(join(cwd, rel)))
    } catch {
      hash.update('(unreadable)')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** 解析 `--flag value` / `--flag`。 */
function parseArgs(argv) {
  const out = { cwd: process.cwd(), buildCmd: 'npm run build', settleMs: 5000, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--build-cmd') out.buildCmd = argv[++i]
    else if (a === '--settle-ms') out.settleMs = Number(argv[++i])
    else if (a === '--help') out.help = true
  }
  return out
}

/**
 * 跑守卫（I/O 都在这里；判据在上面两个纯函数里）。
 *
 * @param {{ cwd: string, buildCmd: string, settleMs: number, now?: () => number, sleep?: (ms: number) => void, json?: boolean }} options
 * @returns {{ ok: boolean, code: number, steps: { step: string, ok: boolean, detail: string }[] }}
 */
export function runGuard({ cwd, buildCmd, settleMs, json = false, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), log = console.log }) {
  const steps = []
  const record = (step, ok, detail) => {
    steps.push({ step, ok, detail })
    if (!json) log(`  [${ok ? 'ok' : 'RED'}] ${step}: ${detail}`)
    return ok
  }
  const gitStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
  // 两次采样都要同一把尺：porcelain（谁被改了）+ 内容哈希（改了**多少**）。
  const sample = () => JSON.stringify({ porcelain: gitStatus(), tracked: hashTracked(cwd) })
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' })

  if (!json) log('precommit guard (T-79):')
  // ---- 守卫 2：有人在写吗（两次采样）--------------------------------------
  const first = sample()
  sleep(settleMs)
  const second = sample()
  const writer = decideWriter({ first, second })
  record('写入守卫（两次采样 = git status --porcelain + 被跟踪文件内容哈希，间隔 ' + settleMs + 'ms）', writer.ok, writer.reason)
  if (!writer.ok) return { ok: false, code: writer.code, steps }

  // ---- 守卫 1：源码 ↔ 产物 -------------------------------------------------
  const libDir = join(cwd, 'lib')
  const before = hashTree(libDir)
  const build = spawnSync(buildCmd, { cwd, shell: true, encoding: 'utf8' })
  const buildOk = build.status === 0
  if (!buildOk) {
    const tail = String(build.stderr ?? build.stdout ?? '').trim().split('\n').slice(-3).join(' / ')
    record('构建退出码', false, `exit=${build.status}${tail ? ' · ' + tail : ''}`)
    return { ok: false, code: EXIT.build, steps }
  }
  record('构建退出码', true, 'exit=0')
  const after = hashTree(libDir)

  // 守卫跑在 `git add` **之后**：提交的是索引，所以要比"工作区 vs 索引"。
  // （与 HEAD 比是错的方向 —— lib/ 作为待提交改动必然非空 ⇒ 假红 ✗。）
  const unstagedLib = (git(['diff', '--name-only', '--', 'lib/']).stdout ?? '').trim()
  const indexMatchesWorktree = unstagedLib.length === 0
  record('工作区 lib/ = 索引 lib/', indexMatchesWorktree, indexMatchesWorktree
    ? '一致（提交里那份就是刚构建的那份）'
    : `不一致：${unstagedLib.split('\n').join(', ')} —— 先 git add 再提交`)

  const verdict = decideConsistency({ buildOk: true, before, after, indexMatchesWorktree })
  record('源码 ↔ 产物一致', verdict.ok, verdict.reason)
  return { ok: verdict.ok, code: verdict.code, steps }
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/precommit-guard.mjs [--cwd DIR] [--build-cmd CMD] [--settle-ms MS] [--json]')
    process.exit(EXIT.ok)
  }
  try {
    const result = runGuard(args)
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else console.log(result.ok ? '✅ 守卫通过 —— 可以提交' : `⛔ 守卫拒绝提交（exit ${result.code}）`)
    process.exit(result.code)
  } catch (error) {
    console.error(`守卫自身出错（不是判定结果，请修守卫）：${error?.message ?? error}`)
    process.exit(EXIT.usage)
  }
}
