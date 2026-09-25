/**
 * The taskboard panel's store: framework-free, testable, and the single place
 * that talks to the local `/dsh-taskboard/*` bridge.
 *
 * Keeping every data operation here (instead of inside components) means the
 * panel, a future badge and the tests all drive the same code path, and the
 * React layer stays a pure projection of `getState()`.
 *
 * One board per workspace: `setCwd` follows the selected session's directory,
 * `refresh()` re-reads the whole board (it is one small JSON file — no
 * pagination), and mutations (`create` / `claim` / `update`) re-read it after
 * a successful write so the view always reflects the file. A 15s poll keeps
 * the board fresh while agents work it; the poll only fires while the page is
 * visible. A `seq` guard makes sure a slow response from a previous cwd can
 * never overwrite the board (or selection) the user is looking at now.
 *
 * @module dsh-taskboard-kit/client-store
 */

import type { Board } from '../shared/types.ts'
import type { ClaimRequest, CommentRequest, CreateRequest, UpdateRequest } from '../shared/bridge.ts'
import { createBridgeClient, type BridgeClient } from './api.ts'

export interface TaskboardState {
  /** 'loading' until the first refresh of the current cwd settles. */
  status: 'loading' | 'ready' | 'error'
  /** Last failure text (load or mutation); shown as a dismissible strip. */
  error: string | null
  /** Current session's directory; how the host finds the workspace board. */
  cwd: string | null
  board: Board | null
  /** Task open in the detail drawer. */
  selectedId: string | null
  /** Whether the done column also lists cancelled tasks. */
  showCancelled: boolean
  /** A mutation is in flight — action buttons stay disabled meanwhile. */
  busy: boolean
}

/** Create/claim/update/comment requests without the cwd (the store fills it in). */
export type CreateInput = Omit<CreateRequest, 'cwd'>
export type UpdateInput = Omit<UpdateRequest, 'cwd'>
export type CommentInput = Omit<CommentRequest, 'cwd'>

export interface TaskboardStore {
  getState(): TaskboardState
  subscribe(listener: () => void): () => void
  /** Begin background polling (ref-counted). Returns a disposer. */
  start(): () => void
  setCwd(cwd: string | null): void
  refresh(): Promise<void>
  select(id: string | null): void
  setShowCancelled(on: boolean): void
  clearError(): void
  /** Create a task; resolves true on success so the form can close itself. */
  create(input: CreateInput): Promise<boolean>
  /** Claim a pool task (human self-assign); conflict surfaces as `error`. */
  claim(id: ClaimRequest['id']): Promise<boolean>
  /** Any task edit: a status action and/or field changes. */
  update(input: UpdateInput): Promise<boolean>
  /** Add an information comment (state untouched); resolves true on success. */
  comment(input: CommentInput): Promise<boolean>
}

export interface StoreOptions {
  pollMs?: number
  bridge?: BridgeClient
}

const INITIAL: TaskboardState = {
  status: 'loading',
  error: null,
  cwd: null,
  board: null,
  selectedId: null,
  showCancelled: false,
  busy: false,
}

/** Build a store. Tests pass a fake bridge; the app uses the default one. */
export function createTaskboardStore(options: StoreOptions = {}): TaskboardStore {
  const bridge = options.bridge ?? createBridgeClient()
  const pollMs = options.pollMs ?? 15_000

  let state: TaskboardState = INITIAL
  const listeners = new Set<() => void>()
  // Last-write-wins guard: a slow board response from a previous cwd must
  // never overwrite the view the user is looking at.
  let seq = 0
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const get = (): TaskboardState => state
  const set = (patch: Partial<TaskboardState>): void => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  async function refresh(): Promise<void> {
    const cwd = state.cwd
    if (!cwd) return
    const mine = ++seq
    const res = await bridge.board(cwd)
    if (mine !== seq) return
    if (res.ok) {
      set({ status: 'ready', board: res.board, error: null })
    } else {
      // A failed reload keeps the board it already has; only a failed FIRST
      // load turns the whole panel into an error block.
      set({ status: state.board ? 'ready' : 'error', error: res.error })
    }
  }

  /** One mutation flow: busy-gated, error-surfaced, re-reads the board after. */
  async function mutate(call: (cwd: string) => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
    const cwd = state.cwd
    if (!cwd || state.busy) return false
    set({ busy: true, error: null })
    try {
      const res = await call(cwd)
      if (!res.ok) {
        set({ error: res.error ?? 'unknown error' })
        return false
      }
      await refresh()
      return true
    } finally {
      set({ busy: false })
    }
  }

  return {
    getState: get,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      subscribers += 1
      timer ??= setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        void refresh()
      }, pollMs)
      void refresh()
      return () => {
        subscribers -= 1
        if (subscribers <= 0 && timer !== undefined) {
          clearInterval(timer)
          timer = undefined
          subscribers = 0
        }
      }
    },
    setCwd(cwd) {
      const next = cwd ?? null
      if (next === state.cwd) return
      // Invalidate in-flight responses, clear the old workspace's view, load.
      seq += 1
      set({
        cwd: next,
        board: null,
        selectedId: null,
        error: null,
        status: next ? 'loading' : 'ready',
      })
      void refresh()
    },
    refresh,
    select(id) {
      set({ selectedId: id })
    },
    setShowCancelled(on) {
      set({ showCancelled: on })
    },
    clearError() {
      set({ error: null })
    },
    create(input) {
      return mutate((cwd) => bridge.create({ ...input, cwd }))
    },
    claim(id) {
      return mutate((cwd) => bridge.claim({ cwd, id }))
    },
    update(input) {
      return mutate((cwd) => bridge.update({ ...input, cwd }))
    },
    comment(input) {
      return mutate((cwd) => bridge.comment({ ...input, cwd }))
    },
  }
}

let singleton: TaskboardStore | undefined

/** The page-wide store (one poller, one panel). */
export function getTaskboardStore(options?: StoreOptions): TaskboardStore {
  singleton ??= createTaskboardStore(options)
  return singleton
}
