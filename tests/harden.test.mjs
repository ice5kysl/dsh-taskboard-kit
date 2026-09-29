/**
 * Hardening tests for dsh-taskboard-kit: how the store behaves under hostile
 * or damaged input — the bug classes the T-3 audit found (see T-8). Every case
 * here fails on the pre-fix code and passes after it.
 *
 *   1. `__proto__` / `constructor` task ids cannot poison this process;
 *   2. a corrupt board leaves ONE `.corrupt` copy, never a growing pile;
 *   3. a live lock holder is never preempted, and release only removes the
 *      lock while it is still ours;
 *   4. structurally broken boards raise StoreErrors instead of TypeErrors, and
 *      `next_seq` can never overwrite an existing task;
 *   5. the text caps hold (a board is re-read whole on every poll).
 *
 * Run: node tests/harden.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'

const {
  StoreError,
  addComment,
  claimTask,
  createTask,
  getTask,
  loadBoard,
  updateTask,
  withBoardLock,
} = await import('../lib/index.js')

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

async function rejectsWith(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof StoreError, `expected StoreError, got ${error}`)
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`)
    return error
  }
  assert.fail(`expected rejection with code ${code}, but it resolved`)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-harden-'))

/** A workspace whose board holds exactly one open task (T-1). */
function task(overrides = {}) {
  return {
    id: 'T-1',
    title: 'seed',
    detail: '',
    status: 'open',
    assignee: null,
    priority: 'medium',
    value: null,
    tags: [],
    created_by: 'human',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    log: [],
    comments: [],
    ...overrides,
  }
}

async function workspace(name, board) {
  const dir = join(root, name)
  await mkdir(join(dir, '.dsh'), { recursive: true })
  if (board !== undefined) {
    await writeFile(join(dir, '.dsh', 'taskboard.json'), typeof board === 'string' ? board : JSON.stringify(board, null, 2))
  }
  return dir
}

const boardFile = (dir) => join(dir, '.dsh', 'taskboard.json')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('dsh-taskboard-kit hardening test:')

await check('a task id can never be a prototype key', async () => {
  const dir = await workspace('proto', { version: 1, workspace: root, next_seq: 2, tasks: { 'T-1': task() } })
  delete Object.prototype.title
  delete Object.prototype.detail
  for (const id of ['__proto__', 'constructor', 'prototype', 'toString']) {
    await rejectsWith(updateTask(dir, id, { title: 'PWNED' }, 'attacker'), 'invalid-input')
    await rejectsWith(getTask(dir, id), 'invalid-input')
    await rejectsWith(claimTask(dir, id, 'attacker'), 'invalid-input')
    await rejectsWith(addComment(dir, id, 'hi', 'attacker'), 'invalid-input')
  }
  assert.ok(!Object.hasOwn(Object.prototype, 'title'), 'Object.prototype.title was not created')
  assert.ok(!Object.hasOwn(Object.prototype, 'detail'), 'Object.prototype.detail was not created')
  const after = await getTask(dir, 'T-1')
  assert.equal(after.title, 'seed', 'the real task is untouched')
})

await check('next_seq can never overwrite an existing task', async () => {
  const dir = await workspace('collision', {
    version: 1,
    workspace: root,
    next_seq: 1,
    tasks: { 'T-3': task({ id: 'T-3', title: 'keep me', value: 8, tags: ['keep'] }) },
  })
  const created = await createTask(dir, { title: 'new' }, 'dsh')
  assert.equal(created.id, 'T-4', 'allocated the next free id, not T-3')
  const kept = await getTask(dir, 'T-3')
  assert.equal(kept.title, 'keep me')
  assert.deepEqual(kept.tags, ['keep'])
  const board = await loadBoard(dir)
  assert.equal(board.next_seq, 5)
})

