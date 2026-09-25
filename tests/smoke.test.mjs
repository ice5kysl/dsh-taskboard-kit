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

await check('registers the five taskboard model tools', () => {
  assert.deepEqual(tools.map((entry) => entry.name).sort(), [
    'taskboard_claim',
    'taskboard_create',
    'taskboard_get',
    'taskboard_list',
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

await check('adds the board rules to the system prompt', () => {
  assert.equal(promptSections.length, 1)
  assert.equal(promptSections[0].name, 'taskboard:rules')
  assert.equal(promptSections[0].order, 5000)
  assert.match(promptSections[0].text, /taskboard_list/)
  assert.match(promptSections[0].text, /taskboard_claim/)
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

// -------------------------------------------------------------- bridge http

await check('bridge: GET /board from loopback answers ok:true with the board', async () => {
  const res = await callBridge(fakeReq({ method: 'GET', url: `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}` }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.board.version, 1)
  assert.equal(body.board.tasks['T-1'].status, 'done')
  assert.equal(body.board.tasks['T-2'].status, 'open')
})

await check('bridge: GET /board on a missing file still answers an empty board', async () => {
  const res = await callBridge(fakeReq({ method: 'GET', url: `/dsh-taskboard/board?cwd=${encodeURIComponent(join(ws, 'nowhere'))}` }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.board.tasks, {})
})

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
    body: { cwd: ws, title: 'from the kanban', priority: 'low' },
  }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.task.id, 'T-3')
  assert.equal(body.task.created_by, 'human')

  const board = await callBridge(fakeReq({ method: 'GET', url: `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}` }))
  assert.equal(board.json().board.tasks['T-3'].title, 'from the kanban')
})

await check('bridge: a claim conflict stays HTTP 200 with code conflict', async () => {
  const first = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/claim',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id: 'T-3' },
  }))
  assert.equal(first.status, 200)
  assert.equal(first.json().ok, true)

  const second = await callBridge(fakeReq({
    method: 'POST',
    url: '/dsh-taskboard/claim',
    headers: { 'x-taskboard': 'mutate' },
    body: { cwd: ws, id: 'T-3' },
  }))
  assert.equal(second.status, 200)
  assert.deepEqual({ ok: second.json().ok, code: second.json().code }, { ok: false, code: 'conflict' })
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
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.plugin, 'taskboard-kit')
  assert.equal(notice.source.form, 'notice')
  // T-2 sits in the pool; T-3 is in_progress (claimed by human above).
  const text = notice.content[0].text
  assert.ok(text.includes('1 claimable'), text)
  assert.ok(text.includes('1 in-progress'), text)
  assert.ok(text.includes('taskboard_list'), text)
})

await rm(ws, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
