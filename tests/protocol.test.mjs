/**
 * Collaboration-protocol test for dsh-taskboard-kit v0.5.4.
 *
 * The five suites that came before cover "the board works". This one covers
 * "multiple agents can actually get along on it": identity/aliases, review
 * ownership, cards parked on a human, staleness, the inbox ranking, and the
 * out-of-band human notification hook.
 *
 * Run: npm test   (or: node tests/protocol.test.mjs)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const lib = await import('../lib/index.js')
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'taskboard.mjs')

process.env.TASKBOARDKIT_LOCALE = 'en'
delete process.env.TASKBOARD_ACTOR
delete process.env.TASKBOARD_WATCH_NAMES
delete process.env.TASKBOARD_ALLOW_SELF_REVIEW
delete process.env.TASKBOARD_NOTIFY_CMD
process.env.TASKBOARD_HUMANS = 'iceskysl'

const HOUR = 3_600_000

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

async function freshWorkspace() {
  return mkdtemp(join(tmpdir(), 'dsh-taskboard-protocol-'))
}

/** Rewrite timestamps in place — the honest way to test clocks without waiting. */
async function age(ws, id, { columnMs = 0, waitMs = 0, quietActor = null, quietMs = 0 } = {}) {
  const board = await lib.loadBoard(ws)
  const task = board.tasks[id]
  if (columnMs > 0) {
    for (const entry of task.log) entry.at = new Date(Date.now() - columnMs).toISOString()
    task.created_at = new Date(Date.now() - columnMs).toISOString()
    task.updated_at = new Date(Date.now() - columnMs).toISOString()
  }
  if (waitMs > 0 && task.waiting_on) task.waiting_on.since = new Date(Date.now() - waitMs).toISOString()
  if (quietActor && board.actors[quietActor]) {
    board.actors[quietActor].last_seen_at = new Date(Date.now() - quietMs).toISOString()
  }
  await lib.saveBoard(ws, board)
  return task
}

console.log('dsh-taskboard-kit collaboration protocol test:')

// ----------------------------------------------------------- identity/roster

await check('roster: aliases unify dsh and dsh-agent into ONE owner', async () => {
  const ws = await freshWorkspace()
  await lib.createTask(ws, { title: 'by the canonical name' }, 'dsh')
  await lib.createTask(ws, { title: 'by an alias' }, 'dsh-agent')
  const board = await lib.loadBoard(ws)
  const names = Object.keys(board.actors)
  assert.equal(names.length, 1, `expected one roster entry, got ${JSON.stringify(names)}`)
  assert.equal(names[0], 'dsh')
  assert.ok(board.actors.dsh.aliases.includes('dsh-agent'))
  assert.ok(lib.sameActor(board, 'dsh', 'dsh-agent'))
  assert.ok(!lib.sameActor(board, 'dsh', 'kimi'))
  await rm(ws, { recursive: true, force: true })
})

await check('roster: acting refreshes last_seen_at; a referenced name has none', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'delegated', assignee: 'claude' }, 'dsh')
  let board = await lib.loadBoard(ws)
  assert.equal(lib.actorSeenAt(board, 'claude'), null, 'being named is not evidence of being alive')
  assert.equal(typeof lib.actorSeenAt(board, 'dsh'), 'string')
  await lib.addComment(ws, task.id, 'a note', 'claude')
  board = await lib.loadBoard(ws)
  assert.equal(typeof lib.actorSeenAt(board, 'claude'), 'string', 'acting IS evidence')
  await rm(ws, { recursive: true, force: true })
})

await check('roster: TASKBOARD_ACTOR_ALIASES adds groups; roster() reports quiet time', async () => {
  const ws = await freshWorkspace()
  process.env.TASKBOARD_ACTOR_ALIASES = 'kimi:kimi-code|kimi-cli'
  await lib.createTask(ws, { title: 'via alias' }, 'kimi-code')
  const entries = await lib.roster(ws)
  const kimi = entries.find((entry) => entry.name === 'kimi')
  assert.ok(kimi, `expected a canonical kimi entry, got ${JSON.stringify(entries.map((e) => e.name))}`)
  assert.deepEqual(kimi.entry.aliases.sort(), ['kimi-cli', 'kimi-code'])
  assert.equal(typeof kimi.quietMs, 'number')
  delete process.env.TASKBOARD_ACTOR_ALIASES
  await rm(ws, { recursive: true, force: true })
})

