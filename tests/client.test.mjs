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
  // The CSS ownership protocol needs the two to agree: scripts/build.mjs writes the
  // envelope id from package.json's name, and the loader compares it with data-plugin.
  assert.equal(client.CLIENT_PLUGIN_ID, envelope.id, 'CSS owner id === bundle envelope id')
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

// ------------------------------------------------- 按负责人 (by-owner) view

/** A task fixture with the fields the owner grouping reads. */
const ownerTask = (over) => ({
  id: 'T-x', title: 't', detail: '', status: 'open', priority: 'medium',
  assignee: null, tags: [], created_by: 'human', created_at: '2026-09-20T09:00:00Z',
  updated_at: '2026-09-20T09:00:00Z', log: [], comments: [],
  reviewer: null, waiting_on: null, value: null, ...over,
})

await check('groupByOwner: one lane per owner, pool first and 等人类 last', () => {
  assert.equal(typeof client.groupByOwner, 'function')
  const board = {
    version: 1, workspace: '/work/a', next_seq: 9,
    actors: {
      dsh: { kind: 'agent', aliases: ['dsh-agent', 'dsh-web'], first_seen_at: '2026-09-01T00:00:00Z', last_seen_at: new Date().toISOString() },
      kimi: { kind: 'agent', aliases: [], first_seen_at: '2026-09-01T00:00:00Z', last_seen_at: new Date().toISOString() },
    },
    tasks: {
      'T-1': ownerTask({ id: 'T-1', assignee: 'dsh' }),
      'T-2': ownerTask({ id: 'T-2', assignee: 'dsh-agent' }),   // alias → same lane
      'T-3': ownerTask({ id: 'T-3', assignee: 'kimi' }),
      'T-4': ownerTask({ id: 'T-4', assignee: null }),          // the pool
      'T-5': ownerTask({ id: 'T-5', assignee: 'kimi', waiting_on: { kind: 'human', who: 'human', question: 'q', since: '2026-09-20T09:00:00Z' } }),
    },
  }
  const groups = client.groupByOwner(board)
  // Order: 待认领 → owners (alphabetical) → 等人类.
  assert.deepEqual(groups.map((g) => g.kind), ['unassigned', 'actor', 'actor', 'human'])
  // `label` carries the RAW owner name; the「等人类 ·」prefix is added by the
  // panel's ownerLabel() at render time, so the data layer stays presentation-free.
  assert.deepEqual(groups.map((g) => g.label), ['', 'dsh', 'kimi', 'kimi'])
  assert.equal(groups[0].key, client.UNASSIGNED_KEY)
  // The human lane shares kimi's name but not its key — the two can coexist.
  assert.notEqual(
    groups.find((g) => g.kind === 'actor' && g.label === 'kimi').key,
    groups.find((g) => g.kind === 'human').key,
  )

  const dsh = groups.find((g) => g.label === 'dsh')
  // Aliases fold into ONE lane instead of splitting across dsh / dsh-agent.
  assert.deepEqual(dsh.tasks.map((t) => t.id).sort(), ['T-1', 'T-2'])
  assert.equal(groups.find((g) => g.kind === 'unassigned').tasks[0].id, 'T-4')
  // kimi has BOTH: work it is doing (T-3) and work blocked on the human (T-5).
  // They are different lanes — a blocked card is not part of anyone's active
  // load, and the two must never be summed into one pile.
  assert.deepEqual(groups.find((g) => g.kind === 'actor' && g.label === 'kimi').tasks.map((t) => t.id), ['T-3'])
  assert.deepEqual(groups.find((g) => g.kind === 'human').tasks.map((t) => t.id), ['T-5'])
})

await check('groupByOwner: hides only SETTLED work, so done cards stay visible', () => {
  const board = {
    version: 1, workspace: '/work/a', next_seq: 5, actors: {},
    tasks: {
      'T-1': ownerTask({ id: 'T-1', assignee: 'kimi', status: 'in_progress' }),
      'T-2': ownerTask({ id: 'T-2', assignee: 'kimi', status: 'done' }),
      'T-3': ownerTask({ id: 'T-3', assignee: 'kimi', status: 'closed' }),
    },
  }
  // done is NOT terminal (v0.6): an unsettled card stays on the owner's plate,
  // because that plate is exactly where the missing close has to show up.
  const live = client.groupByOwner(board)
  assert.deepEqual(live.flatMap((g) => g.tasks.map((t) => t.id)).sort(), ['T-1', 'T-2'])
  const all = client.groupByOwner(board, { includeClosed: true })
  assert.deepEqual(all.flatMap((g) => g.tasks.map((t) => t.id)).sort(), ['T-1', 'T-2', 'T-3'])
  // isFinal is the filter's unit and now means "settled", i.e. closed only.
  assert.equal(client.isFinal(ownerTask({ status: 'done' })), false)
  assert.equal(client.isFinal(ownerTask({ status: 'closed' })), true)
  assert.equal(client.isFinal(ownerTask({ status: 'review' })), false)
  // A null board and an empty board both yield no lanes (the caller shows its own empty state).
  assert.deepEqual(client.groupByOwner(null), [])
  assert.deepEqual(client.groupByOwner({ version: 1, workspace: '/w', next_seq: 1, tasks: {} }), [])
})

