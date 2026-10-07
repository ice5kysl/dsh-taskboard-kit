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
import { L } from './locale.ts'

/** The board tab's views: the status lanes, the owner lanes, or analytics. */
export type BoardGrouping = 'column' | 'owner' | 'stats'

export interface TaskboardState {
  /** 'loading' until the first refresh of the current cwd settles. */
  status: 'loading' | 'ready' | 'error'
  /** Last failure text (load or mutation); shown as a dismissible strip. */
  error: string | null
  /** Current session's directory; how the host finds the workspace board. */
  cwd: string | null
  board: Board | null
  /** Task open in the BOARD TAB's detail drawer. (The mini board keeps its
   *  own selection locally — a shared selection rendered both drawers.) */
  selectedId: string | null
  /** Whether the closed column is expanded (default: a collapsed strip). */
  showClosed: boolean
  /**
   * How the board tab presents the same board: by progress (the six
   * swim-lanes), by owner (one lane per assignee), or as statistics. Purely a
   * view choice — no data changes, no extra requests.
   */
  groupBy: BoardGrouping
  /**
   * Whether SETTLED (`closed`) tasks appear in the「按负责人」view. Off by
   * default: history would bury the live work the owner view exists to show.
   * `done` cards are never filtered out — they still owe a settle (v0.6).
   */
  includeClosed: boolean
  /** Whether the status-bar mini board drawer is open (shared between the
   *  entry pill and the shell.overlay drawer — the two halves of one surface). */
  miniOpen: boolean
  /** A mutation is in flight — action buttons stay disabled meanwhile. */
  busy: boolean
  /** Absolute path of the taskboard CLI (guide interpolation; null = the
   *  host didn't report one, templates fall back to a placeholder). */
  cli: string | null
  /** Absolute path of the board file (guide interpolation). */
  boardFile: string | null
  /**
   * Whether the board FILE exists. `board === empty` alone cannot tell the two
   * first-run shapes apart: absent (needs enabling) vs empty (needs a task).
   */
  boardExists: boolean
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
  setShowClosed(on: boolean): void
  /** Switch the board tab between the progress lanes and the owner lanes. */
  setGroupBy(mode: BoardGrouping): void
  /** Show/hide settled (`closed`) tasks in the owner view. */
  setIncludeClosed(on: boolean): void
  /** Toggle the composer-side mini board drawer. */
  setMiniOpen(open: boolean): void
  clearError(): void
  /**
   * Turn the board on for the current workspace: create the board file and
   * seed `.dsh/BOARD-PROTOCOL.md`. Resolves the host's report (file paths,
   * whether things already existed) so the wizard can show what happened; null
   * when there is no cwd or the write failed (error lands on the store).
   */
  enableBoard(): Promise<EnableOutcome | null>
  /** Create a task; resolves true on success so the form can close itself. */
  create(input: CreateInput): Promise<boolean>
  /** Claim a pool task (human self-assign); conflict surfaces as `error`. */
  claim(id: ClaimRequest['id']): Promise<boolean>
  /** Any task edit: a status action and/or field changes. */
  update(input: UpdateInput): Promise<boolean>
  /** Add an information comment (state untouched); resolves true on success. */
  comment(input: CommentInput): Promise<boolean>
  /**
   * Answer a card parked on a person: post the answer as a comment, then
   * release the wait (`comment` → `unblock`, in THAT order; v0.5.4). The
   * comment is the durable record, the release takes the card off the human's
   * "等你决定" list. Stops at the first failed write, so a failed release can
   * never swallow the answer. Resolves false with `error` set on failure and
   * for empty text (nothing to answer with).
   */
  answerWaiting(id: string, text: string): Promise<boolean>
}

/** What `enableBoard()` resolved with (mirrors the host's EnableResponse). */
export interface EnableOutcome {
  boardFile: string
  protocolFile: string | null
  alreadyExisted: boolean
}

export interface StoreOptions {
  pollMs?: number
  bridge?: BridgeClient
  /** Per-request timeout for the default bridge; kept under the poll interval
   *  so a hung bridge can never stack poll on top of poll (m13). */
  requestTimeoutMs?: number
}

const INITIAL: TaskboardState = {
  status: 'loading',
  error: null,
  cwd: null,
  board: null,
  selectedId: null,
  showClosed: false,
  groupBy: 'column',
  includeClosed: false,
  miniOpen: false,
  busy: false,
  cli: null,
  boardFile: null,
  boardExists: false,
}