await check('legacy boards get a roster derived from the log (no "never acted" lie)', async () => {
  const ws = await freshWorkspace()
  // A board written the way pre-0.5.4 versions did: tasks + log, no actors.
  const legacy = {
    version: 1,
    workspace: ws,
    next_seq: 3,
    tasks: {
      'T-1': {
        id: 'T-1', title: 'old work', detail: '', status: 'in_progress', assignee: 'kimi',
        priority: 'medium', value: null, tags: [], created_by: 'claude', created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-02T00:00:00.000Z',
        log: [
          { at: '2026-09-01T00:00:00.000Z', by: 'claude', event: 'created' },
          { at: '2026-09-02T00:00:00.000Z', by: 'kimi', event: 'claimed' },
        ],
        comments: [{ at: '2026-09-03T00:00:00.000Z', by: 'iceskysl', text: 'go ahead' }],
      },
    },
  }
  await lib.saveBoard(ws, legacy)
  const board = await lib.loadBoard(ws)
  assert.equal(lib.actorSeenAt(board, 'kimi'), '2026-09-02T00:00:00.000Z', 'the log is activity evidence')
  assert.equal(lib.actorSeenAt(board, 'claude'), '2026-09-01T00:00:00.000Z')
  assert.equal(lib.actorSeenAt(board, 'iceskysl'), '2026-09-03T00:00:00.000Z', 'comments count too')
  assert.equal(lib.resolveActor(board, 'iceskysl').kind, 'human', 'TASKBOARD_HUMANS still applies')

  // An entry that exists with last_seen_at: null (a name that was only ever
  // *referenced*, e.g. set as an assignee) is filled from the evidence, while a
  // real recorded observation stays untouched.
  const withRoster = await lib.loadBoard(ws)
  withRoster.actors['referenced-only'] = { kind: 'agent', aliases: [], first_seen_at: '2026-08-01T00:00:00.000Z', last_seen_at: null }
  withRoster.tasks['T-1'].comments.push({ at: '2026-09-04T00:00:00.000Z', by: 'referenced-only', text: 'now I acted' })
  withRoster.actors['kimi'].last_seen_at = '2026-09-02T00:00:00.000Z'
  await lib.saveBoard(ws, withRoster)
  const backfilled = await lib.loadBoard(ws)
  assert.equal(lib.actorSeenAt(backfilled, 'referenced-only'), '2026-09-04T00:00:00.000Z', 'null gets filled from evidence')
  assert.equal(lib.actorSeenAt(backfilled, 'kimi'), '2026-09-02T00:00:00.000Z', 'a recorded observation is never overwritten')
  await rm(ws, { recursive: true, force: true })
})

// ------------------------------------------------------------ review ownership

await check('submit names a reviewer: explicit flag wins', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'work' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'start' }, 'kimi')
  const { task: submitted } = await lib.updateTask(ws, task.id, { action: 'submit', reviewer: 'claude' }, 'kimi')
  assert.equal(submitted.status, 'review')
  assert.equal(submitted.reviewer, 'claude')
  await rm(ws, { recursive: true, force: true })
})

await check('submit without a reviewer falls back to the creator, then the human', async () => {
  const ws = await freshWorkspace()
  // kimi creates and does the work; dsh (the creator) is not the author → dsh reviews.
  const delegated = await lib.createTask(ws, { title: 'delegated work', assignee: 'kimi' }, 'dsh')
  await lib.updateTask(ws, delegated.id, { action: 'start' }, 'kimi')
  const first = await lib.updateTask(ws, delegated.id, { action: 'submit' }, 'kimi')
  assert.equal(first.task.reviewer, 'dsh')

  // Nobody else has ever acted → the human is the last resort.
  const solo = await lib.createTask(ws, { title: 'solo work' }, 'kimi')
  await lib.updateTask(ws, solo.id, { action: 'start' }, 'kimi')
  const second = await lib.updateTask(ws, solo.id, { action: 'submit' }, 'kimi')
  assert.equal(second.task.reviewer, 'dsh', 'the only other actor on the roster takes the review')

  const lonely = await freshWorkspace()
  const reallySolo = await lib.createTask(lonely, { title: 'really solo' }, 'kimi')
  await lib.updateTask(lonely, reallySolo.id, { action: 'start' }, 'kimi')
  const third = await lib.updateTask(lonely, reallySolo.id, { action: 'submit' }, 'kimi')
  assert.equal(third.task.reviewer, lib.HUMAN_ACTOR, 'with no other agent at all, the human reviews')
  await rm(lonely, { recursive: true, force: true })
  await rm(ws, { recursive: true, force: true })
})

