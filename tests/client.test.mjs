/**
 * Browser-face smoke test for dsh-taskboard-kit (no browser needed).
 *
 * The built browser bundle (lib/client.js) is loaded through the official
 * `window.__ModuleLoader__` envelope, its factory is executed with a require
 * that resolves the shell-seeded externals (react, react/jsx-runtime), and
 * the resulting exports are asserted:
 *
 *   1. module shape — name 'taskboard-kit', inject ['slots'];
 *   2. apply() — registers the「看板」conversation.view tab (id 'taskboard',
 *      order 40) against a fake slots ctx, and the injected store is real;
 *   3. the shared board math re-exported from the bundle — columnOf's four
 *      column derivations and compareTasks' priority-then-age ordering.
 *
 * Run: node tests/client.test.mjs   (or: npm test)
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// Pin the browser locale to English before the bundle's locale module reads
// `navigator.language` (node 20 has no global navigator; node 21+ has one
// whose language follows the host ICU locale — either way, pin it).
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true })
} catch {
  /* a non-configurable navigator still resolves to English for this suite */
}

const require_ = createRequire(import.meta.url)
const React = require_('react')
const { renderToStaticMarkup } = require_('react-dom/server')

// -------------------------------------------------------------- bundle load

let envelope
globalThis.window = {
  __ModuleLoader__: {
    load: (captured) => {
      envelope = captured
    },
  },
}
await import('../lib/client.js')
assert.ok(envelope, 'client bundle must register itself with the module loader')
const client = envelope.factory((specifier) => require_(specifier))

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

console.log('dsh-taskboard-kit browser-face smoke test:')

// --------------------------------------------------------- module shape

await check('bundle: the module-loader envelope names the package', () => {
  assert.equal(envelope.id, 'dsh-taskboard-kit')
  assert.equal(client.name, 'taskboard-kit')
  assert.deepEqual([...client.inject], ['slots'])
  assert.equal(client.TASKBOARD_VIEW_ID, 'taskboard')
})

// ------------------------------------------------------------ apply()

