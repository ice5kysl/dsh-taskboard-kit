/**
 * Browser bridge of dsh-taskboard-kit.
 *
 * The kanban tab never touches the board file itself: it calls
 * `/dsh-taskboard/*` on the local dsh web server, and this module runs the
 * same lock-guarded domain operations the model tools use. Requests are
 * accepted only from loopback / same-origin callers, and every mutation must
 * carry the `x-taskboard: mutate` header (CSRF posture).
 *
 * Routes (contract: src/shared/bridge.ts):
 *   GET  /dsh-taskboard/board?cwd=<abs path>   → BoardResponse
 *   POST /dsh-taskboard/create   CreateRequest → TaskResponse
 *   POST /dsh-taskboard/claim    ClaimRequest  → TaskResponse
 *   POST /dsh-taskboard/update   UpdateRequest → TaskResponse
 *   POST /dsh-taskboard/comment  CommentRequest → TaskResponse
 *
 * Browser mutations are always attributed to the actor `human`. Domain
 * failures (conflict / not-found / invalid-input / invalid-transition) come
 * back as HTTP 200 with the ApiError body — the response union is the contract
 * the client parses; only transport-level problems (untrusted caller, missing
 * mutate header, bad body, unknown route, internal fault) use real HTTP error
 * statuses.
 *
 * @module dsh-taskboard-kit/http
 */

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BRIDGE_PREFIX,
  MUTATE_HEADER,
  MUTATE_HEADER_VALUE,
  type ClaimRequest,
  type CommentRequest,
  type CreateRequest,
  type ErrorCode,
  type UpdateRequest,
} from '../shared/bridge.ts'
import type { Board, Task } from '../shared/types.ts'
import {
  StoreError,
  addComment,
  boardFilePath,
  claimTask,
  createTask,
  enableBoard,
  loadBoard,
  updateTask,
} from './store.ts'

export { BRIDGE_PREFIX } from '../shared/bridge.ts'

/** The actor every browser mutation is stamped with (contract). */
const HUMAN_ACTOR = 'human'

/**
 * Absolute path of the bundled CLI (`bin/taskboard.mjs`), derived from the
 * running bundle (`lib/index.js` → `../bin/…`). The panel's usage guide shows
 * it in the copy-paste snippets; `null` when it cannot be resolved.
 */
function cliPath(): string | null {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'taskboard.mjs')
  } catch {
    return null
  }
}

/** The store operations the bridge performs (injectable so tests can fake them). */
export interface TaskboardBridgeDeps {
  loadBoard(cwd: string): Promise<Board>
  createTask: typeof createTask
  enableBoard: typeof enableBoard
  claimTask: typeof claimTask
  updateTask: typeof updateTask
  addComment: typeof addComment
  /**
   * Guard for the caller-supplied `cwd`: the workspace roots this host serves.
   * `false` rejects the request, `true` accepts it, `undefined` means "cannot
   * tell" and leaves the decision to the structural checks in requireCwd.
   */
  isAllowedCwd?(cwd: string): boolean | undefined
  log(message: string): void
}

