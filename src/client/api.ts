/**
 * Browser-side client of the local `/dsh-taskboard/*` bridge.
 *
 * The page holds no credentials: every call is same-origin HTTP against the
 * dsh web server, and the host face reads/writes the workspace's
 * `.dsh/taskboard.json`. Routes and payload shapes come straight from the
 * shared contract (`src/shared/bridge.ts`) — this file only adds transport:
 *
 *   GET  /dsh-taskboard/board?cwd=<abs path>   → BoardResponse
 *   POST /dsh-taskboard/create|claim|update    → TaskResponse
 *
 * Every POST carries `Content-Type: application/json` and the contract's
 * CSRF header (`x-taskboard: mutate`). Failures are values, not exceptions:
 * a transport-level failure (offline, hung bridge, non-JSON reply) resolves
 * to `{ ok: false, code: 'internal' }` so the store can show it verbatim.
 *
 * @module dsh-taskboard-kit/client-api
 */

import {
  BRIDGE_PREFIX,
  MUTATE_HEADER,
  MUTATE_HEADER_VALUE,
  type BoardResponse,
  type ClaimRequest,
  type CreateRequest,
  type TaskResponse,
  type UpdateRequest,
} from '../shared/bridge.ts'
import { L } from './locale.ts'

/** The `/dsh-taskboard` calls the panel makes. */
export interface BridgeClient {
  board(cwd: string, signal?: AbortSignal): Promise<BoardResponse>
  create(req: CreateRequest, signal?: AbortSignal): Promise<TaskResponse>
  claim(req: ClaimRequest, signal?: AbortSignal): Promise<TaskResponse>
  update(req: UpdateRequest, signal?: AbortSignal): Promise<TaskResponse>
}

export interface BridgeOptions {
  /** Bridge prefix; defaults to the contract's BRIDGE_PREFIX. */
  base?: string
  /** Transport override (tests inject a fake). */
  fetch?: typeof fetch
}

/** How long a bridge call may hang before the panel gives up on it. */
const REQUEST_TIMEOUT_MS = 15_000

/** Build the bridge client. */
export function createBridgeClient(options: BridgeOptions = {}): BridgeClient {
  const base = (options.base ?? BRIDGE_PREFIX).replace(/\/+$/, '')
  const doFetch: typeof fetch = options.fetch ?? ((...args) => fetch(...args))

  /** A hung bridge must not wedge the store's busy flag: cap every call. */
  function timeoutSignal(signal?: AbortSignal): { signal: AbortSignal; done(): void } {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    return { signal: controller.signal, done: () => clearTimeout(timer) }
  }

  function internalError(error: unknown): { ok: false; error: string; code: 'internal' } {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    const message = aborted
      ? L('请求超时或已取消，请重试。', 'Request timed out or was cancelled — please retry.')
      : error instanceof Error
        ? error.message
        : String(error)
    return { ok: false, error: message, code: 'internal' }
  }

  async function request<R>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<R> {
    const { signal, done } = timeoutSignal(init.signal)
    let response: Response
    try {
      response = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body === undefined
          ? {}
          : { 'Content-Type': 'application/json', [MUTATE_HEADER]: MUTATE_HEADER_VALUE },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      })
    } catch (error) {
      return internalError(error) as R
    } finally {
      done()
    }

    const text = await response.text().catch(() => '')
    let parsed: { ok?: boolean; error?: unknown } | undefined
    try {
      parsed = text ? (JSON.parse(text) as { ok?: boolean; error?: unknown }) : undefined
    } catch {
      parsed = undefined
    }
    // The contract's envelopes are self-describing: trust an ok:true payload,
    // and trust an ok:false payload even when the HTTP status is an error.
    if (parsed && (parsed.ok === true || (parsed.ok === false && typeof parsed.error === 'string'))) {
      return parsed as R
    }
    return {
      ok: false,
      error: text || response.statusText || `HTTP ${response.status}`,
      code: 'internal',
    } as R
  }

  return {
    board: (cwd, signal) => request<BoardResponse>(`/board?cwd=${encodeURIComponent(cwd)}`, { signal }),
    create: (req, signal) => request<TaskResponse>('/create', { method: 'POST', body: req, signal }),
    claim: (req, signal) => request<TaskResponse>('/claim', { method: 'POST', body: req, signal }),
    update: (req, signal) => request<TaskResponse>('/update', { method: 'POST', body: req, signal }),
  }
}