await check('a structurally broken board raises StoreError, not TypeError', async () => {
  const nullTasks = await workspace('null-tasks', {
    version: 1,
    workspace: root,
    next_seq: 1,
    tasks: null,
  })
  await rejectsWith(createTask(nullTasks, { title: 'x' }, 'dsh'), 'internal')
  await rejectsWith(loadBoard(nullTasks), 'internal')

  const noSeq = await workspace('no-seq', { version: 1, workspace: root, tasks: {} })
  const first = await createTask(noSeq, { title: 'x' }, 'dsh')
  assert.equal(first.id, 'T-1', 'a missing next_seq starts at T-1')

  const badEntry = await workspace('bad-entry', {
    version: 1,
    workspace: root,
    next_seq: 1,
    tasks: { 'T-1': 'not an object' },
  })
  await rejectsWith(loadBoard(badEntry), 'internal')
})

await check('log/tags are hydrated so a hand-written board cannot crash the panel', async () => {
  const dir = await workspace('sparse', {
    version: 1,
    workspace: root,
    next_seq: 2,
    tasks: { 'T-1': { id: 'T-1', title: 'sparse', status: 'open', assignee: null, priority: 'medium' } },
  })
  const task = await getTask(dir, 'T-1')
  assert.deepEqual(task.log, [])
  assert.deepEqual(task.tags, [])
  assert.deepEqual(task.comments, [])
  await addComment(dir, 'T-1', 'still fine', 'dsh')
})

await check('a drifting task id is healed back to its record key', async () => {
  const dir = await workspace('drift', {
    version: 1,
    workspace: root,
    next_seq: 2,
    tasks: { 'T-1': task({ id: 'T-9' }) },
  })
  const healed = await getTask(dir, 'T-1')
  assert.equal(healed.id, 'T-1')
})

await check('a corrupt board keeps exactly one .corrupt copy', async () => {
  const dir = await workspace('corrupt', '{ this is not json')
  for (let i = 0; i < 3; i += 1) {
    await rejectsWith(loadBoard(dir), 'internal')
    await sleep(5) // a distinct millisecond per attempt: the old name was per-ms
  }
  const sidecars = (await readdir(join(dir, '.dsh'))).filter((name) => name.includes('corrupt'))
  assert.deepEqual(sidecars, ['taskboard.json.corrupt'], `expected exactly one backup, got ${JSON.stringify(sidecars)}`)
  assert.equal(await readFile(join(dir, '.dsh', 'taskboard.json.corrupt'), 'utf8'), '{ this is not json')
  // The user-facing message must not leak the absolute path (or file bytes).
  const error = await rejectsWith(loadBoard(dir), 'internal')
  assert.ok(!error.message.includes(dir), 'the error message does not carry the absolute path')
})

await check('a live lock holder is never preempted, a dead one is reclaimed', async () => {
  const dir = await workspace('lock', { version: 1, workspace: root, next_seq: 1, tasks: {} })
  const lock = `${boardFile(dir)}.lock`

  // (a) a live, unsignallable-by-us holder with a stale mtime: wait, do not steal
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  await sleep(250)
  await writeFile(lock, JSON.stringify({ pid: holder.pid, at: '2020-01-01T00:00:00.000Z', token: 'holder' }))
  const past = new Date(Date.now() - 60_000)
  await utimes(lock, past, past)
  let entered = false
  const waiting = withBoardLock(dir, async () => {
    entered = true
  })
  await sleep(700)
  assert.equal(entered, false, 'a live holder (old mtime) must not be preempted')
  holder.kill()
  await waiting
  assert.equal(entered, true, 'once the holder is gone the lock is reclaimed')

  // (b) release only removes the lock while it is still ours
  await withBoardLock(dir, async () => {
    // simulate a reclaim while we are inside the critical section
    await writeFile(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString(), token: 'other' }))
  })
  const after = JSON.parse(await readFile(lock, 'utf8'))
  assert.equal(after.token, 'other', 'a lock we no longer own must survive our release')

  // (c) a dead pid is reclaimed at once, even with a fresh mtime
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise((resolve) => dead.on('exit', resolve))
  await writeFile(lock, JSON.stringify({ pid: dead.pid, at: new Date().toISOString(), token: 'dead' }))
  const started = Date.now()
  await withBoardLock(dir, async () => {})
  assert.ok(Date.now() - started < 2_000, 'a dead holder is reclaimed without waiting out the stale window')
  await readFile(lock, 'utf8').then(
    () => assert.fail('the reclaimed lock should be gone'),
    () => {},
  )

  // (d) a lock naming THIS process with an ancient mtime is a leak (or a pid
  //     reused after a reboot) — it must not block us forever.
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: '2020-01-01T00:00:00.000Z', token: 'leak' }))
  await utimes(lock, past, past)
  const leaked = Date.now()
  await withBoardLock(dir, async () => {})
  assert.ok(Date.now() - leaked < 2_000, 'an ancient own-pid lock is reclaimed')
})