/** Build a store. Tests pass a fake bridge; the app uses the default one. */
export function createTaskboardStore(options: StoreOptions = {}): TaskboardStore {
  const bridge = options.bridge ?? createBridgeClient({ timeoutMs: options.requestTimeoutMs })
  const pollMs = options.pollMs ?? 15_000

  let state: TaskboardState = INITIAL
  const listeners = new Set<() => void>()
  // Last-write-wins guard: a slow board response from a previous cwd must
  // never overwrite the view the user is looking at.
  let seq = 0
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  // Poll plumbing (m13): at most one board request in flight; a second caller
  // coalesces onto it and queues ONE trailing re-read, so a write that landed
  // after the in-flight read still shows up. Requests carry an AbortSignal so
  // switching workspaces actually cancels the old read instead of merely
  // discarding its result.
  let inflight: Promise<void> | null = null
  let trailing = false
  let boardAborter: AbortController | null = null
  // m19: content freshness is the board file's mtime, not the request order.
  let lastAppliedMtime = -1
  // m13: a persistent poll failure is surfaced ONCE — re-setting the same
  // error every tick resurrected the strip the user had dismissed.
  let lastPollError: string | null = null

  const get = (): TaskboardState => state
  const set = (patch: Partial<TaskboardState>): void => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  /** A failed reload keeps the board it already has; only a failed FIRST load
   *  turns the whole panel into an error block. Repeats of the SAME failure
   *  stay silent (the strip is already up, or was dismissed). */
  function reportPollError(message: string): void {
    if (message === lastPollError) return
    lastPollError = message
    set({ status: state.board ? 'ready' : 'error', error: message })
  }

  /** m14: never let a malformed payload paint an "empty board" lie over a
   *  good one — check the minimal shape before applying anything. */
  function isBoardShape(board: Board | undefined): board is Board {
    return !!board && typeof board === 'object' && !!board.tasks && typeof board.tasks === 'object'
  }

  async function refresh(): Promise<void> {
    const cwd = state.cwd
    if (!cwd) return
    if (inflight) {
      trailing = true
      return inflight
    }
    const mine = ++seq
    boardAborter?.abort()
    const aborter = new AbortController()
    boardAborter = aborter
    inflight = (async () => {
      try {
        const res = await bridge.board(cwd, aborter.signal)
        if (mine !== seq) return
        if (res.ok) {
          if (!isBoardShape(res.board)) {
            reportPollError(L(
              'bridge 返回了残缺的看板数据，已保留上一份。',
              'The bridge returned a malformed board; kept the last good one.',
            ))
            return
          }
          if (typeof res.board_mtime === 'number') {
            // A strictly older snapshot must never overwrite a newer one.
            if (res.board_mtime < lastAppliedMtime) return
            lastAppliedMtime = res.board_mtime
          }
          lastPollError = null
          set({
            status: 'ready',
            board: res.board,
            error: null,
            cli: res.cli ?? null,
            boardFile: res.board_file ?? null,
            boardExists: res.board_exists ?? true,
          })
        } else {
          reportPollError(res.error)
        }
      } finally {
        inflight = null
        boardAborter = null
        if (trailing) {
          trailing = false
          void refresh()
        }
      }
    })()
    return inflight
  }

  /** One mutation flow: busy-gated, error-surfaced, re-reads the board after. */
  async function mutate(call: (cwd: string) => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
    const cwd = state.cwd
    if (!cwd) return false
    if (state.busy) {
      // m12: a change swallowed by the busy gate used to fail SILENTLY (a drop
      // that did nothing, with no hint why) — say so instead.
      set({ error: L('上一个操作还没完成，请稍候再试。', 'The previous change is still in flight — try again in a moment.') })
      return false
    }
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

  /** comment → unblock, in that order: the human strip's answer action. */
  async function answerWaiting(id: string, text: string): Promise<boolean> {
    const body = text.trim()
    if (!body) return false
    if (!(await mutate((cwd) => bridge.comment({ cwd, id, text: body })))) return false
    return mutate((cwd) => bridge.update({ cwd, id, action: 'unblock' }))
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
      // Invalidate in-flight responses (and actually cancel the request),
      // reset the freshness/error baselines, clear the old workspace's view.
      seq += 1
      boardAborter?.abort()
      lastAppliedMtime = -1
      lastPollError = null
      set({
        cwd: next,
        board: null,
        selectedId: null,
        error: null,
        cli: null,
        boardFile: null,
        boardExists: false,
        status: next ? 'loading' : 'ready',
      })
      void refresh()
    },
    refresh,
    select(id) {
      set({ selectedId: id })
    },
    setShowClosed(on) {
      set({ showClosed: on })
    },
    setGroupBy(mode) {
      set({ groupBy: mode })
    },
    setIncludeClosed(on) {
      set({ includeClosed: on })
    },
    setMiniOpen(open) {
      // The mini drawer's own selection is component-local and unmounts with
      // it — nothing to clear here (and the board tab's selectedId is theirs).
      set({ miniOpen: open })
    },
    clearError() {
      set({ error: null })
    },
    async enableBoard() {
      const cwd = state.cwd
      if (!cwd || state.busy) return null
      set({ busy: true, error: null })
      try {
        const res = await bridge.enable({ cwd })
        if (!res.ok) {
          set({ error: res.error ?? 'unknown error' })
          return null
        }
        // Re-read so the panel immediately shows the real (empty) board
        // instead of the first-run prompt.
        await refresh()
        return {
          boardFile: res.board_file,
          protocolFile: res.protocol_file ?? null,
          alreadyExisted: res.already_existed,
        }
      } finally {
        set({ busy: false })
      }
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
    answerWaiting,
  }
}

let singleton: TaskboardStore | undefined

/** The page-wide store (one poller, one panel). */
export function getTaskboardStore(options?: StoreOptions): TaskboardStore {
  singleton ??= createTaskboardStore(options)
  return singleton
}
