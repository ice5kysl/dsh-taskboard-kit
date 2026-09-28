/**
 * Store test for dsh-taskboard-kit: the board file, the lock, and every
 * domain operation, driven straight against lib/ with a tmp directory as the
 * workspace. The headline property is claim atomicity: N concurrent claims of
 * one task produce exactly ONE winner and one 'claimed' log entry.
 *
 * Run: node tests/store.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'

const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-store-'))

const {
  StoreError,
  addComment,
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

await check('update walks every legal transition of the v0.3 machine', async () => {
  await createTask(ws, { title: 'lifecycle' }, 'human') // T-4
  let result = await updateTask(ws, 'T-4', { action: 'start' }, 'kimi')
  assert.equal(result.task.status, 'in_progress')
  assert.deepEqual(result.events, ['started'])

  result = await updateTask(ws, 'T-4', { action: 'submit' }, 'kimi')
  assert.equal(result.task.status, 'review')
  assert.deepEqual(result.events, ['submitted'])

  result = await updateTask(ws, 'T-4', { action: 'reject', note: 'missing tests' }, 'human')
  assert.equal(result.task.status, 'in_progress')
  assert.deepEqual(result.events, ['rejected'])
  assert.equal(result.task.log.at(-1).note, 'missing tests')

  result = await updateTask(ws, 'T-4', { action: 'submit' }, 'kimi')
  result = await updateTask(ws, 'T-4', { action: 'approve' }, 'human')
  assert.equal(result.task.status, 'done')
  assert.deepEqual(result.events, ['approved'])

  result = await updateTask(ws, 'T-4', { action: 'reopen' }, 'human')
  assert.equal(result.task.status, 'open')
  assert.deepEqual(result.events, ['reopened'])

  // close is legal from every non-final status; here from open.
  result = await updateTask(ws, 'T-4', { action: 'close' }, 'human')
  assert.equal(result.task.status, 'closed')
  assert.deepEqual(result.events, ['closed'])

  // reopen also works from closed …
  result = await updateTask(ws, 'T-4', { action: 'reopen' }, 'human')
  assert.equal(result.task.status, 'open')

  // … and stop/done round out the machine: start → stop → done (from open).
  await updateTask(ws, 'T-4', { action: 'start' }, 'kimi')
  result = await updateTask(ws, 'T-4', { action: 'stop' }, 'kimi')
  assert.equal(result.task.status, 'open')
  assert.deepEqual(result.events, ['stopped'])
  result = await updateTask(ws, 'T-4', { action: 'done', note: 'shipped' }, 'kimi')
  assert.equal(result.task.status, 'done')
  assert.deepEqual(result.events, ['done'])
  assert.equal(result.task.log.at(-1).note, 'shipped')
})

await check('cancel is accepted as the legacy alias of close', async () => {
  await createTask(ws, { title: 'legacy cancel' }, 'human') // T-5
  const result = await updateTask(ws, 'T-5', { action: 'cancel' }, 'human')
  assert.equal(result.task.status, 'closed')
  assert.deepEqual(result.events, ['closed'], 'cancel records the closed event')
  assert.equal(result.task.log.at(-1).event, 'closed')
})

await check('illegal transitions raise invalid-transition', async () => {
  await createTask(ws, { title: 'no skipping' }, 'human') // T-6
  // open accepts only start / done / close / cancel:
  await rejectsWith(updateTask(ws, 'T-6', { action: 'stop' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'submit' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'approve' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'reject' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'reopen' }, 'kimi'), 'invalid-transition')

  // in_progress: approve/reject/reopen are illegal (need the review gate).
  await updateTask(ws, 'T-6', { action: 'start' }, 'kimi')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'approve' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'reject' }, 'kimi'), 'invalid-transition')

  // review: start/stop are illegal.
  await updateTask(ws, 'T-6', { action: 'submit' }, 'kimi')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'start' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'stop' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'submit' }, 'kimi'), 'invalid-transition')

  // done: only reopen/close are legal.
  await updateTask(ws, 'T-6', { action: 'approve' }, 'human')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'start' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'submit' }, 'kimi'), 'invalid-transition')

  // cancel aliases close here as well: done → closed.
  const closedByAlias = await updateTask(ws, 'T-6', { action: 'cancel' }, 'human')
  assert.equal(closedByAlias.task.status, 'closed')

  // closed: only reopen is legal (close-from-closed too is rejected).
  await rejectsWith(updateTask(ws, 'T-6', { action: 'close' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'done' }, 'kimi'), 'invalid-transition')
  await rejectsWith(updateTask(ws, 'T-6', { action: 'explode' }, 'kimi'), 'invalid-input')
})

await check('assignee changes log assigned / updated and respect the status gate', async () => {
  await createTask(ws, { title: 'reassign me' }, 'human') // T-7
  let result = await updateTask(ws, 'T-7', { assignee: 'kimi' }, 'human')
  assert.equal(result.task.assignee, 'kimi')
  assert.deepEqual(result.events, ['assigned'])

  result = await updateTask(ws, 'T-7', { assignee: 'claude' }, 'human')
  assert.equal(result.task.assignee, 'claude')
  assert.deepEqual(result.events, ['updated'])

  result = await updateTask(ws, 'T-7', { assignee: null }, 'human')
  assert.equal(result.task.assignee, null)
  assert.deepEqual(result.events, ['updated'])

  await updateTask(ws, 'T-7', { action: 'done' }, 'human')
  await rejectsWith(updateTask(ws, 'T-7', { assignee: 'kimi' }, 'human'), 'invalid-input')
})

await check('field edits log one updated entry; a bare note leaves a trace', async () => {
  await createTask(ws, { title: 'edit me', priority: 'low' }, 'human') // T-8
  const result = await updateTask(ws, 'T-8', { title: 'edited', priority: 'high', tags: ['x'], note: 'reprioritized' }, 'human')
  assert.deepEqual(result.events, ['updated'])
  assert.equal(result.task.title, 'edited')
  assert.equal(result.task.priority, 'high')
  assert.deepEqual(result.task.tags, ['x'])
  assert.equal(result.task.log.at(-1).note, 'reprioritized')

  const noted = await updateTask(ws, 'T-8', { note: 'just a comment' }, 'kimi')
  assert.deepEqual(noted.events, ['updated'])
  assert.equal(noted.task.log.at(-1).note, 'just a comment')

  await rejectsWith(updateTask(ws, 'T-8', {}, 'kimi'), 'invalid-input')
  await rejectsWith(updateTask(ws, 'T-999', { action: 'done' }, 'kimi'), 'not-found')
})

await check('stop moves in_progress back to open (assignee kept), and only from there', async () => {
  await createTask(ws, { title: 'pause me' }, 'human') // T-9
  // stop from open is illegal — only in_progress tasks can go back to todo.
  await rejectsWith(updateTask(ws, 'T-9', { action: 'stop' }, 'kimi'), 'invalid-transition')
  await updateTask(ws, 'T-9', { action: 'start', assignee: 'kimi' }, 'kimi')

  const stopped = await updateTask(ws, 'T-9', { action: 'stop' }, 'kimi')
  assert.equal(stopped.task.status, 'open')
  assert.equal(stopped.task.assignee, 'kimi', 'stop keeps the assignee')
  assert.deepEqual(stopped.events, ['stopped'])

  // The dnd combo: stop + unassign in one call (action lands first, then the
  // assignee is validated against the resulting open status).
  await updateTask(ws, 'T-9', { action: 'start' }, 'kimi')
  const combo = await updateTask(ws, 'T-9', { action: 'stop', assignee: null }, 'human')
  assert.equal(combo.task.status, 'open')
  assert.equal(combo.task.assignee, null)
  assert.deepEqual(combo.events, ['stopped', 'updated'])

  // review/done/closed cannot stop either.
  await updateTask(ws, 'T-9', { action: 'start' }, 'kimi')
  await updateTask(ws, 'T-9', { action: 'submit' }, 'kimi')
  await rejectsWith(updateTask(ws, 'T-9', { action: 'stop' }, 'kimi'), 'invalid-transition')
  await updateTask(ws, 'T-9', { action: 'approve' }, 'human')
  await rejectsWith(updateTask(ws, 'T-9', { action: 'stop' }, 'kimi'), 'invalid-transition')
  await updateTask(ws, 'T-9', { action: 'close' }, 'human')
  await rejectsWith(updateTask(ws, 'T-9', { action: 'stop' }, 'kimi'), 'invalid-transition')
})

await check('value: validated against the Fibonacci scale, changeable, clearable', async () => {
  await rejectsWith(createTask(ws, { title: 'bad points', value: 4 }, 'human'), 'invalid-input')
  await rejectsWith(createTask(ws, { title: 'bad points', value: '3' }, 'human'), 'invalid-input')

  const created = await createTask(ws, { title: 'estimated' }, 'human') // T-10
  assert.equal(created.value, null, 'default is unestimated')

  const half = await createTask(ws, { title: 'half point', value: 0.5 }, 'human') // T-11
  assert.equal(half.value, 0.5)

  const estimated = await updateTask(ws, 'T-10', { value: 3 }, 'human')
  assert.equal(estimated.task.value, 3)
  assert.deepEqual(estimated.events, ['updated'])

  const changed = await updateTask(ws, 'T-10', { value: 8 }, 'human')
  assert.equal(changed.task.value, 8)

  const cleared = await updateTask(ws, 'T-10', { value: null }, 'human')
  assert.equal(cleared.task.value, null, 'null clears back to unestimated')
  assert.deepEqual(cleared.events, ['updated'])

  await rejectsWith(updateTask(ws, 'T-10', { value: 7 }, 'human'), 'invalid-input')
  assert.equal((await getTask(ws, 'T-11')).value, 0.5, '0.5 survives a reload')
})

await check('addComment appends to comments, moves updated_at, and never touches the log', async () => {
  await createTask(ws, { title: 'discuss me' }, 'human') // T-12
  const before = await getTask(ws, 'T-12')
  assert.deepEqual(before.comments, [])

  await new Promise((resolve) => setTimeout(resolve, 5)) // let the clock move
  const commented = await addComment(ws, 'T-12', '  发现：锁要等下一个 tick  ', 'kimi')
  assert.equal(commented.comments.length, 1)
  assert.equal(commented.comments[0].by, 'kimi')
  assert.equal(commented.comments[0].text, '发现：锁要等下一个 tick', 'text is trimmed')
  assert.ok(commented.comments[0].at >= before.created_at)
  assert.deepEqual(commented.log, before.log, 'the lifecycle log is untouched')
  assert.ok(commented.updated_at > before.updated_at, 'updated_at moved')

  const second = await addComment(ws, 'T-12', 'test feedback: all green', 'claude')
  assert.equal(second.comments.length, 2)
  assert.equal((await getTask(ws, 'T-12')).comments.length, 2, 'persisted through a reload')

  await rejectsWith(addComment(ws, 'T-12', '   ', 'kimi'), 'invalid-input')
  await rejectsWith(addComment(ws, 'T-999', 'ghost', 'kimi'), 'not-found')
})

await check('loadBoard corrects a stale workspace field after the directory moved', async () => {
  const movedWs = await mkdtemp(join(tmpdir(), 'dsh-taskboard-moved-'))
  try {
    await mkdir(join(movedWs, '.dsh'), { recursive: true })
    const oldPath = '/Users/old/location/dsh'
    const stale = {
      version: 1,
      workspace: oldPath, // the board moved, the field stayed behind
      next_seq: 2,
      tasks: {
        'T-1': {
          id: 'T-1', title: 'moved board', detail: '', status: 'open', assignee: null,
          priority: 'medium', value: null, tags: [], created_by: 'human',
          created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
          log: [{ at: '2026-09-20T00:00:00.000Z', by: 'human', event: 'created' }],
          comments: [],
        },
      },
    }
    const seeded = `${JSON.stringify(stale, null, 2)}\n`
    const file = join(movedWs, '.dsh', 'taskboard.json')
    await writeFile(file, seeded)

    const board = await loadBoard(movedWs)
    assert.equal(board.workspace, movedWs, 'the loaded board reports the CURRENT cwd')

    // Lazy by design: a read-only load must not write — the on-disk field is
    // still stale until the next mutation carries the correction out.
    assert.equal(await readFile(file, 'utf8'), seeded, 'a pure load never writes')

    await addComment(movedWs, 'T-1', 'hello from the new location', 'kimi')
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(persisted.workspace, movedWs, 'the next normal write persists the correction')
  } finally {
    await rm(movedWs, { recursive: true, force: true })
  }
})

await check('loadBoard migrates legacy boards (cancelled → closed, missing value/comments)', async () => {
  const legacyWs = await mkdtemp(join(tmpdir(), 'dsh-taskboard-legacy-'))
  try {
    await mkdir(join(legacyWs, '.dsh'), { recursive: true })
    const legacy = {
      version: 1,
      workspace: legacyWs,
      next_seq: 3,
      tasks: {
        'T-1': {
          id: 'T-1',
          title: 'written by v0.1',
          detail: '',
          status: 'open',
          assignee: null,
          priority: 'medium',
          tags: [],
          created_by: 'human',
          created_at: '2026-09-20T00:00:00.000Z',
          updated_at: '2026-09-20T00:00:00.000Z',
          log: [{ at: '2026-09-20T00:00:00.000Z', by: 'human', event: 'created' }],
          // no comments, no value — the pre-v0.2 shape
        },
        'T-2': {
          id: 'T-2',
          title: 'cancelled under v0.2',
          detail: '',
          status: 'cancelled',
          assignee: 'kimi',
          priority: 'low',
          tags: [],
          created_by: 'human',
          created_at: '2026-09-21T00:00:00.000Z',
          updated_at: '2026-09-22T00:00:00.000Z',
          log: [
            { at: '2026-09-21T00:00:00.000Z', by: 'human', event: 'created' },
            { at: '2026-09-22T00:00:00.000Z', by: 'human', event: 'cancelled' },
          ],
          comments: [],
          // no value — the pre-v0.3 shape
        },
      },
    }
    await writeFile(join(legacyWs, '.dsh', 'taskboard.json'), JSON.stringify(legacy, null, 2))

    const board = await loadBoard(legacyWs)
    const t1 = board.tasks['T-1']
    assert.deepEqual(t1.comments, [], 'comments hydrated on load')
    assert.equal(t1.value, null, 'value hydrated to unestimated')
    const t2 = board.tasks['T-2']
    assert.equal(t2.status, 'closed', 'cancelled status migrates to closed')
    assert.equal(t2.value, null)
    assert.deepEqual(t2.log.map((entry) => entry.event), ['created', 'closed'], 'cancelled log events migrate too')

    // And the migrated board behaves like a native one: reopen the closed
    // legacy task, estimate it, comment on it.
    const reopened = await updateTask(legacyWs, 'T-2', { action: 'reopen', value: 2 }, 'kimi')
    assert.equal(reopened.task.status, 'open')
    assert.equal(reopened.task.value, 2)
    const commented = await addComment(legacyWs, 'T-1', 'first comment on an old board', 'kimi')
    assert.equal(commented.comments.length, 1, 'mutations work right after migration')
  } finally {
    await rm(legacyWs, { recursive: true, force: true })
  }
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
