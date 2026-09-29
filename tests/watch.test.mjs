/**
 * Watcher test for dsh-taskboard-kit: diffBoards as a pure function, and
 * createBoardWatcher driven end-to-end against a real tmp workspace with a
 * fake watchDir (no real fs.watch), fake agents, and real store writes.
 *
 * Run: node tests/watch.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'
delete process.env.TASKBOARD_WATCH_NAMES

const {
  apply,
  createBoardWatcher,
  diffBoards,
  createTask,
  addComment,
  updateTask,
  loadBoard,
  saveBoard,
} = await import('../lib/index.js')

const NAMES = ['dsh', 'dsh-agent']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// --------------------------------------------------------- diffBoards (pure)

let seq = 0
function task(over = {}) {
  seq += 1
  const by = over.created_by ?? 'human'
  return {
    id: `T-${seq}`,
    title: `task ${seq}`,
    detail: '',
    status: 'open',
    assignee: null,
    priority: 'medium',
    value: null,
    tags: [],
    created_by: by,
    created_at: '2026-09-26T00:00:00.000Z',
    updated_at: '2026-09-26T00:00:00.000Z',
    log: [{ at: '2026-09-26T00:00:00.000Z', by, event: 'created' }],
    comments: [],
    ...over,
  }
}
function board(tasks) {
  return { version: 1, workspace: '/w', next_seq: 999, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) }
}
/** A verdict event appended to a task's log. */
function withEvent(t, event, by, note) {
  return {
    ...t,
    status: event === 'approved' ? 'done' : event === 'rejected' ? 'in_progress' : event === 'done' ? 'done' : t.status,
    log: [...t.log, { at: '2026-09-26T01:00:00.000Z', by, event, ...(note ? { note } : {}) }],
  }
}

console.log('dsh-taskboard-kit watcher test:')

await check('diffBoards: bootstrap (prev null) and no-change both stay silent', () => {
  const t = task()
  assert.deepEqual(diffBoards(null, board([t]), NAMES), [])
  assert.deepEqual(diffBoards(board([t]), board([t]), NAMES), [])
})

await check('diffBoards: a task assigned to me (created or reassigned) notifies', () => {
  const delegated = task({ assignee: 'dsh' })
  const lines = diffBoards(board([]), board([delegated]), NAMES)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /assigned to you \(by human\)/)
  assert.match(lines[0], new RegExp(`^${delegated.id} ·`))

  // Reassignment to me on an existing task, done by someone else.
  const before = task({ assignee: 'kimi' })
  const after = { ...before, assignee: 'dsh', log: [...before.log, { at: 'x', by: 'human', event: 'updated' }] }
  const again = diffBoards(board([before]), board([after]), NAMES)
  assert.equal(again.length, 1)
  assert.match(again[0], /assigned to you/)

  // …but tasks for OTHERS and my OWN creations stay silent.
  assert.deepEqual(diffBoards(board([]), board([task({ assignee: 'kimi' })]), NAMES), [])
  assert.deepEqual(diffBoards(board([]), board([task({ assignee: 'dsh', created_by: 'dsh' })]), NAMES), [])
})

await check('diffBoards: new pool tasks notify; ones I created do not', () => {
  const pooled = task()
  const lines = diffBoards(board([]), board([pooled]), NAMES)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /new in pool \(by human\)/)
  assert.deepEqual(diffBoards(board([]), board([task({ created_by: 'dsh-agent' })]), NAMES), [])
})