await check('self-review is refused (and TASKBOARD_ALLOW_SELF_REVIEW=1 is the escape hatch)', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'solo' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'start' }, 'kimi')
  await assert.rejects(
    () => lib.updateTask(ws, task.id, { action: 'submit', reviewer: 'kimi' }, 'kimi'),
    (error) => error.code === 'invalid-input' && /cannot review your own work/.test(error.message),
  )
  process.env.TASKBOARD_ALLOW_SELF_REVIEW = '1'
  const { task: submitted } = await lib.updateTask(ws, task.id, { action: 'submit', reviewer: 'kimi' }, 'kimi')
  assert.equal(submitted.reviewer, 'kimi')
  delete process.env.TASKBOARD_ALLOW_SELF_REVIEW
  await rm(ws, { recursive: true, force: true })
})

await check('approve/reject belong to the reviewer, the creator or the human — nobody else', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'reviewed work', assignee: 'kimi' }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'start' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')

  await assert.rejects(
    () => lib.updateTask(ws, task.id, { action: 'approve' }, 'claude'),
    (error) => error.code === 'conflict' && /waiting for dsh/.test(error.message),
  )
  // The creator can step in (accountable for their own delegation)…
  const { task: approved } = await lib.updateTask(ws, task.id, { action: 'approve' }, 'dsh')
  assert.equal(approved.status, 'done')
  assert.equal(approved.reviewer, null, 'the reviewer field is cleared once decided')
  await rm(ws, { recursive: true, force: true })
})

await check('the human can always decide, even on someone else\'s review', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'escalated', assignee: 'kimi' }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'start' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  const { task: rejected } = await lib.updateTask(ws, task.id, { action: 'reject', note: 'not convincing' }, lib.HUMAN_ACTOR)
  assert.equal(rejected.status, 'in_progress')
  assert.equal(rejected.log.at(-1).note, 'not convincing')
  await rm(ws, { recursive: true, force: true })
})

// -------------------------------------------------------- waiting on someone

await check('block records who the card waits on WITHOUT moving the status', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'needs a decision' }, 'dsh')
  const { task: blocked, events } = await lib.updateTask(ws, task.id, {
    action: 'block',
    wait_kind: 'human',
    wait_who: 'iceskysl',
    wait_question: 'Ship the 0.5.4 bump now, or wait for T-8?',
  }, 'dsh')
  assert.deepEqual(events, ['blocked'])
  assert.equal(blocked.status, 'open', 'parked ≠ a new status')
  assert.equal(blocked.waiting_on.kind, 'human')
  assert.equal(blocked.waiting_on.who, 'iceskysl')
  assert.match(blocked.waiting_on.question, /0\.5\.4/)
  assert.equal((await lib.listTasks(ws, { waiting: 'human' })).length, 1)

  const { task: unblocked, events: unblockEvents } = await lib.updateTask(ws, task.id, { action: 'unblock' }, 'iceskysl')
  assert.deepEqual(unblockEvents, ['unblocked'])
  assert.equal(unblocked.waiting_on, null)
  await assert.rejects(
    () => lib.updateTask(ws, task.id, { action: 'unblock' }, 'dsh'),
    (error) => error.code === 'invalid-transition',
  )
  await rm(ws, { recursive: true, force: true })
})