await check('groupByOwner: lanes are ordered by priority then age, like the status view', () => {
  const board = {
    version: 1, workspace: '/work/a', next_seq: 5, actors: {},
    tasks: {
      'T-1': ownerTask({ id: 'T-1', assignee: 'kimi', priority: 'low', created_at: '2026-09-01T00:00:00Z' }),
      'T-2': ownerTask({ id: 'T-2', assignee: 'kimi', priority: 'high', created_at: '2026-09-25T00:00:00Z' }),
      'T-3': ownerTask({ id: 'T-3', assignee: 'kimi', priority: 'medium', created_at: '2026-09-10T00:00:00Z' }),
    },
  }
  const [lane] = client.groupByOwner(board)
  assert.deepEqual(lane.tasks.map((t) => t.id), ['T-2', 'T-3', 'T-1'])
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

await check('guide hook snippets: guarded, actor-tagged, silent-when-clean, parseable', () => {
  assert.equal(typeof client.hookSnippetKimi, 'function')
  assert.equal(typeof client.hookSnippetClaude, 'function')

  const kimi = client.hookSnippetKimi('/a/bin/taskboard.mjs')
  assert.ok(kimi.includes('/a/bin/taskboard.mjs'), 'cli path interpolated')
  assert.ok(kimi.includes('[ -f .dsh/taskboard.json ]'), 'board-file guard present')
  assert.ok(kimi.includes('inbox --cwd "$PWD" --by kimi'), 'the hook asks for MY inbox, tagged with my name')
  assert.ok(kimi.includes('没有该你处理的事') && kimi.includes('nothing is on you'),
    'the hook stays silent when nothing is on me (both locales)')
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
  assert.ok(parsed.hooks.SessionStart[0].hooks[0].command.includes('--by claude'), 'actor claude in SessionStart')
  assert.ok(parsed.hooks.UserPromptSubmit[0].hooks[0].command.includes('--by claude'), 'UserPromptSubmit carries the same command in full')
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

await check('renderMarkdown: images are real tags, and only over http/https', () => {
  const md = client.renderMarkdown
  const img = md('![截图](https://example.com/a.png)')
  assert.ok(img.includes('<img src="https://example.com/a.png"'), 'http(s) src renders a tag')
  assert.ok(img.includes('alt="截图"'), 'alt rides along')
  assert.ok(img.includes('loading="lazy"') && img.includes('referrerpolicy="no-referrer"'), 'no eager fetch, no referrer')
  assert.ok(!img.includes('<a href'), 'this is an image now — no leftover link')
  assert.ok(!/!<a/.test(img), 'and the old "!" + link degradation is gone')

  // Scheme whitelist: an image src is a LOAD, so only http/https may pass.
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'vbscript:x', 'file:///etc/passwd']) {
    assert.ok(!md(`![x](${bad})`).includes('<img'), `${bad} never becomes an image tag`)
  }
  // Attribute breakout through alt is escaped, not injected.
  const breakout = md('![a" onerror="alert(1)](https://e.com/x.png)')
  assert.ok(!breakout.includes('onerror="alert(1)"'), 'alt cannot break out of the attribute')
  // A plain link is untouched by the new rule (images run before links).
  assert.ok(md('[site](https://e.com)').includes('<a href="https://e.com"'), 'links still render')
})

await check('renderMarkdown: lists nest by indentation (two levels max)', () => {
  const md = client.renderMarkdown
  assert.equal(md('- 一级\n  - 二级'), '<ul><li>一级<ul><li>二级</li></ul></li></ul>', 'a deeper item opens a child list INSIDE the parent li')
  assert.equal(md('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', 'a shallow item closes both levels')
  // Deeper than two levels clamps to level 2 (three-level nesting is noise in a card).
  assert.equal(md('- 一级\n  - 二级\n    - 三级'), '<ul><li>一级<ul><li>二级</li><li>三级</li></ul></li></ul>', 'level 3 clamps to level 2')
  // Marker kinds are honoured per item: a change opens a sibling list.
  assert.equal(md('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>', 'a marker-kind change starts a new list')
  assert.equal(md('- a\n  1. b\n- c'), '<ul><li>a<ol><li>b</li></ol></li><li>c</li></ul>', 'an ordered child nests in the unordered parent')
  // The flat shapes the old renderer produced are byte-identical.
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>')
})

await check('renderMarkdown: task boxes are read-only checkboxes (never a write-back)', () => {
  const md = client.renderMarkdown
  const open = md('- [ ] 未做')
  assert.ok(open.includes('<input type="checkbox" disabled>'), 'an open box is a disabled checkbox')
  assert.ok(!open.includes('checked'), 'and it is not checked')
  for (const mark of ['x', 'X']) {
    assert.ok(md(`- [${mark}] 做完`).includes('<input type="checkbox" disabled checked>'), `${mark} → a checked, disabled box`)
  }
  // Read-only by construction: no handler, no form — nothing can write back to
  // the card file, which would create "who changed my card?" cases.
  assert.ok(!/on[a-z]+=/.test(md('- [x] done')), 'no event handlers ride the rendered box')

  // Prose is not a task list: the rule is anchored to the fragment head.
  assert.ok(md('结论 [x] 已确认').includes('[x] 已确认'), 'a mid-sentence [x] stays literal')
  assert.ok(md('[x](https://e.com)').includes('<a href="https://e.com"'), 'a link with a one-char label is not a box')

  // A table CELL head is a fragment head too — the two inline shapes work there.
  const table = md('| 状态 | 图 |\n|---|---|\n| [x] 完了 | ![图](https://e.com/x.png) |')
  assert.ok(table.includes('<td><input type="checkbox" disabled checked> 完了</td>'), 'a checkbox renders inside a cell')
  assert.ok(table.includes('<td><img src="https://e.com/x.png"'), 'and an image renders inside a cell')
})

await check('panel: a markdown comment renders in a block container (tables are block content)', async () => {
  const board = collabBoard([
    {
      id: 'T-1', title: 'card with a rich comment', status: 'in_progress', assignee: 'dsh',
      comments: [{ at: new Date().toISOString(), by: 'kimi', text: '| 来源 | 事项 |\n|---|---|\n| dsh | 表格不再塞进 span |' }],
    },
  ])
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd(board.workspace)
  await store.refresh()
  store.setMiniOpen(true)
  const html = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store, initialSelectedId: 'T-1', initialTab: 'comments' }))
  assert.ok(html.includes('<div class="tb-md"'), 'the comment body is a block-level div')
  assert.ok(html.includes('<div class="tb-table-wrap"><table>'), 'and its table renders as a table')
})

await check('renderMarkdown: GFM tables render as real tables (not raw pipes)', () => {
  const md = client.renderMarkdown

  const table = md('| 来源 | 事项 |\n|---|----|\n| dsh@kimi.ice | 迁移卡在 PUT |\n| dsh@mum.ice | playbook 修正 |')
  assert.ok(table.includes('<div class="tb-table-wrap"><table>'), 'table rides the horizontal-scroll wrapper')
  assert.ok(table.includes('<thead><tr><th>来源</th><th>事项</th></tr></thead>'), 'header row becomes th cells')
  assert.ok(
    table.includes('<tbody><tr><td>dsh@kimi.ice</td><td>迁移卡在 PUT</td></tr><tr><td>dsh@mum.ice</td><td>playbook 修正</td></tr></tbody>'),
    'body rows become td cells',
  )
  assert.ok(!table.includes('|---|'), 'the delimiter row never leaks as text')

  // Outer pipes are optional, spacing is irrelevant.
  assert.ok(md('a | b\n--- | ---\n1 | 2').includes('<tbody><tr><td>1</td><td>2</td></tr></tbody>'), 'table without outer pipes')
  // A paragraph immediately above a table does not swallow the header row.
  assert.ok(
    md('待办如下：\n| a | b |\n|---|---|\n| 1 | 2 |').startsWith('<p>待办如下：</p><div class="tb-table-wrap">'),
    'table directly under a paragraph still opens a table',
  )
  // Column alignment from the delimiter row.
  const aligned = md('| a | b | c |\n|:--|--:|:-:|\n| 1 | 2 | 3 |')
  assert.ok(aligned.includes('<th style="text-align:left">a</th>'), 'left align')
  assert.ok(aligned.includes('<th style="text-align:right">b</th>'), 'right align')
  assert.ok(aligned.includes('<th style="text-align:center">c</th>'), 'center align')
  assert.ok(aligned.includes('<td style="text-align:center">3</td>'), 'body cells inherit the column align')
  // Ragged rows are normalized to the header width.
  assert.ok(md('| a | b |\n|---|---|\n| 1 |').includes('<tr><td>1</td><td></td></tr>'), 'short row is padded')
  assert.ok(md('| a | b |\n|---|---|\n| 1 | 2 | 3 |').includes('<tr><td>1</td><td>2</td></tr>'), 'long row is clipped')
  // Header-only table (no body rows).
  const empty = md('| a | b |\n|---|---|')
  assert.ok(empty.includes('</thead></table>') && !empty.includes('<tbody>'), 'header-only table has no tbody')
  // A bare delimiter row is a paragraph, not a table (`---` alone is a break).
  assert.ok(md('|---|').includes('<p>|---|</p>'), 'delimiter row without a header stays text')
  assert.ok(md('---').includes('<hr>'), 'thematic break renders')
  // Inline formatting still works inside cells.
  assert.ok(md('| **b** | `x<y` |\n|---|---|').includes('<th><strong>b</strong></th><th><code>x&lt;y</code></th>'), 'cells keep inline rules')
  // Escaped pipes and pipes inside code spans do not split cells.
  assert.ok(md('| a \\| b | c |\n|---|---|').includes('<th>a | b</th><th>c</th>'), 'escaped pipe stays in the cell')
  assert.ok(md('| `a|b` | c |\n|---|---|').includes('<th><code>a|b</code></th><th>c</th>'), 'pipe inside inline code does not split')
  // Cells are escaped exactly like paragraphs — no tag injection through a table.
  assert.ok(!md('| <img src=x onerror=alert(1)> | b |\n|---|---|').includes('<img'), 'table cells cannot inject html')
})

await check('renderMarkdown: setext headings win over the thematic break', () => {
  const md = client.renderMarkdown
  // GFM reads `title\n---` as an h2; rendering it as <p>title</p><hr> would be
  // a silent misread of the most common underline idiom.
  assert.equal(md('标题\n---'), '<h2>标题</h2>')
  assert.equal(md('标题\n==='), '<h1>标题</h1>')
  assert.equal(md('标题\n-'), '<h2>标题</h2>', 'a single dash underline is enough')
  assert.equal(md('a\nb\n---'), '<h2>a<br>b</h2>', 'the underline closes the whole paragraph')
  assert.equal(md('a\n---\nb'), '<h2>a</h2><p>b</p>')
  // `***` / `___` are never underlines — they stay thematic breaks.
  assert.ok(md('a\n***').includes('<p>a</p><hr>'), '*** under text is a break, not a heading')
  // A standalone underline is still a break (nothing to head).
  assert.ok(md('---').includes('<hr>'), 'bare --- has no paragraph to head')
  assert.ok(md('a\n\n---').includes('<p>a</p><hr>'), 'blank line between text and --- keeps it a break')
  // A paragraph followed by a list/heading is unaffected.
  assert.ok(md('说明\n- 项目').startsWith('<p>说明</p><ul>'), 'list after a paragraph stays a list')
  assert.ok(md('说明\n## 小标题').startsWith('<p>说明</p><h2>'), 'heading after a paragraph stays a heading')
  // No runaway loop on a document made only of underlines.
  assert.equal(md('---\n---'), '<hr><hr>')
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

/**
 * Minimal document for the stylesheet-ownership contract. Only the surface
 * `ensureTaskboardStyles` + dsh's loader bookkeeping touch: createElement /
 * head.appendChild / querySelector(All) with the four selectors those two use.
 */
function fakeStyleDocument() {
  const tags = []
  const matches = (tag, selector) => {
    let m
    if (selector === 'style:not([data-plugin])') return tag.getAttribute('data-plugin') === null
    if (selector === 'style[data-plugin]') return tag.getAttribute('data-plugin') !== null
    if ((m = /^style\[data-plugin="([^"]*)"\]$/.exec(selector))) return tag.getAttribute('data-plugin') === m[1]
    if ((m = /^style\[data-plugin-css="([^"]*)"\]$/.exec(selector))) return tag.getAttribute('data-plugin-css') === m[1]
    throw new Error(`fakeStyleDocument: unsupported selector ${selector}`)
  }
  const doc = {
    tags,
    head: { appendChild: (node) => (tags.push(node), node) },
    createElement: () => {
      const attrs = new Map()
      const tag = {
        textContent: '',
        setAttribute: (name, value) => attrs.set(name, String(value)),
        getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
        remove: () => {
          const at = tags.indexOf(tag)
          if (at >= 0) tags.splice(at, 1)
        },
      }
      return tag
    },
    querySelector: (selector) => tags.find((tag) => matches(tag, selector)) ?? null,
    querySelectorAll: (selector) => tags.filter((tag) => matches(tag, selector)),
  }
  return doc
}

// The two loader primitives under test, transcribed from
// @deepseek-ai/dsh-client-modules/lib/client.js.
const loaderClaimStyles = (doc, id) => {
  for (const el of doc.querySelectorAll('style:not([data-plugin])')) el.setAttribute('data-plugin', id)
}
const loaderRemoveOwnedStyles = (doc, id) => {
  for (const el of doc.querySelectorAll('style[data-plugin]')) if (el.getAttribute('data-plugin') === id) el.remove()
}

await check('theme: TB_CSS is injected as a package-owned <head> tag, once, and heals', () => {
  const doc = fakeStyleDocument()
  client.ensureTaskboardStyles(doc)
  assert.equal(doc.tags.length, 1, 'one tag')
  const tag = doc.tags[0]
  // Born owned: dsh's loader stamps `data-plugin` on every UNTAGGED <style> and
  // deletes `style[data-plugin=<pkg>]` on that package's unload. A tag that is
  // ours from birth can never be claimed by a stranger (T-15).
  assert.equal(tag.getAttribute('data-plugin'), client.CLIENT_PLUGIN_ID, 'born with our package id')
  assert.equal(tag.getAttribute('data-plugin-css'), client.CSS_TAG_ID, 'and the loader-inventory fingerprint')

  // Idempotent: every surface mount + the plugin's apply call it again.
  client.ensureTaskboardStyles(doc)
  assert.equal(doc.tags.length, 1, 'second call is a no-op')
  // Self-healing: if the tag ever disappears, the next call puts it back.
  tag.remove()
  client.ensureTaskboardStyles(doc)
  assert.equal(doc.tags.length, 1, 'a lost tag is re-injected on the next mount')

  // No <style> may ride the React tree any more: that is exactly the shape the
  // loader steals and later deletes behind React's back.
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: false, error: 'x' }) }, pollMs: 10 ** 9 })
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(!html.includes('<style'), 'the panel does not render its own <style> tag')
  assert.ok(!html.includes('--dsw-alias-link'), 'TB_CSS text is not shipped inside the markup')

  const css = tag.textContent
  assert.ok(css.includes('.tb-btn-primary'), 'the injected sheet carries the button rules')

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

  // Markdown tables need the stylesheet: the renderer emits .tb-table-wrap /
  // table / th / td, and without rules the cells would render unstyled.
  for (const selector of ['.tb-md .tb-table-wrap {', '.tb-md table {', '.tb-md th, .tb-md td {', '.tb-md th {', '.tb-md hr {']) {
    assert.ok(css.includes(selector), `css carries ${selector}`)
  }
  assert.ok(/\.tb-md \.tb-table-wrap \{[^}]*overflow-x:\s*auto/.test(css), 'tables scroll sideways instead of stretching the drawer')
})

