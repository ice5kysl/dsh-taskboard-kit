/**
 * Store test for dsh-taskboard-kit: the board file, the lock, and every
 * domain operation, driven straight against lib/ with a tmp directory as the
 * workspace. The headline property is claim atomicity: N concurrent claims of
 * one task produce exactly ONE winner and one 'claimed' log entry.
 *
 * Run: node tests/store.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'

const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-store-'))

const {
  StoreError,
  boardFilePath,
  claimTask,
  createTask,
  getTask,
  listTasks,
  loadBoard,
  saveBoard,
  updateTask,
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

/** Assert the rejection is a StoreError with the expected code. */
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

console.log('dsh-taskboard-kit store test:')

await check('boardFilePath points inside the workspace .dsh dir', () => {
  assert.equal(boardFilePath(ws), join(ws, '.dsh', 'taskboard.json'))
})

await check('loadBoard on a missing file returns an empty board (no file created)', async () => {
  const board = await loadBoard(ws)
  assert.equal(board.version, 1)
  assert.equal(board.workspace, ws)
  assert.equal(board.next_seq, 1)
  assert.deepEqual(board.tasks, {})
  await assert.rejects(stat(boardFilePath(ws)), /ENOENT/)
})

await check('create → get → list roundtrip', async () => {
  const created = await createTask(ws, { title: 'first task', detail: 'do the thing', priority: 'high', tags: ['a', 'b'] }, 'human')
  assert.equal(created.id, 'T-1')
  assert.equal(created.status, 'open')
  assert.equal(created.assignee, null)
  assert.equal(created.created_by, 'human')
  assert.deepEqual(created.log.map((entry) => entry.event), ['created'])

  const second = await createTask(ws, { title: 'delegated', assignee: 'kimi' }, 'human')
  assert.equal(second.id, 'T-2')
  assert.equal(second.assignee, 'kimi')
  assert.deepEqual(second.log.map((entry) => entry.event), ['created', 'assigned'])

  const fetched = await getTask(ws, 'T-1')
  assert.equal(fetched.title, 'first task')
  assert.deepEqual(fetched.tags, ['a', 'b'])

  const all = await listTasks(ws)
  assert.deepEqual(all.map((task) => task.id), ['T-1', 'T-2']) // high priority first
  assert.deepEqual((await listTasks(ws, { status: 'open' })).length, 2)
  assert.deepEqual((await listTasks(ws, { assignee: 'none' })).map((task) => task.id), ['T-1'])
  assert.deepEqual((await listTasks(ws, { assignee: 'kimi' })).map((task) => task.id), ['T-2'])
})

await check('create validates its input', async () => {
  await rejectsWith(createTask(ws, { title: '' }, 'human'), 'invalid-input')
  await rejectsWith(createTask(ws, { title: 'x', priority: 'urgent' }, 'human'), 'invalid-input')
  await rejectsWith(createTask(ws, { title: 'x', tags: ['a', 1] }, 'human'), 'invalid-input')
  await rejectsWith(getTask(ws, 'T-999'), 'not-found')
})

await check('claim takes a pool task; a second claim conflicts', async () => {
  const claimed = await claimTask(ws, 'T-1', 'kimi')
  assert.equal(claimed.status, 'in_progress')
  assert.equal(claimed.assignee, 'kimi')
  assert.deepEqual(claimed.log.map((entry) => entry.event), ['created', 'claimed'])

  const error = await rejectsWith(claimTask(ws, 'T-1', 'other-agent'), 'conflict')
  assert.match(error.message, /kimi/)
})

await check('claiming a delegated task conflicts (it is not in the pool)', async () => {
  await rejectsWith(claimTask(ws, 'T-2', 'someone-else'), 'conflict')
})

await check('claim is atomic: 8 concurrent claims → 1 winner, 7 conflicts, 1 log entry', async () => {
  await createTask(ws, { title: 'race me' }, 'human') // T-3
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) => claimTask(ws, 'T-3', `racer-${index}`)),
  )
  const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
  const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(won.length, 1, JSON.stringify(outcomes.map((outcome) => outcome.status)))
  assert.equal(lost.length, 7)
  for (const outcome of lost) {
    assert.ok(outcome.reason instanceof StoreError, `expected StoreError, got ${outcome.reason}`)
    assert.equal(outcome.reason.code, 'conflict')
  }
  const task = await getTask(ws, 'T-3')
  assert.equal(task.status, 'in_progress')
  assert.equal(task.assignee, won[0].value.assignee)
  assert.equal(task.log.filter((entry) => entry.event === 'claimed').length, 1)
})