export interface TaskboardBridge {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * The real dependencies, bound to a host context.
 *
 * `agents` is a **soft** dependency here — this plugin declares
 * `inject = ['tools', 'sessions']`, so the root ctx does NOT expose
 * `ctx.agents`. Reading it directly therefore yielded `undefined` and the cwd
 * whitelist silently degraded to the structural checks in production (verified
 * against a live dsh web: `POST /create` with `cwd=/tmp/<fresh dir>` returned
 * 200 and created the board there). Capture it through `ctx.inject(['agents'])`
 * — the same channel the board watcher uses, which demonstrably resolves in
 * this host — and keep the "unknown → permissive" fallback for the moments
 * before it lands.
 */
export function defaultBridgeDeps(ctx: Context): TaskboardBridgeDeps {
  interface AgentsLike { list(): { id: string }[] }
  interface SessionsLike { get(id: string): { header?: { cwd?: string } } | undefined }
  let injectedAgents: AgentsLike | undefined
  let injectedSessions: SessionsLike | undefined
  try {
    const inject = (ctx as unknown as {
      inject?: (deps: string[], callback: (child: unknown) => void) => unknown
    }).inject
    if (typeof inject === 'function') {
      inject.call(ctx, ['agents'], (child) => {
        const services = child as { agents?: AgentsLike; sessions?: SessionsLike }
        injectedAgents = services.agents ?? injectedAgents
        injectedSessions = services.sessions ?? injectedSessions
      })
    }
  } catch {
    /* no soft dependency channel (tests, headless): stay permissive */
  }

  return {
    loadBoard,
    enableBoard,
    createTask,
    claimTask,
    updateTask,
    addComment,
    // The workspace roots this host actually serves: the cwd of a live
    // session. Read lazily and defensively — when the services are not
    // reachable (tests, headless, a host shape we do not know) this reports
    // "unknown" (undefined), which falls back to the shape checks in
    // requireCwd instead of rejecting every request.
    isAllowedCwd: (cwd) => {
      try {
        const agents = injectedAgents
          ?? (ctx as unknown as { agents?: AgentsLike }).agents
        const sessions = injectedSessions
          ?? (ctx as unknown as { sessions?: SessionsLike }).sessions
        if (!agents || !sessions || typeof agents.list !== 'function') return undefined
        const live = agents.list()
        if (!Array.isArray(live) || live.length === 0) return undefined
        const roots = live
          .map((agent) => sessions.get(agent.id)?.header?.cwd)
          .filter((root): root is string => typeof root === 'string' && root !== '')
        if (roots.length === 0) return undefined
        const target = resolve(cwd)
        return roots.some((root) => resolve(root) === target)
      } catch {
        return undefined
      }
    },
    log: (message) => {
      try {
        ctx.logger('taskboard-kit:http').info(message)
      } catch {
        /* logger is best-effort */
      }
    },
  }
}

// ------------------------------------------------------------------- helpers

/** A structured transport failure the handler turns into an HTTP response. */
class BridgeError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function sendTask(res: ServerResponse, task: Task): void {
  sendJson(res, 200, { ok: true, task })
}

function fail(res: ServerResponse, status: number, code: ErrorCode, message: string): void {
  sendJson(res, status, { ok: false, error: message, code })
}

/** host[:port] → hostname, without the port (and without IPv6 brackets). */
function hostnameOf(host: string | undefined): string | null {
  if (!host) return null
  const bracketed = /^\[([^\]]+)\]/.exec(host)
  if (bracketed) return bracketed[1]!.toLowerCase()
  const colon = host.lastIndexOf(':')
  const bare = colon > 0 ? host.slice(0, colon) : host
  return bare.toLowerCase() || null
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/** 对端 IP 是不是 loopback（含 IPv4-mapped 的 ::ffff:127.x）。 */
function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  return normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(\.\d{1,3}){3}$/.test(normalized)
}

/**
 * Accept a request only from the local GUI or a non-browser local client.
 *
 * The `Host` header must ALWAYS be a loopback literal (`localhost`, `127.x`,
 * `[::1]`) — including when an `Origin` is present. Trusting a self-consistent
 * `Host`+`Origin` pair is exactly what a DNS-rebinding attack produces: the
 * attacker's page resolves its own domain to 127.0.0.1, so the browser sends
 * `Host: evil.com:<port>` with `Origin: http://evil.com:<port>`. Post-rebind
 * that pair is "same origin" from the browser's point of view, so no CORS
 * preflight is involved and the custom mutate header is sent freely.
 *
 * On top of that:
 *   • the CONNECTION must come from loopback when `remoteAddress` is known
 *     (a missing one only happens with injected test doubles);
 *   • when an `Origin` is present it must still be same-origin with `Host`,
 *     which — because `Host` is now a loopback literal — also pins the origin
 *     to a loopback hostname.
 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host ?? ''
  const host = hostnameOf(hostHeader)
  if (!host || !isLoopbackHostname(host)) return false
  const remote = req.socket?.remoteAddress
  if (remote && !isLoopbackAddress(remote)) return false
  const origin = req.headers.origin
  if (origin) return isSameOrigin(origin, hostHeader)
  return true
}

/** host[:port] / [v6][:port] → the port, or undefined when absent. */
function portOf(hostHeader: string): string | undefined {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    if (end < 0) return undefined
    const rest = hostHeader.slice(end + 1)
    return rest.startsWith(':') ? rest.slice(1) : undefined
  }
  const colon = hostHeader.lastIndexOf(':')
  return colon > 0 ? hostHeader.slice(colon + 1) : undefined
}