await check('theme: the dsh module loader can neither claim nor delete our stylesheet (T-15)', () => {
  const doc = fakeStyleDocument()
  client.ensureTaskboardStyles(doc)

  // A stranger module materializes → its claim pass books every unowned tag.
  loaderClaimStyles(doc, 'some-other-plugin')
  assert.equal(doc.tags[0].getAttribute('data-plugin'), client.CLIENT_PLUGIN_ID, 'ours keeps our id (never claimed by a stranger)')
  // …and later reloads/unloads → it deletes what it believes it owns.
  loaderRemoveOwnedStyles(doc, 'some-other-plugin')
  assert.equal(doc.tags.length, 1, "a stranger's reload leaves our stylesheet in place")

  // The old shape proves the mechanism: a <style> rendered inside the React
  // tree is untagged, so it IS claimed by the next module and then deleted
  // behind React's back — React never re-adds a node its fiber still believes
  // in, which is how the whole sheet vanished and the pill fell back to a UA
  // <button>.
  const reactOwned = doc.createElement('style')
  doc.head.appendChild(reactOwned)
  loaderClaimStyles(doc, 'some-other-plugin')
  assert.equal(reactOwned.getAttribute('data-plugin'), 'some-other-plugin', 'an untagged tag IS stolen')
  loaderRemoveOwnedStyles(doc, 'some-other-plugin')
  assert.equal(doc.tags.includes(reactOwned), false, 'and then deleted — the old failure mode, reproduced')
})

// --------------------------------------------------------- mini board (composer side)

await check('openTaskCount: only `closed` is terminal, so `done` still counts', () => {
  assert.equal(typeof client.openTaskCount, 'function')
  const task = (status, assignee) => ({ id: 'T-x', title: 't', status, assignee })
  const board = {
    version: 1, workspace: '/w', next_seq: 8,
    tasks: {
      'T-1': task('open', null),        // pool
      'T-2': task('open', 'kimi'),      // assigned
      'T-3': task('in_progress', 'kimi'),
      'T-4': task('review', 'kimi'),
      'T-5': task('done', 'kimi'),      // approved but NOT settled (v0.6)
      'T-6': task('closed', null),      // the only terminal status
    },
  }
  // done counts: an unsettled card still needs someone to close it out, so it
  // must not vanish from the "what is still on the board" badge.
  assert.equal(client.openTaskCount(board), 5, 'everything except `closed` counts')
  assert.equal(client.openTaskCount({ version: 1, workspace: '/w', next_seq: 1, tasks: {} }), 0, 'empty board → 0 (badge hides)')
  assert.equal(client.openTaskCount(null), 0, 'no board → 0')
})

await check('isFinal / isTerminalStatus: closed is the ONE terminal status', () => {
  const task = (status) => ({ id: 'T-1', title: 't', status, assignee: 'kimi' })
  for (const status of ['open', 'in_progress', 'review', 'done']) {
    assert.equal(client.isFinal(task(status)), false, `${status} is not terminal`)
    assert.equal(client.isTerminalStatus(status), false, `${status} is not terminal`)
  }
  assert.equal(client.isFinal(task('closed')), true, 'closed is terminal')
  assert.equal(client.isTerminalStatus('closed'), true)
  // needsSettling is exactly the done-that-owes-a-close case.
  assert.equal(client.needsSettling(task('done')), true)
  assert.equal(client.needsSettling(task('closed')), false)
  assert.equal(client.needsSettling(task('review')), false)
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
  // done is not terminal (v0.6), so it counts: only `closed` is excluded.
  assert.ok(button.includes('· 5'), 'open-task count as a pill suffix (done included)')
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
  // The done lane is labelled「待收口」/ To settle since v0.6 (it is not terminal).
  for (const label of ['Pool', 'Assigned', 'In progress', 'In review', 'To settle']) {
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
  // peek out while both right edges stay flush with the frame. The mini
  // drawer's selection is component-local — SSR drives it via the prop.
  const layered = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store, initialSelectedId: 'T-3' }))
  assert.ok(layered.includes('wip one') && layered.includes('>Details<'), 'layer 2 stacks the detail drawer over the sheet')
  assert.ok(layered.includes('width:560px'), 'board drawer widened to 560')
  assert.ok(layered.includes('width:520px'), 'detail layer is narrower')
  assert.ok(layered.includes('top:12px') && layered.includes('bottom:12px'), 'detail layer floats off top and bottom')

  // The ghost-drawer regression: a selection in the shared store (the board
  // tab's) must NOT open a detail inside the mini drawer — that rendered
  // both surfaces' DetailDrawers on top of each other.
  store.select('T-3')
  const ghost = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store }))
  assert.ok(!ghost.includes('>Details<'), 'store.selectedId does not leak into the mini drawer')
  assert.equal(store.getState().selectedId, 'T-3', 'the board tab keeps its own selection')
  store.select(null)
})