await check('block needs a question; the kind can be inferred from who', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'needs a decision' }, 'dsh')
  await assert.rejects(
    () => lib.updateTask(ws, task.id, { action: 'block', wait_kind: 'human' }, 'dsh'),
    (error) => error.code === 'invalid-input' && /wait_question/.test(error.message),
  )
  await assert.rejects(
    () => lib.updateTask(ws, task.id, { action: 'block', wait_question: 'who?' }, 'dsh'),
    (error) => error.code === 'invalid-input' && /wait_kind/.test(error.message),
  )
  const { task: inferred } = await lib.updateTask(ws, task.id, {
    action: 'block', wait_who: 'kimi', wait_question: 'are you done with T-3?',
  }, 'dsh')
  assert.equal(inferred.waiting_on.kind, 'agent', 'a named human → human, otherwise agent')
  const { task: namedHuman } = await lib.updateTask(ws, task.id, {
    action: 'block', wait_who: 'iceskysl', wait_question: 'and you?',
  }, 'dsh')
  assert.equal(namedHuman.waiting_on.kind, 'human', 'TASKBOARD_HUMANS marks the human')
  await rm(ws, { recursive: true, force: true })
})

await check('a card waiting on someone is NOT claimable (parked ≠ unowned)', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'T-8 style: needs the human to schedule it' }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'block', wait_kind: 'human', wait_who: 'iceskysl', wait_question: 'schedule it?' }, 'dsh')
  await assert.rejects(
    () => lib.claimTask(ws, task.id, 'kimi'),
    (error) => error.code === 'conflict' && /waiting on human/.test(error.message),
  )
  // …and it is not offered as a pool pick either.
  const items = lib.inboxFor(await lib.loadBoard(ws), 'kimi', { poolLimit: 5 })
  assert.equal(items.filter((item) => item.kind === 'pool_pick').length, 0)
  await rm(ws, { recursive: true, force: true })
})

// ------------------------------------------------------------ staleness/inbox

await check('staleness: column age comes from the last COLUMN event, not from chatter', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'sits in review' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'start' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  await age(ws, task.id, { columnMs: 30 * HOUR })
  // A comment must NOT reset the clock — otherwise chatter hides stalled work.
  await lib.addComment(ws, task.id, 'anyone there?', 'kimi')
  const aged = await lib.getTask(ws, task.id)
  const staleness = lib.stalenessOf(aged)
  assert.ok(staleness.ageMs >= 29 * HOUR, `age ${staleness.ageMs}`)
  assert.equal(staleness.stale, true, 'review SLA is 24h by default')
  assert.ok(staleness.overdueMs > 0)
  await rm(ws, { recursive: true, force: true })
})

await check('enableBoard: creates the board and the workspace protocol doc', async () => {
  const ws = await freshWorkspace()
  const result = await lib.enableBoard(ws)

  assert.equal(result.already_existed, false, 'a virgin workspace had no board')
  assert.equal(result.board_file, join(ws, '.dsh', 'taskboard.json'))
  assert.equal(result.protocol_file, join(ws, '.dsh', 'BOARD-PROTOCOL.md'))

  // The board is real and usable straight away.
  const board = await lib.loadBoard(ws)
  assert.deepEqual(board.tasks, {}, 'a fresh board has no tasks')
  assert.equal(board.workspace, resolve(ws), 'workspace records the absolute cwd')

  // The doc must carry the one rule an agent cannot infer: closed-only terminal.
  const doc = await readFile(join(ws, '.dsh', 'BOARD-PROTOCOL.md'), 'utf8')
  assert.match(doc, /只有 closed 是终点/, 'states the terminal-status rule')
  assert.match(doc, /done.*还没结清|还没结清/, 'explains done still owes a settle')
  assert.match(doc, /不要手改|永远不要手改/, 'warns against hand-editing the JSON')
  await rm(ws, { recursive: true, force: true })
})

