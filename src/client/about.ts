/**
 * The「关于」(About) popover's content — pure data + pure functions, so the
 * panel, the tests and any future surface render the same facts.
 *
 * Two things live here and nowhere else:
 *
 *  1. **The version.** Never hand-maintained: `scripts/build.mjs` injects
 *     `__TB_VERSION__` from package.json via esbuild's `define` at build time.
 *     Outside a build (source tests, a dev runner that forgot the define) the
 *     identifier is simply absent and `aboutVersion` falls back to `dev` —
 *     `typeof` on a never-declared global is safe, so the fallback cannot
 *     throw. The panel must never print an empty or stale version.
 *  2. **The outbound links.** All four GitHub entries (repository · issues ·
 *     the collaboration spec · the release notes) are constants here; the JSX
 *     adds `target="_blank" rel="noreferrer"` to every one of them, so a
 *     mis-typed `rel` is a one-place fix.
 *
 * Everything else (board path, card count, roster size, format version) is
 * derived from the live store by the caller and rendered as `aboutFacts`.
 *
 * @module dsh-taskboard-kit/client-about
 */

import { L } from './locale.ts'

/**
 * Injected by `scripts/build.mjs` (esbuild `define`, value =
 * package.json's `version`). Declared ambient on purpose: TypeScript needs to
 * know the identifier exists, while the bundler is the only thing that can
 * give it a value.
 */
declare const __TB_VERSION__: string | undefined

/** The raw injected version (undefined when the build did not define it). */
export const ABOUT_VERSION_RAW: unknown = typeof __TB_VERSION__ === 'string' ? __TB_VERSION__ : undefined

/**
 * Normalize whatever the build injected into something displayable. Anything
 * that is not a non-empty string — undefined, a number, `''` from a define
 * that evaluated oddly — becomes the `dev` fallback rather than an empty chip.
 */
export function aboutVersion(raw: unknown): string {
  if (typeof raw !== 'string') return 'dev'
  const trimmed = raw.trim()
  return trimmed === '' ? 'dev' : trimmed
}

/** The version this bundle was built with (`dev` outside a define'd build). */
export const TB_VERSION: string = aboutVersion(ABOUT_VERSION_RAW)

/** `v0.7.3`, but a bare `dev` for the fallback (never `vdev`). */
export function aboutVersionLabel(version: string): string {
  return version === 'dev' ? 'dev' : `v${version}`
}

/** The plugin id this panel belongs to (matches the bundle's envelope id). */
export const PLUGIN_ID = 'dsh-taskboard-kit'

/** Where the source, the issues and the docs live. `main` is the default branch. */
export const REPO_URL = 'https://github.com/ice5kysl/dsh-taskboard-kit'
export const ISSUES_URL = `${REPO_URL}/issues/new`
export const COLLAB_URL = `${REPO_URL}/blob/main/docs/COLLABORATION.md`
/** The release-notes section of the English README (stable custom anchor, so a
 *  new release does not break the link the way a heading-slug would). */
export const CHANGELOG_URL = `${REPO_URL}/blob/main/README.md#release-notes`
export const AUTHOR = 'ice5kysl'
export const AUTHOR_URL = 'https://github.com/ice5kysl'
export const LICENSE = 'MIT'

/** One outbound link: a stable key (tests pin the set), a label and a target. */
export interface AboutLink {
  key: 'repo' | 'issues' | 'collab' | 'changelog'
  label: string
  hint: string
  href: string
}

/**
 * The four outbound entries, in reading order: the project itself first, then
 * the three places you go from it (file a bug / read the rules / read what
 * changed). Labels are zh/en via L(); the hints name the concrete target so
 * 「问题反馈」 and 「协作规范」 are never confused.
 */
export function aboutLinks(): AboutLink[] {
  return [
    {
      key: 'repo',
      label: L('仓库', 'Repository'),
      hint: REPO_URL.replace('https://', ''),
      href: REPO_URL,
    },
    {
      key: 'issues',
      label: L('问题反馈', 'Report an issue'),
      hint: L('提缺陷 / 需求', 'bugs / feature requests'),
      href: ISSUES_URL,
    },
    {
      key: 'collab',
      label: L('协作规范', 'Collaboration spec'),
      hint: 'docs/COLLABORATION.md',
      href: COLLAB_URL,
    },
    {
      key: 'changelog',
      label: L('变更记录', 'Release notes'),
      hint: L('README 发行说明', 'README release notes'),
      href: CHANGELOG_URL,
    },
  ]
}

/**
 * One sentence: what this thing IS. Deliberately not package.json's
 * description — that string is written for npm's search index, this one for a
 * human who just clicked ⓘ.
 */
export function aboutTagline(): string {
  return L(
    '每个 workspace 一块本地任务看板：Agent 与人类共用同一个 JSON 文件，认领、推进、审核、收口都在上面走。',
    'One local task board per workspace: agents and humans share a single JSON file for claiming, working, reviewing and settling.',
  )
}

/**
 * The line that carries the architectural claim (and the reassurance): no
 * server, no account, no cloud — the file on this machine is the whole thing.
 */
export function aboutLocalNote(): string {
  return L(
    '看板数据全部在上面这一个 JSON 里——没有服务器、没有账号、没有云同步；旁边的人能看见，只是因为看的是同一个文件。',
    'Every bit of board data lives in that one JSON file — no server, no accounts, no cloud. Others see it only because they read the same file.',
  )
}

/** Input for the transparency block: live numbers the panel already has. */
export interface AboutFactsInput {
  boardFile: string | null
  cwd: string | null
  tasks: number
  /** The board's own roster size (`board.actors`), i.e. actors SEEN here — not
   *  knownActors(), which is the (smaller) set of names tasks mention. */
  roster: number
  boardVersion: number | null
  pluginId: string
}

/** One 「标签 → 值」 row of the transparency block. */
export interface AboutFact {
  key: 'file' | 'tasks' | 'actors' | 'format' | 'plugin'
  label: string
  value: string
}

/**
 * The transparency block — the part of an「关于」that is actually worth
 * reading: WHICH file this board is, HOW MUCH is in it, and WHICH format/plugin
 * wrote it. Values are plain strings so the panel only has to lay them out.
 */
export function aboutFacts(input: AboutFactsInput): AboutFact[] {
  const file = input.boardFile
    ?? (input.cwd ? `${input.cwd}/.dsh/taskboard.json` : '.dsh/taskboard.json')
  return [
    { key: 'file', label: L('看板文件', 'Board file'), value: file },
    { key: 'tasks', label: L('卡片', 'Cards'), value: String(input.tasks) },
    { key: 'actors', label: L('花名册', 'Roster'), value: String(input.roster) },
    { key: 'format', label: L('数据格式', 'Data format'), value: input.boardVersion === null ? '—' : `v${input.boardVersion}` },
    { key: 'plugin', label: L('插件 id', 'Plugin id'), value: input.pluginId },
  ]
}
