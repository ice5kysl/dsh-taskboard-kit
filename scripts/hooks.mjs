#!/usr/bin/env node
/**
 * 仓内 git hook 安装器（T-82，opt-in）。
 *
 * ## 为什么是仓内
 *
 * T-79 交付时把这判断成"改机器级 git 配置、跨仓库生效"，交给 PO 定 ✓。PO 的决定是
 * **做，但只做仓内、可撤销、带逃生门的版本**（理由：同一天同类错误栽了三次 ⇒ 机制 > 纪律）。
 * 所以这里有三条硬纪律：
 *
 *  0. **不生成 hook**：`${HOOKS_DIR}/pre-commit` 是**版本库里的静态文件**（可见 = 会跑的）；
     安装器只 `chmod +x` 它 + 设 `core.hooksPath`（两件都是幂等的）。
  1. **只写 repo-local**（`git config --local` / 等价于写 `.git/config`）—— **绝不 `--global`** ✗。
 *     装了 hook 的人不该影响别的仓库；验收里有一条断言 `git config --global core.hooksPath` 前后不变 ✓。
 *  2. **先读原值再改** ✗：安装前把当前 `core.hooksPath`（可能是用户自己设的！）存进
 *     `<gitdir>/dsh-taskboard-hooks.json`，卸载时**原样还原**（原本没设 ⇒ 再 unset 回去）。
 *  3. **逃生门必须可用且写明** ✓：`git commit --no-verify` 一定还能提交；
 *     `npm run uninstall-hooks` 一定能把配置还原。守卫防手滑，不防人。
 *
 * ## hook 里只"拦"，不"提交"
 *
 * `.githooks/pre-commit` **只调用守卫**（`npm run check:commit`）；pre-commit 的语义就是拦，
 * 在它里面做提交是错的（而且 `git commit` 在 commit 过程中再调用 commit 是自找麻烦）。
 *
 * 用法：
 *   node scripts/hooks.mjs install     # 装（幂等：chmod + 设配置）
 *   node scripts/hooks.mjs uninstall   # 卸（还原原值）
 *   node scripts/hooks.mjs status      # 看当前是什么状态
 *
 * @module dsh-taskboard-kit/hooks-installer
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓内 hooks 目录（相对仓库根 ⇒ git 会自己相对 top-level 解析）。 */
export const HOOKS_DIR = '.githooks'

/** 状态文件的姓名（住在 `<gitdir>/` 里 ⇒ 不进版本库、不跨克隆）。 */
const STATE_NAME = 'dsh-taskboard-hooks.json'

/**
 * 仓内 hooks 目录（相对仓库根 ⇒ git 自己相对 top-level 解析）。
 *
 * T-82（PO 打回"安装时才生成"）后：`pre-commit` 是**版本库里的静态文件**，
 * 安装器**不生成它**，只做两件幂等的事 —— `chmod +x` + 设 `core.hooksPath` ✓。
 * 理由：hook 是代码 ⇒ 应当进 diff、可评审、可 blame；"看到的 = 会跑的"；
 * 而"生成文件"不幂等（正文一改就得重装）✗。
 */

/** 跑 git 并返回 stdout（失败抛）。 */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** 仓库根 / git 目录。 */
function locate(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  const gitDir = resolve(root, git(root, ['rev-parse', '--absolute-git-dir']).trim())
  return { root, gitDir }
}

/** 读 repo-local 的 core.hooksPath（没设 ⇒ null）。 */
function readLocalHooksPath(root) {
  try {
    const value = git(root, ['config', '--local', '--get', 'core.hooksPath']).trim()
    return value === '' ? null : value
  } catch {
    return null // --get 在"没设"时退出码 1
  }
}

/**
 * 安装（幂等）。
 *
 * @param {string} cwd 仓库内任意目录
 * @param {{ log?: (s: string) => void }} [io]
 * @returns {{ root: string, hooksPath: string, previous: string | null, alreadyInstalled: boolean }}
 */