await check('enableBoard: is idempotent and NEVER rewrites existing data', async () => {
  const ws = await freshWorkspace()
  await lib.enableBoard(ws)

  // Real work lands on the board, and the project edits its own protocol doc —
  // both must survive a second enable untouched.
  const task = await lib.createTask(ws, { title: 'precious work' }, 'kimi')
  const docPath = join(ws, '.dsh', 'BOARD-PROTOCOL.md')
  await writeFile(docPath, '# 本项目自己的规范（改过了）\n', 'utf8')

  const again = await lib.enableBoard(ws)
  assert.equal(again.already_existed, true, 'reports the board was already there')
  assert.equal(again.protocol_file, null, 'no protocol rewrite was attempted')

  const board = await lib.loadBoard(ws)
  assert.equal(board.tasks[task.id].title, 'precious work', 'the task survived')
  assert.equal(await readFile(docPath, 'utf8'), '# 本项目自己的规范（改过了）\n', 'the edited doc survived')

  // seedProtocol:false creates only the board.
  const bare = await freshWorkspace()
  const noSeed = await lib.enableBoard(bare, { seedProtocol: false })
  assert.equal(noSeed.protocol_file, null, 'no doc when seeding is off')
  await assert.rejects(readFile(join(bare, '.dsh', 'BOARD-PROTOCOL.md')), 'and it really is absent')
  await rm(bare, { recursive: true, force: true })
  await rm(ws, { recursive: true, force: true })
})

await check('staleness: only SETTLED cards never go stale; done still does', async () => {
  const ws = await freshWorkspace()
  const fresh = await lib.createTask(ws, { title: 'just now' }, 'kimi')
  assert.equal(lib.isStale(await lib.getTask(ws, fresh.id)), false)

  // done is NOT terminal (v0.6): approved-but-unclosed work goes stale like
  // any other unfinished card, because the missing close IS the rot.
  const done = await lib.createTask(ws, { title: 'finished long ago' }, 'kimi')
  await lib.updateTask(ws, done.id, { action: 'done' }, 'kimi')
  await age(ws, done.id, { columnMs: 365 * 24 * HOUR })
  assert.equal(lib.isStale(await lib.getTask(ws, done.id)), true, 'a done-but-unsettled card goes stale')

  // closed is the one terminal status: settled work is never "late".
  const closed = await lib.createTask(ws, { title: 'settled long ago' }, 'kimi')
  await lib.updateTask(ws, closed.id, { action: 'done' }, 'kimi')
  await lib.updateTask(ws, closed.id, { action: 'close' }, 'kimi')
  await age(ws, closed.id, { columnMs: 365 * 24 * HOUR })
  assert.equal(lib.isStale(await lib.getTask(ws, closed.id)), false, 'a settled card is not late')
  await rm(ws, { recursive: true, force: true })
})