await check('diffBoards: verdicts (approved/rejected/done) on MY tasks notify, others do not', () => {
  const held = task({ assignee: 'dsh', status: 'review' })
  const approved = withEvent(held, 'approved', 'human')
  const lines = diffBoards(board([held]), board([approved]), NAMES)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /approved by human/)

  const created = task({ created_by: 'dsh', assignee: 'kimi', status: 'review' })
  const rejected = withEvent(created, 'rejected', 'human', 'needs a test')
  const rejectedLines = diffBoards(board([created]), board([rejected]), NAMES)
  assert.equal(rejectedLines.length, 1)
  assert.match(rejectedLines[0], /rejected by human — needs a test/)

  const doneLines = diffBoards(board([held]), board([withEvent(held, 'done', 'human')]), NAMES)
  assert.equal(doneLines.length, 1)

  // Someone else's task approved, and a verdict I recorded myself: silent.
  const alien = task({ assignee: 'kimi', created_by: 'kimi', status: 'review' })
  assert.deepEqual(diffBoards(board([alien]), board([withEvent(alien, 'approved', 'human')]), NAMES), [])
  assert.deepEqual(diffBoards(board([held]), board([withEvent(held, 'approved', 'dsh')]), NAMES), [])
})

await check('diffBoards: new comments on my tasks notify (others and self-echo do not)', () => {
  const mine = task({ assignee: 'dsh' })
  const commented = { ...mine, comments: [{ at: 'x', by: 'human', text: '验收过了' }] }
  const lines = diffBoards(board([mine]), board([commented]), NAMES)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /new comment by human: 验收过了/)

  const selfComment = { ...mine, comments: [{ at: 'x', by: 'dsh', text: 'my own note' }] }
  assert.deepEqual(diffBoards(board([mine]), board([selfComment]), NAMES), [])

  const alien = task({ assignee: 'kimi', created_by: 'kimi' })
  const alienComment = { ...alien, comments: [{ at: 'x', by: 'human', text: 'not your business' }] }
  assert.deepEqual(diffBoards(board([alien]), board([alienComment]), NAMES), [])

  // Several new comments merge into one line per task.
  const twice = { ...mine, comments: [{ at: 'x', by: 'human', text: 'one' }, { at: 'y', by: 'claude', text: 'two' }] }
  const merged = diffBoards(board([mine]), board([twice]), NAMES)
  assert.equal(merged.length, 1)
  assert.match(merged[0], /2 new comments \(latest by claude\)/)
})

// ------------------------------------------- watcher integration (fake fs)

const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-watch-'))

await check('watcher: change → debounced diff → one injected notice', async () => {
  const changeCallbacks = new Map()
  const notices = []
  let liveAgents = [{ id: 'a1', cwd: ws }]
  const watcher = createBoardWatcher({
    loadBoard,
    resolveAgents: () => liveAgents,
    injectNotice: (agentId, text) => notices.push({ agentId, text }),
    names: NAMES,
    log: () => {},
    watchDir: (cwd, onChange) => {
      changeCallbacks.set(cwd, onChange)
      return () => changeCallbacks.delete(cwd)
    },
    debounceMs: 5,
    throttleMs: 60,
    reconcileMs: 60_000, // never fires during the test; start() reconciles once
  })
  const stop = watcher.start()
  try {
    assert.ok(changeCallbacks.has(ws), 'the live session\'s .dsh dir is watched')
    await sleep(30) // let the baseline load land (first sight never notifies)

    // 1) a task assigned to dsh by the human → one notice.
    await createTask(ws, { title: 'review the watcher', assignee: 'dsh' }, 'human')
    changeCallbacks.get(ws)()
    await sleep(30)
    assert.equal(notices.length, 1, JSON.stringify(notices))
    assert.equal(notices[0].agentId, 'a1')
    assert.match(notices[0].text, /\[board change\]/)
    assert.match(notices[0].text, /T-1 · assigned to you \(by human\)/)
    assert.match(notices[0].text, /taskboard_get/)

    // 2) storm: two pool tasks inside the 60ms window merge into ONE notice.
    await createTask(ws, { title: 'pool one' }, 'human')
    changeCallbacks.get(ws)()
    await createTask(ws, { title: 'pool two' }, 'human')
    changeCallbacks.get(ws)()
    await sleep(20) // debounced pokes ran, but the storm window holds the flush
    assert.equal(notices.length, 1, 'storm window holds the second notice back')
    await sleep(100)
    assert.equal(notices.length, 2, 'merged notice flushed when the window closed')
    assert.match(notices[1].text, /T-2 · new in pool/)
    assert.match(notices[1].text, /T-3 · new in pool/)

    // 3) no live session in the workspace → dropped, not injected.
    liveAgents = []
    await sleep(80) // let the storm window slide past
    await createTask(ws, { title: 'nobody home' }, 'human')
    changeCallbacks.get(ws)()
    await sleep(40)
    assert.equal(notices.length, 2, 'a workspace without a live session is not notified')

    // 4) self-actions never echo: the store writes by dsh itself.
    liveAgents = [{ id: 'a1', cwd: ws }]
    await createTask(ws, { title: 'my own task', assignee: 'dsh' }, 'dsh-agent')
    changeCallbacks.get(ws)()
    await sleep(40)
    assert.equal(notices.length, 2, 'own actions do not echo back')
  } finally {
    stop()
    assert.equal(changeCallbacks.size, 0, 'stop unwatches everything')
  }
})

