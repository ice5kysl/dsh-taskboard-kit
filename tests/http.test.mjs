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

const { createTaskboardBridge, defaultBridgeDeps, isTrustedRequest } = await import('../lib/index.js')

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

await check('★ zero live sessions is a FACT, not "unknown" — a fresh dir is still refused', async () => {
  // kimi 2026-09-30 真机复测抓到的洞：`live.length === 0 → undefined`
  // 把「服务拿不到」与「确定零会话」混为一谈，于是**没人用 dsh 时白名单整体退场** ——
  // 而"没人在用"恰恰是守护最该在场的场景（本机任意进程可往任意可写目录建板）。
  //
  // 这个用例按**生产形状**接线：fake ctx 只在 inject 里给 agents/sessions，
  // 且 list() 返回**空数组**（服务可达、事实为空）。
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const fresh = await mkdtemp(join(tmpdir(), 'dsh-taskboard-nolive-'))
  const withBoard = await mkdtemp(join(tmpdir(), 'dsh-taskboard-hasboard-'))
  try {
    const fakeCtx = {
      logger: () => ({ info: () => {} }),
      inject: (deps, callback) => {
        if (deps[0] === 'agents') {
          // 服务可达，但此刻确实没有任何 live 会话
          callback({
            agents: { list: () => [] },
            sessions: { get: () => undefined },
          })
        }
      },
    }
    const deps = defaultBridgeDeps(fakeCtx)
    assert.equal(
      deps.isAllowedCwd(fresh),
      false,
      'reachable but empty ⇒ false（确定的事实，不是"未知"）',
    )

    // 端到端：全新目录必须被拒，且**不写盘**
    const board = createTaskboardBridge(deps)
    const refused = res()
    await board.handle({
      method: 'POST',
      url: '/dsh-taskboard/create',
      headers: { host: '127.0.0.1:3080', 'x-taskboard': 'mutate' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ cwd: fresh, title: 'must not be written' }))
      },
    }, refused)
    assert.equal(refused.status, 403, '零 live 会话 + 全新目录 ⇒ 403')
    assert.equal(existsSync(join(fresh, '.dsh', 'taskboard.json')), false, '且没有写任何文件')

    // 反向：已有板文件的目录仍放行（面板指向旧会话的场景不能坏）
    await mkdir(join(withBoard, '.dsh'), { recursive: true })
    await writeFile(join(withBoard, '.dsh', 'taskboard.json'), JSON.stringify({
      version: 1, next_seq: 1, tasks: {}, actors: {},
    }))
    const okRes = res()
    await board.handle({
      method: 'GET',
      url: `/dsh-taskboard/board?cwd=${encodeURIComponent(withBoard)}`,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: async function* () {},
    }, okRes)
    assert.equal(okRes.status, 200, '有板文件的目录仍放行（面板不会坏）')
  } finally {
    await rm(fresh, { recursive: true, force: true })
    await rm(withBoard, { recursive: true, force: true })
  }
})

await check('unreachable services stay permissive (tests / headless must not break)', async () => {
  // 与上一条配对：服务**拿不到**时仍是"未知"⇒ undefined ⇒ 交回形状检查。
  // 两者必须区分开，否则要么守护退场、要么每个请求都 403。
  const fakeCtx = { logger: () => ({ info: () => {} }) }
  const deps = defaultBridgeDeps(fakeCtx)
  assert.equal(deps.isAllowedCwd('/tmp/anything'), undefined, '拿不到服务 ⇒ 未知（permissive）')
})

await check('the cwd whitelist actually ENGAGES through the real host wiring', async () => {
  // The gap this covers: every other test injects `isAllowedCwd` by hand, so
  // the production wiring was never exercised — and in a live dsh web it
  // returned `undefined` for every cwd (the root ctx does not expose `agents`,
  // a soft dependency), leaving the guard inert. Verified live: a POST /create
  // with a fresh /tmp cwd created a board there and answered 200.
  const { mkdtemp, rm } = await import('node:fs/promises')
  const servedRoot = await mkdtemp(join(tmpdir(), 'dsh-taskboard-served-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-taskboard-outside-'))
  try {
    const fakeCtx = {
      logger: () => ({ info: () => {} }),
      // The host shape that matters: `agents` is NOT on the root ctx (this
      // plugin declares only tools+sessions), it arrives via ctx.inject.
      inject: (deps, callback) => {
        if (deps[0] === 'agents') {
          callback({
            agents: { list: () => [{ id: 'a1' }] },
            sessions: { get: () => ({ header: { cwd: servedRoot } }) },
          })
        }
      },
    }
    const deps = defaultBridgeDeps(fakeCtx)
    assert.equal(deps.isAllowedCwd(servedRoot), true, 'a live session workspace is served')
    assert.equal(deps.isAllowedCwd(outside), false, 'and anything else is not')

    // End to end: a boardless directory outside the served roots must be refused
    // (this is the mkdir-anywhere primitive the audit flagged).
    const board = createTaskboardBridge(deps)
    const refused = res()
    await board.handle({
      method: 'POST',
      url: '/dsh-taskboard/create',
      headers: { host: '127.0.0.1:3080', 'x-taskboard': 'mutate' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ cwd: outside, title: 'should never be written' }))
      },
    }, refused)
    assert.equal(refused.status, 403, 'a boardless, unserved cwd is refused')
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(join(outside, '.dsh', 'taskboard.json')), false, 'and nothing was written')
  } finally {
    await rm(servedRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

console.log(failed === 0 ? '\nall bridge checks passed' : `\n${failed} bridge check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
