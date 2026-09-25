/**
 * Browser-face smoke test for dsh-taskboard-kit (no browser needed).
 *
 * The built browser bundle (lib/client.js) is loaded through the official
 * `window.__ModuleLoader__` envelope, its factory is executed with a require
 * that resolves the shell-seeded externals (react, react/jsx-runtime), and
 * the resulting exports are asserted:
 *
 *   1. module shape — name 'taskboard-kit', inject ['slots'];
 *   2. apply() — registers the「看板」conversation.view tab (id 'taskboard',
 *      order 40) against a fake slots ctx, and the injected store is real;
 *   3. the shared board math re-exported from the bundle — columnOf's four
 *      column derivations and compareTasks' priority-then-age ordering.
 *
 * Run: node tests/client.test.mjs   (or: npm test)
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// Pin the browser locale to English before the bundle's locale module reads
// `navigator.language` (node 20 has no global navigator; node 21+ has one
// whose language follows the host ICU locale — either way, pin it).
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true })
} catch {
  /* a non-configurable navigator still resolves to English for this suite */
}

const require_ = createRequire(import.meta.url)

// -------------------------------------------------------------- bundle load

let envelope
globalThis.window = {
  __ModuleLoader__: {
    load: (captured) => {
      envelope = captured
    },
  },
}
await import('../lib/client.js')
assert.ok(envelope, 'client bundle must register itself with the module loader')
const client = envelope.factory((specifier) => require_(specifier))

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

console.log('dsh-taskboard-kit browser-face smoke test:')

// --------------------------------------------------------- module shape

await check('bundle: the module-loader envelope names the package', () => {
  assert.equal(envelope.id, 'dsh-taskboard-kit')
  assert.equal(client.name, 'taskboard-kit')
  assert.deepEqual([...client.inject], ['slots'])
  assert.equal(client.TASKBOARD_VIEW_ID, 'taskboard')
})

// ------------------------------------------------------------ apply()

