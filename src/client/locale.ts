/**
 * Browser-side locale detection for dsh-taskboard-kit.
 *
 * One question, answered once: is the shell showing Chinese or English? The
 * answer comes from the host's resolved language (`<html lang>`, which includes
 * the settings preference), then `navigator.language` (then
 * `navigator.languages[0]`); anything that is not `zh*` — including a missing
 * navigator (tests, SSR) — resolves to English. Every user-facing string is
 * written in both languages
 * at the call site:
 *
 *   L('看板', 'Board', { n: 3 })
 *
 * @module dsh-taskboard-kit/client-locale
 */

type Locale = 'zh' | 'en'

/** `{name}` placeholders inside a copy string. */
type Vars = Record<string, string | number>

let cachedTag: string | undefined
let cachedLocale: Locale | undefined

/**
 * 生效语言。**宿主优先**：dsh 会把设置里的 preference 解析成 `active` 并同步到
 * `<html lang>`（中文写成 `zh-CN`），而 `navigator.language` 只是浏览器/Electron
 * 的原始值 —— 两者可以不一致（本机实测 navigator 报 `en-US`，界面却是中文），
 * 只嗅 navigator 就会出现「核心界面中文、插件英文」的半截本地化。
 *
 * 宿主那个入口是 `immediately` 加载的，在我们的插件挂载前就已写好；切换语言时
 * 它也会实时更新，所以这里按**当前值**判、不再缓存一次就定终身。
 */
export function browserLocale(): Locale {
  let raw = ''
  try {
    raw = (typeof document !== 'undefined' && document.documentElement?.lang) || ''
    if (!raw && typeof navigator !== 'undefined') {
      raw = navigator.language || navigator.languages?.[0] || ''
    }
  } catch {
    raw = ''
  }
  if (raw === cachedTag && cachedLocale) return cachedLocale
  cachedTag = raw
  cachedLocale = raw.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return cachedLocale
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