await check('empty states tell the truth: no-session ≠ loading ≠ error', async () => {
  // cwd unresolved (the session share delivered nothing — e.g. the host's
  // session list is broken): say "open a session", never fake an endless
  //「正在加载看板」— a null cwd never refreshes, so status never leaves
  // 'loading' and the bare loading branch would show forever.
  const idleStore = client.createTaskboardStore({ bridge: { board: async () => ({ ok: false, error: 'never called' }) }, pollMs: 10 ** 9 })
  const noSession = renderToStaticMarkup(React.createElement(client.BoardPanel, { store: idleStore }))
  assert.ok(noSession.includes('Open a session'), 'board tab: null cwd → explicit no-session state')
  assert.ok(!noSession.includes('Loading the board'), 'board tab: null cwd is NOT disguised as loading')

  // Bridge failing with cwd set: both surfaces must surface the error (with
  // a retry) — the bare「正在加载看板」branch used to swallow it.
  const failBridge = { board: async () => ({ ok: false, error: 'boom', code: 'internal' }) }
  const errStore = client.createTaskboardStore({ bridge: failBridge, pollMs: 10 ** 9 })
  errStore.setCwd('/work/a')
  await errStore.refresh()
  assert.equal(errStore.getState().status, 'error')
  const boardErr = renderToStaticMarkup(React.createElement(client.BoardPanel, { store: errStore }))
  assert.ok(boardErr.includes('Cannot read the board'), 'board tab: error state surfaces the error')
  errStore.setMiniOpen(true)
  const miniErr = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store: errStore }))
  assert.ok(miniErr.includes('Cannot read the board'), 'mini drawer: error state surfaces the error')
  assert.ok(miniErr.includes('Retry'), 'mini drawer: error state offers a retry')
  assert.ok(!miniErr.includes('Loading the board'), 'mini drawer: error is NOT disguised as loading')
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

// ------------------------------------------- collaboration marks (v0.5.4)
// The board's other axis: `reviewer` (who owes the verdict) and `waiting_on`
// (who the card is parked on). The point of these checks is the human side —
// a card parked on a person must be visibly DIFFERENT from claimable work, and
// answering it must be one gesture that leaves a record.

/** A board fixture with the v0.5.4 fields; `iso(ms)` = ms ago. */
function collabBoard(tasks, actors) {
  const now = Date.now()
  const iso = (ms) => new Date(now - ms).toISOString()
  const base = {
    detail: '', assignee: null, reviewer: null, waiting_on: null,
    priority: 'medium', value: null, tags: [],
    created_by: 'dsh', created_at: iso(9 * 24 * 3600_000), updated_at: iso(60_000),
    log: [], comments: [],
  }
  const roster = {
    dsh: { kind: 'agent', aliases: ['dsh-agent'], first_seen_at: iso(9 * 24 * 3600_000), last_seen_at: iso(60_000) },
    kimi: { kind: 'agent', aliases: [], first_seen_at: iso(9 * 24 * 3600_000), last_seen_at: iso(120_000) },
    iceskysl: { kind: 'human', aliases: [], first_seen_at: iso(9 * 24 * 3600_000), last_seen_at: iso(300_000) },
    ...actors,
  }
  return {
    version: 1, workspace: '/work/a', next_seq: 99, actors: roster,
    tasks: Object.fromEntries(tasks.map((task) => [task.id, { ...base, ...task }])),
    iso,
  }
}

/** Load a fixture board into a fresh store and render the board tab. */
async function renderBoard(board) {
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd(board.workspace)
  await store.refresh()
  return { store, html: renderToStaticMarkup(React.createElement(client.BoardPanel, { store })) }
}

await check('store.answerWaiting: comment first, then unblock (and never the other way round)', async () => {
  assert.equal(typeof client.createTaskboardStore, 'function')
  const calls = []
  const board = { version: 1, workspace: '/w', next_seq: 1, tasks: {}, actors: {} }
  const bridge = {
    board: async () => ({ ok: true, board }),
    comment: async (req) => { calls.push(['comment', req.id, req.text]); return { ok: true, task: {} } },
    update: async (req) => { calls.push(['update', req.id, req.action]); return { ok: true, task: {} } },
  }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/w')
  await store.refresh()

  assert.equal(store.getState().error, null, 'clean start')
  // The answer is trimmed before it is stored, and the release follows it.
  assert.equal(await store.answerWaiting('T-1', '  撤掉 C 段  '), true)
  assert.deepEqual(calls, [['comment', 'T-1', '撤掉 C 段'], ['update', 'T-1', 'unblock']], 'comment → unblock, in order')

  // A failed comment must NOT release the wait: the answer is the durable
  // record, and an unblock without it would silently drop the question.
  calls.length = 0
  const failing = {
    board: bridge.board,
    comment: async () => ({ ok: false, error: 'boom' }),
    update: async () => { calls.push(['update']); return { ok: true, task: {} } },
  }
  const broken = client.createTaskboardStore({ bridge: failing, pollMs: 10 ** 9 })
  broken.setCwd('/w')
  await broken.refresh()
  assert.equal(await broken.answerWaiting('T-1', 'x'), false)
  assert.deepEqual(calls, [], 'no unblock after a failed comment')
  assert.equal(broken.getState().error, 'boom', 'the failure surfaces on the store error channel')

  // Empty text is a no-op — no request at all.
  calls.length = 0
  assert.equal(await store.answerWaiting('T-1', '   '), false)
  assert.deepEqual(calls, [], 'blank answer fires nothing')
})

await check('human strip: cards parked on a PERSON get their own surface', async () => {
  const fixture = collabBoard([
    {
      id: 'T-1', title: '删掉 C 段吗', status: 'in_progress', assignee: 'dsh',
      waiting_on: { kind: 'human', who: 'iceskysl', question: 'C 段前提已过时——撤掉还是重定义？', since: new Date(Date.now() - 48 * 3600_000).toISOString() },
    },
    {
      id: 'T-2', title: '等 kimi 回执', status: 'in_progress', assignee: 'dsh',
      waiting_on: { kind: 'agent', who: 'kimi', question: '回执呢', since: new Date(Date.now() - 3600_000).toISOString() },
    },
  ])
  const { store, html } = await renderBoard(fixture)

  assert.ok(html.includes('class="tb-human-strip"'), 'the strip renders when a person is being waited on')
  assert.ok(html.includes('◷ 1 card(s) waiting on you'), 'it counts ONLY the human-parked card (the agent-parked one is the agents\' business)')
  assert.ok(!html.includes('2 card(s) waiting on you'), 'the agent-parked card is not counted as the human\'s')
  assert.ok(html.includes('删掉 C 段吗'), 'the card title is listed')
  assert.ok(html.includes('C 段前提已过时'), 'the full question is shown verbatim — answerable without opening anything')
  assert.ok(html.includes('waiting on iceskysl · 2d'), 'who is waiting and for how long')
  assert.ok(html.includes('>overdue<'), 'a 48h wait passes the 24h human SLA and is marked')
  assert.ok(html.includes('Reply'), 'an answer affordance is offered inline')
  // The agent-parked card still carries its badge on the CARD (not the strip).
  // 2026-10-01: the card's footer is strictly ONE line, so the chip is the
  // compact 「◷ who · age」 and the full sentence moved into its tooltip — the
  // invariant (agent waits ride the card badge, humans get the strip) is
  // unchanged, only the copy got shorter.
  // Assert on the RENDERED TEXT (tags stripped): the chip is built from two
  // spans — the who part ellipsizes, the age is pinned — so matching raw markup
  // would test the markup rather than what the user reads.
  const cardText = html.replace(/<[^>]*>/g, '')
  assert.ok(cardText.includes('◷ kimi · 1h'), 'agent waits ride the card badge (compact chip)')
  assert.ok(html.includes('waiting on agent kimi'), 'the full sentence survives in the tooltip')

  // Selecting the waiting card unfolds the inline answer box (textarea + the
  // one-gesture 「回复并解除等待」 submit). SSR drives the selection via the store.
  store.select('T-1')
  const opened = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(opened.includes('class="tb-textarea"'), 'the answer box opens for the selected waiting card')
  assert.ok(opened.includes('Reply &amp; release'), 'the one-gesture answer button is there')
  assert.ok(opened.includes('>Hide<'), 'and it can be folded away again')
  store.select(null)
})