await check('apply(): the「看板」conversation view tab is registered', () => {
  const registrations = []
  const injections = []
  const disposers = []
  const ctx = {
    logger: () => ({ info: () => {} }),
    effect: (fn) => {
      const dispose = fn()
      const disposer = () => {
        if (typeof dispose === 'function') dispose()
      }
      disposers.push(disposer)
      return disposer
    },
    slots: {
      inject: (slot, callback) => {
        injections.push(slot)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  assert.deepEqual([...new Set(injections)], ['conversation.view'])

  // The「看板」view tab sits after 对话 | 轨迹 | 文件 | 消息 (order 40).
  const view = registrations.find((row) => row.options.name === 'conversation.view')
  assert.ok(view, 'a conversation.view registration exists')
  assert.equal(view.options.id, 'taskboard')
  assert.equal(view.options.order, 40)
  assert.equal(view.options.label(), 'Board')
  assert.equal(typeof view.component, 'function')

  // The slot share is the page-wide store.
  const store = view.options.inject().store
  assert.equal(typeof store.getState, 'function')
  assert.equal(typeof store.subscribe, 'function')
  const state = store.getState()
  assert.equal(state.status, 'loading')
  assert.equal(state.board, null)
  assert.equal(state.showClosed, false)

  // Effects: just the board poller — its disposer must stop the interval.
  assert.equal(disposers.length, 1)
  for (const dispose of disposers) dispose()
})

// --------------------------------------------------------- shared board math

await check('columnOf: the five statuses map onto the six columns', () => {
  // open + no assignee → the claimable pool
  assert.equal(client.columnOf({ status: 'open', assignee: null }), 'pool')
  // open + assignee → delegated, not yet started
  assert.equal(client.columnOf({ status: 'open', assignee: 'kimi' }), 'assigned')
  // the other four statuses map one-to-one onto their columns
  assert.equal(client.columnOf({ status: 'in_progress', assignee: 'kimi' }), 'in_progress')
  assert.equal(client.columnOf({ status: 'review', assignee: 'kimi' }), 'review')
  assert.equal(client.columnOf({ status: 'done', assignee: 'kimi' }), 'done')
  assert.equal(client.columnOf({ status: 'closed', assignee: null }), 'closed')
})

await check('compareTasks: priority first, then oldest first', () => {
  const task = (id, priority, created_at) => ({ id, priority, created_at })
  const high = task('T-1', 'high', '2026-09-20T09:00:00Z')
  const medium = task('T-2', 'medium', '2026-09-19T09:00:00Z')
  const low = task('T-3', 'low', '2026-09-18T09:00:00Z')

  // Priority dominates age: the younger high still precedes medium and low.
  const sorted = [low, medium, high].sort(client.compareTasks)
  assert.deepEqual(sorted.map((row) => row.id), ['T-1', 'T-2', 'T-3'])
  assert.ok(client.compareTasks(high, medium) < 0)
  assert.ok(client.compareTasks(low, high) > 0)

  // Same priority: oldest first; same timestamp: id breaks the tie.
  const older = task('T-4', 'medium', '2026-09-18T09:00:00Z')
  const newer = task('T-5', 'medium', '2026-09-19T09:00:00Z')
  assert.ok(client.compareTasks(older, newer) < 0)
  assert.ok(client.compareTasks(newer, older) > 0)
  const tieA = task('T-6', 'low', '2026-09-18T09:00:00Z')
  const tieB = task('T-7', 'low', '2026-09-18T09:00:00Z')
  assert.ok(client.compareTasks(tieA, tieB) < 0)
  assert.equal(client.compareTasks(tieA, tieA), 0)
})

// --------------------------------------------------------- drag-and-drop semantics

await check('planDrop: drops compile into the six-column op sequences', () => {
  assert.equal(typeof client.planDrop, 'function')
  const poolCard = { status: 'open', assignee: null }
  const assignedCard = { status: 'open', assignee: 'kimi' }
  const wipCard = { status: 'in_progress', assignee: 'kimi' }
  const reviewCard = { status: 'review', assignee: 'kimi' }
  const doneCard = { status: 'done', assignee: 'kimi' }
  const closedCard = { status: 'closed', assignee: 'kimi' }

  // 待认领 → 待审核: claim first, then submit.
  assert.deepEqual(client.planDrop(poolCard, 'review'), [
    { kind: 'claim' },
    { kind: 'update', patch: { action: 'submit' } },
  ])
  // 已指派 → 待审核: start, then submit.
  assert.deepEqual(client.planDrop(assignedCard, 'review'), [
    { kind: 'update', patch: { action: 'start' } },
    { kind: 'update', patch: { action: 'submit' } },
  ])
  // 进行中 → 待审核: just submit.
  assert.deepEqual(client.planDrop(wipCard, 'review'), [{ kind: 'update', patch: { action: 'submit' } }])
  // 待审核 → 进行中: reject (打回继续干).
  assert.deepEqual(client.planDrop(reviewCard, 'in_progress'), [{ kind: 'update', patch: { action: 'reject' } }])
  // 待审核 → 已完成: approve.
  assert.deepEqual(client.planDrop(reviewCard, 'done'), [{ kind: 'update', patch: { action: 'approve' } }])
  // Anything not closed → 已关闭: close.
  assert.deepEqual(client.planDrop(poolCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  assert.deepEqual(client.planDrop(wipCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  assert.deepEqual(client.planDrop(reviewCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  assert.deepEqual(client.planDrop(doneCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  // 已完成/已关闭 never go back to 待审核.
  assert.deepEqual(client.planDrop(doneCard, 'review'), [])
  assert.deepEqual(client.planDrop(closedCard, 'review'), [])
  // Dropping where the card already lives is a no-op — no request may fire.
  assert.deepEqual(client.planDrop(poolCard, 'pool'), [])
  assert.deepEqual(client.planDrop(reviewCard, 'review'), [])
  assert.deepEqual(client.planDrop(doneCard, 'done'), [])
  assert.deepEqual(client.planDrop(closedCard, 'closed'), [])
  assert.deepEqual(client.planDrop(assignedCard, 'assigned', 'kimi'), [])
  // 已指派 with an EMPTY name means 放回待认领: same plan as a drop on pool.
  assert.deepEqual(client.planDrop(assignedCard, 'assigned', ''), [{ kind: 'update', patch: { assignee: null } }])
  assert.deepEqual(client.planDrop(assignedCard, 'assigned', '   '), [{ kind: 'update', patch: { assignee: null } }])
  // 待审核 → 待认领: reject back to 进行中, then stop + unassign.
  assert.deepEqual(client.planDrop(reviewCard, 'pool'), [
    { kind: 'update', patch: { action: 'reject' } },
    { kind: 'update', patch: { action: 'stop', assignee: null } },
  ])
  // A finished card dropped on 进行中 needs both halves, in order.
  assert.deepEqual(client.planDrop(doneCard, 'in_progress'), [
    { kind: 'update', patch: { action: 'reopen' } },
    { kind: 'update', patch: { action: 'start' } },
  ])
  // 已完成 → 已指派 with a name: reopen straight into that assignee.
  assert.deepEqual(client.planDrop(doneCard, 'assigned', 'nova'), [{ kind: 'update', patch: { action: 'reopen', assignee: 'nova' } }])
})

// --------------------------------------------------------- actor roster

await check('knownActors: union of all four sources, cleaned and sorted', () => {
  assert.equal(typeof client.knownActors, 'function')
  const task = (over) => ({
    id: 'T-x', title: 't', detail: '', status: 'open', priority: 'medium',
    assignee: null, tags: [], created_by: 'human', created_at: '2026-09-20T09:00:00Z',
    updated_at: '2026-09-20T09:00:00Z', log: [], comments: [], ...over,
  })
  const board = {
    version: 1, workspace: '/work/a', next_seq: 5,
    tasks: {
      // assignee + created_by + log[].by + comments[].by; duplicates across
      // sources collapse; null assignee and empty by are dropped.
      'T-1': task({
        id: 'T-1', assignee: 'kimi', created_by: 'human',
        log: [{ at: '2026-09-20T09:00:00Z', by: 'kimi', event: 'claimed' }, { at: '2026-09-20T10:00:00Z', by: 'claude', event: 'started' }],
        comments: [{ at: '2026-09-21T09:00:00Z', by: 'dsh', text: 'handoff' }],
      }),
      'T-2': task({
        id: 'T-2', assignee: null, created_by: 'human',
        log: [{ at: '2026-09-20T09:00:00Z', by: '', event: 'created' }, { at: '2026-09-20T09:01:00Z', by: 'claude', event: 'updated' }],
        comments: [],
      }),
      'T-3': task({ id: 'T-3', assignee: 'agent-x', created_by: 'agent-x' }),
    },
  }
  assert.deepEqual(client.knownActors(board), ['agent-x', 'claude', 'dsh', 'human', 'kimi'])
  // An empty board has an empty roster (the UI shows the hint, not a dead input).
  assert.deepEqual(client.knownActors({ version: 1, workspace: '/work/b', next_seq: 1, tasks: {} }), [])
})

// ------------------------------------------------------------------ done

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