await check('text caps hold for detail/comment/note/title/tags', async () => {
  const dir = await workspace('caps', { version: 1, workspace: root, next_seq: 1, tasks: {} })
  await rejectsWith(createTask(dir, { title: 'x'.repeat(501) }, 'dsh'), 'invalid-input')
  await rejectsWith(createTask(dir, { title: 'big', detail: 'x'.repeat(200_001) }, 'dsh'), 'invalid-input')
  const ok = await createTask(dir, { title: 'ok', detail: 'x'.repeat(200_000) }, 'dsh')
  await rejectsWith(addComment(dir, ok.id, 'x'.repeat(50_001), 'dsh'), 'invalid-input')
  await rejectsWith(updateTask(dir, ok.id, { note: 123 }, 'dsh'), 'invalid-input')
  await rejectsWith(updateTask(dir, ok.id, { note: 'x'.repeat(50_001) }, 'dsh'), 'invalid-input')
  await rejectsWith(createTask(dir, { title: 'tags', tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }, 'dsh'), 'invalid-input')
  await rejectsWith(createTask(dir, { title: 'tags', tags: ['x'.repeat(101)] }, 'dsh'), 'invalid-input')
})

await check('claim atomicity still holds after the lock rewrite', async () => {
  const dir = await workspace('race', { version: 1, workspace: root, next_seq: 2, tasks: { 'T-1': task() } })
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      claimTask(dir, 'T-1', `racer-${index}`).then(
        (value) => ({ status: 'won', value }),
        (error) => ({ status: 'lost', error }),
      ),
    ),
  )
  assert.equal(outcomes.filter((outcome) => outcome.status === 'won').length, 1, 'exactly one winner')
  const final = await getTask(dir, 'T-1')
  assert.equal(final.log.filter((entry) => entry.event === 'claimed').length, 1)
})

await check('a board that VANISHES is not silently read as empty (nor overwritten)', async () => {
  const { mkdtemp, rm, unlink } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-vanish-'))
  try {
    // Two real tasks, seen by this process.
    await createTask(dir, { title: 'first' }, 'dsh')
    await createTask(dir, { title: 'second' }, 'dsh')
    const before = await loadBoard(dir)
    assert.equal(Object.keys(before.tasks).length, 2)

    // The file disappears (iCloud eviction, a move, a churning filesystem).
    await unlink(join(dir, '.dsh', 'taskboard.json'))

    // Reading must fail loudly rather than look like a brand-new workspace…
    const readError = await loadBoard(dir).then(() => null, (e) => e)
    assert.ok(readError, 'a vanished board must not read as empty')
    assert.equal(readError.name, 'StoreError')
    assert.match(readError.message, /disappeared/)

    // …because the next write would otherwise replace both tasks with one.
    const writeError = await createTask(dir, { title: 'replacement' }, 'dsh').then(() => null, (e) => e)
    assert.ok(writeError, 'a write over a vanished board must be refused')
    assert.match(writeError.message, /disappeared/)

    // A workspace that never had a board is still a normal first run.
    const fresh = await mkdtemp(join(tmpdir(), 'dsh-taskboard-fresh-'))
    const empty = await loadBoard(fresh)
    assert.deepEqual(Object.keys(empty.tasks), [])
    await rm(fresh, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log(failed === 0 ? '\nall hardening checks passed' : `\n${failed} hardening check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