await check('displayTitle: 只剥「与本卡重复」的前缀（【owner】/T-<本卡id>），且不动数据', async () => {
  const t = (over) => ({ id: 'T-93', title: '', status: 'in_progress', assignee: 'kimi', created_by: 'dsh', ...over })
  // ① 两种前缀一次剥干净（主人 2026-10-01 的诉求：第 2 行只放标题）
  assert.equal(
    client.displayTitle(t({ title: '【kimi】 T-93 · iOS v2 M7 连接与推送：退避/去重' })),
    'iOS v2 M7 连接与推送：退避/去重',
  )
  // ② 只有【owner】前缀（无 T 号）也剥；创建者前缀同样算重复
  assert.equal(client.displayTitle(t({ title: '【kimi】v1.42.0 iOS v2 独立验收' })), 'v1.42.0 iOS v2 独立验收')
  assert.equal(client.displayTitle(t({ title: '【dsh】交给 kimi 的活' })), '交给 kimi 的活')
  // ③ 别的 actor 的前缀是【信息】不是噪音：不剥
  assert.equal(client.displayTitle(t({ title: '【cc】等 kimi 回执' })), '【cc】等 kimi 回执')
  // ④ T 号不是本卡的：不剥（否则会吃掉真实标题内容）
  assert.equal(client.displayTitle(t({ title: 'T-89 的前置条件' })), 'T-89 的前置条件')
  // ④b 非重复的 boxed 前缀保留，但【本卡 id】仍要剥（它一定重复）
  assert.equal(
    client.displayTitle(t({ assignee: null, created_by: 'dsh', title: '【kimi】 T-93 · 别人提的活' })),
    '【kimi】 别人提的活',
  )
  // ④c reviewer 的前缀也算重复（卡上已经有「审核 cc」徽章）
  assert.equal(client.displayTitle(t({ assignee: 'dsh', reviewer: 'cc', title: '【cc】整理回填' })), '整理回填')
  assert.equal(client.displayTitle(t({ title: 'T-93' })), 'T-93', '剥空了就退回原文')
  // ⑤ 无前缀的标题原样返回
  assert.equal(client.displayTitle(t({ title: '普通标题' })), '普通标题')
  // ⑥ 纯展示：绝不改数据
  const src = t({ title: '【kimi】 T-93 · 标题' })
  client.displayTitle(src)
  assert.equal(src.title, '【kimi】 T-93 · 标题', 'displayTitle 不得改动 task')
})

await check('stale + reviewer: column age, a quiet dot, and who owes the verdict', async () => {
  const now = Date.now()
  const reviewTask = (reviewer, submittedAgoMs) => ({
    id: 'T-4', title: 'review one', status: 'review', assignee: 'dsh', reviewer,
    log: [
      { at: new Date(now - 9 * 24 * 3600_000).toISOString(), by: 'dsh', event: 'created' },
      { at: new Date(now - submittedAgoMs).toISOString(), by: 'dsh', event: 'submitted' },
    ],
  })

  // A 1h-old review card is inside the 24h SLA: no stale mark.
  const fresh = await renderBoard(collabBoard([reviewTask('kimi', 3600_000)]))
  assert.ok(!fresh.html.includes('class="tb-stale"'), 'a fresh review card carries no stale mark')
  assert.ok(fresh.html.includes('review kimi'), 'the reviewer badge names who owes the verdict')
  assert.ok(!fresh.html.includes('(inactive)'), 'a reviewer seen 2 minutes ago is not flagged quiet')

  // 3 days in the review column: stale, and the age badge counts time in the
  // CURRENT column (creation age would be meaningless here).
  const old = await renderBoard(collabBoard([reviewTask('kimi', 3 * 24 * 3600_000)]))
  assert.ok(old.html.includes('class="tb-stale"'), 'a 3d-old review card carries the stale dot')
  assert.ok(old.html.includes('3d in this column'), 'the badge counts time in the current column')
  assert.ok(!old.html.includes('9d in this column'), 'NOT time since creation')

  // A reviewer the roster has never heard of (the lost claude case): hinted,
  // never reassigned.
  const ghost = await renderBoard(collabBoard([reviewTask('ghost', 3 * 24 * 3600_000)]))
  assert.ok(ghost.html.includes('review ghost (inactive)'), 'an unknown reviewer is marked quiet')
  assert.equal(ghost.store.getState().board.tasks['T-4'].reviewer, 'ghost', 'the hint never reassigns the card')
})

await check('activity timeline: blocked / unblocked carry real labels', async () => {
  const now = Date.now()
  const iso = (ms) => new Date(now - ms).toISOString()
  const board = {
    version: 1, workspace: '/work/a', next_seq: 3, actors: {},
    tasks: {
      'T-1': {
        id: 'T-1', title: 'parked one', detail: '', status: 'in_progress', assignee: 'dsh',
        reviewer: null, waiting_on: null, priority: 'medium', value: null, tags: [],
        created_by: 'dsh', created_at: iso(4 * 3600_000), updated_at: iso(3600_000),
        log: [
          { at: iso(3 * 3600_000), by: 'dsh', event: 'started' },
          { at: iso(2 * 3600_000), by: 'dsh', event: 'blocked', note: '等主人排期' },
          { at: iso(3600_000), by: 'human', event: 'unblocked' },
        ],
        comments: [],
      },
    },
  }
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refresh()
  store.setMiniOpen(true)

  // The activity tab renders one row per log event through EVENT_LABELS; a
  // missing key would silently fall back to the raw event name.
  const html = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store, initialSelectedId: 'T-1', initialTab: 'activity' }))
  assert.ok(html.includes('>waiting<'), 'blocked renders a localized label')
  assert.ok(html.includes('>released<'), 'unblocked renders a localized label')
  assert.ok(html.includes('等主人排期'), 'the log note rides the row')
})

await check('panel: the「按负责人」view renders owner lanes, the switch and the done toggle', async () => {
  const board = collabBoard([
    { id: 'T-1', title: 'pool work', status: 'open', assignee: null },
    { id: 'T-2', title: 'kimi building it', status: 'in_progress', assignee: 'kimi' },
    { id: 'T-3', title: 'dsh alias card', status: 'in_progress', assignee: 'dsh-agent' },
    {
      id: 'T-4', title: 'kimi blocked on you', status: 'in_progress', assignee: 'kimi',
      waiting_on: { kind: 'human', who: 'iceskysl', question: '撤掉还是重定义？', since: new Date(Date.now() - 3600_000).toISOString() },
    },
  ])
  const { store, html } = await renderBoard(board)

  // Default view is still the six status lanes — the owner view is opt-in.
  assert.ok(html.includes('In progress'), 'status lanes render by default')
  assert.ok(html.includes('By owner'), 'the view switch is offered')
  assert.ok(!html.includes('Include closed'), 'the settled toggle is hidden in the status view')

  // Switch to the owner view and re-render through the same store.
  store.setGroupBy('owner')
  const ownerHtml = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(ownerHtml.includes('Unassigned'), 'the pool gets its own lane')
  assert.ok(ownerHtml.includes('>kimi<'), 'kimi has a lane')
  // dsh-agent folds into dsh's lane: one lane, not two.
  assert.equal((ownerHtml.match(/>dsh</g) ?? []).length, 1, 'aliases fold to ONE dsh lane')
  assert.ok(ownerHtml.includes('Waiting on human · kimi'), 'the blocked lane is labelled as such')
  assert.ok(ownerHtml.includes('Include closed'), 'the settled toggle appears in the owner view')
  // The owner view is a projection, not a status board: cards are not draggable.
  assert.ok(ownerHtml.includes('draggable="false"'), 'owner-view cards are not drag sources')

  // Only SETTLED work is hidden by default (v0.6): a done card is not settled,
  // so it keeps showing until someone closes it out.
  const withSettled = collabBoard([
    { id: 'T-1', title: 'stillLiveMarker', status: 'in_progress', assignee: 'kimi' },
    { id: 'T-2', title: 'doneMarker', status: 'done', assignee: 'kimi' },
    { id: 'T-3', title: 'settledMarker', status: 'closed', assignee: 'kimi' },
  ])
  const second = await renderBoard(withSettled)
  second.store.setGroupBy('owner')
  const hidden = renderToStaticMarkup(React.createElement(client.BoardPanel, { store: second.store }))
  assert.ok(hidden.includes('stillLiveMarker'), 'live cards render')
  assert.ok(hidden.includes('doneMarker'), 'done-but-unsettled cards STAY visible')
  assert.ok(!hidden.includes('settledMarker'), 'settled cards are hidden by default')
  second.store.setIncludeClosed(true)
  const shown = renderToStaticMarkup(React.createElement(client.BoardPanel, { store: second.store }))
  assert.ok(shown.includes('settledMarker'), 'the toggle brings settled cards back')
})

await check('panel: done-but-unsettled cards get a settle strip with a one-click close', async () => {
  const calls = []
  const board = collabBoard([
    { id: 'T-1', title: 'approvedNotClosed', status: 'done', assignee: 'kimi' },
    { id: 'T-2', title: 'stillRunning', status: 'in_progress', assignee: 'kimi' },
  ])
  const store = client.createTaskboardStore({
    bridge: {
      board: async () => ({ ok: true, board }),
      update: async (req) => { calls.push([req.id, req.action]); return { ok: true, task: {} } },
    },
    pollMs: 10 ** 9,
  })
  store.setCwd(board.workspace)
  await store.refresh()

  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  // The strip names the card that is finished but not closed out.
  assert.ok(html.includes('done, awaiting settle'), 'the settle strip is rendered')
  assert.ok(html.includes('approvedNotClosed'), 'the unsettled card is listed')
  // done is not terminal, so the lane label says so instead of reading "Done".
  assert.ok(html.includes('To settle'), 'the done lane is labelled「待收口」/ To settle')

  // The one-click settle closes through the store (not a hand-rolled fetch).
  const task = store.getState().board.tasks['T-1']
  assert.equal(task.status, 'done', 'fixture starts at done')
  assert.equal(await store.update({ id: 'T-1', action: 'close' }), true)
  assert.deepEqual(calls, [['T-1', 'close']], 'settle posts action=close')
})