await check('update walks every legal transition', async () => {
  await createTask(ws, { title: 'lifecycle' }, 'human') // T-4
  let result = await updateTask(ws, 'T-4', { action: 'start' }, 'kimi')
  assert.equal(result.task.status, 'in_progress')
  assert.deepEqual(result.events, ['started'])

  result = await updateTask(ws, 'T-4', { action: 'done', note: 'shipped' }, 'kimi')
  assert.equal(result.task.status, 'done')
  assert.deepEqual(result.events, ['done'])
  assert.equal(result.task.log.at(-1).note, 'shipped')

  result = await updateTask(ws, 'T-4', { action: 'reopen' }, 'human')
  assert.equal(result.task.status, 'open')
  assert.deepEqual(result.events, ['reopened'])

  result = await updateTask(ws, 'T-4', { action: 'cancel' }, 'human')
  assert.equal(result.task.status, 'cancelled')
  assert.deepEqual(result.events, ['cancelled'])

  // done is also legal straight from open; cancel covers open too (both above).
})

await check('illegal transitions raise invalid-transition', async () => {
  await createTask(ws, { title: 'no skipping' }, 'human') // T-5
  await rejectsWith(updateTask(ws, 'T-5', { action: 'reopen' }, 'kimi'), 'invalid-transition')
  await updateTask(ws, 'T-5', { action: 'done' }, 'kimi')
  await rejectsWith(updateTask(ws, 'T-5', { action: 'start' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-5', { action: 'cancel' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-5', { action: 'explode' }, 'kimi'), 'invalid-input')
})

await check('assignee changes log assigned / updated and respect the status gate', async () => {
  await createTask(ws, { title: 'reassign me' }, 'human') // T-6
  let result = await updateTask(ws, 'T-6', { assignee: 'kimi' }, 'human')
  assert.equal(result.task.assignee, 'kimi')
  assert.deepEqual(result.events, ['assigned'])

  result = await updateTask(ws, 'T-6', { assignee: 'claude' }, 'human')
  assert.equal(result.task.assignee, 'claude')
  assert.deepEqual(result.events, ['updated'])

  result = await updateTask(ws, 'T-6', { assignee: null }, 'human')
  assert.equal(result.task.assignee, null)
  assert.deepEqual(result.events, ['updated'])

  await updateTask(ws, 'T-6', { action: 'done' }, 'human')
  await rejectsWith(updateTask(ws, 'T-6', { assignee: 'kimi' }, 'human'), 'invalid-input')
})

await check('field edits log one updated entry; a bare note leaves a trace', async () => {
  await createTask(ws, { title: 'edit me', priority: 'low' }, 'human') // T-7
  const result = await updateTask(ws, 'T-7', { title: 'edited', priority: 'high', tags: ['x'], note: 'reprioritized' }, 'human')
  assert.deepEqual(result.events, ['updated'])
  assert.equal(result.task.title, 'edited')
  assert.equal(result.task.priority, 'high')
  assert.deepEqual(result.task.tags, ['x'])
  assert.equal(result.task.log.at(-1).note, 'reprioritized')

  const noted = await updateTask(ws, 'T-7', { note: 'just a comment' }, 'kimi')
  assert.deepEqual(noted.events, ['updated'])
  assert.equal(noted.task.log.at(-1).note, 'just a comment')

  await rejectsWith(updateTask(ws, 'T-7', {}, 'kimi'), 'invalid-input')
  await rejectsWith(updateTask(ws, 'T-999', { action: 'done' }, 'kimi'), 'not-found')
})

await check('saveBoard → loadBoard keeps the data identical (and the file is 0600)', async () => {
  const board = await loadBoard(ws)
  board.workspace = ws
  await saveBoard(ws, board)
  const reloaded = await loadBoard(ws)
  assert.deepEqual(reloaded, board)
  const mode = (await stat(boardFilePath(ws))).mode & 0o777
  assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`)
  // And what is on disk is genuinely the JSON we think it is.
  const raw = JSON.parse(await readFile(boardFilePath(ws), 'utf8'))
  assert.equal(raw.next_seq, board.next_seq)
  assert.equal(Object.keys(raw.tasks).length, Object.keys(board.tasks).length)
})

await rm(ws, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
