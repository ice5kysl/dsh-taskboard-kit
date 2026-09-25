/**
 * Host-side (node) locale helper for dsh-taskboard-kit.
 *
 * `TASKBOARDKIT_LOCALE=en` selects English; anything else (including unset)
 * keeps the Chinese default. Tool METADATA stays English regardless (the model
 * consumes it) — only user-facing output text goes through `L()`.
 *
 * Resolved per call, not cached: tests flip the env var mid-process.
 *
 * @module dsh-taskboard-kit/host-locale
 */

export type Locale = 'zh' | 'en'

export interface Vars {
  readonly [name: string]: string | number | undefined
}

export function detectLocale(): Locale {
  return (process.env.TASKBOARDKIT_LOCALE ?? '').toLowerCase() === 'en' ? 'en' : 'zh'
}

/** Pick the localized template and substitute `{name}` placeholders. */
export function L(zh: string, en: string, vars?: Vars): string {
  const template = detectLocale() === 'zh' ? zh : en
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : raw,
  )
}
