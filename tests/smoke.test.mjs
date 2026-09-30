/**
 * Standalone smoke test for the host face (no cordis runtime needed).
 *
 * Applies the plugin to a minimal fake ctx (logger / tools / sessions /
 * webServer / systemPrompt / on), then exercises the whole contract:
 *   - five taskboard_* tools are registered, the bridge is mounted, the
 *     system-prompt section is added
 *   - the tools drive a full lifecycle: create → list → claim → done → get
 *   - the browser bridge answers GET /board, rejects non-loopback callers,
 *     and rejects mutations without the x-taskboard header
 *   - a session start with work on the board injects a context-only notice
 *
 * Run: node tests/smoke.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

process.env.TASKBOARDKIT_LOCALE = 'en'
delete process.env.TASKBOARD_ACTOR

const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-smoke-'))

const { apply, inject, name: pluginName, BRIDGE_PREFIX } = await import('../lib/index.js')

// ------------------------------------------------------------- fake dsh host

const tools = []
const webRoutes = []
const promptSections = []
const listeners = {}

apply({
  logger: () => ({ info: () => {} }),
  tools: { register: (tool) => tools.push(tool) },
  sessions: { get: () => ({ header: { cwd: ws } }) },
  // Optional faces are mounted through cordis' soft dependency injection.
  inject: (deps, callback) => {
    const [dep] = [...deps]
    if (dep === 'webServer') {
      return callback({
        effect: (fn) => fn(),
        webServer: {
          register: (route) => {
            webRoutes.push(route)
            return () => {}
          },
        },
      })
    }
    if (dep === 'systemPrompt') {
      return callback({
        systemPrompt: {
          section: (options) => {
            promptSections.push(options)
            return () => {}
          },
        },
      })
    }
    if (dep === 'agents') {
      // No live agents in this harness: the board watcher stays off, tools unaffected.
      return callback({})
    }
    throw new Error(`unexpected soft dependency: ${dep}`)
  },
  on: (name, listener) => {
    listeners[name] = listener
    return () => {}
  },
})

const tool = (name) => tools.find((entry) => entry.name === name)
const exec = { agent: 'a1' }

// Fake req/res for the collected bridge handler. req must be async-iterable
// (the bridge reads POST bodies with `for await`).
function fakeReq({ method, url, body, headers = {}, remoteAddress = '127.0.0.1' }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:4321', ...headers }
  req.socket = { remoteAddress }
  return req
}

function fakeRes() {
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  return {
    status: 0,
    body: '',
    done,
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.body = payload ?? ''
      resolveDone()
    },
    json() {
      return this.body ? JSON.parse(this.body) : undefined
    },
  }
}

async function callBridge(req) {
  const res = fakeRes()
  // The collected wrapper voids the bridge promise, so wait for end() instead.
  await webRoutes[0].handler(req, res)
  await res.done
  return res
}

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

console.log('dsh-taskboard-kit host smoke test:')

await check('plugin identity: name + inject declare the cordis contract', () => {
  assert.equal(pluginName, 'taskboard-kit')
  assert.deepEqual([...inject], ['tools', 'sessions'])
})

await check('registers the eight taskboard model tools', () => {
  assert.deepEqual(tools.map((entry) => entry.name).sort(), [
    'taskboard_claim',
    'taskboard_comment',
    'taskboard_create',
    'taskboard_get',
    'taskboard_inbox',
    'taskboard_list',
    'taskboard_roster',
    'taskboard_update',
  ])
})

await check('mounts the /dsh-taskboard browser bridge on the web server', () => {
  assert.equal(BRIDGE_PREFIX, '/dsh-taskboard')
  assert.equal(webRoutes.length, 1)
  assert.equal(webRoutes[0].kind, 'prefix')
  assert.equal(webRoutes[0].path, '/dsh-taskboard')
  assert.equal(typeof webRoutes[0].handler, 'function')
})

await check('adds the collaboration protocol to the system prompt', () => {
  assert.equal(promptSections.length, 1)
  assert.equal(promptSections[0].name, 'taskboard:rules')
  assert.equal(promptSections[0].order, 5000)
  const text = promptSections[0].text
  // The protocol must teach the whole loop, not just the tool names.
  assert.match(text, /taskboard_inbox/)
  assert.match(text, /taskboard_claim/)
  assert.match(text, /action=submit, reviewer=/)
  assert.match(text, /action=block/)
  assert.match(text, /unblock/)
  assert.match(text, /cannot review your own work/)
  assert.match(text, /never edit the JSON by hand/i)
})

await check('listens for agent/session-start', () => {
  assert.equal(typeof listeners['agent/session-start'], 'function')
})

// ----------------------------------------------------------- tool lifecycle

await check('taskboard_create allocates T-1 (default actor dsh-agent)', async () => {
  const text = await tool('taskboard_create').execute(
    { title: 'write the host face', detail: 'store + tools + http + index', priority: 'high', tags: ['host'] },
    exec,
  )
  assert.ok(text.includes('T-1'), text)
  assert.ok(text.includes('claimable pool'), text)

  const second = await tool('taskboard_create').execute({ title: 'write the client face', by: 'kimi' }, exec)
  assert.ok(second.includes('T-2'), second)
})

await check('taskboard_list shows summary lines and totals', async () => {
  const text = await tool('taskboard_list').execute({}, exec)
  assert.ok(text.includes('T-1 · open · unassigned · high · write the host face'), text)
  assert.ok(text.includes('T-2 · open'), text)
  assert.ok(text.includes('board totals: open 2'), text)

  const poolOnly = await tool('taskboard_list').execute({ column: 'pool' }, exec)
  assert.ok(poolOnly.includes('2 task(s)'), poolOnly)
  const noneHigh = await tool('taskboard_list').execute({ assignee: 'none', status: 'done' }, exec)
  assert.ok(noneHigh.includes('No tasks match'), noneHigh)
})

await check('taskboard_claim takes T-1; a second claim gets a friendly conflict', async () => {
  const text = await tool('taskboard_claim').execute({ id: 'T-1' }, exec)
  assert.ok(text.includes('Claimed T-1 (in_progress · dsh-agent)'), text)

  const again = await tool('taskboard_claim').execute({ id: 'T-1', by: 'kimi' }, exec)
  assert.ok(again.includes('Cannot claim T-1'), again)
  assert.ok(again.includes('held by dsh-agent'), again)
  assert.ok(!/Error:|at\s+\w+\s+\(/.test(again), `conflict must not leak a stack: ${again}`)
})

await check('taskboard_update moves T-1 to done with a note', async () => {
  const text = await tool('taskboard_update').execute({ id: 'T-1', action: 'done', note: 'host face shipped' }, exec)
  assert.ok(text.includes('Updated T-1: done'), text)
  assert.ok(text.includes('Now done'), text)

  const illegal = await tool('taskboard_update').execute({ id: 'T-1', action: 'start' }, exec)
  assert.ok(illegal.includes('not allowed'), illegal)

  const missing = await tool('taskboard_update').execute({ id: 'T-999', action: 'done' }, exec)
  assert.ok(missing.includes('Task not found'), missing)
})

await check('taskboard_get renders the full task and its timeline', async () => {
  const text = await tool('taskboard_get').execute({ id: 'T-1' }, exec)
  assert.ok(text.includes('T-1 · done · high'), text)
  assert.ok(text.includes('write the host face'), text)
  assert.ok(text.includes('store + tools + http + index'), text)
  assert.ok(text.includes('tags: host'), text)
  assert.ok(text.includes('timeline:'), text)
  assert.ok(text.includes('· created'), text)
  assert.ok(text.includes('· claimed'), text)
  assert.ok(text.includes('· done — host face shipped'), text)
})

await check('taskboard_comment leaves a comment without touching the state', async () => {
  const text = await tool('taskboard_comment').execute(
    { id: 'T-2', text: 'handoff: the client face is mid-flight, api.ts is the seam', by: 'kimi' },
    exec,
  )
  assert.ok(text.includes('Commented on T-2'), text)

  const full = await tool('taskboard_get').execute({ id: 'T-2' }, exec)
  assert.ok(full.includes('T-2 · open'), full, 'state untouched')
  assert.ok(full.includes('comments:'), full)
  assert.ok(full.includes('kimi · handoff: the client face is mid-flight'), full)

  const empty = await tool('taskboard_comment').execute({ id: 'T-2', text: '   ' }, exec)
  assert.ok(empty.includes('Invalid input'), empty)
})

await check('the review flow: claim → submit → reject → submit → approve', async () => {
  await tool('taskboard_claim').execute({ id: 'T-2', by: 'kimi' }, exec)

  const submitted = await tool('taskboard_update').execute({ id: 'T-2', action: 'submit', by: 'kimi' }, exec)
  assert.ok(submitted.includes('Updated T-2: submitted. Now review'), submitted)

  const tooEarly = await tool('taskboard_update').execute({ id: 'T-2', action: 'start' }, exec)
  assert.ok(tooEarly.includes('not allowed'), tooEarly, 'review cannot restart directly')

  const rejected = await tool('taskboard_update').execute({ id: 'T-2', action: 'reject', note: 'needs a test', by: 'human' }, exec)
  assert.ok(rejected.includes('Updated T-2: rejected. Now in_progress'), rejected)

  await tool('taskboard_update').execute({ id: 'T-2', action: 'submit', by: 'kimi' }, exec)
  const approved = await tool('taskboard_update').execute({ id: 'T-2', action: 'approve', by: 'human' }, exec)
  assert.ok(approved.includes('Updated T-2: approved. Now done'), approved)

  const full = await tool('taskboard_get').execute({ id: 'T-2' }, exec)
  for (const event of ['claimed', 'submitted', 'rejected', 'approved']) {
    assert.ok(full.includes(`· ${event}`), `${event} missing from the timeline:\n${full}`)
  }
  assert.ok(full.includes('· rejected — needs a test'), full, 'the rejection note rides the event')

  // One more pool task, so the session-start notice at the end still has work
  // waiting in the pool.
  const created = await tool('taskboard_create').execute({ title: 'another pool task', value: 3 }, exec)
  assert.ok(created.includes('T-3'), created)
  const valued = await tool('taskboard_list').execute({}, exec)
  assert.ok(valued.includes('T-3 · open · unassigned · medium · v3 · another pool task'), valued)
})

// -------------------------------------------------------------- bridge http

await check('bridge: GET /board from loopback answers ok:true with the board', async () => {
  const res = await callBridge(fakeReq({ method: 'GET', url: `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}` }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.board.version, 1)
  assert.equal(body.board.tasks['T-1'].status, 'done')
  assert.equal(body.board.tasks['T-2'].status, 'done')
  assert.equal(body.board.tasks['T-3'].status, 'open')
  assert.equal(body.board.tasks['T-3'].value, 3)
})

await check('bridge: GET /board on a missing file still answers an empty board', async () => {
  const res = await callBridge(fakeReq({ method: 'GET', url: `/dsh-taskboard/board?cwd=${encodeURIComponent(join(ws, 'nowhere'))}` }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.board.tasks, {})
})

// A boardless READ stays permissive on purpose (the「开启看板」state); the sharp
// edge is a WRITE, which `requireCwd(..., mutating)` refuses on an unknown
// whitelist — the three-state × direction matrix lives in tests/http.test.mjs.

await check('bridge: a non-loopback caller is 403', async () => {
  const res = await callBridge(fakeReq({ method: 'GET', url: `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}`, remoteAddress: '10.0.0.5' }))
  assert.equal(res.status, 403)
  assert.equal(res.json().ok, false)
})

await check('bridge: a cross-origin browser page is 403', async () => {
  const res = await callBridge(fakeReq({
    method: 'GET',
    url: `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}`,
    headers: { origin: 'https://evil.example' },
  }))
  assert.equal(res.status, 403)
})

await check('bridge: POST without the x-taskboard header is 403', async () => {
  const res = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/create',
    body: { cwd: ws, title: 'sneaky' },
  }))
  assert.equal(res.status, 403)
  assert.equal(res.json().ok, false)
})

await check('bridge: POST /create with the mutate header creates as human', async () => {
  const res = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/create',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, title: 'from the kanban', priority: 'low', value: 5 },
  }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.task.id, 'T-4')
  assert.equal(body.task.created_by, 'human')
  assert.equal(body.task.value, 5, 'value passes through the bridge')

  const board = await callBridge(fakeReq({ method: 'GET', url: `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}` }))
  assert.equal(board.json().board.tasks['T-4'].title, 'from the kanban')
})

await check('bridge: POST /update walks submit → approve as human', async () => {
  await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/claim',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id: 'T-4' },
  }))
  const submitted = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/update',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id: 'T-4', action: 'submit' },
  }))
  assert.equal(submitted.status, 200)
  assert.equal(submitted.json().task.status, 'review')
  const approved = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/update',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id: 'T-4', action: 'approve' },
  }))
  assert.equal(approved.status, 200)
  assert.equal(approved.json().task.status, 'done')
})

await check('bridge: a claim conflict stays HTTP 200 with code conflict', async () => {
  const created = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/create',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, title: 'claimable via panel' },
  }))
  const id = created.json().task.id // T-5

  const first = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/claim',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id },
  }))
  assert.equal(first.status, 200)
  assert.equal(first.json().ok, true)

  const second = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/claim',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id },
  }))
  assert.equal(second.status, 200)
  assert.deepEqual({ ok: second.json().ok, code: second.json().code }, { ok: false, code: 'conflict' })
})

await check('bridge: POST /comment without the mutate header is 403', async () => {
  const res = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/comment',
    body: { cwd: ws, id: 'T-5', text: 'sneaky' },
  }))
  assert.equal(res.status, 403)
  assert.equal(res.json().ok, false)
})

await check('bridge: POST /comment with the mutate header comments as human', async () => {
  const res = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/comment',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id: 'T-5', text: 'looks good from the kanban' },
  }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.task.id, 'T-5')
  assert.equal(body.task.comments.length, 1)
  assert.equal(body.task.comments[0].by, 'human')
  assert.equal(body.task.comments[0].text, 'looks good from the kanban')
  assert.equal(body.task.status, 'in_progress', 'commenting never moves the state')
})

await check('bridge: unknown route is 404', async () => {
  const res = await callBridge(fakeReq({ method: 'GET', url: '/dsh-taskboard/nope' }))
  assert.equal(res.status, 404)
  assert.equal(res.json().ok, false)
})

// ---------------------------------------------------------- session notice

await check('session start injects a context-only board notice (work is waiting)', async () => {
  const injected = []
  const agent = { id: 'a1', inject: (message) => injected.push(message), followup: () => assert.fail('must not wake') }
  listeners['agent/session-start']({ agent })
  // The hook is fire-and-forget; wait for its async body to land.
  for (let attempt = 0; attempt < 100 && injected.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(injected.length, 1, 'expected one injected notice')
  const notice = injected[0]
  assert.equal(notice.role, 'user')
  // v4 producer-owned source kind — matches dsh's v3→v4 migrator output for
  // the retired { kind: 'plugin', plugin: 'taskboard-kit' } wrapper.
  assert.equal(notice.source.kind, 'plugin:taskboard-kit')
  assert.equal('plugin' in notice.source, false)
  assert.equal(notice.source.form, 'notice')
  // T-2 sits in the pool; T-3 is in_progress (claimed by human above).
  const text = notice.content[0].text
  // The notice is the agent's own actionable slice, not a bare board count.
  assert.match(text, /taskboard_inbox/, text)
  assert.match(text, /item\(s\) on you/, text)
  assert.match(text, /T-\d+/, text)
  assert.ok(!text.includes('claimable'), `the old bare-count wording is gone: ${text}`)
})

await rm(ws, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