await check('the two-step close: done is not terminal, and an unsettled card is chased', async () => {
  const ws = await freshWorkspace()

  // A normal flow: claim → start → submit → approve lands in `done`.
  const task = await lib.createTask(ws, { title: 'ship the thing', assignee: 'kimi' }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'start' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  await lib.updateTask(ws, task.id, { action: 'approve' }, 'dsh')
  assert.equal((await lib.getTask(ws, task.id)).status, 'done', 'approve lands in done')

  // done is NOT terminal: it still shows up as work on the owner's plate, and
  // the owner gets an inbox item telling them to close it out.
  const afterApprove = await lib.loadBoard(ws)
  const mine = lib.inboxFor(afterApprove, 'kimi').filter((i) => i.kind === 'settle_mine')
  assert.deepEqual(mine.map((i) => i.task.id), [task.id], 'the owner is told to settle it')
  assert.match(mine[0].suggest, /--action close/, 'the suggested command is the settle')

  // And the board health names it as its own failure mode.
  const health = lib.boardHealth(afterApprove)
  assert.deepEqual(health.needsSettling.map((i) => i.task.id), [task.id], 'unsettled work is a health finding')

  // Once closed it leaves both lists — the card is settled.
  await lib.updateTask(ws, task.id, { action: 'close' }, 'kimi')
  const settled = await lib.loadBoard(ws)
  assert.equal((await lib.getTask(ws, task.id)).status, 'closed')
  assert.deepEqual(lib.inboxFor(settled, 'kimi').filter((i) => i.kind === 'settle_mine'), [], 'settled work leaves the inbox')
  assert.deepEqual(lib.boardHealth(settled).needsSettling, [], 'settled work leaves the health list')

  // reopen undoes a wrong settle (done|closed → open).
  await lib.updateTask(ws, task.id, { action: 'reopen' }, 'kimi')
  assert.equal((await lib.getTask(ws, task.id)).status, 'open', 'reopen takes it back to the board')

  await rm(ws, { recursive: true, force: true })
})

await check('inbox: ranked review_owed → unblock_me → returned → stalled → assigned → pool', async () => {
  const ws = await freshWorkspace()
  // A review dsh owes.
  const review = await lib.createTask(ws, { title: 'awaiting my verdict', assignee: 'kimi' }, 'dsh')
  await lib.updateTask(ws, review.id, { action: 'start' }, 'kimi')
  await lib.updateTask(ws, review.id, { action: 'submit', reviewer: 'dsh' }, 'kimi')
  // Someone waiting on dsh.
  const waiting = await lib.createTask(ws, { title: 'blocked on me' }, 'kimi')
  await lib.updateTask(ws, waiting.id, { action: 'block', wait_who: 'dsh', wait_question: 'can you re-run the audit?' }, 'kimi')
  // A card returned to dsh after a rejection.
  const returned = await lib.createTask(ws, { title: 'sent back to me', assignee: 'dsh' }, 'kimi')
  await lib.updateTask(ws, returned.id, { action: 'start' }, 'dsh')
  await lib.updateTask(ws, returned.id, { action: 'submit', reviewer: 'kimi' }, 'dsh')
  await lib.updateTask(ws, returned.id, { action: 'reject', note: 'needs evidence' }, 'kimi')
  // A pool task worth claiming.
  await lib.createTask(ws, { title: 'free work', priority: 'high', value: 5 }, 'kimi')

  const items = lib.inboxFor(await lib.loadBoard(ws), 'dsh')
  const kinds = items.map((item) => item.kind)
  assert.deepEqual(kinds, ['review_owed', 'unblock_me', 'returned', 'pool_pick'], JSON.stringify(kinds))
  assert.equal(items[0].task.id, review.id)
  assert.match(items[0].suggest, /approve\|reject/)
  assert.match(items[1].suggest, /unblock/)
  await rm(ws, { recursive: true, force: true })
})

await check('inbox: my own stale card and a delegate who went quiet both surface', async () => {
  const ws = await freshWorkspace()
  const mine = await lib.createTask(ws, { title: 'my stalled work', assignee: 'dsh' }, 'dsh')
  await lib.updateTask(ws, mine.id, { action: 'start' }, 'dsh')
  await age(ws, mine.id, { columnMs: 100 * HOUR })
  const delegated = await lib.createTask(ws, { title: 'handed to a ghost', assignee: 'claude' }, 'dsh')
  await lib.updateTask(ws, delegated.id, { action: 'start' }, 'claude')
  await age(ws, delegated.id, { columnMs: 100 * HOUR, quietActor: 'claude', quietMs: 100 * HOUR })

  const items = lib.inboxFor(await lib.loadBoard(ws), 'dsh')
  const kinds = items.map((item) => item.kind)
  assert.ok(kinds.includes('stalled_mine'), JSON.stringify(kinds))
  assert.ok(kinds.includes('orphaned_mine'), JSON.stringify(kinds))
  const orphan = items.find((item) => item.kind === 'orphaned_mine')
  assert.equal(orphan.actor, 'claude')
  assert.match(orphan.suggest, /--assignee/)
  await rm(ws, { recursive: true, force: true })
})

await check('a fresh delegation is NOT an orphan; only time makes one', async () => {
  const ws = await freshWorkspace()
  // Handing a card to a name that has never acted is a normal handoff…
  const fresh = await lib.createTask(ws, { title: 'just delegated', assignee: 'brand-new-agent' }, 'dsh')
  let board = await lib.loadBoard(ws)
  assert.deepEqual(lib.boardHealth(board).orphaned, [], 'assigning to a brand-new actor must not alarm immediately')
  assert.equal(lib.assigneeIsGone(board, board.tasks[fresh.id]).gone, false)
  // …but the same card, untouched for longer than the quiet window, is one.
  const aged = await lib.loadBoard(ws)
  for (const entry of aged.tasks[fresh.id].log) entry.at = new Date(Date.now() - 100 * HOUR).toISOString()
  await lib.saveBoard(ws, aged)
  board = await lib.loadBoard(ws)
  assert.equal(lib.assigneeIsGone(board, board.tasks[fresh.id]).gone, true)
  // The assignee is on the roster but has never acted: never-seen, not unknown.
  assert.equal(lib.assigneeIsGone(board, board.tasks[fresh.id]).reason, 'never-seen')
  assert.deepEqual(lib.boardHealth(board).orphaned.map((issue) => issue.task.id), [fresh.id])
  await rm(ws, { recursive: true, force: true })
})

await check('boardHealth separates the four failure modes, and waitingHuman is the human\'s list', async () => {
  const ws = await freshWorkspace()
  const human = await lib.createTask(ws, { title: 'needs iceskysl' }, 'dsh')
  await lib.updateTask(ws, human.id, { action: 'block', wait_kind: 'human', wait_who: 'iceskysl', wait_question: 'go/no-go?' }, 'dsh')
  const unowned = await lib.createTask(ws, { title: 'reviewed by nobody', assignee: 'kimi' }, 'dsh')
  await lib.updateTask(ws, unowned.id, { action: 'start' }, 'kimi')
  await lib.updateTask(ws, unowned.id, { action: 'submit' }, 'kimi')
  const board = await lib.loadBoard(ws)
  assert.equal(board.tasks[unowned.id].status, 'review')
  board.tasks[unowned.id].reviewer = null // legacy board shape: in review with nobody named
  await lib.saveBoard(ws, board)

  const health = lib.boardHealth(await lib.loadBoard(ws))
  assert.deepEqual(health.waitingHuman.map((issue) => issue.task.id), [human.id])
  assert.deepEqual(health.unownedReview.map((issue) => issue.task.id), [unowned.id])
  assert.equal(lib.waitingOnHuman(await lib.loadBoard(ws)).length, 1)
  assert.deepEqual(health.orphaned, [], 'kimi just acted, so nothing is orphaned yet')
  await rm(ws, { recursive: true, force: true })
})

await check('a human wait past its SLA is flagged as overdue (the escalation trigger)', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'parked too long' }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'block', wait_kind: 'human', wait_question: 'still waiting' }, 'dsh')
  await age(ws, task.id, { waitMs: 30 * HOUR })
  const aged = await lib.getTask(ws, task.id)
  const staleness = lib.stalenessOf(aged)
  assert.equal(staleness.waitOverdue, true)
  const items = lib.inboxFor(await lib.loadBoard(ws), 'dsh')
  const humanItem = items.find((item) => item.kind === 'human_blocked')
  assert.ok(humanItem, 'the agent must be told to go ping the human')
  // The board names the CONCEPT (a notify channel the agent owns), never one
  // vendor: a workspace with no msg9 must not read the suggestion as a
  // prerequisite. msg9 may appear as an example, never as the requirement.
  assert.match(humanItem.suggest, /通知通道/, 'the agent is told to use ITS channel, not a hard-coded one')
  assert.match(humanItem.suggest, /msg9/, 'msg9 survives as one example, not as a prerequisite')
  await rm(ws, { recursive: true, force: true })
})