/** `origin` addresses the same scheme/host/port as the `Host` header. */
function isSameOrigin(origin: string, hostHeader: string): boolean {
  try {
    const parsed = new URL(origin)
    // WHATWG URL 给 IPv6 保留方括号（'[::1]'），hostnameOf 会去掉——对齐再比。
    const originHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (originHost !== hostnameOf(hostHeader)) return false
    const expected = portOf(hostHeader) ?? (parsed.protocol === 'https:' ? '443' : '80')
    const actual = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return actual === expected
  } catch {
    return false
  }
}

const MAX_BODY_BYTES = 256 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, 'invalid-input', 'request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BridgeError(400, 'invalid-input', 'request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof BridgeError) throw error
    throw new BridgeError(400, 'invalid-input', 'request body is not valid JSON')
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Every POST must carry the mutate header before its body is even read. */
function requireMutateHeader(req: IncomingMessage): void {
  if (req.headers[MUTATE_HEADER] !== MUTATE_HEADER_VALUE) {
    throw new BridgeError(403, 'forbidden', `missing "${MUTATE_HEADER}: ${MUTATE_HEADER_VALUE}" header`)
  }
}

/**
 * The one required field of every mutation body (and of the board read).
 *
 * `cwd` selects the board file, so it is validated before any filesystem work:
 * an absolute path, no `..` segments, and — when the host can tell — a
 * workspace it actually serves (`deps.isAllowedCwd`). Without the last check a
 * caller could address (and, on a mutation, *create*) any
 * `<dir>/.dsh/taskboard.json` on the machine.
 *
 * The whitelist is **live sessions only** (`agents.list()` / `sessions.list()`
 * are live-only), while the panel legitimately shows a workspace whose session
 * is not live right now (an older session picked in the sidebar). Refusing
 * those would break the kanban for the human, so a directory that already
 * carries a board file is accepted: it is a workspace this instance has served
 * before, not an arbitrary path. What stays closed is exactly the sharp edge —
 * *creating* `.dsh/` in a directory nobody has ever put a board in.
 */
function requireCwd(deps: TaskboardBridgeDeps, raw: unknown): string {
  const value = str(raw)
  if (!value) throw new BridgeError(400, 'invalid-input', 'field "cwd" is required')
  if (!isAbsolute(value)) {
    throw new BridgeError(400, 'invalid-input', '"cwd" must be an absolute path')
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new BridgeError(400, 'invalid-input', '"cwd" must not contain ".."')
  }
  const cwd = resolve(value)
  if (deps.isAllowedCwd?.(cwd) === false && !existsSync(boardFilePath(cwd))) {
    throw new BridgeError(
      403,
      'forbidden',
      'cwd is not a workspace served by this dsh instance and has no board file',
    )
  }
  return cwd
}

/**
 * Run one domain operation and answer with the contract shape: domain
 * StoreErrors stay HTTP 200 with the ApiError body (the client parses the
 * union either way); only an internal fault earns a real 500.
 */
async function runDomain(res: ServerResponse, op: () => Promise<Task>): Promise<void> {
  try {
    return sendTask(res, await op())
  } catch (error) {
    if (error instanceof StoreError) {
      return fail(res, error.code === 'internal' ? 500 : 200, error.code, error.message)
    }
    throw error
  }
}

/**
 * Same error contract as `runDomain`, but for routes that answer with shapes
 * other than a Task (enable returns file paths). Kept separate so the Task
 * routes keep their exact return type.
 */
async function runPlain<T>(res: ServerResponse, op: () => Promise<T>): Promise<void> {
  try {
    return sendJson(res, 200, await op())
  } catch (error) {
    if (error instanceof StoreError) {
      return fail(res, error.code === 'internal' ? 500 : 200, error.code, error.message)
    }
    throw error
  }
}

// -------------------------------------------------------------------- bridge