await check('apply(): the「看板」conversation view tab is registered', () => {
  const registrations = []
  const injections = []
  const disposers = []
  const ctx = {
    logger: () => ({ info: () => {} }),
    effect: (fn) => {
      const dispose = fn()
      const disposer = () => {
        if (typeof dispose === 'function') dispose()
      }
      disposers.push(disposer)
      return disposer
    },
    slots: {
      inject: (slot, callback) => {
        injections.push(slot)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  assert.deepEqual([...new Set(injections)].sort(), ['conversation.composer.dock', 'conversation.view', 'shell.overlay'])

  // The「看板」view tab sits after 对话 | 轨迹 | 文件 | 消息 (order 40).
  const view = registrations.find((row) => row.options.name === 'conversation.view')
  assert.ok(view, 'a conversation.view registration exists')
  assert.equal(view.options.id, 'taskboard')
  assert.equal(view.options.order, 40)
  assert.equal(view.options.label(), 'Board')
  assert.equal(typeof view.component, 'function')

  // The status-bar entry pill (composer.dock, beside the shipped stats row)
  // and the full-height right drawer (shell.overlay).
  const entry = registrations.find((row) => row.options.name === 'conversation.composer.dock')
  assert.ok(entry, 'the status-bar entry is registered into composer.dock')
  assert.equal(entry.options.id, 'taskboard-mini-entry')
  assert.equal(typeof entry.component, 'function')
  const mini = registrations.find((row) => row.options.name === 'shell.overlay')
  assert.ok(mini, 'the mini board drawer is registered into shell.overlay')
  assert.equal(mini.options.id, 'taskboard-mini')
  assert.equal(typeof mini.component, 'function')

  // All three surfaces share the page-wide store.
  const store = view.options.inject().store
  assert.equal(typeof store.getState, 'function')
  assert.equal(typeof store.subscribe, 'function')
  assert.equal(entry.options.inject().store, store, 'entry shares the store')
  assert.equal(mini.options.inject().store, store, 'mini board shares the store')
  const state = store.getState()
  assert.equal(state.status, 'loading')
  assert.equal(state.board, null)
  assert.equal(state.showClosed, false)
  assert.equal(state.miniOpen, false)

  // Effects: just the board poller — its disposer must stop the interval.
  assert.equal(disposers.length, 1)
  for (const dispose of disposers) dispose()
})

// --------------------------------------------------------- shared board math

await check('columnOf: the five statuses map onto the six columns', () => {
  // open + no assignee → the claimable pool
  assert.equal(client.columnOf({ status: 'open', assignee: null }), 'pool')
  // open + assignee → delegated, not yet started
  assert.equal(client.columnOf({ status: 'open', assignee: 'kimi' }), 'assigned')
  // the other four statuses map one-to-one onto their columns
  assert.equal(client.columnOf({ status: 'in_progress', assignee: 'kimi' }), 'in_progress')
  assert.equal(client.columnOf({ status: 'review', assignee: 'kimi' }), 'review')
  assert.equal(client.columnOf({ status: 'done', assignee: 'kimi' }), 'done')
  assert.equal(client.columnOf({ status: 'closed', assignee: null }), 'closed')
})

await check('compareTasks: priority first, then oldest first', () => {
  const task = (id, priority, created_at) => ({ id, priority, created_at })
  const high = task('T-1', 'high', '2026-09-20T09:00:00Z')
  const medium = task('T-2', 'medium', '2026-09-19T09:00:00Z')
  const low = task('T-3', 'low', '2026-09-18T09:00:00Z')

  // Priority dominates age: the younger high still precedes medium and low.
  const sorted = [low, medium, high].sort(client.compareTasks)
  assert.deepEqual(sorted.map((row) => row.id), ['T-1', 'T-2', 'T-3'])
  assert.ok(client.compareTasks(high, medium) < 0)
  assert.ok(client.compareTasks(low, high) > 0)

  // Same priority: oldest first; same timestamp: id breaks the tie.
  const older = task('T-4', 'medium', '2026-09-18T09:00:00Z')
  const newer = task('T-5', 'medium', '2026-09-19T09:00:00Z')
  assert.ok(client.compareTasks(older, newer) < 0)
  assert.ok(client.compareTasks(newer, older) > 0)
  const tieA = task('T-6', 'low', '2026-09-18T09:00:00Z')
  const tieB = task('T-7', 'low', '2026-09-18T09:00:00Z')
  assert.ok(client.compareTasks(tieA, tieB) < 0)
  assert.equal(client.compareTasks(tieA, tieA), 0)
})

// --------------------------------------------------------- drag-and-drop semantics

await check('planDrop: drops compile into the six-column op sequences', () => {
  assert.equal(typeof client.planDrop, 'function')
  const poolCard = { status: 'open', assignee: null }
  const assignedCard = { status: 'open', assignee: 'kimi' }
  const wipCard = { status: 'in_progress', assignee: 'kimi' }
  const reviewCard = { status: 'review', assignee: 'kimi' }
  const doneCard = { status: 'done', assignee: 'kimi' }
  const closedCard = { status: 'closed', assignee: 'kimi' }

  // 待认领 → 待审核: claim first, then submit.
  assert.deepEqual(client.planDrop(poolCard, 'review'), [
    { kind: 'claim' },
    { kind: 'update', patch: { action: 'submit' } },
  ])
  // 已指派 → 待审核: start, then submit.
  assert.deepEqual(client.planDrop(assignedCard, 'review'), [
    { kind: 'update', patch: { action: 'start' } },
    { kind: 'update', patch: { action: 'submit' } },
  ])
  // 进行中 → 待审核: just submit.
  assert.deepEqual(client.planDrop(wipCard, 'review'), [{ kind: 'update', patch: { action: 'submit' } }])
  // 待审核 → 进行中: reject (打回继续干).
  assert.deepEqual(client.planDrop(reviewCard, 'in_progress'), [{ kind: 'update', patch: { action: 'reject' } }])
  // 待审核 → 已完成: approve.
  assert.deepEqual(client.planDrop(reviewCard, 'done'), [{ kind: 'update', patch: { action: 'approve' } }])
  // Anything not closed → 已关闭: close.
  assert.deepEqual(client.planDrop(poolCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  assert.deepEqual(client.planDrop(wipCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  assert.deepEqual(client.planDrop(reviewCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  assert.deepEqual(client.planDrop(doneCard, 'closed'), [{ kind: 'update', patch: { action: 'close' } }])
  // 已完成/已关闭 never go back to 待审核.
  assert.deepEqual(client.planDrop(doneCard, 'review'), [])
  assert.deepEqual(client.planDrop(closedCard, 'review'), [])
  // Dropping where the card already lives is a no-op — no request may fire.
  assert.deepEqual(client.planDrop(poolCard, 'pool'), [])
  assert.deepEqual(client.planDrop(reviewCard, 'review'), [])
  assert.deepEqual(client.planDrop(doneCard, 'done'), [])
  assert.deepEqual(client.planDrop(closedCard, 'closed'), [])
  assert.deepEqual(client.planDrop(assignedCard, 'assigned', 'kimi'), [])
  // 已指派 with an EMPTY name means 放回待认领: same plan as a drop on pool.
  assert.deepEqual(client.planDrop(assignedCard, 'assigned', ''), [{ kind: 'update', patch: { assignee: null } }])
  assert.deepEqual(client.planDrop(assignedCard, 'assigned', '   '), [{ kind: 'update', patch: { assignee: null } }])
  // 待审核 → 待认领: reject back to 进行中, then stop + unassign.
  assert.deepEqual(client.planDrop(reviewCard, 'pool'), [
    { kind: 'update', patch: { action: 'reject' } },
    { kind: 'update', patch: { action: 'stop', assignee: null } },
  ])
  // A finished card dropped on 进行中 needs both halves, in order.
  assert.deepEqual(client.planDrop(doneCard, 'in_progress'), [
    { kind: 'update', patch: { action: 'reopen' } },
    { kind: 'update', patch: { action: 'start' } },
  ])
  // 已完成 → 已指派 with a name: reopen straight into that assignee.
  assert.deepEqual(client.planDrop(doneCard, 'assigned', 'nova'), [{ kind: 'update', patch: { action: 'reopen', assignee: 'nova' } }])
})

// --------------------------------------------------------- actor roster

await check('knownActors: union of all four sources, cleaned and sorted', () => {
  assert.equal(typeof client.knownActors, 'function')
  const task = (over) => ({
    id: 'T-x', title: 't', detail: '', status: 'open', priority: 'medium',
    assignee: null, tags: [], created_by: 'human', created_at: '2026-09-20T09:00:00Z',
    updated_at: '2026-09-20T09:00:00Z', log: [], comments: [], ...over,
  })
  const board = {
    version: 1, workspace: '/work/a', next_seq: 5,
    tasks: {
      // assignee + created_by + log[].by + comments[].by; duplicates across
      // sources collapse; null assignee and empty by are dropped.
      'T-1': task({
        id: 'T-1', assignee: 'kimi', created_by: 'human',
        log: [{ at: '2026-09-20T09:00:00Z', by: 'kimi', event: 'claimed' }, { at: '2026-09-20T10:00:00Z', by: 'claude', event: 'started' }],
        comments: [{ at: '2026-09-21T09:00:00Z', by: 'dsh', text: 'handoff' }],
      }),
      'T-2': task({
        id: 'T-2', assignee: null, created_by: 'human',
        log: [{ at: '2026-09-20T09:00:00Z', by: '', event: 'created' }, { at: '2026-09-20T09:01:00Z', by: 'claude', event: 'updated' }],
        comments: [],
      }),
      'T-3': task({ id: 'T-3', assignee: 'agent-x', created_by: 'agent-x' }),
    },
  }
  assert.deepEqual(client.knownActors(board), ['agent-x', 'claude', 'dsh', 'human', 'kimi'])
  // An empty board has an empty roster (the UI shows the hint, not a dead input).
  assert.deepEqual(client.knownActors({ version: 1, workspace: '/work/b', next_seq: 1, tasks: {} }), [])
})

// --------------------------------------------------------- guide snippets

await check('guide snippets: interpolate cli/cwd, degrade on a null cli', () => {
  assert.equal(typeof client.conventionSnippet, 'function')
  assert.equal(typeof client.dispatchSnippet, 'function')

  const conv = client.conventionSnippet('/a/bin/taskboard.mjs')
  assert.ok(conv.includes('/a/bin/taskboard.mjs'), 'cli path interpolated')
  assert.ok(conv.includes('--cwd "$PWD"'), 'convention is portable across projects via $PWD')
  assert.ok(!conv.includes('--cwd /'), 'no frozen absolute cwd baked into the convention template')

  const fallback = client.conventionSnippet(null)
  assert.ok(fallback.includes('<taskboard 插件目录>/bin/taskboard.mjs'), 'null cli degrades to the placeholder')
  assert.ok(fallback.includes('--cwd "$PWD"'), 'still portable without a cli path')

  const disp = client.dispatchSnippet('/a/bin/taskboard.mjs', '/w')
  assert.ok(disp.includes('assignee'), 'dispatch teaches the assignee lookup')
  assert.ok(disp.includes('T-__'), 'dispatch keeps the first-task placeholder')
  assert.ok(disp.includes('/a/bin/taskboard.mjs'), 'cli path interpolated')
  const dispFallback = client.dispatchSnippet(null, '/w')
  assert.ok(dispFallback.includes('<taskboard 插件目录>/bin/taskboard.mjs'), 'null cli degrades to the placeholder')
})

await check('guideProjectDir: the board file location wins over the detected cwd', () => {
  assert.equal(typeof client.guideProjectDir, 'function')
  assert.equal(client.guideProjectDir('/proj/x/.dsh/taskboard.json', '/elsewhere'), '/proj/x', 'board_file is authoritative')
  assert.equal(client.guideProjectDir(null, '/session/cwd'), '/session/cwd', 'cwd is the fallback')
  assert.equal(client.guideProjectDir(null, null), '<workspace>', 'last-resort placeholder')
  assert.equal(client.guideProjectDir('/odd/path/board.json', '/w'), '/w', 'unrecognized board_file shape falls back to cwd')
})

await check('guide hook snippets: guarded, assignee-tagged, parseable', () => {
  assert.equal(typeof client.hookSnippetKimi, 'function')
  assert.equal(typeof client.hookSnippetClaude, 'function')

  const kimi = client.hookSnippetKimi('/a/bin/taskboard.mjs')
  assert.ok(kimi.includes('/a/bin/taskboard.mjs'), 'cli path interpolated')
  assert.ok(kimi.includes('[ -f .dsh/taskboard.json ]'), 'board-file guard present')
  assert.ok(kimi.includes('--assignee kimi'), 'assignee kimi in the command')
  assert.equal(kimi.match(/\[\[hooks\]\]/g).length, 2, 'two [[hooks]] blocks (SessionStart + UserPromptSubmit)')
  assert.ok(kimi.includes('event = "SessionStart"'))
  assert.ok(kimi.includes('event = "UserPromptSubmit"'))
  assert.ok(kimi.includes('--cwd "$PWD"'), 'hook runs against the session project dir')
  assert.ok(client.hookSnippetKimi(null).includes('<taskboard 插件目录>/bin/taskboard.mjs'), 'null cli degrades to the placeholder')

  const claude = client.hookSnippetClaude('/a/bin/taskboard.mjs')
  const parsed = JSON.parse(claude) // must be valid JSON (quotes escaped by construction)
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].type, 'command')
  assert.ok(parsed.hooks.SessionStart[0].hooks[0].command.includes('/a/bin/taskboard.mjs'), 'cli path in the SessionStart command')
  assert.ok(parsed.hooks.SessionStart[0].hooks[0].command.includes('[ -f .dsh/taskboard.json ]'), 'board-file guard in SessionStart')
  assert.ok(parsed.hooks.SessionStart[0].hooks[0].command.includes('--assignee claude'), 'assignee claude in SessionStart')
  assert.ok(parsed.hooks.UserPromptSubmit[0].hooks[0].command.includes('--assignee claude'), 'UserPromptSubmit carries the same command in full')
  assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].command, parsed.hooks.SessionStart[0].hooks[0].command, 'both events carry the full identical command (no "ditto" shorthand)')
  assert.ok(client.hookSnippetClaude(null).includes('插件目录'), 'null cli degrades to the placeholder')
})

// --------------------------------------------------------- markdown + refs

await check('renderMarkdown: real structure for the common syntax', () => {
  const md = client.renderMarkdown
  assert.equal(typeof md, 'function')

  // Blocks.
  assert.ok(md('## 标题').startsWith('<h2>'), 'heading renders')
  assert.ok(md('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'), 'bullet list renders')
  assert.ok(md('1. a\n2. b').includes('<ol><li>a</li><li>b</li></ol>'), 'numbered list renders')
  assert.ok(md('> wise\n> words').includes('<blockquote>wise<br>words</blockquote>'), 'quote renders')
  assert.ok(md('one\ntwo\n\nthree').includes('one<br>two</p><p>three'), 'single newline = break, blank line = new paragraph')
  const fenced = md('```\nconst a = 1 < 2\n```')
  assert.ok(fenced.includes('<pre><code>const a = 1 &lt; 2</code></pre>'), 'fenced code renders escaped verbatim')

  // Inline.
  assert.ok(md('**b**').includes('<strong>b</strong>'), 'bold')
  assert.ok(md('*i*').includes('<em>i</em>'), 'italic')
  assert.ok(md('`x<y`').includes('<code>x&lt;y</code>'), 'inline code is escaped')
  const link = md('[site](https://example.com/a?x=1&y=2)')
  assert.ok(link.includes('<a href="https://example.com/a?x=1&amp;y=2"'), 'http(s) link renders, & escaped in href')
  assert.ok(link.includes('target="_blank"') && link.includes('rel="noopener noreferrer"'), 'links externalize safely')
  assert.ok(md('` **not bold** `').includes('**not bold**'), 'markup inside inline code stays literal')
})

await check('renderMarkdown: multi-source input cannot inject anything', () => {
  const md = client.renderMarkdown
  assert.ok(!md('<script>alert(1)</script>').includes('<script>'), 'raw html is escaped')
  assert.ok(!md('<img src=x onerror=alert(1)>').includes('<img'), 'img onerror never becomes a tag')
  assert.ok(!md('[click](javascript:alert(1))').includes('<a'), 'javascript: urls stay literal text')
  assert.ok(!md('[click](vbscript:x)').includes('<a'), 'vbscript: urls stay literal text')
  assert.ok(!md('[click](data:text/html,<b>)').includes('<a'), 'data: urls stay literal text')
  const breakout = md('[x](https://a.b/"onmouseover="alert(1)")')
  assert.ok(!breakout.includes('onmouseover="alert(1)"'), 'attribute breakout is neutralized by escaping')
  // An unclosed fence just renders to the end of input — never throws.
  assert.ok(md('```\nnever closed').includes('<pre><code>never closed</code></pre>'))
})

await check('taskRef: T-N shows as #N, anything else verbatim', () => {
  assert.equal(typeof client.taskRef, 'function')
  assert.equal(client.taskRef('T-3'), '#3')
  assert.equal(client.taskRef('T-12'), '#12')
  assert.equal(client.taskRef('abc'), 'abc')
  assert.equal(client.taskRef('T-x'), 'T-x')
})

// --------------------------------------------------------- theme tokens

await check('theme: the primary button rides the shell link tokens (no white block in dark mode)', () => {
  // dsh dark theme resolves --dsw-alias-brand-primary to a NEAR-WHITE
  // monochrome fill — using it as a button fill was the "white block" bug
  // (twice: once with #fff text, once via button-primary-fill which aliases
  // brand-primary). The shell's own blue primary button (the composer send
  // key) measures to --dsw-alias-link in both themes; the pairing is
  // label-primary-foreground text and button-info-hover for the hover.
  // The loading view still injects TB_CSS, so no bridge is needed.
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: false, error: 'x' }) }, pollMs: 10 ** 9 })
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? ''
  assert.ok(css.includes('.tb-btn-primary'), 'primary rule injected with the panel')

  const primary = (css.match(/\.tb-btn-primary \{([^}]*)\}/) ?? [])[1] ?? ''
  assert.ok(primary.includes('background:var(--dsw-alias-link') || primary.includes('background: var(--dsw-alias-link'), 'fill = the link token (blue in BOTH themes)')
  assert.ok(primary.includes('var(--dsw-alias-label-primary-foreground'), 'text = shell on-fill token')
  assert.ok(!primary.includes('button-primary-fill'), 'no button-primary-fill (aliases brand-primary = near-white in dark)')
  assert.ok(!/background:\s*(#fff|#ffffff|white)\b/i.test(primary), 'no hardcoded white background on the primary button')
  assert.ok(!/color:\s*(#fff|#ffffff|white)\b/i.test(primary), 'no hardcoded white text on the primary button')

  const hover = (css.match(/\.tb-btn-primary:hover \{([^}]*)\}/) ?? [])[1] ?? ''
  assert.ok(hover.includes('var(--dsw-alias-button-info-hover'), 'hover = the link-paired info-hover token')

  // No tb-* rule may hardcode a white/light background (var() fallbacks for
  // pre-token shells are the sanctioned exception and live inside var()).
  assert.ok(!/\.tb-[a-z-]+[^{]*\{[^}]*background:\s*(#fff|#ffffff|white)\b/i.test(css), 'no tb-* rule hardcodes a white background')
})

// --------------------------------------------------------- mini board (composer side)

await check('openTaskCount: every not-final task, zero on an empty board', () => {
  assert.equal(typeof client.openTaskCount, 'function')
  const task = (status, assignee) => ({ id: 'T-x', title: 't', status, assignee })
  const board = {
    version: 1, workspace: '/w', next_seq: 8,
    tasks: {
      'T-1': task('open', null),        // pool
      'T-2': task('open', 'kimi'),      // assigned
      'T-3': task('in_progress', 'kimi'),
      'T-4': task('review', 'kimi'),
      'T-5': task('done', 'kimi'),      // final
      'T-6': task('closed', null),      // final
    },
  }
  assert.equal(client.openTaskCount(board), 4, 'open+assigned+in_progress+review counted, done/closed not')
  assert.equal(client.openTaskCount({ version: 1, workspace: '/w', next_seq: 1, tasks: {} }), 0, 'empty board → 0 (badge hides)')
  assert.equal(client.openTaskCount(null), 0, 'no board → 0')
})

await check('mini board: entry button badge and the six-block drawer', async () => {
  const now = Date.now()
  const iso = (ms) => new Date(now - ms).toISOString()
  const mk = (id, title, status, assignee) => ({
    id, title, detail: '', status, assignee, priority: 'medium', value: null,
    tags: [], created_by: 'human', created_at: iso(1000 * 60 * 60), updated_at: iso(1000 * 60), log: [], comments: [],
  })
  const board = {
    version: 1, workspace: '/work/a', next_seq: 7,
    tasks: {
      'T-1': mk('T-1', 'pool one', 'open', null),
      'T-2': mk('T-2', 'assigned one', 'open', 'kimi'),
      'T-3': mk('T-3', 'wip one', 'in_progress', 'kimi'),
      'T-4': mk('T-4', 'review one', 'review', 'kimi'),
      'T-5': mk('T-5', 'done one', 'done', 'kimi'),
      'T-6': mk('T-6', 'closed one', 'closed', 'kimi'),
    },
  }
  const bridge = { board: async () => ({ ok: true, board }) }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refresh()

  // Entry pill: quiet stats-row look, count as a dim suffix (no loud badge).
  const button = renderToStaticMarkup(React.createElement(client.MiniBoardButton, { store }))
  assert.ok(button.includes('tb-mini-entry'), 'the pill rides the quiet entry class')
  assert.ok(button.includes('Board'), 'button label')
  assert.ok(button.includes('· 4'), 'open-task count as a pill suffix')
  assert.ok(button.includes('data-composer-stats') === false, 'we never impersonate the stats row')

  // Drawer closed → the overlay renders nothing at all.
  const closed = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store }))
  assert.equal(closed, '', 'overlay is null while closed')

  // Drawer open: full-height right drawer, five expanded blocks + the
  // collapsed closed row.
  store.setMiniOpen(true)
  const open = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store }))
  assert.ok(open.includes('position:fixed'), 'frame-wide backdrop')
  assert.ok(open.includes('height:100%'), 'full-height drawer')
  for (const label of ['Pool', 'Assigned', 'In progress', 'In review', 'Done']) {
    assert.ok(open.includes(`>${label}<`), `block: ${label}`)
  }
  assert.ok(open.includes('Closed (1)'), 'closed renders collapsed as one toggle row')
  assert.ok(!open.includes('closed one'), 'closed tasks hidden while collapsed')
  for (const title of ['pool one', 'assigned one', 'wip one', 'review one', 'done one']) {
    assert.ok(open.includes(title), `row: ${title}`)
  }
  assert.ok(open.includes('>#3<'), 'rows carry the #N ref')
  assert.ok(open.includes('unclaimed'), 'pool row carries the outline badge')
  assert.ok(open.includes('draggable'), 'rows are draggable (planDrop pipeline)')

  // A row click opens the layer-2 detail drawer (shared DetailDrawer),
  // visibly offset from the board drawer: narrower (520 vs 560) and floated
  // 12px off the top and bottom, so the lower layer's left edge + corners
  // peek out while both right edges stay flush with the frame.
  store.select('T-3')
  const layered = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store }))
  assert.ok(layered.includes('wip one') && layered.includes('>Details<'), 'layer 2 stacks the detail drawer over the sheet')
  assert.ok(layered.includes('width:560px'), 'board drawer widened to 560')
  assert.ok(layered.includes('width:520px'), 'detail layer is narrower')
  assert.ok(layered.includes('top:12px') && layered.includes('bottom:12px'), 'detail layer floats off top and bottom')
})

await check('runPlanOps: executes the plan in order and stops at the first failure', async () => {
  assert.equal(typeof client.runPlanOps, 'function')
  const calls = []
  const store = {
    claim: async (id) => { calls.push(['claim', id]); return true },
    update: async (input) => { calls.push(['update', input]); return true },
  }
  // The mini board's drop on 待审核 for a pool card = claim + submit.
  await client.runPlanOps(store, 'T-1', client.planDrop({ status: 'open', assignee: null }, 'review'))
  assert.deepEqual(calls, [['claim', 'T-1'], ['update', { id: 'T-1', action: 'submit' }]], 'claim then submit, in order')

  // A failing step stops the sequence (the error rides the store's channel).
  const failing = {
    claim: async () => false,
    update: async (input) => { calls.push(['update-after-fail', input]); return true },
  }
  await client.runPlanOps(failing, 'T-2', client.planDrop({ status: 'open', assignee: null }, 'review'))
  assert.ok(!calls.some((row) => row[0] === 'update-after-fail'), 'no op runs after a failure')
})

// ------------------------------------------------------------------ done

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
