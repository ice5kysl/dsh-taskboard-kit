/**
 * Browser-side locale detection for dsh-taskboard-kit.
 *
 * One question, answered once: is the shell showing Chinese or English? The
 * answer comes from `navigator.language` (then `navigator.languages[0]`);
 * anything that is not `zh*` — including a missing navigator (tests, SSR) —
 * resolves to English. Every user-facing string is written in both languages
 * at the call site:
 *
 *   L('看板', 'Board', { n: 3 })
 *
 * @module dsh-taskboard-kit/client-locale
 */

type Locale = 'zh' | 'en'

/** `{name}` placeholders inside a copy string. */
type Vars = Record<string, string | number>

let cached: Locale | undefined

/** The effective browser locale (cached for the life of the page). */
export function browserLocale(): Locale {
  if (cached) return cached
  let raw = ''
  try {
    raw = (typeof navigator !== 'undefined' && (navigator.language || navigator.languages?.[0])) || ''
  } catch {
    raw = ''
  }
  cached = raw.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return cached
}

/** Localized string helper for browser copy. */
export function L(zh: string, en: string, vars?: Vars): string {
  let text = browserLocale() === 'zh' ? zh : en
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      text = text.split(`{${key}}`).join(String(value))
    }
  }
  return text
}