/** Build the `/dsh-taskboard` handler. */
export function createTaskboardBridge(deps: TaskboardBridgeDeps): TaskboardBridge {
  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || BRIDGE_PREFIX
    const method = req.method ?? 'GET'

    // The board read needs no mutate header and no existing file: a workspace
    // that never touched the board simply gets an empty one back. `cli` /
    // `board_file` tell the panel's guide where the CLI and the data live.
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/board`) {
      const cwd = requireCwd(deps, url.searchParams.get('cwd'))
      try {
        const cli = cliPath()
        const boardFile = boardFilePath(cwd)
        return sendJson(res, 200, {
          ok: true,
          board: await deps.loadBoard(cwd),
          cli: cli && existsSync(cli) ? cli : null,
          board_file: boardFile,
          // Reported alongside the board so the panel can tell "no board yet"
          // (offer to enable) apart from "empty board" (offer to create).
          board_exists: existsSync(boardFile),
        })
      } catch (error) {
        if (error instanceof StoreError) {
          return fail(res, error.code === 'internal' ? 500 : 200, error.code, error.message)
        }
        throw error
      }
    }

    // Turn the board on for a workspace. The empty-state wizard calls this:
    // it creates the board file (so the panel stops showing "no board yet") and
    // seeds the workspace protocol doc. Idempotent and never destructive.
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/enable`) {
      requireMutateHeader(req)
      const body = await readJsonBody(req)
      const cwd = requireCwd(deps, body.cwd)
      return runPlain(res, async () => {
        const result = await deps.enableBoard(cwd, { seedProtocol: body.seed_protocol !== false })
        return { ok: true as const, ...result }
      })
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/create`) {
      requireMutateHeader(req)
      const body = await readJsonBody(req)
      const cwd = requireCwd(deps, body.cwd)
      const request = body as unknown as CreateRequest
      return runDomain(res, () => deps.createTask(cwd, {
        title: request.title,
        ...(request.detail !== undefined ? { detail: request.detail } : {}),
        ...(request.assignee !== undefined ? { assignee: request.assignee } : {}),
        ...(request.priority !== undefined ? { priority: request.priority } : {}),
        ...(request.value !== undefined ? { value: request.value } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
      }, HUMAN_ACTOR))
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/claim`) {
      requireMutateHeader(req)
      const body = await readJsonBody(req)
      const cwd = requireCwd(deps, body.cwd)
      const request = body as unknown as ClaimRequest
      return runDomain(res, () => deps.claimTask(cwd, request.id, HUMAN_ACTOR))
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/update`) {
      requireMutateHeader(req)
      const body = await readJsonBody(req)
      const cwd = requireCwd(deps, body.cwd)
      const request = body as unknown as UpdateRequest
      return runDomain(res, async () => (await deps.updateTask(cwd, request.id, {
        ...(request.action !== undefined ? { action: request.action } : {}),
        ...(request.assignee !== undefined ? { assignee: request.assignee } : {}),
        ...(request.reviewer !== undefined ? { reviewer: request.reviewer } : {}),
        ...(request.wait_kind !== undefined ? { wait_kind: request.wait_kind } : {}),
        ...(request.wait_who !== undefined ? { wait_who: request.wait_who } : {}),
        ...(request.wait_question !== undefined ? { wait_question: request.wait_question } : {}),
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.detail !== undefined ? { detail: request.detail } : {}),
        ...(request.priority !== undefined ? { priority: request.priority } : {}),
        ...(request.value !== undefined ? { value: request.value } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
        ...(request.note !== undefined ? { note: request.note } : {}),
      }, HUMAN_ACTOR)).task)
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/comment`) {
      requireMutateHeader(req)
      const body = await readJsonBody(req)
      const cwd = requireCwd(deps, body.cwd)
      const request = body as unknown as CommentRequest
      return runDomain(res, () => deps.addComment(cwd, request.id, request.text, HUMAN_ACTOR))
    }

    return fail(res, 404, 'not-found', `no route for ${method} ${path}`)
  }

  return {
    async handle(req, res) {
      try {
        if (!isTrustedRequest(req)) {
          return fail(res, 403, 'forbidden', 'untrusted host or origin')
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        await route(req, res, url)
      } catch (error) {
        if (error instanceof BridgeError) {
          return fail(res, error.status, error.code, error.message)
        }
        if (error instanceof StoreError) {
          return fail(res, error.code === 'internal' ? 500 : 200, error.code, error.message)
        }
        const message = (error as Error)?.message ?? String(error)
        deps.log(`bridge error: ${message}`)
        // Never echo an unexpected failure to the caller: the message can carry
        // absolute paths and fragments of file content, and the panel renders
        // an `ok:false` body verbatim. The detail stays in the host log.
        return fail(res, 500, 'internal', 'internal error')
      }
    },
  }
}