await check('escapeTarget: one Escape closes exactly ONE layer, topmost first', () => {
  assert.equal(typeof client.escapeTarget, 'function')
  const layers = (over) => ({ guide: false, picker: false, drawer: false, ...over })

  // The z-order is guide (30) > picker (25) > drawer (21); unwind follows it.
  assert.equal(client.escapeTarget(layers({ guide: true, picker: true, drawer: true })), 'guide')
  assert.equal(client.escapeTarget(layers({ picker: true, drawer: true })), 'picker')
  assert.equal(client.escapeTarget(layers({ drawer: true })), 'drawer')
  // Nothing open → nothing to close (the key stays with the page).
  assert.equal(client.escapeTarget(layers({})), null)

  // The drawer is the ONLY layer that coexists with the others (guide and
  // picker both float above it), so it must never win while one is up — that
  // is what would make a single keypress tear down two layers.
  assert.notEqual(client.escapeTarget(layers({ guide: true, drawer: true })), 'drawer')
  assert.notEqual(client.escapeTarget(layers({ picker: true, drawer: true })), 'drawer')

  // A focused input that already consumed the key keeps it: nothing closes.
  assert.equal(client.escapeTarget(layers({ guide: true, picker: true, drawer: true }), { defaultPrevented: true }), null)
  assert.equal(client.escapeTarget(layers({ drawer: true }), { defaultPrevented: true }), null)
  // …and an event that did NOT consume it still unwinds normally.
  assert.equal(client.escapeTarget(layers({ drawer: true }), { defaultPrevented: false }), 'drawer')
})

await check('panel: the「统计」view renders KPIs, charts and tables from the same board', async () => {
  const board = collabBoard([
    { id: 'T-1', title: 'wip', status: 'in_progress', assignee: 'kimi', value: 3 },
    { id: 'T-2', title: 'awaitingVerification', status: 'review', assignee: 'dsh' },
    { id: 'T-3', title: 'awaitingSettle', status: 'done', assignee: 'kimi' },
    { id: 'T-4', title: 'settledAlready', status: 'closed', assignee: 'kimi' },
  ])
  const { store } = await renderBoard(board)

  // The switch offers all three views; stats is opt-in.
  const base = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(base.includes('By status'), 'status lanes render by default')
  assert.ok(base.includes('Stats'), 'the stats option is offered')

  store.setGroupBy('stats')
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))

  // KPI tiles: every headline number is on screen.
  for (const label of ['Open', 'To settle', 'WIP', 'Blocked', 'Settled', 'Median cycle', 'Settle lag', 'Reject rate', 'Total value']) {
    assert.ok(html.includes(label), `KPI tile: ${label}`)
  }
  // Section titles for the charts/tables.
  for (const title of ['At a glance', 'Daily flow', 'By status', 'By priority / value', 'Owners', 'Where time piles up']) {
    assert.ok(html.includes(title), `section: ${title}`)
  }
  // The flow legend + the owner table's columns.
  for (const key of ['created', 'settled', 'backlog']) {
    assert.ok(html.includes(key), `flow legend: ${key}`)
  }
  assert.ok(html.includes('Cycle') && html.includes('Actions'), 'owner table columns')
  // Counts stay honest: 3 unsettled (everything but the closed card).
  assert.ok(html.includes('>3<'), 'the open count reflects `done` counting as open')
  // The fixture's cards carry no done/approved events, so the cycle tile must
  // read as "no data" rather than inventing a number from creation times.
  assert.ok(html.includes('no samples yet'), 'an empty metric says so in its tooltip')
})

await check('panel: an unopened board offers to turn the board on, not "create a task"', async () => {
  // board_exists:false = the workspace has no board file at all. Telling the
  // reader to "ask an agent to create a task" would be advice that cannot work.
  const board = collabBoard([])
  const store = client.createTaskboardStore({
    bridge: { board: async () => ({ ok: true, board, board_exists: false, board_file: '/w/.dsh/taskboard.json', cli: '/cli/taskboard.mjs' }) },
    pollMs: 10 ** 9,
  })
  store.setCwd('/w')
  await store.refresh()
  assert.equal(store.getState().boardExists, false, 'the store tracks file existence')

  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(html.includes('not on for this workspace'), 'the wizard explains the board is off')
  assert.ok(html.includes('Turn the board on'), 'and offers the enable action')
  assert.ok(html.includes('taskboard.json') && html.includes('BOARD-PROTOCOL.md'), 'names both files it will create')
  assert.ok(!html.includes('has no cards yet'), 'the empty-board prompt is NOT shown')
})

await check('panel: an ON but empty board asks for a task instead', async () => {
  const board = collabBoard([])
  const store = client.createTaskboardStore({
    bridge: { board: async () => ({ ok: true, board, board_exists: true }) },
    pollMs: 10 ** 9,
  })
  store.setCwd('/w')
  await store.refresh()

  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(html.includes('has no cards yet'), 'now the prompt is to create the first card')
  assert.ok(!html.includes('Turn the board on'), 'the wizard is gone')
})

await check('store.enableBoard: posts /enable, then re-reads the board', async () => {
  const calls = []
  const empty = collabBoard([])
  const store = client.createTaskboardStore({
    bridge: {
      board: async () => ({ ok: true, board: empty, board_exists: calls.length > 0 }),
      enable: async (req) => {
        calls.push(req.cwd)
        return { ok: true, board_file: '/w/.dsh/taskboard.json', protocol_file: '/w/.dsh/BOARD-PROTOCOL.md', already_existed: false }
      },
    },
    pollMs: 10 ** 9,
  })
  store.setCwd('/w')
  await store.refresh()
  assert.equal(store.getState().boardExists, false, 'starts unopened')

  const outcome = await store.enableBoard()
  assert.deepEqual(calls, ['/w'], 'enable was called for the current cwd')
  assert.equal(outcome.protocolFile, '/w/.dsh/BOARD-PROTOCOL.md')
  assert.equal(store.getState().boardExists, true, 'the re-read picked up the new board')

  // No cwd → nothing to enable, no request fired.
  const idle = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board: empty }) }, pollMs: 10 ** 9 })
  assert.equal(await idle.enableBoard(), null, 'no cwd → no-op')
})

await check('panel: the view switch renders as TWO groups (lanes) + (stats)', async () => {
  const board = collabBoard([{ id: 'T-1', title: 'x', status: 'in_progress', assignee: 'kimi' }])
  const { store } = await renderBoard(board)
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))

  // Two groups, each in its own bordered box: the lane views (which rearrange
  // the same cards) are separated from stats (which shows numbers instead).
  const groupCount = (html.match(/role="group"/g) ?? []).length
  assert.equal(groupCount, 2, 'exactly two groups')

  // Group 1 holds the two lane views, group 2 holds stats — order matters:
  // the lane views stay adjacent so switching between them feels like one
  // control, and stats sits apart as the different mode it is.
  const first = html.indexOf('role="group"')
  const second = html.indexOf('role="group"', first + 1)
  const g1 = html.slice(first, second)
  const g2 = html.slice(second)
  assert.ok(g1.includes('By status') && g1.includes('By owner'), 'group 1 = the two lane views')
  assert.ok(!g1.includes('Stats'), 'stats is NOT in the lane group')
  assert.ok(g2.includes('Stats'), 'group 2 = stats')
  assert.ok(!g2.includes('By owner'), 'the lane views are not duplicated into group 2')

  // All three remain reachable as tabs.
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3, 'three tabs total')
})
await check('panel: an empty board keeps its 「no tasks」 state even in the stats view', async () => {
  const board = collabBoard([])
  const { store } = await renderBoard(board)
  store.setGroupBy('stats')
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  // The panel's own empty state wins over the stats body: a page of zeroes is
  // worse than one sentence telling you the board is empty. (collabBoard's
  // fixture has no board_exists, so the store defaults to "exists".)
  assert.ok(html.includes('has no cards yet'), 'the panel empty state is shown')
  assert.ok(!html.includes('At a glance'), 'no KPI wall over an empty board')
  // StatsView itself degrades safely when handed nothing (a null board).
  const empty = renderToStaticMarkup(React.createElement(client.StatsView, { board: null }))
  assert.ok(empty.includes('nothing to measure'), 'StatsView has its own empty state')
})


