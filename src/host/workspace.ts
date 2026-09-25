/**
 * Resolve the workspace directory a tool call belongs to.
 *
 * dsh binds every agent to a session, and the session records the absolute
 * directory it was created in (`session.header.cwd`) — that directory owns the
 * board. The host is typed only by the tiny structural slice we read (like
 * msg9-kit's WebServerLike), never by importing host internals.
 *
 * @module dsh-taskboard-kit/workspace
 */

/** The `ctx.sessions` slice we read. */
interface SessionsLike {
  get(id: string): { header?: { cwd?: string } } | undefined
}

/** The tool-execution slice we read: the calling agent (its session id). */
export interface ExecLike {
  agent?: unknown
}

/**
 * The session id behind `exec.agent`: a plain string in test doubles, an
 * object with a string `id` (dsh's Agent) in a live host.
 */
function sessionIdOf(agent: unknown): string | undefined {
  if (typeof agent === 'string' && agent !== '') return agent
  if (agent && typeof agent === 'object') {
    const id = (agent as { id?: unknown }).id
    if (typeof id === 'string' && id !== '') return id
  }
  return undefined
}

/**
 * The calling session's cwd, falling back to the plugin process's own cwd when
 * the host cannot say (unknown agent, headless profile, disposed session) —
 * better a board next to the binary than no board at all.
 */
export function resolveCwd(ctx: unknown, exec?: ExecLike): string {
  const sessionId = sessionIdOf(exec?.agent)
  if (sessionId) {
    try {
      const sessions = (ctx as { sessions?: SessionsLike }).sessions
      const cwd = sessions?.get(sessionId)?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      /* in cordis, reading an un-provided service throws: fall through */
    }
  }
  return process.cwd()
}