export function install(cwd, io = {}) {
  const log = io.log ?? console.log
  const { root, gitDir } = locate(cwd)
  const stateFile = join(gitDir, STATE_NAME)
  const previous = readLocalHooksPath(root)
  const alreadyInstalled = existsSync(stateFile)
  // **先读原值再改**：只在第一次安装时记录，重复安装不要覆盖成"我们自己" ✗
  if (!alreadyInstalled) {
    writeFileSync(stateFile, JSON.stringify({ previousHooksPath: previous, installedAt: new Date().toISOString() }, null, 2) + '\n')
  }
  const hooksDir = join(root, HOOKS_DIR)
  const hookFile = join(hooksDir, 'pre-commit')
  // **不生成** hook：它是版本库里的静态文件（可见、可评审、单一事实源）。
  // 少了它 ⇒ 大声报错，而不是"悄悄替你造一个"✗（那样评审时看不到将要执行什么）。
  if (!existsSync(hookFile)) {
    throw new Error(
      `找不到 ${HOOKS_DIR}/pre-commit —— 它是**版本库里的静态文件**，安装器不生成它。` +
      `如果你在一个新克隆里，先确认这个文件在（git checkout 拿回它）；` +
      `如果你在别的仓库里跑这个安装器，请把该文件也放进去。`,
    )
  }
  chmodSync(hookFile, 0o755) // 幂等：克隆时丢掉的执行位在这里补回
  // repo-local ⇒ 写的是 .git/config，**不碰** ~/.gitconfig ✓
  git(root, ['config', '--local', 'core.hooksPath', HOOKS_DIR])
  log(`已安装（repo-local）：core.hooksPath = ${HOOKS_DIR}`)
  log(`  原值：${previous === null ? '(未设置)' : previous}${alreadyInstalled ? '（本次是重复安装，沿用首次记录的原值）' : ' —— 已记入 ' + STATE_NAME}`)
  log('  逃生门：git commit --no-verify ／ 卸载：npm run uninstall-hooks')
  return { root, hooksPath: HOOKS_DIR, previous: alreadyInstalled ? (readState(stateFile)?.previousHooksPath ?? previous) : previous, alreadyInstalled }
}

/** 读状态文件（坏了 ⇒ null，不抛）。 */
function readState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 卸载：把 `core.hooksPath` **还原成安装前的样子**（原本没设 ⇒ unset 回去）。
 *
 * @param {string} cwd 仓库内任意目录
 * @param {{ log?: (s: string) => void }} [io]
 * @returns {{ root: string, restored: string | null }}
 */
export function uninstall(cwd, io = {}) {
  const log = io.log ?? console.log
  const { root, gitDir } = locate(cwd)
  const stateFile = join(gitDir, STATE_NAME)
  const state = readState(stateFile)
  if (state && typeof state.previousHooksPath === 'string' && state.previousHooksPath !== '') {
    git(root, ['config', '--local', 'core.hooksPath', state.previousHooksPath])
    log(`已卸载：core.hooksPath 还原为安装前的值 ${state.previousHooksPath}`)
    rmSync(stateFile, { force: true })
    return { root, restored: state.previousHooksPath }
  }
  // 原本就没设（或没有状态文件）⇒ 把自己加的那一项**删掉**，而不是留下空串
  try {
    git(root, ['config', '--local', '--unset', 'core.hooksPath'])
  } catch {
    /* 本来就没有这一项 */
  }
  rmSync(stateFile, { force: true })
  log('已卸载：core.hooksPath 已清除（安装前它本来就没设置）')
  return { root, restored: null }
}

/** 当前状态。 */
export function status(cwd) {
  const { root, gitDir } = locate(cwd)
  const stateFile = join(gitDir, STATE_NAME)
  const hookFile = join(root, HOOKS_DIR, 'pre-commit')
  return {
    root,
    hooksPath: readLocalHooksPath(root),
    hookInstalled: existsSync(hookFile),
    state: readState(stateFile),
  }
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const action = process.argv[2]
  const cwd = process.cwd()
  try {
    if (action === 'install') install(cwd)
    else if (action === 'uninstall') uninstall(cwd)
    else if (action === 'status') console.log(JSON.stringify(status(cwd), null, 2))
    else {
      console.log('用法: node scripts/hooks.mjs install|uninstall|status')
      process.exit(1)
    }
  } catch (error) {
    console.error(`hook 安装器失败：${error?.message ?? error}`)
    process.exit(1)
  }
}