await check('watcher: reconcile drops a workspace whose session went away', async () => {
  const changeCallbacks = new Map()
  let liveAgents = [{ id: 'a1', cwd: ws }]
  const watcher = createBoardWatcher({
    loadBoard,
    resolveAgents: () => liveAgents,
    injectNotice: () => {},
    names: NAMES,
    log: () => {},
    watchDir: (cwd, onChange) => {
      changeCallbacks.set(cwd, onChange)
      return () => changeCallbacks.delete(cwd)
    },
    reconcileMs: 60_000,
  })
  const stop = watcher.start()
  try {
    assert.ok(changeCallbacks.has(ws))
    liveAgents = []
    watcher.reconcile()
    assert.ok(!changeCallbacks.has(ws), 'unwatched once no live session remains')
    liveAgents = [{ id: 'a2', cwd: ws }]
    watcher.reconcile()
    assert.ok(changeCallbacks.has(ws), 're-watched when a session comes back')
  } finally {
    stop()
  }
})

// -------------------------------------------------------------- apply wiring

function fakeCtx() {
  const effects = []
  const ctx = {
    logger: () => ({ info: () => {} }),
    tools: { register: () => () => {} },
    sessions: { get: () => ({ header: { cwd: ws } }) },
    inject: (deps, callback) => {
      const [dep] = [...deps]
      if (dep === 'webServer') return callback({ effect: () => {}, webServer: { register: () => () => {} } })
      if (dep === 'systemPrompt') return callback({ systemPrompt: { section: () => () => {} } })
      if (dep === 'agents') {
        return callback({
          effect: (fn, description) => effects.push(description), // effect body never runs: no real watcher
          agents: { list: () => [{ id: 'a1', inject: () => {} }], get: (id) => ({ id, inject: () => {} }) },
        })
      }
      throw new Error(`unexpected soft dependency: ${dep}`)
    },
    on: () => () => {},
  }
  return { ctx, effects }
}

await check('apply wires the board watcher through ctx.inject(["agents"])', () => {
  delete process.env.TASKBOARD_WATCH
  const { ctx, effects } = fakeCtx()
  apply(ctx)
  assert.deepEqual(effects, ['taskboard-kit: board watcher'])
})

await check('TASKBOARD_WATCH=0 disables the watcher entirely', () => {
  process.env.TASKBOARD_WATCH = '0'
  try {
    const { ctx, effects } = fakeCtx()
    apply(ctx)
    assert.deepEqual(effects, [], 'no watcher effect registered')
  } finally {
    delete process.env.TASKBOARD_WATCH
  }
})

// ------------------------------------- sibling sessions + clock-driven audit

