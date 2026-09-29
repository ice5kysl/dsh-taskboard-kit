/**
 * Bridge-face tests for dsh-taskboard-kit: the trust gate and the `cwd` guard.
 *
 * These are the two ways a *local* bridge can still be turned into a
 * filesystem primitive by someone else's web page:
 *
 *   1. trusting a self-consistent `Host`+`Origin` pair (DNS rebinding);
 *   2. accepting any absolute `cwd` (any `<dir>/.dsh/taskboard.json`).
 *
 * No port is bound: the handler is driven with fake req/res objects.
 *
 * Run: node tests/http.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'

const { createTaskboardBridge, isTrustedRequest } = await import('../lib/index.js')

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

/** A minimal IncomingMessage stand-in. */
const req = (headers, remoteAddress = '127.0.0.1', method = 'GET', url = '/') => ({
  method,
  url,
  headers,
  socket: { remoteAddress },
})

/** A minimal ServerResponse stand-in that records what was sent. */
function res() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-http-'))

console.log('dsh-taskboard-kit bridge test:')

await check('a self-consistent Host+Origin pair is still untrusted (DNS rebinding)', async () => {
  // The attacker's page resolves its own domain to 127.0.0.1, so these two
  // headers agree — and that agreement is exactly what must NOT be trusted.
  assert.equal(isTrustedRequest(req({ host: 'evil.com:3080', origin: 'http://evil.com:3080' })), false)
  assert.equal(isTrustedRequest(req({ host: 'evil.com:3080', origin: 'http://evil.com:3080' }, '10.0.0.5')), false)
  assert.equal(isTrustedRequest(req({ host: 'evil.com:3080' })), false, 'no Origin, non-loopback Host')
  assert.equal(isTrustedRequest(req({ host: 'localhost:3080' })), true, 'loopback Host, no Origin (curl/test)')
  assert.equal(
    isTrustedRequest(req({ host: 'localhost:3080', origin: 'http://localhost:3080' }, '10.0.0.5')),
    false,
    'a remote peer is rejected even with a matching Origin',
  )
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true)
  assert.equal(isTrustedRequest(req({ host: '[::1]:3080', origin: 'http://[::1]:3080' })), true)
  assert.equal(
    isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })),
    false,
    'port mismatch',
  )
  assert.equal(
    isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://evil.com:3080' })),
    false,
    'hostname mismatch',
  )
  assert.equal(isTrustedRequest(req({ origin: 'http://localhost:3080' })), false, 'no Host at all')
})

/** The bridge under test: /etc is the one cwd the fake host does not serve. */
function bridge() {
  const deps = {
    loadBoard: async (cwd) => ({ version: 1, workspace: cwd, next_seq: 1, tasks: {} }),
    createTask: async (cwd, input) => ({ id: 'T-1', ...input }),
    claimTask: async () => ({ id: 'T-1' }),
    updateTask: async () => ({ task: { id: 'T-1' }, events: [] }),
    addComment: async () => ({ id: 'T-1' }),
    isAllowedCwd: (cwd) => cwd !== '/etc',
    log: () => {},
  }
  return createTaskboardBridge(deps)
}

const trusted = { host: '127.0.0.1:3080' }

