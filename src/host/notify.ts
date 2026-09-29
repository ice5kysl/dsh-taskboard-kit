/**
 * The human-facing half of dsh-taskboard-kit — "依赖人类的就加上人类".
 *
 * A card can be *waiting on a human* (`task.waiting_on.kind === 'human'`), and
 * that is a promise the board must keep: the human is not in the agent loop, so
 * a card parked for them has to actually reach them. Three channels, in order
 * of reliability:
 *
 *   1. **The panel** — the「等你」strip in the kanban tab. Always there, no
 *      configuration, and the same strip the human answers from.
 *   2. **The hook** — `TASKBOARD_NOTIFY_CMD`, an arbitrary shell command run
 *      when a card starts waiting on a human (or blows its wait SLA). The board
 *      itself stays dependency-free: whoever wants msg9 / a desktop
 *      notification / a webhook wires it here and owns that wiring. The card is
 *      handed over as JSON on stdin plus `TASKBOARD_*` env vars.
 *   3. **The agent** — every live agent session of that workspace is told, so an
 *      agent with msg9 tools can mail the human itself and keep the card
 *      blocked until the answer lands.
 *
 * Delivery is best-effort by contract: a broken hook must never fail the
 * mutation that triggered it, and it is always logged.
 *
 * @module dsh-taskboard-kit/notify
 */

import { spawn } from 'node:child_process'
import type { Task } from '../shared/types.ts'

/** One "the human needs to look at this" event. */
export interface HumanNotice {
  cwd: string
  task: Task
  /** What exactly the human must decide (copied from `waiting_on.question`). */
  question: string
  /** `blocked` = just parked on a human; `overdue` = it has been waiting too long. */
  reason: 'blocked' | 'overdue'
  /** Who is blocked by this (the agent that asked, best effort). */
  waitingBy: string
  /** How long the card has been waiting, in ms (0 for a fresh `blocked`). */
  waitedMs: number
}

export interface NotifyResult {
  /** True when an out-of-panel channel actually ran. */
  delivered: boolean
  /** `hook` | `none` — how it was (or was not) delivered. */
  how: 'hook' | 'none'
  /** Human-readable failure, when the hook failed. */
  error?: string
}

export interface NotifyDeps {
  /** Seam for tests: run the hook. Defaults to a real shell spawn. */
  runHook?(command: string, payload: string, env: Record<string, string>): Promise<void>
  log(message: string): void
}

/** The payload handed to the hook (stdin JSON; also mirrored into env vars). */
export function noticePayload(notice: HumanNotice): Record<string, unknown> {
  return {
    kind: 'taskboard.human',
    reason: notice.reason,
    workspace: notice.cwd,
    task: {
      id: notice.task.id,
      title: notice.task.title,
      status: notice.task.status,
      priority: notice.task.priority,
      value: notice.task.value,
      assignee: notice.task.assignee,
      created_by: notice.task.created_by,
      detail: notice.task.detail,
    },
    question: notice.question,
    waiting_by: notice.waitingBy,
    waited_ms: notice.waitedMs,
    board_file: `${notice.cwd}/.dsh/taskboard.json`,
  }
}

const HOOK_TIMEOUT_MS = 5_000

function defaultRunHook(command: string, payload: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, { shell: true, env: { ...process.env, ...env } })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`notify hook timed out after ${HOOK_TIMEOUT_MS}ms`))
    }, HOOK_TIMEOUT_MS)
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`notify hook exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`))
    })
    child.stdin?.end(payload)
  })
}

/**
 * Deliver one human-facing notice. Never throws: a failed hook is logged and
 * reported, the card stays blocked, and the panel still shows it.
 */
export async function notifyHuman(notice: HumanNotice, deps: NotifyDeps): Promise<NotifyResult> {
  const command = process.env.TASKBOARD_NOTIFY_CMD?.trim()
  if (!command) return { delivered: false, how: 'none' }
  const payload = JSON.stringify(noticePayload(notice), null, 2)
  const env = {
    TASKBOARD_NOTIFY_REASON: notice.reason,
    TASKBOARD_TASK_ID: notice.task.id,
    TASKBOARD_TASK_TITLE: notice.task.title,
    TASKBOARD_TASK_PRIORITY: notice.task.priority,
    TASKBOARD_QUESTION: notice.question,
    TASKBOARD_WORKSPACE: notice.cwd,
    TASKBOARD_WAITED_MS: String(notice.waitedMs),
  }
  try {
    await (deps.runHook ?? defaultRunHook)(command, payload, env)
    return { delivered: true, how: 'hook' }
  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    deps.log(`human notify hook failed for ${notice.task.id}: ${message}`)
    return { delivered: false, how: 'hook', error: message }
  }
}

/**
 * The shell command an agent can wire as `TASKBOARD_NOTIFY_CMD` to push a
 * blocked card to a msg9 inbox: the payload's question and id become the mail
 * body. Documented rather than hard-coded — the board never learns msg9.
 */
export function msg9HookExample(inbox: string): string {
  return `TASKBOARD_NOTIFY_CMD='printf "%s\\n" "[看板] $TASKBOARD_TASK_ID 需要你决定（$TASKBOARD_NOTIFY_REASON）" "$TASKBOARD_QUESTION" | msg9 send --to ${inbox} --subject "看板 ${'$'}TASKBOARD_TASK_ID 等你决定"'`
}
