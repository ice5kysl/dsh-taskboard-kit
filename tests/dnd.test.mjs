/**
 * Drag-and-drop planning tests for the ownerless-card dead end.
 *
 * `start` only requires `open` and never sets an assignee, while `reopen`
 * keeps whatever assignee there was. So the pre-fix `[reopen, start]` plan
 * could move an unowned card into 进行中 with no owner — a state `claim`
 * refuses (it needs `open`), recoverable only by stopping it into the pool
 * first. The plan must CLAIM such a card instead.
 *
 * Run: node tests/dnd.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// The shared DnD planner ships in the browser bundle, so load it the way the
// shell does: through the __ModuleLoader__ envelope.
let envelope
globalThis.window = { __ModuleLoader__: { load: (captured) => { envelope = captured } } }
await import('../lib/client.js')
assert.ok(envelope, 'client bundle must register itself with the module loader')
const client = envelope.factory((specifier) => createRequire(import.meta.url)(specifier))
const { planDrop } = client

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

const claim = { kind: 'claim' }
const update = (patch) => ({ kind: 'update', patch })

console.log('dsh-taskboard-kit DnD plan test:')

check('an unowned finished card is claimed, not started ownerless', () => {
  assert.deepEqual(planDrop({ status: 'done', assignee: null }, 'in_progress'), [update({ action: 'reopen' }), claim])
  assert.deepEqual(planDrop({ status: 'closed', assignee: null }, 'in_progress'), [update({ action: 'reopen' }), claim])
})

check('an owned finished card is reopened and started', () => {
  assert.deepEqual(planDrop({ status: 'done', assignee: 'kimi' }, 'in_progress'), [
    update({ action: 'reopen' }),
    update({ action: 'start' }),
  ])
})

check('an unowned review card goes back to the pool and is claimed', () => {
  assert.deepEqual(planDrop({ status: 'review', assignee: null }, 'in_progress'), [
    update({ action: 'reject' }),
    update({ action: 'stop' }),
    claim,
  ])
  assert.deepEqual(planDrop({ status: 'review', assignee: 'kimi' }, 'in_progress'), [update({ action: 'reject' })])
})

check('the ownerless dead end is unreachable from every start state', () => {
  const starts = [
    { status: 'open', assignee: null },
    { status: 'open', assignee: 'kimi' },
    { status: 'review', assignee: null },
    { status: 'review', assignee: 'kimi' },
    { status: 'done', assignee: null },
    { status: 'done', assignee: 'kimi' },
    { status: 'closed', assignee: null },
  ]
  for (const task of starts) {
    const plan = planDrop(task, 'in_progress')
    if (plan.length === 0) continue
    // A plan that ends in 进行中 must either already have an owner, or assign
    // one — i.e. a plan whose first op is `reopen` on an unowned card must
    // contain a claim.
    const reopened = plan.some((op) => op.kind === 'update' && op.patch.action === 'reopen')
    if (reopened && !task.assignee) {
      assert.ok(plan.some((op) => op.kind === 'claim'), `unowned ${task.status} plan must claim: ${JSON.stringify(plan)}`)
    }
  }
})

check('the other columns are unchanged', () => {
  assert.deepEqual(planDrop({ status: 'in_progress', assignee: 'kimi' }, 'in_progress'), [])
  assert.deepEqual(planDrop({ status: 'open', assignee: null }, 'pool'), [])
  assert.deepEqual(planDrop({ status: 'review', assignee: 'kimi' }, 'review'), [])
  assert.deepEqual(planDrop({ status: 'review', assignee: 'kimi' }, 'done'), [update({ action: 'approve' })])
  assert.deepEqual(planDrop({ status: 'done', assignee: 'kimi' }, 'closed'), [update({ action: 'close' })])
})

console.log(failed === 0 ? '\nall DnD plan checks passed' : `\n${failed} DnD plan check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