await check('cwd must be absolute, traversal-free and a workspace this host serves', async () => {
  const board = bridge()

  const relative = res()
  await board.handle(req(trusted, '127.0.0.1', 'GET', `/dsh-taskboard/board?cwd=${encodeURIComponent('relative/dir')}`), relative)
  assert.equal(relative.status, 400)

  const traversal = res()
  await board.handle(req(trusted, '127.0.0.1', 'GET', `/dsh-taskboard/board?cwd=${encodeURIComponent('/tmp/../etc')}`), traversal)
  assert.equal(traversal.status, 400, 'a `..` segment is rejected')

  const outside = res()
  await board.handle(req(trusted, '127.0.0.1', 'GET', `/dsh-taskboard/board?cwd=${encodeURIComponent('/etc')}`), outside)
  assert.equal(outside.status, 403, 'a cwd outside the served workspaces is refused')

  const missing = res()
  await board.handle(req(trusted, '127.0.0.1', 'GET', '/dsh-taskboard/board'), missing)
  assert.equal(missing.status, 400)

  const allowed = res()
  await board.handle(req(trusted, '127.0.0.1', 'GET', `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}`), allowed)
  assert.equal(allowed.status, 200)
  assert.equal(JSON.parse(allowed.body).ok, true)
  assert.equal(allowed.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(allowed.headers['Cache-Control'], 'no-store')
})

await check('an untrusted caller is refused before anything else', async () => {
  const board = bridge()
  const response = res()
  await board.handle(req({ host: 'evil.com:3080', origin: 'http://evil.com:3080' }, '127.0.0.1', 'GET', '/dsh-taskboard/board?cwd=/etc'), response)
  assert.equal(response.status, 403)
})

await check('a mutation needs the mutate header (checked before the body)', async () => {
  const board = bridge()
  const bare = res()
  // No body at all: the header guard must reject before anything is read.
  await board.handle(req(trusted, '127.0.0.1', 'POST', '/dsh-taskboard/create'), bare)
  assert.equal(bare.status, 403, 'no x-taskboard header')
})

await check('an unexpected failure is sanitized (no paths, no file bytes)', async () => {
  const board = createTaskboardBridge({
    loadBoard: async () => {
      throw new Error("EACCES: permission denied, open '/Users/someone/secret/.dsh/taskboard.json'")
    },
    createTask: async () => ({}),
    claimTask: async () => ({}),
    updateTask: async () => ({ task: {}, events: [] }),
    addComment: async () => ({}),
    log: () => {},
  })
  const response = res()
  await board.handle(req(trusted, '127.0.0.1', 'GET', `/dsh-taskboard/board?cwd=${encodeURIComponent(ws)}`), response)
  assert.equal(response.status, 500)
  assert.ok(!response.body.includes('/Users/someone'), 'the absolute path is not echoed')
  assert.ok(!response.body.includes('EACCES'), 'the raw error is not echoed')
  assert.equal(JSON.parse(response.body).error, 'internal error')
})

await check('a workspace with a board file is served even when its session is not live', async () => {
  // The panel legitimately switches to an older session's workspace; the host's
  // live-session list cannot know it, so refusing would break the kanban. What
  // stays closed is creating `.dsh/` in a directory nobody ever used.
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const known = await mkdtemp(join(tmpdir(), 'dsh-taskboard-known-'))
  const fresh = await mkdtemp(join(tmpdir(), 'dsh-taskboard-fresh-'))
  try {
    await mkdir(join(known, '.dsh'), { recursive: true })
    await writeFile(join(known, '.dsh', 'taskboard.json'), JSON.stringify({ version: 1, workspace: known, next_seq: 1, tasks: {} }))

    const board = bridge() // only /etc is refused, but we widen the refusal:
    const strict = createTaskboardBridge({
      loadBoard: async (cwd) => ({ version: 1, workspace: cwd, next_seq: 1, tasks: {} }),
      createTask: async (cwd, input) => ({ id: 'T-1', ...input }),
      claimTask: async () => ({ id: 'T-1' }),
      updateTask: async () => ({ task: { id: 'T-1' }, events: [] }),
      addComment: async () => ({ id: 'T-1' }),
      // This host serves nothing at all: every cwd is "not in the whitelist".
      isAllowedCwd: () => false,
      log: () => {},
    })

    const served = res()
    await strict.handle(req(trusted, '127.0.0.1', 'GET', `/dsh-taskboard/board?cwd=${encodeURIComponent(known)}`), served)
    assert.equal(served.status, 200, 'an existing board is readable even outside the live list')

    const refused = res()
    await strict.handle(req(trusted, '127.0.0.1', 'GET', `/dsh-taskboard/board?cwd=${encodeURIComponent(fresh)}`), refused)
    assert.equal(refused.status, 403, 'a boardless directory is not a workspace we serve')
    assert.match(JSON.parse(refused.body).error, /no board file/)

    assert.ok(board, 'the shared fixture bridge still builds')
  } finally {
    await rm(known, { recursive: true, force: true })
    await rm(fresh, { recursive: true, force: true })
  }
})

console.log(failed === 0 ? '\nall bridge checks passed' : `\n${failed} bridge check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
