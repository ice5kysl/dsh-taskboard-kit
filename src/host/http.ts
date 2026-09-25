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

import type { IncomingMessage, ServerResponse } from 'node:http'
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
  claimTask,
  createTask,
  loadBoard,
  updateTask,
} from './store.ts'

export { BRIDGE_PREFIX } from '../shared/bridge.ts'

/** The actor every browser mutation is stamped with (contract). */
const HUMAN_ACTOR = 'human'

/** The store operations the bridge performs (injectable so tests can fake them). */
export interface TaskboardBridgeDeps {
  loadBoard(cwd: string): Promise<Board>
  createTask: typeof createTask
  claimTask: typeof claimTask
  updateTask: typeof updateTask
  addComment: typeof addComment
  log(message: string): void
}

export interface TaskboardBridge {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/** The real dependencies, bound to a host context. */
export function defaultBridgeDeps(ctx: Context): TaskboardBridgeDeps {
  return {
    loadBoard,
    createTask,
    claimTask,
    updateTask,
    addComment,
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
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
 * A browser `Origin` is authoritative: when present it MUST be same-origin
 * with the `Host` header, so a page on another site cannot drive this bridge
 * through the user's browser (CSRF). Requests with no `Origin` at all — curl,
 * test doubles, other local tools — are accepted only when the CONNECTION
 * comes from loopback (`req.socket.remoteAddress`): the `Host` header is
 * client-supplied, so checking it alone would let any process impersonate the
 * panel. The loopback Host check stays as a secondary guard; a missing
 * remoteAddress only happens with injected test doubles, which keep the old
 * Host-only behaviour.
 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host)
  if (!host) return false
  const origin = req.headers.origin
  if (origin) return isSameOrigin(origin, req.headers.host ?? '')
  const remote = req.socket?.remoteAddress
  if (remote && !isLoopbackAddress(remote)) return false
  return isLoopbackHostname(host)
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

/** The one required field of every mutation body. */
function requireCwd(body: Record<string, unknown>): string {
  const cwd = str(body.cwd)
  if (!cwd) throw new BridgeError(400, 'invalid-input', 'field "cwd" is required')
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

// -------------------------------------------------------------------- bridge

/** Build the `/dsh-taskboard` handler. */
export function createTaskboardBridge(deps: TaskboardBridgeDeps): TaskboardBridge {
  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || BRIDGE_PREFIX
    const method = req.method ?? 'GET'

    // The board read needs no mutate header and no existing file: a workspace
    // that never touched the board simply gets an empty one back.
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/board`) {
      const cwd = str(url.searchParams.get('cwd'))
      if (!cwd) throw new BridgeError(400, 'invalid-input', 'query parameter "cwd" is required')
      try {
        return sendJson(res, 200, { ok: true, board: await deps.loadBoard(cwd) })
      } catch (error) {
        if (error instanceof StoreError) {
          return fail(res, error.code === 'internal' ? 500 : 200, error.code, error.message)
        }
        throw error
      }
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/create`) {
      requireMutateHeader(req)
      const body = await readJsonBody(req)
      const cwd = requireCwd(body)
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
      const cwd = requireCwd(body)
      const request = body as unknown as ClaimRequest
      return runDomain(res, () => deps.claimTask(cwd, request.id, HUMAN_ACTOR))
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/update`) {
      requireMutateHeader(req)
      const body = await readJsonBody(req)
      const cwd = requireCwd(body)
      const request = body as unknown as UpdateRequest
      return runDomain(res, async () => (await deps.updateTask(cwd, request.id, {
        ...(request.action !== undefined ? { action: request.action } : {}),
        ...(request.assignee !== undefined ? { assignee: request.assignee } : {}),
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
      const cwd = requireCwd(body)
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
        return fail(res, 500, 'internal', message)
      }
    },
  }
}
