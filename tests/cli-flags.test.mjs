/**
 * CLI argument-handling tests for dsh-taskboard-kit.
 *
 * The pre-fix parser treated any token starting with `--` as a switch, so
 * `--detail "-- 注意"` silently stored an EMPTY detail and exited 0 — an agent
 * pasting markdown lost the body without a single warning. It also had no
 * `--key=value` form and ignored flags nobody implements (`--priorty high`).
 *
 * Run: node tests/cli-flags.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/taskboard.mjs', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-cli-'))

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

/** Run the CLI against `root` (or another cwd) and return the child result. */
function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TASKBOARD_ACTOR: '', ...env },
  })
}

/** Read one task back through the CLI, parsed. */
function read(id, cwd = root) {
  const result = cli(['get', id, '--cwd', cwd, '--json'])
  assert.equal(result.status, 0, `get ${id} failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

console.log('dsh-taskboard-kit CLI flag test:')

await check('a value starting with `--` is stored, not silently dropped', async () => {
  const created = cli(['create', '--cwd', root, '--by', 'dsh', '--title', '前缀 detail', '--detail', '-- 注意：这条以两个减号开头'])
  assert.equal(created.status, 0, created.stderr)
  assert.equal(read('T-1').detail, '-- 注意：这条以两个减号开头')

  const valued = cli(['create', '--cwd', root, '--by', 'dsh', '--title', '等号形式', '--detail=-- 等号传值'])
  assert.equal(valued.status, 0, valued.stderr)
  assert.equal(read('T-2').detail, '-- 等号传值')

  const separator = cli(['create', '--cwd', root, '--by', 'dsh', '--title', '分隔线', '--detail=--- 分组 ---'])
  assert.equal(separator.status, 0, separator.stderr)
  assert.equal(read('T-3').detail, '--- 分组 ---')
})

await check('a value flag without a value fails loudly', async () => {
  const result = cli(['create', '--cwd', root, '--title', 'x', '--detail'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /requires a value/)
})

await check('an unknown flag fails loudly instead of being ignored', async () => {
  const result = cli(['create', '--cwd', root, '--title', 'x', '--priorty', 'high'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown flag/)
})

await check('an empty actor never claims a task', async () => {
  const claimed = cli(['claim', 'T-1', '--cwd', root, '--by', ''])
  assert.equal(claimed.status, 0, claimed.stderr)
  const task = read('T-1')
  assert.equal(task.assignee, 'cli-agent', 'the fallback actor is used, not an empty string')
  assert.equal(task.status, 'in_progress')
  assert.equal(task.log.at(-1).by, 'cli-agent')
})

await check('the normal flag set still works', async () => {
  const listed = cli(['list', '--cwd', root, '--assignee', 'cli-agent'])
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /T-1 · in_progress · cli-agent/)

  const updated = cli(['update', 'T-1', '--cwd', root, '--by', 'dsh', '--action', 'stop', '--note', '-- 收工', '--value', '1/2'])
  assert.equal(updated.status, 0, updated.stderr)
  const task = read('T-1')
  assert.equal(task.status, 'open')
  assert.equal(task.value, 0.5)
  assert.equal(task.log.at(-1).note, '-- 收工')
})

await check('an unknown command still exits non-zero with usage', async () => {
  const result = cli(['nope', '--cwd', root])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown command/)
})

console.log(failed === 0 ? '\nall CLI flag checks passed' : `\n${failed} CLI flag check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
