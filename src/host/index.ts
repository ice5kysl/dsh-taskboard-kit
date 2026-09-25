/**
 * dsh-taskboard-kit — host face (skeleton; replaced by the full implementation).
 *
 * @module dsh-taskboard-kit
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'taskboard-kit'
export const inject = ['tools', 'sessions'] as const

export function apply(ctx: Context): void {
  ctx.logger('taskboard-kit').info('taskboard-kit loaded (skeleton)')
}