// ---------------------------------------------------------------- 统计 view

/** A board fixture with explicit log timelines, for the analytics functions. */
function statsBoard(specs) {
  const base = {
    detail: '', status: 'open', assignee: null, reviewer: null, waiting_on: null,
    priority: 'medium', value: null, tags: [], created_by: 'human', log: [], comments: [],
  }
  const tasks = {}
  for (const spec of specs) {
    tasks[spec.id] = {
      ...base, ...spec,
      created_at: spec.created_at, updated_at: spec.created_at,
      log: spec.log ?? [{ at: spec.created_at, by: spec.created_by ?? 'human', event: 'created' }],
    }
  }
  return { version: 1, workspace: '/w', next_seq: 99, actors: {}, tasks }
}

await check('stats: headline counts `done` as open work and only `closed` as settled', () => {
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString()
  const board = statsBoard([
    { id: 'T-1', status: 'in_progress', assignee: 'kimi', created_at: at(100) },
    { id: 'T-2', status: 'review', assignee: 'kimi', created_at: at(90) },
    { id: 'T-3', status: 'done', assignee: 'kimi', created_at: at(80) },
    { id: 'T-4', status: 'closed', assignee: 'kimi', created_at: at(70), log: [
      { at: at(70), by: 'human', event: 'created' },
      { at: at(60), by: 'kimi', event: 'approved' },
      { at: at(20), by: 'kimi', event: 'closed' },
    ] },
    { id: 'T-5', status: 'open', assignee: null, created_at: at(60), waiting_on: { kind: 'human', who: 'x', question: 'q', since: at(10) } },
  ])
  const h = client.headline(board)
  assert.equal(h.total, 5)
  assert.equal(h.open, 4, 'everything but closed')
  assert.equal(h.unsettled, 1, 'the done card owes a settle')
  assert.equal(h.settled, 1)
  assert.equal(h.wip, 2, 'in_progress + review')
  assert.equal(h.blocked, 1)
  // Cycle counts only cards that FINISHED (done/approved), and carries n.
  assert.equal(h.cycle.n, 1, 'only the one card with a done/approved event')
  // 70h ago → 60h ago = 10h of actual work (NOT the 50h to `closed`).
  assert.equal(client.durationText(h.cycle.value), '10.0h')
  assert.equal(h.settleLag.n, 1, 'that same card then sat 40h before being closed')
  assert.equal(client.headline(null).total, 0, 'null board → zeros, no throw')
})

await check('stats: cycle measures work (created→done), settle lag measures paperwork', () => {
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString()
  // The exact shape that produced a nonsense "10.3h": a card finished in ~1h
  // but left unsettled for days. Measuring to `closed` would report 4 days.
  const board = statsBoard([
    { id: 'T-1', status: 'closed', assignee: 'kimi', created_at: at(100), log: [
      { at: at(100), by: 'kimi', event: 'created' },
      { at: at(99), by: 'kimi', event: 'approved' },   // work took 1h
      { at: at(2), by: 'human', event: 'closed' },      // paperwork took 97h
    ] },
  ])
  const h = client.headline(board)
  assert.equal(client.durationText(h.cycle.value), '1.0h', 'cycle = the WORK, not the close lag')
  assert.equal(h.cycle.n, 1)
  // The lag is reported separately instead of being smuggled into the cycle.
  // 97h is past durationText's 48h switch, so it reads in days.
  assert.equal(client.durationText(h.settleLag.value), '4.0d')
  assert.equal(h.settleLag.n, 1)

  // A card that finished but was never closed contributes a cycle, no lag.
  const open = statsBoard([
    { id: 'T-1', status: 'done', created_at: at(10), log: [
      { at: at(10), by: 'kimi', event: 'created' },
      { at: at(8), by: 'kimi', event: 'done' },
    ] },
  ])
  const o = client.headline(open)
  assert.equal(o.cycle.n, 1, 'finished work counts toward the cycle')
  assert.equal(o.settleLag.n, 0, 'no close yet → no lag sample')
  assert.equal(o.settleLag.value, null)

  // `reopen` does not erase the fact that the work was once finished.
  const reopened = statsBoard([
    { id: 'T-1', status: 'open', created_at: at(50), log: [
      { at: at(50), by: 'kimi', event: 'created' },
      { at: at(30), by: 'kimi', event: 'done' },
      { at: at(10), by: 'kimi', event: 'reopened' },
    ] },
  ])
  assert.equal(client.durationText(client.headline(reopened).cycle.value), '20.0h')
})

await check('stats: a one-sample median is exposed as such, never as a trend', () => {
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString()
  const single = statsBoard([
    { id: 'T-1', status: 'done', created_at: at(10), log: [
      { at: at(10), by: 'kimi', event: 'created' },
      { at: at(9), by: 'kimi', event: 'done' },
    ] },
  ])
  const h = client.headline(single)
  // n is what lets the UI say "only 1 card" instead of printing a confident
  // "1.0h" that looks like a measured median.
  assert.equal(h.cycle.n, 1)
  const empty = statsBoard([{ id: 'T-1', status: 'open', created_at: at(10) }])
  assert.equal(client.headline(empty).cycle.value, null)
  assert.equal(client.headline(empty).cycle.n, 0, 'no samples → n=0, not a fake 0ms')
})

await check('stats: reject rate counts cards that reached review and were sent back', () => {
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString()
  const board = statsBoard([
    { id: 'T-1', status: 'review', created_at: at(10), log: [
      { at: at(10), by: 'kimi', event: 'created' },
      { at: at(8), by: 'kimi', event: 'submitted' },
      { at: at(6), by: 'dsh', event: 'rejected' },
      { at: at(4), by: 'kimi', event: 'submitted' },
    ] },
    { id: 'T-2', status: 'done', created_at: at(10), log: [
      { at: at(10), by: 'kimi', event: 'created' },
      { at: at(8), by: 'kimi', event: 'submitted' },
      { at: at(6), by: 'dsh', event: 'approved' },
    ] },
    { id: 'T-3', status: 'open', created_at: at(10) },
  ])
  // 2 cards reached review, 1 was rejected → 50%. The never-submitted card is
  // not counted at all (it never entered the review pipeline).
  assert.equal(client.percentText(client.headline(board).rejectRate), '50%')
  const noReview = statsBoard([{ id: 'T-1', status: 'open', created_at: at(10) }])
  assert.equal(client.headline(noReview).rejectRate, null, 'no review traffic → null, not 0%')
  assert.equal(client.percentText(null), '—')
})

await check('stats: flow counts created/settled per day and tracks the backlog', () => {
  const day = (offset) => {
    const d = new Date()
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - offset)
    return d.toISOString()
  }
  const board = statsBoard([
    { id: 'T-1', status: 'open', created_at: day(3) },
    { id: 'T-2', status: 'open', created_at: day(3) },
    { id: 'T-3', status: 'closed', created_at: day(2), log: [
      { at: day(2), by: 'kimi', event: 'created' },
      { at: day(1), by: 'kimi', event: 'closed' },
    ] },
  ])
  const rows = client.flow(board, { days: 5 })
  assert.equal(rows.length, 5, 'a fixed-width axis, gaps included')

  const createdOn = (offset) => rows[rows.length - 1 - offset]
  assert.equal(createdOn(3).created, 2, 'two cards created that day')
  assert.equal(createdOn(1).settled, 1, 'one card settled the next day')

  // Backlog: rises by created, falls by settled, and never goes negative.
  assert.equal(createdOn(4).backlog, 0, 'nothing before the window')
  assert.equal(createdOn(3).backlog, 2)
  assert.equal(createdOn(1).backlog, 2, '2 created + 1 created − 1 settled')
  assert.ok(rows.every((row) => row.backlog >= 0), 'backlog is never negative')
  // A settled card cannot depress the backlog below zero.
  const odd = client.flow(statsBoard([
    { id: 'T-1', status: 'closed', created_at: day(2), log: [
      { at: day(2), by: 'kimi', event: 'created' },
      { at: day(1), by: 'kimi', event: 'closed' },
    ] },
  ]), { days: 3 })
  // Created on day 0 → backlog 1; settled the next day → back to 0, never below.
  assert.equal(odd[0].backlog, 1, 'one card created, one open')
  assert.equal(odd[1].backlog, 0, 'settled the next day')
  assert.ok(odd.every((row) => row.backlog >= 0), 'never negative')
})

await check('stats: daySeries is a contiguous local-time axis ending today', () => {
  const series = client.daySeries(4)
  assert.equal(series.length, 4)
  assert.equal(series[3], client.todayKey(), 'the last bucket is today (local time)')
  // Contiguous: each step is exactly one day, so charts have no phantom gaps.
  for (let i = 1; i < series.length; i += 1) {
    const prev = new Date(`${series[i - 1]}T12:00:00`).getTime()
    const next = new Date(`${series[i]}T12:00:00`).getTime()
    assert.equal(next - prev, 24 * 3600_000, `${series[i - 1]} → ${series[i]} is one day`)
  }
})