// --------------------------------------------------------------- human notify

await check('notifyHuman: no hook wired → panel-only, nothing thrown', async () => {
  const result = await lib.notifyHuman(
    { cwd: '/tmp/x', task: { id: 'T-1' }, question: 'decide', reason: 'blocked', waitingBy: 'dsh', waitedMs: 0 },
    { log: () => {} },
  )
  assert.equal(result.delivered, false)
  assert.equal(result.how, 'none')
})

await check('notifyHuman: the hook receives the card on stdin and in env', async () => {
  const ws = await freshWorkspace()
  const task = await lib.createTask(ws, { title: 'blocked card', assignee: 'dsh' }, 'dsh')
  await lib.updateTask(ws, task.id, { action: 'block', wait_kind: 'human', wait_who: 'iceskysl', wait_question: 'Ship it?' }, 'dsh')
  const blocked = await lib.getTask(ws, task.id)

  const out = join(ws, 'notify.json')
  process.env.NOTIFY_OUT = out
  process.env.TASKBOARD_NOTIFY_CMD = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.env.NOTIFY_OUT,JSON.stringify({reason:process.env.TASKBOARD_NOTIFY_REASON,id:process.env.TASKBOARD_TASK_ID,question:process.env.TASKBOARD_QUESTION,stdin:JSON.parse(d)})))"`
  const result = await lib.notifyHuman(
    { cwd: ws, task: blocked, question: blocked.waiting_on.question, reason: 'blocked', waitingBy: 'dsh', waitedMs: 0 },
    { log: () => {} },
  )
  assert.equal(result.delivered, true)
  assert.equal(result.how, 'hook')

  const payload = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(payload.reason, 'blocked')
  assert.equal(payload.id, task.id)
  assert.equal(payload.question, 'Ship it?')
  assert.equal(payload.stdin.kind, 'taskboard.human')
  assert.equal(payload.stdin.task.id, task.id)
  assert.equal(payload.stdin.question, 'Ship it?')
  delete process.env.TASKBOARD_NOTIFY_CMD
  delete process.env.NOTIFY_OUT
  await rm(ws, { recursive: true, force: true })
})