await check('diffBoards: a declared sibling session is mine, yet its actions still reach me', () => {
  const before = board([task({ id: 'T-1', created_by: 'dsh-audit', assignee: 'dsh-audit' })])
  const after = board([task({ id: 'T-1', created_by: 'dsh-audit', assignee: 'dsh-audit' })])
  // The sibling holds the card and hands a review to itself — but on a board
  // where it is declared as a sibling, that card is OURS, so its action is news.
  after.tasks['T-1'].reviewer = 'dsh-audit'
  after.tasks['T-1'].log.push({ at: '2026-09-26T01:00:00.000Z', by: 'dsh-audit', event: 'submitted' })
  const withSibling = diffBoards(before, after, NAMES, ['dsh-audit'])
  assert.ok(withSibling.some((line) => line.includes('review requested from you')), JSON.stringify(withSibling))

  // Undeclared, the exact same change belongs to a stranger: not my news.
  const withoutSibling = diffBoards(before, after, NAMES, [])
  assert.deepEqual(withoutSibling, [])
})

await check('diffBoards: my own action is still silent when siblings are declared', () => {
  const before = board([task({ id: 'T-1', created_by: 'human' })])
  const after = board([task({ id: 'T-1', created_by: 'human' })])
  after.tasks['T-1'].comments.push({ at: '2026-09-26T01:00:00.000Z', by: 'dsh', text: 'mine' })
  assert.deepEqual(diffBoards(before, after, NAMES, ['dsh-audit']), [])
})

await check('watcher: the clock-driven audit nudges my stale card WITHOUT any file change', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-taskboard-audit-'))
  const notices = []
  const watcher = createBoardWatcher({
    loadBoard,
    resolveAgents: () => [{ id: 'a1', cwd }],
    injectNotice: (_id, text) => notices.push(text),
    names: NAMES,
    log: () => {},
    watchDir: () => () => {},
    reconcileMs: 60_000,
  })
  const stop = watcher.start()
  try {
    const mine = await createTask(cwd, { title: 'my stalled work', assignee: 'dsh-agent' }, 'dsh-agent')
    await updateTask(cwd, mine.id, { action: 'start' }, 'dsh-agent')
    // Age the card past the in_progress SLA by rewriting the log clock.
    const agedBoard = await loadBoard(cwd)
    for (const entry of agedBoard.tasks[mine.id].log) entry.at = new Date(Date.now() - 100 * 3600_000).toISOString()
    await saveBoard(cwd, agedBoard)

    await watcher.audit(cwd)
    assert.equal(notices.length, 1, JSON.stringify(notices))
    assert.match(notices[0], /self-audit/)
    assert.match(notices[0], new RegExp(mine.id))
    assert.match(notices[0], /stalled_mine/)

    // Throttled: an identical item set does not nag again right away.
    await watcher.audit(cwd)
    assert.equal(notices.length, 1)
  } finally {
    stop()
    await rm(cwd, { recursive: true, force: true })
  }
})

await check('watcher: a human wait past the SLA escalates out-of-band, once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-taskboard-escalate-'))
  const escalated = []
  const watcher = createBoardWatcher({
    loadBoard,
    resolveAgents: () => [{ id: 'a1', cwd }],
    injectNotice: () => {},
    names: NAMES,
    log: () => {},
    watchDir: () => () => {},
    reconcileMs: 60_000,
    onHumanWaitOverdue: (escalation) => escalated.push(escalation),
  })
  const stop = watcher.start()
  try {
    const parked = await createTask(cwd, { title: 'parked on the human' }, 'dsh-agent')
    await updateTask(cwd, parked.id, {
      action: 'block', wait_kind: 'human', wait_who: 'iceskysl', wait_question: 'go/no-go?',
    }, 'dsh-agent')
    const agedBoard = await loadBoard(cwd)
    agedBoard.tasks[parked.id].waiting_on.since = new Date(Date.now() - 30 * 3600_000).toISOString()
    await saveBoard(cwd, agedBoard)

    await watcher.audit(cwd)
    assert.equal(escalated.length, 1, JSON.stringify(escalated))
    assert.equal(escalated[0].task.id, parked.id)
    assert.equal(escalated[0].question, 'go/no-go?')
    assert.equal(escalated[0].reason, 'overdue')
    // Escalation rides the same throttle window: no repeat nagging.
    await watcher.audit(cwd)
    assert.equal(escalated.length, 1)
  } finally {
    stop()
    await rm(cwd, { recursive: true, force: true })
  }
})

await rm(ws, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
