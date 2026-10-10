/**
 * T-79 —— 提交前守卫的回归测试。
 *
 * 这个文件的重点不是"函数返回 false"，而是**守卫真的阻止了提交**：
 * 事故的形态是"守卫红了也照样 commit" ✗（PO 手工跑守卫时，断言写在 `||` 分支里
 * 只打印警告，`set -e` 被处理掉 ⇒ 提交照旧发生）。所以：
 *
 *   · 判据本身用注入的假副作用做单测（快、确定、可枚举边界）；
 *   · **阻断性**用真 git 仓库 + 真 `guarded-commit.sh` 端到端验 —— 量的是
 *     `git log` 的**行数有没有增长**（能证伪的观察量，不是"我以为它退出了"）。
 *
 * 两起真实事故各有一条用例（卡面「验收」要求把它们当回归用例）：
 *   事故①：build 失败 / 退出码被吞 ⇒ lib 没被替换 ⇒ 必须红
 *   事故②：别人正在写同一工作区 ⇒ 必须红；且"提交内部 src 与 lib 矛盾"必须拦得住
 *
 * Run: node tests/precommit-guard.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, chmodSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from 'node:process'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const GUARD = join(REPO, 'scripts', 'precommit-guard.mjs')
const COMMIT = join(REPO, 'scripts', 'guarded-commit.sh')
const { EXIT, decideConsistency, decideWriter, decideIndex, hashTree, hashTracked, runGuard } = await import('../scripts/precommit-guard.mjs')
const { install, uninstall, status, HOOKS_DIR } = await import('../scripts/hooks.mjs')
const npmScript = (name) => JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts[name]

let failed = 0
// ⚠️ 必须 await：T-82 起有用例要给后台写进程留时间（async）——
// 不 await 的话断言会在别的用例之后才跑，失败会变成未处理的 rejection（假绿/乱序）✗
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

console.log('dsh-taskboard-kit precommit guard test:')

// ---------------------------------------------------------------- 判据单测
await check('T-79 · 一致性判据的**方向**：有未提交改动（但构建幂等）必须**绿**，不许假红', () => {
  // 这正是 PO 手工跑守卫时栽的那条 ✗ —— 判据如果是"工作区与 HEAD 无差异"，
  // 那么 lib/ 作为**待提交的改动**必然让守卫报红 ⇒ 假红 ⇒ 训练人绕过它。
  // 正确判据 = 「build 没有产生新的改动」。
  const same = 'abc'
  const verdict = decideConsistency({ buildOk: true, before: same, after: same, indexMatchesWorktree: true })
  assert.equal(verdict.ok, true, `有未提交改动（已 add）+ 构建幂等 ⇒ 绿：${verdict.reason}`)
  // 反过来：同样"有未提交改动"，但构建**改了** lib/ ⇒ 红（陈产物）
  const drift = decideConsistency({ buildOk: true, before: 'abc', after: 'def', indexMatchesWorktree: true })
  assert.equal(drift.ok, false)
  assert.equal(drift.code, EXIT.drift)
  assert.match(drift.reason, /构建产生了新的改动/)
})

await check('T-79 · 事故①：构建失败（退出码非 0）必须红 —— lib/ 没被替换就等于在提交旧代码', () => {
  const v = decideConsistency({ buildOk: false, before: 'abc', after: 'abc', indexMatchesWorktree: true })
  assert.equal(v.ok, false, '构建失败绝不能算通过')
  assert.equal(v.code, EXIT.build)
  assert.match(v.reason, /构建失败/)
})

await check('T-79 · ★暂存了旧产物（add 完又 rebuild）必须红 —— commit 提交的是**索引**里那份', () => {
  const v = decideConsistency({ buildOk: true, before: 'same', after: 'same', indexMatchesWorktree: false })
  assert.equal(v.ok, false)
  assert.equal(v.code, EXIT.drift)
  assert.match(v.reason, /暂存区里的 lib\//)
  // 这条**不看** lib/ 相对 HEAD 有没有改动（看了就会假红）：判据只问"工作区 = 索引吗"。
  assert.equal(decideConsistency({ buildOk: true, before: 'same', after: 'same', indexMatchesWorktree: true }).ok, true)
})

await check('T-79 · 事故②：两次采样不一致（有人在写）必须红', () => {
  assert.equal(decideWriter({ first: ' M src/a.ts\n', second: ' M src/a.ts\n M src/b.ts\n' }).ok, false)
  assert.equal(decideWriter({ first: ' M src/a.ts\n', second: ' M src/a.ts\n' }).ok, true)
  // 采样内容为空（干净工作区）也一致 ⇒ 绿：判据是"两次是否相同"，不是"有没有改动"。
  assert.equal(decideWriter({ first: '', second: '' }).ok, true)
})

await check('T-79 · 树指纹按**内容**算：touch 不算改动，改一个字节才算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb79-hash-'))
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'a.js'), 'AAA')
    const first = hashTree(join(dir, 'lib'))
    // mtime 变了、内容没变 ⇒ 指纹必须相同（否则写入守卫自己 touch 一下就会假红）
    execFileSync('touch', [join(dir, 'lib', 'a.js')])
    assert.equal(hashTree(join(dir, 'lib')), first, 'touch 不算改动')
    writeFileSync(join(dir, 'lib', 'a.js'), 'AAB')
    assert.notEqual(hashTree(join(dir, 'lib')), first, '改一个字节就算改动')
    // 同样长度、不同内容也要能分辨（只比 size 会漏）
    writeFileSync(join(dir, 'lib', 'a.js'), 'ZZZ')
    assert.notEqual(hashTree(join(dir, 'lib')), first)
    // 目录不存在 = 空树，不抛
    assert.equal(typeof hashTree(join(dir, 'nope')), 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('T-79 · ★判据自身：**只用 porcelain 会漏掉事故②**（它是本卡最值钱的一条修正）', () => {
  const repo = makeRepo()
  try {
    // 先把 src/a.txt 弄成"已修改"状态（事故②当时 BoardPanel.tsx 就处在这个状态）
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    const beforePorcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo.dir, encoding: 'utf8' })
    const beforeHash = hashTracked(repo.dir)
    // 模拟"另一个 agent 继续写同一个已经改过的文件"
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2-plus-more-edits')
    const afterPorcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo.dir, encoding: 'utf8' })
    const afterHash = hashTracked(repo.dir)

    assert.equal(afterPorcelain, beforePorcelain, 'porcelain **看不出来**：同一个文件继续被写，输出一字不变 ⇒ 只用它的守卫拦不住事故②')
    assert.notEqual(afterHash, beforeHash, '内容哈希看得出来 ⇒ 采样必须带上它')
    assert.equal(decideWriter({ first: beforePorcelain, second: afterPorcelain }).ok, true, '（只用 porcelain 的判据在这里会误判为"没人写"）')
    assert.equal(decideWriter({ first: beforeHash, second: afterHash }).ok, false, '带上内容哈希才判得对')
  } finally {
    repo.cleanup()
  }
})

// ------------------------------------------------- 端到端：守卫必须真的阻断
/** 造一个真 git 仓库（有自己的 src/lib 与一个可控的"构建"）。 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tb79-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't79@example.test')
  git('config', 'user.name', 'T79')
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.txt'), 'v1')
  writeFileSync(join(dir, 'lib', 'a.js'), 'built:v1')
  // hook 的契约：**这个仓自己提供 `check:commit`**（hook 里只写 `npm run check:commit`，
  // 这样它会用这个仓自己的构建/守卫配置，而不是硬编码某台机器上的路径）。
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 't82-fixture', private: true,
    scripts: { 'check:commit': `node ${JSON.stringify(GUARD)} --cwd . --build-cmd "node build.mjs" --settle-ms 120` },
  }, null, 2))
  // 「构建」= 把 src 的内容抄进 lib（等价于 esbuild 的产物关系），失败可控
  writeFileSync(join(dir, 'build.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs'
    if (process.env.BUILD_FAIL === '1') { console.error('boom'); process.exit(1) }
    writeFileSync('lib/a.js', 'built:' + readFileSync('src/a.txt', 'utf8'))
  `)
  // 像一次真实克隆那样：**静态 hook 文件本来就在版本库里**（T-82 打回后的契约）
  mkdirSync(join(dir, '.githooks'), { recursive: true })
  writeFileSync(join(dir, '.githooks', 'pre-commit'), readFileSync(join(REPO, '.githooks', 'pre-commit'), 'utf8'))
  chmodSync(join(dir, '.githooks', 'pre-commit'), 0o644) // 故意不带执行位 ⇒ 安装器要把它补回来
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const logLen = (dir) => execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
const runGuardCli = (dir, extra = {}) =>
  spawnSync('node', [GUARD, '--cwd', dir, '--build-cmd', 'node build.mjs', '--settle-ms', '120'], {
    encoding: 'utf8',
    env: { ...process.env, ...extra },
  })

await check('T-79 · ★阻断用例：守卫红 ⇒ **提交没有发生**（git log 不增长，不是"函数返回 false"）', () => {
  const repo = makeRepo()
  try {
    // 构造真不一致：改了 src 但不重建 ⇒ 提交里的 lib/ 不是这份源码的构建
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    repo.git('add', '-A')
    const before = logLen(repo.dir)

    const guard = runGuardCli(repo.dir)
    assert.notEqual(guard.status, 0, `守卫必须非零退出（实际 ${guard.status}）`)
    assert.equal(guard.status, EXIT.drift, `这一格应当是「不一致」：${guard.stdout}`)

    // 走**真正的提交入口**：守卫红 ⇒ commit 那一步根本不该被执行
    const commit = spawnSync('bash', [COMMIT, '-m', 'should not happen'], {
      cwd: repo.dir, encoding: 'utf8', env: { ...process.env, GUARD_BUILD_CMD: 'node build.mjs', GUARD_SETTLE_MS: '120' },
    })
    assert.notEqual(commit.status, 0, 'guarded-commit 必须非零退出')
    assert.equal(logLen(repo.dir), before, '★ 守卫红的时候，提交不能发生（git log 必须没增长）')
    // 注意：守卫**会跑构建**（那是它的第一条检查），所以 lib/ 被重建成 v2 是正常的 ✓ ——
    // 它拦的是"提交"，不是"构建"。这条断言故意留在这里说明这一点。
    assert.equal(readFileSync(join(repo.dir, 'lib', 'a.js'), 'utf8'), 'built:v2', '守卫跑了构建（本来就会），但没提交')
  } finally {
    repo.cleanup()
  }
})

await check('T-79 · 事故①回归：构建失败 ⇒ 守卫红，且**没有提交**', () => {
  const repo = makeRepo()
  try {
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    repo.git('add', '-A')
    const before = logLen(repo.dir)
    const guard = runGuardCli(repo.dir, { BUILD_FAIL: '1' })
    assert.equal(guard.status, EXIT.build, `构建失败应当是 exit ${EXIT.build}：${guard.stdout}`)
    assert.match(guard.stdout, /构建退出码/)
    const commit = spawnSync('bash', [COMMIT, '-m', 'nope'], {
      cwd: repo.dir, encoding: 'utf8', env: { ...process.env, GUARD_BUILD_CMD: 'node build.mjs', BUILD_FAIL: '1' },
    })
    assert.notEqual(commit.status, 0)
    assert.equal(logLen(repo.dir), before, '★ 构建失败时提交也不能发生')
  } finally {
    repo.cleanup()
  }
})

await check('T-79 · 事故②回归：有人在写（两次采样不一致）⇒ 守卫红，且没有提交', async () => {
  const repo = makeRepo()
  try {
    const before = logLen(repo.dir)
    // 先暂存一次（否则会先撞上 T-82 的"索引为空"那条，测不到写入守卫）
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2-seeded')
    repo.git('add', '-A')
    // 起一个**并发**的写入进程：每 60ms 改一次工作区（比守卫 120ms 的采样间隔勤）。
    // 用 spawn（不是 spawnSync）—— 同步跑等于等它写完再采样，永远采不到"正在写" ✗。
    const writer = spawn('bash', ['-c', 'for i in $(seq 1 40); do echo "w$i" >> src/a.txt; sleep 0.06; done'], { cwd: repo.dir, stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 150))
    const guard = runGuardCli(repo.dir) // settle 120ms ⇒ 两次采样之间必然有人在写
    writer.kill('SIGKILL')
    assert.equal(guard.status, EXIT.writer, `写入守卫应当 exit ${EXIT.writer}：${guard.stdout}`)
    assert.match(guard.stdout, /工作区在两次采样之间被改写了/)
    const commit = spawnSync('bash', [COMMIT, '-m', 'nope'], {
      cwd: repo.dir, encoding: 'utf8', env: { ...process.env, GUARD_BUILD_CMD: 'node build.mjs', GUARD_SETTLE_MS: '120' },
    })
    assert.notEqual(commit.status, 0)
    assert.equal(logLen(repo.dir), before, '★ 有人在写时提交不能发生')
  } finally {
    repo.cleanup()
  }
})

await check('T-79 · 正常路径：先构建 + 无人并发写 ⇒ 守卫绿，且提交**真的发生**（否则守卫会被绕过）', () => {
  const repo = makeRepo()
  try {
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    execFileSync('node', ['build.mjs'], { cwd: repo.dir }) // 先 build（与它自己的产物关系一致）
    repo.git('add', '-A')
    const before = logLen(repo.dir)

    const guard = runGuardCli(repo.dir)
    assert.equal(guard.status, EXIT.ok, `正常路径必须绿：${guard.stdout}`)

    const commit = spawnSync('bash', [COMMIT, '-m', 'chore: 正常路径'], {
      cwd: repo.dir, encoding: 'utf8', env: { ...process.env, GUARD_BUILD_CMD: 'node build.mjs', GUARD_SETTLE_MS: '120' },
    })
    assert.equal(commit.status, 0, `守卫通过时提交应当成功：${commit.stderr}`)
    assert.equal(logLen(repo.dir), before + 1, '★ 守卫通过时提交要真的发生（绿的时候它必须让路）')
  } finally {
    repo.cleanup()
  }
})

await check('T-79 · 反例：把断言写进 `||` 分支只打印警告 ⇒ 提交照旧发生（这是本卡要消灭的形态）', () => {
  const repo = makeRepo()
  try {
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    repo.git('add', '-A')
    const before = logLen(repo.dir)
    // 一个"看着像守卫、其实不阻断"的脚本：红着也提交
    writeFileSync(join(repo.dir, 'fake-guard.sh'), `
      set -e
      node ${JSON.stringify(GUARD)} --cwd ${JSON.stringify(repo.dir)} --build-cmd "node build.mjs" --settle-ms 120 || echo "⚠️ 守卫报了红，仅提醒"
      git -C ${JSON.stringify(repo.dir)} commit -m "红着也提交"
    `)
    const out = spawnSync('bash', [join(repo.dir, 'fake-guard.sh')], { cwd: repo.dir, encoding: 'utf8' })
    assert.equal(out.status, 0)
    assert.equal(logLen(repo.dir), before + 1, '反例：不阻断的守卫**确实**会让提交发生 —— 这就是为什么必须有阻断用例')
  } finally {
    repo.cleanup()
  }
})

await check('T-79 · CLI 表面：--help / --json 可用；守卫把每一步都报出来（不做真构建）', () => {
  const help = spawnSync('node', [GUARD, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /precommit-guard/)

  // ⚠️ 这条**故意**不在真仓上跑 `npm run build`：
  //   ① 测试不该有"重建发布产物"的副作用；
  //   ② 断言"真仓此刻是绿的"会依赖开发者有没有 `git add` ⇒ 一个会随工作区状态飘的假失败 ✗。
  //   判据本身的可证伪性由上面那些临时仓库的用例负责。
  const repo = makeRepo()
  try {
    // 有东西可提交（否则先撞"索引为空"），而且要**先构建**再暂存 ——
    // 否则守卫会正确地报"产物不是这份源码的构建"，那就测不到"CLI 表面"这件事了。
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    execFileSync('node', ['build.mjs'], { cwd: repo.dir })
    repo.git('add', '-A')
    const result = runGuard({ cwd: repo.dir, buildCmd: 'node build.mjs', settleMs: 0, json: true, log: () => {}, sleep: () => {} })
    assert.equal(typeof result.ok, 'boolean')
    const steps = result.steps.map((s) => s.step)
    assert.ok(steps.some((s) => /写入守卫/.test(s)), '要报出写入守卫这一步')
    assert.ok(steps.some((s) => /构建退出码/.test(s)), '要报出构建退出码这一步')
    assert.ok(steps.some((s) => /源码 ↔ 产物一致/.test(s)), '要报出一致性这一步')
    assert.equal(result.ok, true, `临时仓里构建幂等 ⇒ 绿：${JSON.stringify(result.steps)}`)
    // --json 能机读，且带退出码
    assert.equal(result.code, EXIT.ok)
  } finally {
    repo.cleanup()
  }
})

// ------------------------------------------------- T-82：空索引 + 仓内 hook
await check('T-82 · 索引为空要说人话（你就是忘了 git add），而且**不执行提交**', () => {
  const repo = makeRepo()
  try {
    // 工作区有改动、但**没有 add** —— PO 2026-10-10 dogfood 时正是这个状态
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    const before = logLen(repo.dir)
    const guard = runGuardCli(repo.dir)
    assert.equal(guard.status, EXIT.emptyIndex, `空索引应当是 exit ${EXIT.emptyIndex}：${guard.stdout}`)
    assert.match(guard.stdout, /索引为空 ⇒ 你是不是忘了 `git add`/, '必须在守卫阶段就说清原因')
    assert.ok(!guard.stdout.includes('构建退出码'), '空索引要在**构建之前**拦住（fail fast，且不给工作区留副作用）')
    assert.ok(!guard.stdout.includes('写入守卫'), '空索引也比写入守卫先跑（最便宜的最先，不让人白等一次采样）')
    assert.equal(readFileSync(join(repo.dir, 'lib', 'a.js'), 'utf8'), 'built:v1', '没动过 lib/')

    const commit = spawnSync('bash', [COMMIT, '-m', 'nope'], {
      cwd: repo.dir, encoding: 'utf8', env: { ...process.env, GUARD_BUILD_CMD: 'node build.mjs', GUARD_SETTLE_MS: '120' },
    })
    assert.notEqual(commit.status, 0, '空索引时不能提交')
    assert.equal(logLen(repo.dir), before, '★ 空索引 ⇒ 提交没发生')
    // 纯空仓（连工作区也没改）时给另一句人话
    const repo2 = makeRepo()
    try {
      const g2 = runGuardCli(repo2.dir)
      assert.equal(g2.status, EXIT.emptyIndex)
      assert.match(g2.stdout, /没有东西可提交/, '工作区也干净时给"没有东西可提交"')
      assert.equal(decideIndex({ indexEmpty: false, dirty: true }).ok, true, '有暂存内容 ⇒ 绿')
    } finally {
      repo2.cleanup()
    }
  } finally {
    repo.cleanup()
  }
})

await check('T-82 · 仓内 hook：装上 ⇒ 守卫红时 **commit 被 git 拦下**（不是靠我们的脚本拦）', () => {
  const repo = makeRepo()
  try {
    install(repo.dir, { log: () => {} })
    // 装的是 repo-local，且 hook 文件可执行
    assert.equal(execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo.dir, encoding: 'utf8' }).trim(), HOOKS_DIR)
    const st = status(repo.dir)
    assert.equal(st.hookInstalled, true)

    // 构造真不一致：改 src 但不重建 ⇒ 守卫红
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v2')
    repo.git('add', '-A')
    const before = logLen(repo.dir)
    // 走**真 git commit**（hook 由 git 自己调用）—— 用 npm 脚本会绕开 hook 的语义
    const commit = spawnSync('git', ['commit', '-m', 'should be blocked by hook'], {
      cwd: repo.dir, encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH, GUARD_BUILD_CMD: 'node build.mjs' },
    })
    assert.notEqual(commit.status, 0, `hook 必须让 commit 失败：${commit.stdout}${commit.stderr}`)
    assert.equal(logLen(repo.dir), before, '★ 装了 hook 之后，守卫红 ⇒ git log 不增长')

    // 绿时必须放行：先按它自己的产物关系构建，再提交
    execFileSync('node', ['build.mjs'], { cwd: repo.dir })
    repo.git('add', '-A')
    const ok = spawnSync('git', ['commit', '-m', 'hook should let this through'], { cwd: repo.dir, encoding: 'utf8' })
    assert.equal(ok.status, 0, `绿时 hook 必须放行（否则它会被卸载）：${ok.stderr}`)
    assert.equal(logLen(repo.dir), before + 1, '★ 绿时提交要真的发生')

    // 逃生门：--no-verify 仍能提交
    writeFileSync(join(repo.dir, 'src', 'a.txt'), 'v3-stale') // 又是"改了没重建"的红状态
    repo.git('add', '-A')
    const beforeNoVerify = logLen(repo.dir)
    const bypass = spawnSync('git', ['commit', '--no-verify', '-m', 'emergency'], { cwd: repo.dir, encoding: 'utf8' })
    assert.equal(bypass.status, 0, `--no-verify 必须仍然可用：${bypass.stderr}`)
    assert.equal(logLen(repo.dir), beforeNoVerify + 1, '★ 逃生门可用（守卫防手滑，不防人）')
  } finally {
    repo.cleanup()
  }
})

await check('T-82 · ★装/卸都只碰 repo-local：`git config --global core.hooksPath` **前后不变**', () => {
  const globalBefore = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' })
  const globalValueBefore = globalBefore.status === 0 ? globalBefore.stdout.trim() : null

  const repo = makeRepo()
  try {
    // 先给这个仓设一个"用户自己的" hooksPath ⇒ 卸载必须**还原它**，而不是清掉
    execFileSync('git', ['config', '--local', 'core.hooksPath', 'my-own-hooks'], { cwd: repo.dir })
    install(repo.dir, { log: () => {} })
    assert.equal(execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo.dir, encoding: 'utf8' }).trim(), HOOKS_DIR)
    uninstall(repo.dir, { log: () => {} })
    assert.equal(
      execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo.dir, encoding: 'utf8' }).trim(),
      'my-own-hooks',
      '★ 卸载要把 core.hooksPath 还原成**安装前的原值**（先读原值再改）',
    )
    // 原本没设的情况 ⇒ 卸完应当"没有这一项"，而不是留空串
    const repo2 = makeRepo()
    try {
      install(repo2.dir, { log: () => {} })
      uninstall(repo2.dir, { log: () => {} })
      const after = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo2.dir, encoding: 'utf8' })
      assert.notEqual(after.status, 0, '原本没设 ⇒ 卸完应当查不到这一项')
    } finally {
      repo2.cleanup()
    }
  } finally {
    repo.cleanup()
  }

  const globalAfter = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' })
  const globalValueAfter = globalAfter.status === 0 ? globalAfter.stdout.trim() : null
  assert.equal(globalValueAfter, globalValueBefore, '★ 装/卸 hook 绝不能改全局配置（不会影响别的仓库）')
})

await check('T-82 · ★静态 hook 缺失时，安装器**大声报错**（不许悄悄替你生成一个）', () => {
  const repo = makeRepo()
  try {
    rmSync(join(repo.dir, '.githooks', 'pre-commit'))
    assert.throws(() => install(repo.dir, { log: () => {} }), /找不到 \.githooks\/pre-commit/)
    assert.ok(!existsSync(join(repo.dir, '.githooks', 'pre-commit')), '不许"顺手"把它造出来 —— 那正是评审时看不到 hook 正文的成因')
    // 而且不该留下半个安装状态（配置没改）
    const after = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo.dir, encoding: 'utf8' })
    assert.notEqual(after.status, 0, '报错时不该已经把 core.hooksPath 改掉')
  } finally {
    repo.cleanup()
  }
})

await check('T-82 · hook 里**只调用守卫**（不提交），且 npm 脚本都在', () => {
  // hook 的内容由**安装器**写入（单一事实源在 scripts/hooks.mjs 的常量里），
  // 所以从"临时仓装好之后"读它，而不是假设仓里躺着一个静态文件。
  const repo = makeRepo()
  let hook
  try {
    install(repo.dir, { log: () => {} })
    const hookPath = join(repo.dir, HOOKS_DIR, 'pre-commit')
    hook = readFileSync(hookPath, 'utf8')
    // T-82 打回后的契约：hook 是**版本库里的静态文件**，安装器只 chmod + 设配置
    // ⇒ 安装前后**正文逐字节相同**（安装器没有偷偷生成/改写它）
    assert.equal(hook, readFileSync(join(REPO, HOOKS_DIR, 'pre-commit'), 'utf8'), '安装器不改写 hook 正文（单一事实源 = 版本库里那份）')
    assert.ok((statSync(hookPath).mode & 0o111) !== 0, '安装器要把执行位补回来（否则 git 不会跑它）')
  } finally {
    repo.cleanup()
  }
  assert.match(hook, /check:commit/, 'pre-commit 调守卫')
  assert.ok(!/git (commit|-C .* commit)/.test(hook.replace(/^\s*#.*$/gm, '')), 'pre-commit 里不许自己提交（它只负责拦）')
  assert.match(hook, /--no-verify/, '逃生门要写在 hook 里，让人一眼看到')
  for (const name of ['install-hooks', 'uninstall-hooks', 'check:commit', 'commit:guarded']) {
    assert.ok(npmScript(name), `package.json 里要有 ${name}`)
  }
  assert.match(npmScript('install-hooks'), /hooks\.mjs install/)
  assert.match(npmScript('uninstall-hooks'), /hooks\.mjs uninstall/)
})

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall precommit-guard checks passed')
}