await check('notifyHuman: a broken hook is logged and swallowed (the board never fails on it)', async () => {
  const logs = []
  process.env.TASKBOARD_NOTIFY_CMD = 'exit 7'
  const result = await lib.notifyHuman(
    { cwd: '/tmp/x', task: { id: 'T-9' }, question: 'q', reason: 'overdue', waitingBy: 'dsh', waitedMs: 1 },
    { log: (message) => logs.push(message) },
  )
  assert.equal(result.delivered, false)
  assert.equal(result.how, 'hook')
  assert.match(result.error, /exited 7/)
  assert.equal(logs.length, 1)
  delete process.env.TASKBOARD_NOTIFY_CMD
})

// ------------------------------------------------------------------- the CLI

await check('cli: block/unblock + inbox + stale + roster drive the same rules', async () => {
  const ws = await freshWorkspace()
  const cli = async (...args) => {
    const { stdout } = await run('node', [bin, '--cwd', ws, '--by', 'kimi', ...args])
    return stdout.trim()
  }
  const created = JSON.parse(await cli('create', '--title', 'cli 协议验证', '--json'))
  await cli('claim', created.id)

  // Blocking on the human parks the card and names it in the human list.
  const blocked = JSON.parse(await cli('update', created.id, '--action', 'block', '--who', 'iceskysl', '--question', '要不要现在发版？', '--json'))
  assert.equal(blocked.waiting_on.kind, 'human')
  assert.equal(blocked.status, 'in_progress', 'parking never fakes a status')
  const waiting = await cli('list', '--waiting', 'human')
  assert.match(waiting, new RegExp(created.id))
  assert.match(waiting, /wait:human\(iceskysl\)/)

  const stale = await cli('stale')
  assert.match(stale, /在等人类决定/)
  assert.match(stale, new RegExp(created.id))

  const inbox = await cli('inbox')
  assert.match(inbox, /waiting on the human \(go ping them\)/)

  const roster = await cli('roster')
  assert.match(roster, /kimi/)
  assert.match(roster, /iceskysl/)
  assert.match(roster, /never acted/, 'the human has not touched the board yet')

  const unblocked = JSON.parse(await cli('update', created.id, '--action', 'unblock', '--json'))
  assert.equal(unblocked.waiting_on, null)

  // Submit names a reviewer, and the verdict is enforced.
  const submitted = JSON.parse(await cli('update', created.id, '--action', 'submit', '--reviewer', 'dsh', '--json'))
  assert.equal(submitted.reviewer, 'dsh')
  const refused = await run('node', [bin, '--cwd', ws, '--by', 'claude', 'update', created.id, '--action', 'approve'])
    .then(() => null, (error) => error)
  assert.ok(refused, 'a third agent may not decide')
  assert.equal(refused.code, 3, 'conflict exit code')
  assert.match(refused.stderr, /waiting for dsh/)

  const approved = JSON.parse(await cli('update', created.id, '--action', 'approve', '--by', 'dsh', '--json'))
  assert.equal(approved.status, 'done')
  await rm(ws, { recursive: true, force: true })
})

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