await check('stats: distributions and dwell rank the biggest first', () => {
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString()
  const board = statsBoard([
    { id: 'T-1', status: 'in_progress', priority: 'high', value: 5, created_at: at(10) },
    { id: 'T-2', status: 'in_progress', priority: 'high', value: 3, created_at: at(40) },
    { id: 'T-3', status: 'open', assignee: 'kimi', priority: 'low', value: 1, created_at: at(5) },
  ])
  const status = client.byStatus(board)
  assert.deepEqual(status.map((s) => s.key), ['in_progress', 'assigned'])
  assert.equal(status[0].count, 2)
  assert.equal(client.percentText(status[0].share), '67%')

  const priority = client.byPriority(board)
  assert.equal(priority[0].key, 'high')
  assert.equal(priority[0].count, 2)

  // Value sums per owner; unestimated cards are reported, not silently zeroed.
  const value = client.valueByOwner(board)
  assert.equal(value.rows[0].owner, '')
  assert.equal(value.rows[0].value, 8)
  assert.equal(value.unestimated, 0)
  const withUnestimated = statsBoard([{ id: 'T-1', status: 'open', value: null, created_at: at(1) }])
  assert.equal(client.valueByOwner(withUnestimated).unestimated, 1)

  // Dwell: T-2 sat longer, so in_progress carries the larger total.
  const dwell = client.dwellByColumn(board)
  assert.equal(dwell[0].column, 'in_progress')
  assert.equal(dwell[0].tasks, 2)
  // Settled work never contributes to dwell.
  const settledBoard = statsBoard([
    { id: 'T-1', status: 'closed', created_at: at(100), log: [
      { at: at(100), by: 'kimi', event: 'created' },
    ] },
  ])
  assert.deepEqual(client.dwellByColumn(settledBoard), [], 'settled cards leave the dwell chart')
})

await check('stats: duration text is compact at every scale', () => {
  assert.equal(client.durationText(30_000), '1m')
  assert.equal(client.durationText(90 * 60_000), '1.5h')
  // Hours stay hours until 48h, then switch to days.
  assert.equal(client.durationText(30 * 3600_000), '30.0h')
  assert.equal(client.durationText(72 * 3600_000), '3.0d')
  assert.equal(client.durationText(null), '—')
  assert.equal(client.durationText(0), '0m')
})

// ------------------------------------------- T-10: client-side audit minors

const t10Board = (tasks = {}) => ({ version: 1, workspace: '/w', next_seq: 10, tasks, actors: {} })

await check('m12: a change fired into the busy gate is refused WITH a visible reason', async () => {
  let releaseCreate
  const createGate = new Promise((resolve) => { releaseCreate = resolve })
  const bridge = {
    board: async () => ({ ok: true, board: t10Board() }),
    create: async () => { await createGate; return { ok: true, task: {} } },
    update: async () => ({ ok: true, task: {} }),
  }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/w')
  await store.refresh()

  const first = store.create({ title: 'x' }) // occupies the busy slot
  await new Promise((resolve) => setTimeout(resolve, 0)) // let mutate() raise busy
  assert.equal(store.getState().busy, true, 'first mutation in flight')

  assert.equal(await store.update({ id: 'T-1', action: 'start' }), false, 'a second change is refused')
  assert.match(store.getState().error, /in flight|稍候/, 'and the refusal says WHY (no silent drop)')

  releaseCreate()
  assert.equal(await first, true)
  assert.equal(store.getState().busy, false, 'busy settles afterwards')
})

await check('m13: refreshes coalesce onto the in-flight read, with one trailing re-read', async () => {
  let calls = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const bridge = {
    board: async () => {
      calls += 1
      if (calls === 1) await firstGate
      return { ok: true, board: t10Board() }
    },
  }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/w') // fires read #1 (hangs on the gate)
  const extra = store.refresh() // must coalesce, not stack
  assert.equal(calls, 1, 'a refresh while one is in flight fires no new request')
  releaseFirst()
  await extra
  for (let i = 0; i < 50 && calls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(calls, 2, 'exactly one trailing re-read fires after the in-flight one settles')

  // And once idle, further refreshes go straight through (no trailing loop).
  await store.refresh()
  assert.equal(calls, 3)
  await store.refresh()
  assert.equal(calls, 4)
})

await check('m13: a persistent failure is surfaced once, not resurrected every poll', async () => {
  let reply = { ok: false, error: 'boom' }
  const bridge = { board: async () => reply }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/w')
  await store.refresh()
  assert.equal(store.getState().error, 'boom', 'the first failure surfaces')

  store.clearError()
  assert.equal(store.getState().error, null)
  await store.refresh()
  assert.equal(store.getState().error, null, 'the SAME failure does not resurrect the dismissed strip')

  reply = { ok: false, error: 'boom-2' }
  await store.refresh()
  assert.equal(store.getState().error, 'boom-2', 'a DIFFERENT failure is shown')

  reply = { ok: true, board: t10Board() }
  await store.refresh()
  assert.equal(store.getState().error, null, 'recovery clears the strip')

  reply = { ok: false, error: 'boom' }
  await store.refresh()
  assert.equal(store.getState().error, 'boom', 'after a recovery the failure reports afresh')
})

await check('m13: the board read carries an AbortSignal, and setCwd cancels a stale read', async () => {
  const events = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const bridge = {
    board: async (cwd, signal) => {
      const reads = events.filter((e) => e[0] === 'read').length
      events.push(['read', cwd, signal instanceof AbortSignal])
      if (reads === 0) {
        signal?.addEventListener('abort', () => events.push(['aborted', cwd]))
        await firstGate
      }
      return { ok: true, board: { ...t10Board(), workspace: cwd } }
    },
  }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/w1')
  await new Promise((resolve) => setTimeout(resolve, 0)) // read #1 (/w1) in flight
  store.setCwd('/w2') // must cancel the /w1 read
  releaseFirst()
  for (let i = 0; i < 50 && store.getState().board?.workspace !== '/w2'; i++) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.deepEqual(events[0], ['read', '/w1', true], 'the read carries an AbortSignal (no dead plumbing)')
  assert.ok(events.some((e) => e[0] === 'aborted' && e[1] === '/w1'), 'switching cwd aborts the stale read')
  assert.ok(events.some((e) => e[0] === 'read' && e[1] === '/w2'), 'the new cwd is read')
  assert.equal(store.getState().board?.workspace, '/w2')
})

await check('m14: a malformed ok:true payload never paints an empty-board lie', async () => {
  const good = t10Board({ 'T-1': { id: 'T-1', title: 'real', status: 'open' } })
  let reply = { ok: true, board: good }
  const bridge = { board: async () => reply }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/w')
  await store.refresh()
  assert.equal(store.getState().board?.tasks['T-1']?.title, 'real', 'good board applied')

  reply = { ok: true } // board missing entirely
  await store.refresh()
  assert.equal(store.getState().board?.tasks['T-1']?.title, 'real', 'the last good board is kept')
  assert.match(store.getState().error, /malformed|残缺/, 'and the failure is said out loud')
  assert.equal(store.getState().status, 'ready', 'a board we have stays on screen')

  reply = { ok: true, board: { version: 1 } } // tasks missing — would crash render
  await store.refresh()
  assert.equal(store.getState().board?.tasks['T-1']?.title, 'real', 'a tasks-less payload is rejected too')
})

await check('m19: a strictly older snapshot never overwrites a newer one', async () => {
  const snap = (n) => t10Board({ [`T-${n}`]: { id: `T-${n}`, title: `snap-${n}`, status: 'open' } })
  let reply = { ok: true, board: snap(1), board_mtime: 100 }
  const bridge = { board: async () => reply }
  const store = client.createTaskboardStore({ bridge, pollMs: 10 ** 9 })
  store.setCwd('/w')
  await store.refresh()
  assert.equal(store.getState().board?.tasks['T-1']?.title, 'snap-1')

  reply = { ok: true, board: snap(2), board_mtime: 50 } // a stale snapshot arrives late
  await store.refresh()
  assert.equal(store.getState().board?.tasks['T-1']?.title, 'snap-1', 'strictly older mtime discarded')

  reply = { ok: true, board: snap(3), board_mtime: 150 }
  await store.refresh()
  assert.equal(store.getState().board?.tasks['T-3']?.title, 'snap-3', 'newer mtime applied')

  reply = { ok: true, board: snap(4), board_mtime: 150 }
  await store.refresh()
  assert.equal(store.getState().board?.tasks['T-4']?.title, 'snap-4', 'equal mtime still applies (same file, idempotent)')
})

// ------------------------------------------------------------------ done

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
