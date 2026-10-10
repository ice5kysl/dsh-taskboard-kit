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
import { readFileSync, readdirSync } from 'node:fs'
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
  // v0.7.3: the row's holder chip replaced the old per-field badges (wait +
  // reviewer + assignee, which said the same thing three times). The pool row
  // now reads `○ the pool` — same words the card and the drawer use — with the
  // mark carrying the action. (The holder-row assertions proper live in the
  // T-35 check further down.)
  assert.ok(open.includes('the pool'), 'a pool row names the pool (holder mark + kind, not a bare badge)')
  assert.ok(!open.includes('unclaimed'), 'the old per-field「unclaimed」badge is gone')
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

await check('T-76 · 汇总条：一行、只数人类的等待、空态不渲染（大横幅已删）', async () => {
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

  // 0.8.0 那块 ~150px 的大横幅（卡标题 + 问题全文 + 回复框全铺在顶上）没有了。
  assert.ok(!html.includes('tb-human-strip'), '顶部的大横幅被删掉了')
  assert.ok(!html.includes('card(s) waiting on you'), '横幅那句文案也不在了')

  // 取而代之：一行汇总条，计数**只算人类的等待**（等 Agent 是 Agent 之间的事）。
  assert.ok(html.includes('class="tb-wait-bar"'), '汇总条在等待卡存在时渲染')
  assert.ok(html.includes('data-waiting="1"'), '条上带机器可读的计数（1）')
  assert.ok(html.includes('⏳ 1 waiting on you'), '只数人类停牌的那张')
  assert.ok(!html.includes('2 waiting on you'), '等 Agent 的卡不算进"等你决定"')
  assert.ok(html.includes('Jump to it'), '「跳过去」是这一行唯一的动作')
  assert.ok(html.includes('Dismiss (this session only'), '右侧的 × 关掉它（只在本会话生效）')

  // 空态：没有等待卡 ⇒ 整条不渲染（也不许出现「0 张在等你」）。
  const quiet = collabBoard([{ id: 'T-9', title: '没人在等', status: 'in_progress', assignee: 'dsh' }])
  const quietHtml = (await renderBoard(quiet)).html
  assert.ok(!quietHtml.includes('tb-wait-bar'), '没有等待卡时整条不渲染')
  assert.ok(!/0 waiting on you/.test(quietHtml), '不许出现「0 张在等你」')
})

await check('T-76 · 卡片凸显：等你决定的卡有竖条 + ⏳ 徽章（title = 问题全文），别的卡没有', async () => {
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
  const { html } = await renderBoard(fixture)

  // 竖条（CSS 类）+ 徽章（卡面第一行）：两处都在等待你的那张卡上。
  assert.ok(html.includes('tb-card-wait'), '等待你的卡带左侧竖条的类')
  assert.ok(html.includes('tb-badge-you'), '等待你的卡带 ⏳ 徽章')
  assert.ok(html.includes('⏳ waiting on you'), '徽章说的是「等你决定」')
  // 信息不丢：原横幅第 2–3 行那份**问题全文**，现在挂在徽章的 title 上，一字不动。
  assert.ok(html.includes('title="C 段前提已过时——撤掉还是重定义？"'), '徽章 title = 问题全文（横幅只是移走，不是删掉信息）')

  // 只标记"等你"的卡：等 Agent 的那张不许混进来（否则两种等待又长得一样了）。
  const cardOf = (id) => {
    const at = html.indexOf(`data-task="${id}"`)
    return html.slice(html.lastIndexOf('<button', at), html.indexOf('</button>', at))
  }
  assert.ok(cardOf('T-1').includes('tb-card-wait') && cardOf('T-1').includes('tb-badge-you'), 'T-1（等你）被标记')
  assert.ok(!cardOf('T-2').includes('tb-card-wait'), 'T-2（等 Agent）没有竖条')
  assert.ok(!cardOf('T-2').includes('tb-badge-you'), 'T-2（等 Agent）没有「等你决定」徽章')
  assert.ok(!cardOf('T-2').includes('C 段前提已过时'), 'T-2 不背 T-1 的问题全文')

  // 列内排最前：同一列里，等人的那张排在等 Agent 的前面（compareTasks 仍是次序口径）。
  assert.ok(html.indexOf('data-task="T-1"') < html.indexOf('data-task="T-2"'), '等你的卡在列内排最前')

  // 等 Agent 的卡照旧只有它自己的琥珀等待徽章（两种等待在形状与颜色上都分开）。
  const cardText = cardOf('T-2').replace(/<[^>]*>/g, '')
  assert.ok(/◷\s*kimi/.test(cardText), '等 Agent 的卡仍然靠它自己的等待徽章表达')
})

await check('T-76 · waitingFirst：只把「等你决定」的卡提前，其余次序原样（compareTasks 说了算）', () => {
  const at = '2026-10-10T00:00:00.000Z'
  const mk = (id, waiting, priority = 'medium', created = at) => ({
    id, title: id, detail: '', status: 'in_progress', assignee: 'dsh', reviewer: null,
    waiting_on: waiting, priority, value: null, tags: [], created_by: 'dsh',
    created_at: created, updated_at: created, log: [], comments: [],
  })
  const humanWait = { kind: 'human', who: 'iceskysl', question: 'q', since: at }
  const agentWait = { kind: 'agent', who: 'kimi', question: 'q', since: at }

  // 等人的卡提前；同为"没人等"的两张之间，仍是 compareTasks 的原次序（优先级高的前）。
  const rows = [mk('T-1', null, 'low'), mk('T-2', humanWait, 'low'), mk('T-3', agentWait, 'high'), mk('T-4', null, 'high')]
  assert.deepEqual(rows.slice().sort(client.waitingFirst).map((t) => t.id), ['T-2', 'T-3', 'T-4', 'T-1'],
    '等人类的先出；其余按 compareTasks（高优先级在前、同龄按 id）')
  // 反例：等 Agent 的卡**不会**被提前（它没有 ⏳ 徽章，插到最前面就是"两种事看起来一样"）。
  assert.equal(client.waitingFirst(mk('T-3', agentWait), mk('T-4', null)), client.compareTasks(mk('T-3', agentWait), mk('T-4')),
    '等 Agent 的卡参与比较时，结果与纯 compareTasks 一致')
  assert.equal(client.isWaitingOnYou(mk('T-2', humanWait)), true)
  assert.equal(client.isWaitingOnYou(mk('T-3', agentWait)), false)
  assert.equal(client.isWaitingOnYou(mk('T-1', null)), false)
})

await check('T-76 · 回答「等你决定」的入口搬进抽屉（同一张卡、同一份问题全文）', async () => {
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
  const { store } = await renderBoard(fixture)

  // 未选中时抽屉里没有回复框（它只跟着选中的那张卡走）。
  assert.ok(!renderToStaticMarkup(React.createElement(client.BoardPanel, { store })).includes('Reply &amp; release'))

  // 选中等待你的那张 ⇒ 抽屉的等待框里出现「回复并解除等待」（comment → unblock，
  // 仍然由 store.answerWaiting 拥有那两步的顺序，测试见上一条）。
  store.select('T-1')
  const opened = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(opened.includes('class="tb-textarea"'), '选中等你的卡，抽屉里出现回复框')
  assert.ok(opened.includes('Reply &amp; release'), '一键回复并解除等待还在')
  assert.ok(opened.includes('C 段前提已过时'), '问题全文也在抽屉里')
  assert.ok(opened.includes('>overdue<'), '等了 48h > 24h 人类 SLA ⇒ 琥珀「已超时」仍然显形')

  // 选中「等 Agent」的那张：问题照常显示，但**没有**回答框（那个问题是给 Agent 的）。
  store.select('T-2')
  const agent = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(agent.includes('回执呢'), '等 Agent 的问题也在抽屉里')
  assert.ok(!agent.includes('Reply &amp; release'), '等 Agent 的卡不给人类一个"回复并解除等待"的入口')
  store.select(null)
})

await check('currentHolder: 任何阶段有且只有一个持球人（closed 除外），且指向该阶段的正确字段', async () => {
  const base = {
    id: 'T-1', title: 'x', detail: '', status: 'open', assignee: 'dsh', reviewer: null,
    waiting_on: null, priority: 'medium', value: null, tags: [], created_by: 'dsh',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    log: [], comments: [],
  }
  const statuses = ['open', 'in_progress', 'review', 'done', 'closed']
  // 4 档等待（含 who 为空 —— kimi 打回的遗漏档：store 拒绝认领等待中的卡，
  // 渲染成「池子里」会给出一个点了必然失败的入口）
  const waits = [null, { kind: 'human', who: 'iceskysl' }, { kind: 'agent', who: 'kimi' }, { kind: 'human', who: null }]
  // T-42 第 2 条：fixture 里的人名必须是**名册里真有的**名字（与 collabBoard 的
  // roster 同一批）。`iceskyls` 这个错拼就是这么混进来的 —— 断言只比
  // `h.who === waiting_on.who`，错拼照样全绿，所以得单独钉一下。
  const rosterNames = new Set(['dsh', 'kimi', 'iceskysl'])
  for (const wait of waits) {
    if (wait?.who) assert.ok(rosterNames.has(wait.who), `fixture 里的人名 ${wait.who} 不在名册里（错拼？正确是 iceskysl）`)
  }
  let cases = 0
  for (const status of statuses) {
    for (const assignee of [null, 'dsh']) {
      for (const reviewer of [null, 'kimi']) {
        for (const waiting_on of waits) {
          cases += 1
          const task = { ...base, status, assignee, reviewer, waiting_on }
          const h = client.currentHolder(task)
          if (status === 'closed') {
            assert.equal(h, null, 'closed 是终态：没人该动')
            continue
          }
          assert.ok(h, `${status} 必须有一个持球人`)
          // 唯一性：持球人是一个 actor，不是一串 actor
          if (h.who !== null) {
            assert.equal(typeof h.who, 'string')
            assert.ok(!/[,，、/]/.test(h.who), `持球人必须唯一，实际 ${h.who}`)
          }
          // 指向该阶段的正确字段
          if (waiting_on) {
            assert.equal(h.who, waiting_on.who, '等待优先：球在必须回答的那一方')
            assert.equal(h.action, waiting_on.kind === 'human' ? 'answer' : 'reply')
            assert.notEqual(h.action, 'claim', '等待中的卡永远不是"待认领"（store 会拒绝认领）')
          } else if (status === 'review') {
            assert.equal(h.who, reviewer ?? 'dsh', 'review：球在裁决人（缺省回落到卡主）')
            assert.equal(h.action, 'decide')
          } else if (status === 'done') {
            assert.equal(h.who, 'dsh', 'done：球在卡主（收口权）')
            assert.equal(h.action, 'settle')
          } else if (!assignee) {
            assert.equal(h.who, null, '没人认领时球在池子里')
            assert.equal(h.action, 'claim')
          } else {
            assert.equal(h.who, assignee, '干活阶段：球在负责人')
            assert.equal(h.action, 'work')
          }
        }
      }
    }
  }
  assert.ok(cases >= 80, `组合覆盖 ${cases} 例（5×2×2×4）`)
  // 动作文案两种语言都在
  assert.ok(client.holderActionLabel('decide').length > 0)
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
  // ④d kimi 打回的反例（过度剥离 = 篡改真实标题，最坏方向）：编号必须是一个**完整 token**
  assert.equal(client.displayTitle(t({ title: 'T-930 的回归' })), 'T-930 的回归', 'T-930 不是 T-93')
  assert.equal(client.displayTitle(t({ title: 'T-93X 贴连' })), 'T-93X 贴连', 'T-93X 不是 T-93')
  assert.equal(client.displayTitle(t({ title: 'T-93-2 子任务' })), 'T-93-2 子任务', 'T-93-2 是子编号')
  // ④d′ T-42 第 7 条（kimi 在 T-25 复审里点名的两条同族残余）：编号后跟 `-字母` 或
  // `.数字` 都不是"本卡编号 + 分隔符"，而是**另一个标识符**（hotfix 分支 / 子版本）。
  // 上一版只挡 `(?!-\d)`，于是 `T-93-hotfix` 被剥成 `-hotfix`、`T-93.5` 被小数点
  // 分隔符吃掉变成 `5 回归` —— 仍是打回的那个形状：咬掉真实标题。
  assert.equal(client.displayTitle(t({ title: 'T-93-hotfix 分支' })), 'T-93-hotfix 分支', 'T-93-hotfix 是另一个标识符')
  assert.equal(client.displayTitle(t({ title: 'T-93.5 回归' })), 'T-93.5 回归', 'T-93.5 是子版本号')
  assert.equal(client.displayTitle(t({ id: 'T-9', title: 'T-93 别人的卡' })), 'T-93 别人的卡', 'T-9 不得吃掉 T-93 的前缀')
  assert.equal(client.displayTitle(t({ id: 'T-9', title: 'T-90 的回归' })), 'T-90 的回归', 'T-9 不得吃掉 T-90')
  // 但本卡自己的编号仍然要剥（各种分隔符）
  assert.equal(client.displayTitle(t({ title: 'T-93 · 正题' })), '正题')
  assert.equal(client.displayTitle(t({ title: 'T-93: 正题' })), '正题')
  assert.equal(client.displayTitle(t({ title: '#93 正题' })), '正题')
  assert.equal(client.displayTitle(t({ title: 'T-93' })), 'T-93', '剥空退回原文')
  // ④e 归一化（kimi nit ①）：大小写/空格不同也算同一个 actor
  assert.equal(client.displayTitle(t({ title: '【Kimi】 正题' })), '正题', '大小写不敏感')
  assert.equal(client.displayTitle(t({ title: '【 kimi 】 正题' })), '正题', '空格不敏感')
  // ④f 分隔符残留（kimi nit ②）
  assert.equal(client.displayTitle(t({ title: 'T-93 · - X' })), 'X', '不留悬挂分隔符')
  // ⑤ 无前缀的标题原样返回
  assert.equal(client.displayTitle(t({ title: '普通标题' })), '普通标题')
  // ⑥ 纯展示：绝不改数据
  const src = t({ title: '【kimi】 T-93 · 标题' })
  client.displayTitle(src)
  assert.equal(src.title, '【kimi】 T-93 · 标题', 'displayTitle 不得改动 task')
})

// T-42 第 6 条（kimi 的 T-27 建议 b）：`#93` 这个记号不自解释，tooltip 里点名
// 「任务编号」。卡面 / 详情抽屉 / mini 抽屉共用同一处措辞（taskRefTitle）。
await check('T-42 · 编号的 tooltip 说清它是什么（「任务编号」），不再只念一遍裸 id', async () => {
  assert.equal(client.taskRefTitle('T-93'), 'Task id T-93', '措辞只有一处（zh 孪生在同一个 L() 调用里）')
  const board = collabBoard([{ id: 'T-93', title: 'ref title', status: 'in_progress', assignee: 'dsh' }])
  const { store, html } = await renderBoard(board)
  assert.ok(html.includes('title="Task id T-93"'), '卡面的 #93 带着「任务编号」tooltip')
  // 详情抽屉里那一个 ref 也是同一句（同一函数，一处置措辞）。
  store.select('T-93')
  const drawer = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(drawer.includes('title="Task id T-93"'), '抽屉里的 ref 同措辞')
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
  assert.ok(
    /⚑\s*kimi/.test(fresh.html.replace(/<[^>]*>/g, '')),
    'the decide mark names who owes the verdict',
  )
  assert.ok(fresh.html.includes('reviewer: kimi'), 'and the words live in the tooltip')
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
  // 2026-10-01（持球人）：裁决人不再是一枚独立徽章，而卡面只有一句「球在 ghost（待裁决）」；
  // 「久未活动」这条证据落在 tooltip 里（可见性靠 hover/详情抽屉），不再污染卡面 —— 但不变量不变：
  // 一个花名册里查无此人的裁决人必须被显式点名。
  assert.ok(/⚑\s*ghost/.test(ghost.html.replace(/<[^>]*>/g, '')), 'the decide mark names the ghost')
  assert.ok(/ghost owes this review but has been quiet/.test(ghost.html), 'an unknown reviewer is still flagged quiet (tooltip)')
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
  // T-38 口径变更：`含已关闭` 从"只在按负责人视角渲染"改成**常驻**。旧断言
  // （「the settled toggle is hidden in the status view」）钉的正是被修掉的那个缺陷
  // ——切视角时这一行凭空多/少一个控件，是"显示不稳定"的真正来源。所以这里反过来
  // 钉：默认（按进度）视角它必须在。变异：把渲染条件改回 groupBy==='owner' ⇒ 红。
  assert.ok(html.includes('Include closed'), 'the settled toggle is ALWAYS there (status view too)')

  // Switch to the owner view and re-render through the same store.
  store.setGroupBy('owner')
  const ownerHtml = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(ownerHtml.includes('Unassigned'), 'the pool gets its own lane')
  assert.ok(ownerHtml.includes('>kimi<'), 'kimi has a lane')
  // dsh-agent folds into dsh's lane: one lane, not two.
  assert.equal((ownerHtml.match(/data-lane="dsh"/g) ?? []).length, 1, 'aliases fold to ONE dsh lane')
  assert.ok(ownerHtml.includes('Waiting on human · kimi'), 'the blocked lane is labelled as such')
  assert.ok(ownerHtml.includes('Include closed'), 'the settled toggle is there in the owner view too')
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

await check('escapeTarget: the「关于」popover is its own topmost layer (T-35)', () => {
  // `about` was added in 0.7.3. The older callers build their layer record
  // without the key, which is why it must stay optional at the call sites the
  // panel does not own (the mini board, other plugins).
  const layers = (over) => ({ about: false, guide: false, picker: false, drawer: false, ...over })

  // z-order: about (41) > guide (31) > picker (25) > drawer (21).
  assert.equal(client.escapeTarget(layers({ about: true, guide: true, picker: true, drawer: true })), 'about')
  assert.equal(client.escapeTarget(layers({ about: true, guide: true })), 'about')
  // An Escape while ⓘ is up must NEVER reach the drawer or the guide under it:
  // one keypress, one layer — the regression this wiring exists to prevent.
  assert.notEqual(client.escapeTarget(layers({ about: true, drawer: true })), 'drawer')
  assert.notEqual(client.escapeTarget(layers({ about: true, guide: true })), 'guide')
  // With ⓘ closed the stack below is unchanged (the guide still owns the key).
  assert.equal(client.escapeTarget(layers({ guide: true, picker: true, drawer: true })), 'guide')
  // And a key a focused control consumed closes nothing, about included.
  assert.equal(client.escapeTarget(layers({ about: true }), { defaultPrevented: true }), null)
})

// ------------------------------------------ keyboard navigation (T-36, v0.7.4)
// `j` / `k` walk the board in visual order, `Enter` opens the first card, and a
// focused text control keeps all three keys. The unit under test is NOT a DOM
// listener but the exact predicates the panel's keydown handler runs
// (boardKeyIntent → stepSelection), so a regression here is a regression in the
// real path. SSR cannot dispatch keys at all — the browser-side probe
// (.probe-ui/preview4-keys.mjs) covers the wiring and the drawer follow-through.

/** The panel's dispatcher, reduced: a key sequence → the selection it ends on. */
function walkKeys(order, start, keys) {
  let sel = start
  for (const key of keys) {
    const intent = client.boardKeyIntent({ key, target: { tagName: 'BODY' } })
    if (!intent) continue
    if (intent.kind === 'open') {
      if (sel === null) sel = order[0] ?? null
      continue
    }
    const next = client.stepSelection(order, sel, intent.delta)
    if (next !== null) sel = next
  }
  return sel
}

await check('T-36 · ★ 焦点在输入框 / 评论框 / contenteditable 里时 j / k / Enter 一律放行原生行为', () => {
  const body = { tagName: 'BODY' }
  const input = { tagName: 'INPUT' }
  const textarea = { tagName: 'TEXTAREA' }
  const editable = { tagName: 'DIV', isContentEditable: true }
  const editableByAttr = { tagName: 'DIV', getAttribute: (name) => (name === 'contenteditable' ? '' : null) }

  assert.equal(client.isTypingTarget(input), true, 'input 是文本控件')
  assert.equal(client.isTypingTarget(textarea), true, 'textarea（评论框）是文本控件')
  assert.equal(client.isTypingTarget(editable), true, 'contenteditable 是文本控件')
  assert.equal(client.isTypingTarget(editableByAttr), true, '只带 contenteditable 属性的元素也算')
  assert.equal(client.isTypingTarget(body), false)
  assert.equal(client.isTypingTarget(null), false)
  assert.equal(client.isTypingTarget('j'), false, '非元素目标不算')
  assert.equal(client.isTypingTarget({ tagName: 'DIV', getAttribute: () => 'false' }), false, 'contenteditable="false" 不是')

  for (const target of [input, textarea, editable, editableByAttr]) {
    assert.equal(client.boardKeyIntent({ key: 'j', target }), null, 'j 不抢输入框')
    assert.equal(client.boardKeyIntent({ key: 'k', target }), null, 'k 不抢输入框')
    assert.equal(client.boardKeyIntent({ key: 'Enter', target }), null, 'Enter 不抢输入框')
  }
  // …而在文本控件之外，同样三个键就是看板的。
  assert.deepEqual(client.boardKeyIntent({ key: 'j', target: body }), { kind: 'step', delta: 1 })
  assert.deepEqual(client.boardKeyIntent({ key: 'k', target: body }), { kind: 'step', delta: -1 })
  assert.deepEqual(client.boardKeyIntent({ key: 'Enter', target: body }), { kind: 'open' })
})

await check('T-36 · ★ j / k 按视觉顺序走位：两块泳道 × 每道两张卡（列序 × 列内序）', async () => {
  // ids are deliberately anti-correlated with the walk: whatever "sorted by id"
  // would produce, the visual order is the lanes' own (priority-sorted) order.
  const board = collabBoard([
    { id: 'T-9', title: 'poolHigh', status: 'open', priority: 'high' },
    { id: 'T-2', title: 'poolLow', status: 'open', priority: 'low' },
    { id: 'T-5', title: 'assignedHigh', status: 'assigned', assignee: 'kimi', priority: 'high' },
    { id: 'T-1', title: 'assignedLow', status: 'assigned', assignee: 'kimi', priority: 'low' },
  ])
  const { store, html } = await renderBoard(board)
  // The order the browser paints, read straight out of the markup: lane by
  // lane, card by card. T-42：认卡改用 `data-task`（稳定钩子），不再拿 ref 的
  // tooltip 文案认 —— 那支文案现在是「任务编号 {id}」，会随措辞漂。
  const rendered = html
    .split('class="tb-card')
    .slice(1)
    .map((chunk) => chunk.match(/data-task="(T-\d+)"/)?.[1])
    .filter(Boolean)
  assert.deepEqual(rendered, ['T-9', 'T-2', 'T-5', 'T-1'], '画出来的次序是 列序 × 列内序，不是 id 序')

  const order = client.keyboardOrderFor({
    groupBy: 'column',
    showClosed: false,
    columns: [
      { column: 'pool', tasks: [{ id: 'T-9' }, { id: 'T-2' }] },
      { column: 'assigned', tasks: [{ id: 'T-5' }, { id: 'T-1' }] },
    ],
    groups: [],
  })
  assert.deepEqual(order, rendered, '键盘顺序 === 渲染顺序')
  assert.deepEqual(
    client.visualOrder([[{ id: 'T-9' }, { id: 'T-2' }], [{ id: 'T-5' }, { id: 'T-1' }]]),
    rendered,
    'visualOrder = 泳道序 × 道内卡序',
  )

  assert.equal(walkKeys(order, null, ['j']), 'T-9', 'j 从空选中进入第一张')
  assert.equal(walkKeys(order, null, ['j', 'j']), 'T-2', 'j 在同一道内往下')
  assert.equal(walkKeys(order, null, ['j', 'j', 'j']), 'T-5', 'j 跨泳道继续往下（不是按 id 跳）')
  assert.equal(walkKeys(order, null, ['j', 'j', 'j', 'j']), 'T-1')
  assert.equal(walkKeys(order, null, ['j', 'j', 'k']), 'T-9', 'j j k 回到第一张')
  assert.equal(walkKeys(order, null, ['k']), 'T-1', 'k 从空选中自底部进入')
  assert.equal(walkKeys(order, 'T-5', ['k', 'k']), 'T-9', 'k 反向跨泳道')

  // 走位走的就是点击那条路（store.select）⇒ 高亮与抽屉必然跟着换。
  store.select('T-9')
  assert.equal(store.getState().selectedId, 'T-9')
  const after = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  const activeChunks = after.split('class="tb-card active').slice(1)
  assert.equal(activeChunks.length, 1, '同一时刻只有一张卡带 active（用现有的 tb-card active 样式）')
  assert.equal(activeChunks[0].match(/data-task="(T-\d+)"/)?.[1], 'T-9', 'active 高亮落在被选中的那张卡上')
})

await check('T-36 · 边界不越界；空板 / 统计视图 / 收起的已关闭列都"无处可去"且不报错', () => {
  const order = ['T-1', 'T-2']
  assert.equal(client.stepSelection(order, 'T-2', 1), 'T-2', '最后一张按 j 停在原地（不循环）')
  assert.equal(client.stepSelection(order, 'T-1', -1), 'T-1', '第一张按 k 停在原地')
  assert.equal(client.stepSelection([], null, 1), null, '空板：无处可去')
  assert.equal(client.stepSelection([], 'T-1', -1), null)
  assert.equal(walkKeys([], null, ['j', 'k', 'Enter']), null, '空板连按不报错、也选不中任何东西')
  // 没有选中：j 从顶部进入，k 从底部进入 —— 键往哪走就从哪头进。
  assert.equal(client.stepSelection(order, null, 1), 'T-1')
  assert.equal(client.stepSelection(order, null, -1), 'T-2')
  // 选中项不在当前视图里（被「含已关闭」过滤掉 / 换了视图）：按方向重新进入，
  // 而不是把高亮甩到不相干的邻居上。
  assert.equal(client.stepSelection(order, 'T-99', 1), 'T-1')
  assert.equal(client.stepSelection(order, 'T-99', -1), 'T-2')

  // 收起的「已关闭」列不渲染 ⇒ 不是可走目标；展开后才进顺序；统计页没有卡。
  const cards = (ids) => ids.map((id) => ({ id }))
  const base = {
    groupBy: 'column',
    showClosed: false,
    columns: [
      { column: 'pool', tasks: cards(['T-1']) },
      { column: 'closed', tasks: cards(['T-8', 'T-7']) },
    ],
    groups: [],
  }
  assert.deepEqual(client.keyboardOrderFor(base), ['T-1'], '收起的已关闭条不是可走目标')
  assert.deepEqual(client.keyboardOrderFor({ ...base, showClosed: true }), ['T-1', 'T-8', 'T-7'], '展开后进顺序')
  assert.deepEqual(client.keyboardOrderFor({ ...base, groupBy: 'stats' }), [], '统计页没有卡可走')
  assert.deepEqual(
    client.keyboardOrderFor({
      ...base,
      groupBy: 'owner',
      groups: [{ tasks: cards(['T-1']) }, { tasks: cards(['T-5', 'T-3']) }],
    }),
    ['T-1', 'T-5', 'T-3'],
    '按负责人 = 泳道序 × 卡序',
  )
})

await check('T-36 · 只拿该拿的键：Esc 仍归 escapeTarget，模态层 / ⌘ 快捷键 / 输入法一律放行', () => {
  const body = { tagName: 'BODY' }
  const layers = (over) => ({ about: false, guide: false, picker: false, create: false, ...over })

  // Esc 不在这套判定里：分层仍由 escapeTarget 一处负责（不新增第二套语义）。
  assert.equal(client.boardKeyIntent({ key: 'Escape', target: body }), null, 'Esc 不走 j/k 这条路')
  assert.equal(client.escapeTarget({ about: false, guide: false, picker: false, drawer: true }), 'drawer', 'Esc 分层原样')

  // 模态层浮在上面时（指南 / 关于 / 成员选择器 / 新建表单），j / k / Enter 不是看板的。
  for (const layer of ['about', 'guide', 'picker', 'create']) {
    assert.equal(client.boardKeyIntent({ key: 'j', target: body }, layers({ [layer]: true })), null, `${layer} 浮层持有键盘`)
    assert.equal(client.boardKeyIntent({ key: 'Enter', target: body }, layers({ [layer]: true })), null, `${layer} 浮层持有 Enter`)
  }
  // 抽屉不是阻碍层：抽屉开着时继续浏览正是这个功能的本意。
  assert.deepEqual(client.boardKeyIntent({ key: 'j', target: body }, layers({})), { kind: 'step', delta: 1 })

  // 已消费 / 带修饰键 / 输入法组字中 / 非绑定键：全部交还给页面。
  assert.equal(client.boardKeyIntent({ key: 'j', target: body, defaultPrevented: true }), null)
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(client.boardKeyIntent({ key: 'j', target: body, [mod]: true }), null, `${mod} 组合键不抢`)
  }
  assert.equal(client.boardKeyIntent({ key: 'j', target: body, isComposing: true }), null, '拼音组字中不抢键')
  assert.equal(client.boardKeyIntent({ key: 'x', target: body }), null)
  assert.equal(client.boardKeyIntent({ key: 'J', target: body }), null, '只有小写 j / k 是绑定')
})

await check('T-36 · 帮助浮层（?）里写明快捷键：j / k 走位 + Enter + Esc 分层 + 输入框不生效', async () => {
  const board = collabBoard([{ id: 'T-1', title: 'one', status: 'open' }])
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd(board.workspace)
  await store.refresh()
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store, initialGuideOpen: true }))
  assert.ok(html.includes('For humans'), '指南照旧渲染')
  // locale in this process resolves to English; the zh twin lives in the same
  // L() call (and is checked by the browser probe with locale zh-CN).
  assert.ok(html.includes('j / k move the selection'), '指南写明 j / k 走位')
  assert.ok(html.includes('Enter opens the first card'), '指南写明 Enter')
  assert.ok(html.includes('Escape closes exactly one layer'), '指南写明 Esc 只关最上面一层')
  assert.ok(html.includes('a text box has focus'), '指南写明输入框里不生效')
})

// -------------------------------------------------------- 卡面记号图例（T-42 第 5 条）
// kimi 的 T-27 建议 a：记号的含义全在 tooltip 里 ⇒ 不 hover 的人在面板内没有自查
// 入口。图例补上，而且必须由**卡面真正用的那几个常量**派生 —— 所以这条断言按
// 「真正会渲染的记号」逐一去撞渲染出来的 HTML（少一行就红）。
await check('T-42 · 指南里有卡面记号图例：每个真正会渲染的记号都在里面', async () => {
  const board = collabBoard([{ id: 'T-1', title: 'one', status: 'open' }])
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd(board.workspace)
  await store.refresh()
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store, initialGuideOpen: true }))
  assert.ok(html.includes('Marks on a card'), '图例这一节在指南里')
  // 六个持球记号：直接拿 HOLDER_MARKS（卡面渲染用的就是它）逐个撞。
  for (const [action, mark] of Object.entries(client.HOLDER_MARKS)) {
    assert.ok(html.includes(`>${mark}<`), `持球记号 ${mark}（${action}）在图例里`)
  }
  // 属性行记号 + 编号简写 + 价值点 + 列龄，也同样逐一撞（编号取自 taskRef() 本身）。
  for (const mark of ['@', '✎', client.taskRef('T-93'), '◆3', '9d']) {
    assert.ok(html.includes(`>${mark}<`), `记号 ${mark} 在图例里`)
  }
  // 图例源就是 markLegend()：它的每一行都必须在渲染结果里出现（同一份数据）。
  const marks = client.markLegend().map((row) => row.mark)
  assert.ok(marks.length >= 10, `图例至少覆盖 10 个记号，实际 ${marks.length}`)
  for (const mark of marks) assert.ok(html.includes(`>${mark}<`), `markLegend() 的 ${mark} 渲染出来了`)
})

// ------------------------------------------ reveal in viewport (T-37, v0.7.4)
// 键盘走位的高亮必须看得见；但「已经可见时不滚」才是这条体验的关键 —— 每按一次 j
// 都重新对齐比不滚更烦。判定（isVisibleIn）与调用（revealIntoView）都是纯函数，
// node 直接跑面板真正用的那条路径；"真的滚了 / 真的没动"只能由真浏览器证明
// （.probe-ui/preview4-keys.mjs 的长板 + 反向断言 + scrollIntoView 探针）。

const box = (top, bottom, left = 0, right = 100) => ({ top, bottom, left, right })

await check('T-37 · isVisibleIn：整张卡要完整落在容器可见区内（四边都算，带容差）', () => {
  const view = box(100, 300)
  assert.equal(client.isVisibleIn(box(120, 200), view), true, '整张卡在可见区内 ⇒ 可见')
  assert.equal(client.isVisibleIn(box(100, 300), view), true, '正好贴边 ⇒ 可见')
  assert.equal(client.isVisibleIn(box(98, 200), view), false, '上边被裁 ⇒ 不可见')
  assert.equal(client.isVisibleIn(box(120, 302), view), false, '下边被裁 ⇒ 不可见')
  assert.equal(client.isVisibleIn(box(120, 200, -30, 100), view), false, '左边被横向裁掉 ⇒ 不可见')
  assert.equal(client.isVisibleIn(box(120, 200, 0, 130), view), false, '右边被横向裁掉 ⇒ 不可见')
  // 容差：亚像素 / 贴边不该触发"跳一下"。
  assert.equal(client.isVisibleIn(box(99.5, 300.5), view, client.REVEAL_MARGIN), true, '1px 容差内算可见')
  assert.equal(client.isVisibleIn(box(99.5, 300.5), view, 0), false, '不给容差时就是不可见')
})

await check('T-37 · ★ revealIntoView：可见时一个滚动容器都不碰；被祖先裁掉才滚，且只用 nearest', () => {
  const calls = []
  const card = (rect) => ({ getBoundingClientRect: () => rect, scrollIntoView: (options) => calls.push(options ?? null) })
  const viewports = [box(100, 300), box(0, 900, 0, 1280)]

  assert.equal(client.revealIntoView(card(box(120, 200)), viewports), false, '可见 ⇒ 不用滚')
  assert.equal(calls.length, 0, '可见 ⇒ scrollIntoView 一次都没调（nearest 之外还有一道闸门）')

  assert.equal(client.revealIntoView(card(box(320, 400)), viewports), true, '掉在下面 ⇒ 要滚')
  assert.equal(calls.length, 1, '一次 scrollIntoView 就够（浏览器自己滚需要的那几个祖先）')
  assert.deepEqual(calls[0], { block: 'nearest', inline: 'nearest' }, 'nearest 语义')
  assert.equal(calls[0].behavior, undefined, '绝不带 behavior:smooth（连按会排队卡顿）')

  // 最近祖先里"可见"、却被**横向**泳道容器裁掉（列在屏幕外）⇒ 一样要滚。
  calls.length = 0
  assert.equal(client.revealIntoView(card(box(120, 200, 1300, 1450)), [box(100, 300, 0, 1280)]), true, '横向被裁 ⇒ 要滚')

  // 没有可判的容器 / 没有目标 / 目标没有 scrollIntoView：都不许炸。
  calls.length = 0
  assert.equal(client.revealIntoView(card(box(1, 2)), []), false, '没有可判的容器 ⇒ 不滚')
  assert.equal(client.revealIntoView(null, viewports), false, '没有目标 ⇒ 不报错')
  assert.equal(client.revealIntoView({ getBoundingClientRect: () => box(320, 400) }, viewports), true, '目标没有 scrollIntoView 也不炸')
  assert.equal(calls.length, 0)
})

await check('T-37 · scrollAncestorBoxes：从卡往上收集每个可滚动祖先（最近在前），无祖先退回窗口', () => {
  const el = (name) => ({ name, parentElement: null })
  const card = el('card')
  const laneBody = el('laneBody') // overflowY:auto —— 泳道自己的纵向滚动
  const plain = el('plain')       // 不滚，必须被跳过
  const laneRow = el('laneRow')   // overflowX:auto —— 横向泳道
  const host = el('host')         // overflowY:scroll —— 宿主外框
  card.parentElement = laneBody
  laneBody.parentElement = plain
  plain.parentElement = laneRow
  laneRow.parentElement = host
  const styles = { laneBody: { overflowY: 'auto' }, laneRow: { overflowX: 'auto' }, host: { overflowY: 'scroll' }, plain: {} }
  const rects = { card: box(500, 560), laneBody: box(100, 300), laneRow: box(0, 400), host: box(0, 900, 0, 1280) }
  const computed = (node) => styles[node.name] ?? {}
  const rect = (node) => rects[node.name]
  const windowView = box(0, 900, 0, 1280)

  assert.deepEqual(
    client.scrollAncestorBoxes(card, computed, rect, windowView),
    [rects.laneBody, rects.laneRow, rects.host],
    '最近的在前、不滚的祖先被跳过（横向泳道也算，列在屏幕外就看不见）',
  )
  // 一个可滚动祖先都没有 ⇒ 退回窗口视口；窗口也不知道 ⇒ 空（不碰任何东西）。
  assert.deepEqual(client.scrollAncestorBoxes(card, () => ({}), rect, windowView), [windowView])
  assert.deepEqual(client.scrollAncestorBoxes(card, () => ({}), rect, null), [])
  // 面板那条路径的组合（收集 → 判定）：卡在最近的泳道里被裁 ⇒ 要滚且只滚一次。
  const calls = []
  const real = { parentElement: laneBody, getBoundingClientRect: () => rects.card, scrollIntoView: (options) => calls.push(options) }
  const found = client.scrollAncestorBoxes(real, computed, rect, windowView)
  assert.equal(client.revealIntoView(real, found), true, '被最近祖先裁掉 ⇒ 滚')
  assert.deepEqual(calls, [{ block: 'nearest', inline: 'nearest' }])
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

// --------------------------------------- T-28: 统计页 v2（结构增强）

/** 相对现在的 ISO 时间：`at({d:3, h:2})` = 3 天 2 小时前。 */
const ago = ({ d = 0, h = 0 } = {}) => new Date(Date.now() - (d * 24 + h) * 3600_000).toISOString()

/** 一条日志：相对时间 + 谁 + 什么事件。 */
const ev = (when, by, event, note) => ({ at: ago(when), by, event, ...(note ? { note } : {}) })

await check('stats/blocked: 等待区间重建（T-52）——历史等待不再隐身', () => {
  const now = Date.now()
  // T-1：6 天前挂起 → 4 天前解除 → 2 天前再挂起。`waiting_on.since` 只指向第二次，
  // 第一次挂起在旧口径（只读 since）下是隐身的。日末桶：s[0]=6 天前 … s[6]=今天。
  const relift = statsBoard([
    { id: 'T-1', status: 'open', created_at: ago({ d: 7 }),
      waiting_on: { kind: 'human', who: 'x', question: 'q', since: ago({ d: 2 }) },
      log: [ev({ d: 7 }, 'h', 'created'), ev({ d: 6 }, 'k', 'blocked'), ev({ d: 4 }, 'h', 'unblocked'), ev({ d: 2 }, 'k', 'blocked')] },
  ])
  const s = client.kpis(relift, { days: 7, now }).blocked.series
  assert.equal(s[0], 1, '第一次挂起那天的日末桶：1（旧口径这里是 0）')
  assert.equal(s[3], 0, '两次等待之间的日末桶：0')
  assert.equal(s[4], 1, '第二次挂起之后：1')
  assert.equal(s[6], 1, '此刻：1')
  assert.equal(client.kpis(relift, { days: 7, now }).blocked.value, 1, '当期值（当前快照）：1')
  // 旧板回退：waiting_on 在、blocked 事件一个没有 —— 按 since 计，行为与旧口径一致。
  const legacy = statsBoard([
    { id: 'T-2', status: 'open', created_at: ago({ d: 7 }),
      waiting_on: { kind: 'human', who: 'x', question: 'q', since: ago({ d: 5 }) },
      log: [ev({ d: 7 }, 'h', 'created')] },
  ])
  const sl = client.kpis(legacy, { days: 7, now }).blocked.series
  assert.equal(sl[0], 0, 'since（5 天前）之前的日末桶不计')
  assert.equal(sl[2], 1, 'since 之后按等待计')
  assert.equal(sl[6], 1, '至今仍在等')
  // 收口之后不算（与旧口径一致）；收口之前的等待段照算。
  const settled = statsBoard([
    { id: 'T-3', status: 'closed', created_at: ago({ d: 7 }),
      waiting_on: { kind: 'human', who: 'x', question: 'q', since: ago({ d: 4 }) },
      log: [ev({ d: 7 }, 'h', 'created'), ev({ d: 2 }, 'h', 'closed')] },
  ])
  const ss = client.kpis(settled, { days: 7, now }).blocked.series
  assert.equal(ss[3], 1, '收口之前、等待之中：1')
  assert.equal(ss[6], 0, '收口之后不算')
})

await check('stats/blocked: 隐式结束等待也闭合区间（T-60）—— 末点不再与当期值同屏打架', () => {
  const now = Date.now()
  // store 里 submit / approve / reject / done / close / reopen 都会清 `waiting_on`。
  // T-62 ② 起**写侧**会给每条路径补一条 `unblocked`（新数据天然闭合，见
  // tests/authority-wait.test.mjs）；这里造的是**老数据**形态：log 里没有那条
  // `unblocked`，只有一个"隐式结束"的状态事件 —— 读侧必须认它，否则等待段
  // 一路延伸到此刻，走势图末点=1 而当期值=0（T-60 探针的正是这一格）。
  const implicit = (event, status) => statsBoard([
    { id: 'T-1', status, created_at: ago({ d: 7 }),
      log: [
        ev({ d: 7 }, 'h', 'created'),
        ev({ d: 6 }, 'k', 'started'),
        ev({ d: 5 }, 'k', 'blocked'),
        ev({ d: 3 }, 'k', event),
      ] },
  ])
  for (const [event, status] of [['submitted', 'review'], ['approved', 'done'], ['done', 'done'], ['closed', 'closed'], ['reopened', 'open']]) {
    const k = client.kpis(implicit(event, status), { days: 7, now }).blocked
    assert.equal(k.series[1], 1, `${event}: 挂起当天的日末桶 = 1`)
    assert.equal(k.series[3], 0, `${event}: ${event} 当天之后不应算「还在等」（T-60 的那一格）`)
    assert.equal(k.series[6], 0, `${event}: 此刻没在等`)
    assert.equal(k.series.at(-1), k.value, `${event}: 走势图末点必须等于当期值（同屏不得矛盾）`)
  }
  // 反面：真的还在等（没有任何终点事件）⇒ 末点与当期值同时 = 1，修复没有把等待抹掉。
  const stillWaiting = statsBoard([
    { id: 'T-2', status: 'in_progress', created_at: ago({ d: 7 }),
      waiting_on: { kind: 'human', who: 'x', question: 'q', since: ago({ d: 5 }) },
      log: [ev({ d: 7 }, 'h', 'created'), ev({ d: 5 }, 'k', 'blocked')] },
  ])
  const w = client.kpis(stillWaiting, { days: 7, now }).blocked
  assert.equal(w.series[6], 1, '还在等：末点 = 1')
  assert.equal(w.value, 1, '还在等：当期值 = 1')
  // 新数据形态（T-62 写侧在场）：blocked → unblocked → submitted，同样闭合。
  const explicit = statsBoard([
    { id: 'T-3', status: 'review', created_at: ago({ d: 7 }),
      log: [ev({ d: 7 }, 'h', 'created'), ev({ d: 5 }, 'k', 'blocked'), ev({ d: 3 }, 'k', 'unblocked'), ev({ d: 3 }, 'k', 'submitted')] },
  ])
  const e = client.kpis(explicit, { days: 7, now }).blocked
  assert.equal(e.series[1], 1, '新数据：挂起当天 = 1')
  assert.equal(e.series[3], 0, '新数据：unblocked 当天之后不算')
  assert.equal(e.series.at(-1), e.value, '新数据：末点 = 当期值')
})

await check('stats/window: 窗外的事件不进当期，也不会偷偷算进上一期', () => {
  const now = Date.now()
  const board = statsBoard([
    // 6 天前收口 → 落进 7 天当期
    { id: 'T-1', status: 'closed', created_at: ago({ d: 6 }), log: [ev({ d: 6 }, 'h', 'created'), ev({ d: 5 }, 'k', 'approved'), ev({ d: 5 }, 'h', 'closed')] },
    // 12 天前收口 → 只在 14 天当期里；对 7 天窗口它是"上一期"
    { id: 'T-2', status: 'closed', created_at: ago({ d: 12 }), log: [ev({ d: 12 }, 'h', 'created'), ev({ d: 12 }, 'k', 'approved'), ev({ d: 11 }, 'h', 'closed')] },
    // 25 天前收口 → 只在 30 天当期里
    { id: 'T-3', status: 'closed', created_at: ago({ d: 25 }), log: [ev({ d: 25 }, 'h', 'created'), ev({ d: 25 }, 'k', 'approved'), ev({ d: 24 }, 'h', 'closed')] },
    // 70 天前收口 → 任何窗口的当期/上一期都不该看见它
    { id: 'T-4', status: 'closed', created_at: ago({ d: 71 }), log: [ev({ d: 71 }, 'h', 'created'), ev({ d: 70 }, 'k', 'approved'), ev({ d: 70 }, 'h', 'closed')] },
  ])
  const settled = (days) => client.kpis(board, { days, now }).settled
  assert.equal(settled(7).value, 1, '7 天窗口只看见 6 天前那张')
  assert.equal(settled(14).value, 2)
  assert.equal(settled(30).value, 3)
  // 更长的时间窗只能装得更多：同一份数据在三档下单调不减。
  assert.ok(settled(7).value <= settled(14).value && settled(14).value <= settled(30).value)
  // 上一期 = 紧挨着的那个等长窗口（[days, 2×days)），不是"全部历史"。
  assert.equal(settled(7).previous, 1, 'T-2 落在 [7,14)')
  assert.equal(settled(14).previous, 1, 'T-3 落在 [14,28)')
  assert.equal(settled(30).previous, 0, 'T-4 在 70 天前，[30,60) 里没有它')
  // 折线的横轴也吃同一个窗口。
  assert.equal(client.flow(board, { days: 7, now }).length, 7)
  assert.equal(client.flow(board, { days: 30, now }).length, 30)
  // 状态类 KPI 是"此刻的快照"，不受窗口长度影响（窗口只决定"跟哪一刻比"）。
  const openBoard = statsBoard([{ id: 'T-9', status: 'open', created_at: ago({ d: 40 }) }])
  for (const days of [7, 14, 30]) {
    const kpi = client.kpis(openBoard, { days, now }).open
    assert.equal(kpi.value, 1, '40 天前建的卡现在仍然是未结清')
    assert.equal(kpi.series.length, days, '走势的桶数就是窗口天数')
    assert.ok(kpi.series.every((point) => point === 1), '窗口内每一天它都是未结清')
  }
})

await check('stats/window: 把数据挪出窗口，环比跟着反向（不是写死的）', () => {
  const now = Date.now()
  const build = (movedDays) => statsBoard([
    // 当期里的一张（1 天前收口）
    { id: 'T-1', status: 'closed', created_at: ago({ d: 3 }), log: [ev({ d: 3 }, 'h', 'created'), ev({ d: 1 }, 'h', 'closed')] },
    // 被挪动的那张：2 天前（当期）↔ 9 天前（上一期 [7,14)）
    { id: 'T-2', status: 'closed', created_at: ago({ d: 12 }), log: [ev({ d: 12 }, 'h', 'created'), ev({ d: movedDays }, 'h', 'closed')] },
    // 一直待在上一期的一张
    { id: 'T-3', status: 'closed', created_at: ago({ d: 11 }), log: [ev({ d: 11 }, 'h', 'created'), ev({ d: 10 }, 'h', 'closed')] },
  ])
  const inside = client.kpis(build(2), { days: 7, now }).settled
  const outside = client.kpis(build(9), { days: 7, now }).settled
  assert.equal(inside.value, 2, '挪进来：当期 2 张')
  assert.equal(inside.previous, 1)
  assert.ok(inside.diff > 0 && inside.delta > 0, '当期变多 → 正环比')
  assert.equal(outside.value, 1, '挪出去：当期只剩 1 张')
  assert.equal(outside.previous, 2)
  assert.ok(outside.diff < 0 && outside.delta < 0, '当期变少 → 负环比')
  // 同一张卡，只改它收口的时间，环比的方向必须真的翻转。
  assert.ok(Math.sign(inside.delta) === -Math.sign(outside.delta), 'delta 的方向随之翻转')
})

await check('stats/kpi: 样本不足时不给环比（比值/中位数要两侧各 n ≥ 3）', () => {
  const now = Date.now()
  const board = statsBoard([
    { id: 'T-1', status: 'closed', created_at: ago({ d: 4, h: 2 }), log: [ev({ d: 4 }, 'h', 'created'), ev({ d: 4 }, 'k', 'approved'), ev({ d: 3 }, 'h', 'closed')] },
  ])
  const cycle = client.kpis(board, { days: 7, now }).cycle
  assert.ok(cycle.value !== null, '有 1 个样本，中位数本身还是有的')
  assert.equal(cycle.n, 1)
  assert.equal(cycle.comparable, false, 'n < 3 → 不敢当趋势')
  assert.equal(cycle.delta, null, '样本不足就不给环比数字')
  assert.equal(client.MIN_TREND_SAMPLES, 3)
  // 计数类是精确值，不适用样本门槛（0 → 3 张就是变了 3 张，不是统计推断）。
  const counts = client.kpis(board, { days: 7, now }).settled
  assert.equal(counts.comparable, true)
  assert.equal(counts.value, 1)
  assert.equal(counts.previous, 0)
  assert.equal(counts.delta, null, '上期为 0 时百分比没有定义')
  assert.equal(counts.diff, 1, '但绝对差照样给')
})

await check('stats/holders: 每张未结清卡恰好归属一个持球人（别名折进同一组）', () => {
  const now = Date.now()
  const board = statsBoard([
    // 六种动作各来一张，外加一张已结清（它不属于任何人）
    { id: 'T-1', status: 'open', assignee: null, created_at: ago({ d: 1 }) },
    { id: 'T-2', status: 'open', assignee: 'kimi', created_at: ago({ d: 1 }), log: [ev({ d: 1 }, 'h', 'created'), ev({ d: 1 }, 'k', 'assigned')] },
    { id: 'T-3', status: 'in_progress', assignee: 'kimi', created_at: ago({ d: 1 }), log: [ev({ d: 1 }, 'h', 'created'), ev({ d: 1 }, 'k', 'started')] },
    { id: 'T-4', status: 'review', assignee: 'cc', reviewer: 'dsh-agent', created_at: ago({ d: 1 }), log: [ev({ d: 1 }, 'h', 'created'), ev({ d: 1 }, 'cc', 'submitted')] },
    { id: 'T-5', status: 'done', assignee: 'kimi', created_by: 'human', created_at: ago({ d: 1 }), log: [ev({ d: 1 }, 'h', 'created'), ev({ d: 1 }, 'k', 'approved')] },
    { id: 'T-6', status: 'open', assignee: 'cc', created_at: ago({ d: 1 }), waiting_on: { kind: 'agent', who: 'dsh', question: 'q', since: ago({ h: 2 }) }, log: [ev({ d: 1 }, 'h', 'created')] },
    // 无名等待：`waiting_on.who` 允许为 null（types.ts）。它**不是**池子里的卡
    // —— store 明确拒绝认领等待中的卡，渲染成"可认领"就是骗人（T-26 复核抓到过）。
    { id: 'T-8', status: 'open', assignee: null, created_at: ago({ d: 2 }), waiting_on: { kind: 'human', who: null, question: '叫谁来答？', since: ago({ h: 3 }) }, log: [ev({ d: 2 }, 'h', 'created')] },
    { id: 'T-7', status: 'closed', assignee: 'kimi', created_at: ago({ d: 1 }), log: [ev({ d: 1 }, 'h', 'created'), ev({ d: 1 }, 'h', 'closed')] },
  ])
  // 名册把 dsh-agent 折成 dsh：T-4 的审核人和 T-6 要等的人是同一个 Actor。
  board.actors = { dsh: { kind: 'agent', aliases: ['dsh-agent'], first_seen_at: ago({ d: 9 }), last_seen_at: ago({ h: 1 }) } }
  const groups = client.holderGroups(board, { now })
  const open = Object.values(board.tasks).filter((task) => task.status !== 'closed')
  const assignments = groups.flatMap((group) => group.actions.flatMap((bucket) => bucket.ids.map((id) => [id, group.key, bucket.action])))
  assert.equal(assignments.length, open.length, '一张未结清卡只出现一次')
  assert.equal(new Set(assignments.map(([id]) => id)).size, open.length, '没有重复也没有遗漏')
  for (const [id, key, action] of assignments) {
    assert.ok(open.some((task) => task.id === id), `${id} 是未结清卡`)
    assert.equal(typeof key, 'string', '分组键是字符串（池子组为 ""）')
    assert.ok(['claim', 'work', 'answer', 'reply', 'decide', 'settle'].includes(action), `${id} 的动作合法`)
  }
  // 池子组只装"真的没人认领"的那张：无名等待必须自成一组，不许混进来。
  const pool = groups.find((group) => group.kind === 'pool')
  assert.ok(pool, '池子组存在')
  assert.equal(pool.who, null)
  assert.deepEqual(pool.actions.map((bucket) => bucket.action), ['claim'])
  assert.deepEqual(pool.actions[0].ids, ['T-1'], '池子里只有 T-1')
  const unnamed = groups.find((group) => group.kind === 'unnamed_wait')
  assert.ok(unnamed, '无名等待自成一类，不被当成池子')
  assert.equal(unnamed.who, null)
  assert.deepEqual(unnamed.actions[0].ids, ['T-8'])
  assert.equal(unnamed.actions[0].action, 'answer', '它是"待回复"，不是"待认领"')
  assert.equal(unnamed.quiet, false, '没指名就没人可怪（失联判断对它沉默）')
  // 别名折叠：审核人 dsh-agent 与等待对象 dsh 落在同一个持球人身上。
  const dshRow = groups.find((group) => group.key === 'dsh')
  assert.ok(dshRow, 'dsh 组存在（dsh-agent 折进来）')
  assert.equal(dshRow.kind, 'actor')
  assert.equal(dshRow.total, 2)
  assert.deepEqual(dshRow.actions.map((bucket) => bucket.action).sort(), ['decide', 'reply'])
  // 已结清的卡不在任何分组里。
  assert.ok(!assignments.some(([id]) => id === 'T-7'), 'closed 的卡没有人持球')
  // 分组总数 = 未结清数。
  assert.equal(groups.reduce((sum, group) => sum + group.total, 0), open.length)
})

await check('panel: 无名等待不被统计页渲染成「可认领的池子」', async () => {
  const board = collabBoard([
    { id: 'T-1', title: 'unnamedWait', status: 'open', assignee: null, created_at: ago({ d: 2 }), waiting_on: { kind: 'human', who: null, question: '叫谁来答？', since: ago({ h: 30 }) }, log: [
      { at: ago({ d: 2 }), by: 'human', event: 'created' },
    ] },
  ])
  const { store } = await renderBoard(board)
  store.setGroupBy('stats')
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  // 持球人排行那一行的名字（`.tb-holder-name` 是这一行唯一的钩子 —— 负责人表里
  // 也有一个 '(pool)'，那是"没人认领的卡归在谁名下"，两者不能混着断言）。
  const names = [...html.matchAll(/class="tb-holder-name"[^>]*>([^<]*)/g)].map((match) => match[1])
  assert.deepEqual(names, ['(unnamed wait)'], '持球人排行里它是「未指名的等待」，不是池子')
  assert.ok(html.includes('wait overdue'), '而且它确实是"等待超时"这条异常')
  assert.ok(html.includes('>unnamed<'), '异常行的"谁"一列是「未指名」而不是"池子"')
})

// ------------------------------------------------- 卡面层：无名等待（T-40 ①）
// 「无名等待不是池子」这条不变量有三层：派生层（holderGroups，上方已护）、统计页
// （上方已护）、以及**卡面**——最该有护栏的一层，偏偏此前没有：把 TaskCard 的等待
// 分支顺序改回旧顺序（先判 holder.who === null），整套 client 测试仍全绿。这条补上。
//
// 措辞注意：一张 open + 无负责人的卡**列推导确实落在 Pool 列**，所以第 1 行的状态
// 标签照旧读作 "Pool"——那是列推导，不是谎言。会骗人的是**持球行**说「池子里」：
// store 明确拒绝认领等待中的卡，那句话等于给一个点了必然失败的入口。断言因此按
// **卡面切片**做，而不是拿整页 html 去撞 "Pool"。
await check('panel 卡面：无名等待（who === null）说「等的是哪一类」，绝不说「池子里」', async () => {
  const waitingAt = new Date(Date.now() - 3 * 3600_000).toISOString()
  const board = collabBoard([
    // 无名等待 ×3：三种 kind 各一，who 都为 null。
    { id: 'T-8', title: 'waitHuman', status: 'open', assignee: null, waiting_on: { kind: 'human', who: null, question: '叫谁来答？', since: waitingAt } },
    { id: 'T-9', title: 'waitAgent', status: 'open', assignee: null, waiting_on: { kind: 'agent', who: null, question: 'q', since: waitingAt } },
    { id: 'T-10', title: 'waitExternal', status: 'open', assignee: null, waiting_on: { kind: 'external', who: null, question: 'q', since: waitingAt } },
    // 指了名的等待：名字照旧上卡面（这条断言不能把"报名字"一起改坏）。
    { id: 'T-11', title: 'waitNamed', status: 'open', assignee: null, waiting_on: { kind: 'agent', who: 'kimi', question: 'q', since: waitingAt } },
    // 正对照：真·池子卡。没有它，「不含池子文案」可以靠"干脆永不渲染池子文案"通过。
    { id: 'T-1', title: 'genuinePool', status: 'open', assignee: null },
  ])
  const { html } = await renderBoard(board)
  // 按卡切片：每张卡是一个 <button class="tb-card">，用它自己的标题认领自己那块。
  const chunks = html.split('<button type="button" class="tb-card').slice(1)
  const cardOf = (title) => {
    const chunk = chunks.find((row) => row.includes(`>${title}<`))
    assert.ok(chunk, `卡面里有「${title}」`)
    return chunk
  }
  const textOf = (chunk) => chunk.replace(/<[^>]*>/g, '')
  const POOL_COPY = 'in the pool' // 池子文案（en-US 被钉在测试进程里；zh 孪生在同一处 L() 调用里）

  for (const [title, kind] of [['waitHuman', 'a human'], ['waitAgent', 'an agent'], ['waitExternal', 'an external party']]) {
    const card = cardOf(title)
    const text = textOf(card)
    assert.ok(!text.includes(POOL_COPY), `${title}：无名等待不是池子（卡面读作「${POOL_COPY}」= 一个点了必然失败的认领入口）`)
    assert.ok(text.includes(kind), `${title}：说出等的是哪一类（期望「${kind}」，实际「${text}」）`)
    assert.ok(card.includes('class="tb-badge-wait"'), `${title}：戴等待徽章（琥珀），不是池子徽章`)
  }

  // 正对照：真·池子卡必须**仍然**读作池子。
  const pool = cardOf('genuinePool')
  assert.ok(textOf(pool).includes(POOL_COPY), '真·池子卡照旧说「in the pool」——上面的断言不是靠"永不渲染池子文案"通过的')
  assert.ok(pool.includes('class="tb-badge-outline"'), '真·池子用池子徽章（○）')

  // 指了名的等待不受影响。
  assert.ok(/◷\s*kimi/.test(textOf(cardOf('waitNamed'))), '指了名的等待仍报名字')
  assert.ok(html.includes('waiting on agent kimi'), '整句照旧在 tooltip 里')
})

// ------------------------------------------------- 裁决人仍可裁决（T-40 ②）
// review 卡被 block 时"遮蔽"真实存在：block 在第三方（等人类答一个前提问题），而裁决人
// 本可先行裁决 —— host 的 approve/reject 会一并清掉 waiting_on（src/host/store.ts），
// 所以不是 blocker。既然不是 blocker，持球 tooltip 就必须把这句话说出来，否则读者以为
// 「谁都不能动」（kimi 在 T-26 的复核里指出，T-40 落地）。
await check('panel 持球 tooltip：被 block 的待审核卡点名「裁决人 {reviewer} 仍可裁决」', async () => {
  const since = new Date(Date.now() - 3600_000).toISOString()
  const blockedReview = (reviewer) => ({
    id: 'T-4', title: 'blockedReview', status: 'review', assignee: 'dsh', reviewer,
    waiting_on: { kind: 'human', who: 'iceskysl', question: '这个前提还成立吗？', since },
  })
  const { store, html } = await renderBoard(collabBoard([blockedReview('cc')]))
  // 持球 chip 的 title 属性就是这句 tooltip —— SSR 里找不到就等于没写。
  assert.ok(html.includes('waiting on human iceskysl'), '等待本身照旧先说（谁被等着）')
  assert.ok(html.includes('reviewer cc can still decide'), '补的那句在卡面 tooltip 里，且点名的是裁决人 cc')
  assert.ok(html.includes('这个前提还成立吗？'), '被等的问题也还在')

  // 抽屉里同样可见：持球行与卡面共用 holderTitle，一处措辞两处生效。
  store.select('T-4')
  const opened = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  const drawer = opened.slice(opened.indexOf('<aside'))
  assert.ok(drawer.length > 0, '抽屉渲染出来了')
  assert.ok(drawer.includes('reviewer cc can still decide'), '抽屉的持球行 tooltip 也带这句（这是"抽屉里可见"的那一层）')
  store.select(null)

  // 换个裁决人，名字跟着换（{reviewer} 是变量，不是写死的 cc）。
  const other = await renderBoard(collabBoard([blockedReview('kimi')]))
  assert.ok(other.html.includes('reviewer kimi can still decide'), '{reviewer} 取的是这张卡的裁决人')

  // 没有 review 就没有"裁决人"：这句话不许乱窜到别的等待卡上。
  const work = await renderBoard(collabBoard([
    { id: 'T-5', title: 'blockedWork', status: 'in_progress', assignee: 'dsh', reviewer: null, waiting_on: { kind: 'human', who: 'iceskysl', question: 'q', since } },
  ]))
  assert.ok(!work.html.includes('can still decide'), '进行中的等待卡没有裁决人，不该出现这句话')

  // 没被 block 的 review 卡：也不该出现（它的 tooltip 已经说了「裁决人：kimi」）。
  // 裁决人用 kimi —— 它在 collabBoard 的名册里且刚活动过，才走「裁决人：X」那一支；
  // 名册里查无此人的裁决人走的是"欠审核但久未活动"的措辞（另一条已有断言）。
  const plainReview = await renderBoard(collabBoard([
    { id: 'T-6', title: 'plainReview', status: 'review', assignee: 'dsh', reviewer: 'kimi', waiting_on: null },
  ]))
  assert.ok(!plainReview.html.includes('can still decide'), '没被 block 的 review 卡不加这句：等待是它的前提')
  assert.ok(plainReview.html.includes('reviewer: kimi'), '它照旧说的是「裁决人：kimi」')
})

await check('stats/anomalies: 阈值沿用看板自己的陈旧规则，一张卡只占一行', () => {
  const now = Date.now()
  const board = statsBoard([
    // 评审列躺了 30h（SLA 24h）→ review_overdue
    { id: 'T-1', status: 'review', assignee: 'cc', reviewer: 'kimi', created_at: ago({ d: 3 }), log: [ev({ d: 3 }, 'h', 'created'), ev({ d: 3 }, 'cc', 'started'), ev({ h: 30 }, 'cc', 'submitted')] },
    // 在等人类 30h（SLA 24h）→ wait_overdue（比"久未动"更急）；卡自己在进行中躺了 5 天
    { id: 'T-2', status: 'in_progress', assignee: 'kimi', created_at: ago({ d: 5 }), waiting_on: { kind: 'human', who: 'iceskysl', question: 'q', since: ago({ h: 30 }) }, log: [ev({ d: 5 }, 'h', 'created'), ev({ d: 5, h: 1 }, 'k', 'started')] },
    // 窗口内被打回 → recent_reject
    { id: 'T-3', status: 'in_progress', assignee: 'dsh', created_at: ago({ d: 5 }), log: [ev({ d: 5 }, 'h', 'created'), ev({ d: 3 }, 'dsh', 'submitted'), ev({ d: 1 }, 'kimi', 'rejected')] },
    // 刚开工、什么都正常 → 不该出现
    { id: 'T-4', status: 'in_progress', assignee: 'kimi', created_at: ago({ h: 3 }), log: [ev({ h: 3 }, 'h', 'created'), ev({ h: 2 }, 'k', 'started')] },
    // 已结清 → 永远不出现
    { id: 'T-5', status: 'closed', assignee: 'kimi', created_at: ago({ d: 40 }), log: [ev({ d: 40 }, 'h', 'created'), ev({ d: 1 }, 'h', 'closed')] },
  ])
  board.actors = { kimi: { kind: 'agent', aliases: [], first_seen_at: ago({ d: 9 }), last_seen_at: ago({ h: 1 }) } }
  const rows = client.anomalies(board, { days: 7, now })
  const byId = new Map(rows.map((row) => [row.taskId, row]))
  assert.equal(byId.size, rows.length, '一张卡只占一行')
  assert.equal(byId.get('T-1').kind, 'review_overdue')
  assert.equal(byId.get('T-2').kind, 'wait_overdue', '等待超时压过久未动')
  assert.ok(byId.get('T-2').also.includes('idle'), '两个原因都记着，只是主因排第一')
  assert.equal(byId.get('T-3').kind, 'recent_reject')
  assert.equal(byId.has('T-4'), false, '3 小时的卡不是异常')
  assert.equal(byId.has('T-5'), false, '已结清的不进异常清单')
  // 排序：越急越靠前（等待超时 → 评审超时 → …）。
  const ranks = { wait_overdue: 0, review_overdue: 1, holder_quiet: 2, recent_reject: 3, idle: 4 }
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(ranks[rows[i - 1].kind] <= ranks[rows[i].kind], '按急迫度排序')
  }
  // 阈值就是看板那套，不是统计页另造的：评审列 24h。
  assert.equal(byId.get('T-1').ageMs > 24 * 3600_000, true)
})

await check('stats/milestones: 只有 v1.42.0 这种 tag 算里程碑，其它 tag 不算', () => {
  const board = statsBoard([
    { id: 'T-1', status: 'closed', value: 5, tags: ['ios', 'v1.42.0'], created_at: ago({ d: 9 }), log: [ev({ d: 9 }, 'h', 'created'), ev({ d: 8 }, 'h', 'closed')] },
    { id: 'T-2', status: 'open', value: 3, tags: ['v1.42.0'], created_at: ago({ d: 4 }) },
    { id: 'T-3', status: 'done', value: null, tags: ['v1.42.0', 'm7'], created_at: ago({ d: 2 }) },
    { id: 'T-4', status: 'open', value: 2, tags: ['v1.43.0'], created_at: ago({ d: 1 }) },
    { id: 'T-5', status: 'open', value: 1, tags: ['v1.42', 'v1.42.0.1', 'ios'], created_at: ago({ d: 1 }) },
  ])
  assert.equal(client.isMilestoneTag('v1.42.0'), true)
  assert.equal(client.isMilestoneTag('v1.42'), false, '少一段不是版本号')
  assert.equal(client.isMilestoneTag('v1.42.0.1'), false)
  assert.equal(client.isMilestoneTag('ios'), false)
  // T-42 第 4 条：前缀大小写的口径必须与 semverParts()（`replace(/^v/i, '')`）一致 ——
  // 闸门收的前缀，解析器一定认；否则 `V1.42.0` 能解析却永远进不了这块统计。
  assert.equal(client.isMilestoneTag('V1.42.0'), true, 'semverParts 容忍的大写前缀，闸门也得认')
  assert.equal(client.isMilestoneTag('  V1.42.0  '), true, 'trim 之后同一口径')
  assert.equal(client.isMilestoneTag('V1.42'), false, '大小写不敏感不等于放宽段数')
  const rows = client.milestones(board)
  assert.deepEqual(rows.map((row) => row.tag), ['v1.43.0', 'v1.42.0'], '版本号大的在前')
  const m = rows[1]
  assert.equal(m.total, 3)
  assert.equal(m.settled, 1)
  assert.equal(m.open, 2)
  assert.equal(m.remaining, 2)
  assert.equal(m.valueTotal, 8, '◆5 + ◆3（第三张没估值）')
  assert.equal(m.valueDelivered, 5)
  assert.deepEqual(m.ids, ['T-1', 'T-2', 'T-3'])
  // 没有里程碑 tag 的板 → 空数组（视图据此整块不渲染）。
  assert.deepEqual(client.milestones(statsBoard([{ id: 'T-1', tags: ['ios', 'm7'], created_at: ago({ d: 1 }) }])), [])
  assert.deepEqual(client.milestones(null), [])
})

await check('stats/value: 积压 ◆ 与窗口内交付 ◆ 是两个数，吞吐按窗口天数摊', () => {
  const now = Date.now()
  const board = statsBoard([
    // 窗口内交付 ◆5
    { id: 'T-1', status: 'closed', value: 5, created_at: ago({ d: 8 }), log: [ev({ d: 8 }, 'h', 'created'), ev({ d: 7 }, 'k', 'approved'), ev({ d: 2 }, 'h', 'closed')] },
    // 上一期交付的 ◆2（不算进窗口内交付）
    { id: 'T-2', status: 'closed', value: 2, created_at: ago({ d: 20 }), log: [ev({ d: 20 }, 'h', 'created'), ev({ d: 19 }, 'k', 'approved'), ev({ d: 12 }, 'h', 'closed')] },
    // 积压 ◆3
    { id: 'T-3', status: 'in_progress', value: 3, created_at: ago({ d: 3 }) },
    // 没估值的不进任何 ◆ 数字
    { id: 'T-4', status: 'open', value: null, created_at: ago({ d: 1 }) },
  ])
  const view = client.valueView(board, { days: 7, now })
  assert.equal(view.backlogValue, 3)
  assert.equal(view.backlogTasks, 2, '未结清 2 张（含没估值那张）')
  assert.equal(view.deliveredValue, 5)
  assert.equal(view.deliveredTasks, 1)
  assert.equal(view.throughputPerDay.toFixed(2), (5 / 7).toFixed(2))
  assert.equal(view.unestimated, 1)
  assert.equal(view.avgValue?.toFixed(2), (10 / 3).toFixed(2), '每卡平均只除已评估的 3 张')
  // 平均周期算的是"干完"（created → done/approved），不是收口：
  // 两张卡各 1 天，均值 = 1 天（durationText 在 48h 以内按小时显示）。
  assert.equal(view.avgCycleMs, 24 * 3600_000)
  assert.equal(view.cycleN, 2)
})

await check('stats/niceAxis: 刻度是 1/2/5×10ⁿ，覆盖最大值且含 0', () => {
  const cases = [[3, 4], [7, 4], [1, 4], [0, 4], [23, 4], [0.4, 4]]
  for (const [max, count] of cases) {
    const axis = client.niceAxis(max, count)
    assert.ok(axis.max >= max, `${max} 的上界 ${axis.max} 必须盖住数据`)
    assert.equal(axis.ticks[0], 0, '刻度从 0 起')
    assert.equal(axis.ticks[axis.ticks.length - 1], axis.max)
    const step = axis.ticks[1] - axis.ticks[0]
    for (let i = 1; i < axis.ticks.length; i += 1) {
      const gap = Number((axis.ticks[i] - axis.ticks[i - 1]).toFixed(6))
      assert.equal(gap, Number(step.toFixed(6)), '刻度等距')
    }
  }
  assert.deepEqual(client.niceAxis(0), { max: 1, ticks: [0, 1] }, '空数据也给一个合法轴')
  assert.equal(client.niceAxis(7).max, 8, '7 的上界是 8（不是 7）')
})

await check('stats/statusAt: 用 log 重放"那一刻的状态"，不是猜的', () => {
  const board = statsBoard([
    { id: 'T-1', status: 'closed', created_at: ago({ d: 10 }), log: [
      ev({ d: 10 }, 'h', 'created'), ev({ d: 9 }, 'k', 'started'), ev({ d: 8 }, 'k', 'submitted'),
      ev({ d: 7 }, 'd', 'rejected'), ev({ d: 6 }, 'k', 'submitted'), ev({ d: 5 }, 'd', 'approved'),
      ev({ d: 4 }, 'h', 'closed'),
    ] },
  ])
  const task = board.tasks['T-1']
  const at = (d) => Date.now() - d * 24 * 3600_000
  assert.equal(client.statusAt(task, at(11)), null, '还没建卡')
  assert.equal(client.statusAt(task, at(9.5)), 'open')
  assert.equal(client.statusAt(task, at(8.5)), 'in_progress')
  assert.equal(client.statusAt(task, at(7.5)), 'review')
  assert.equal(client.statusAt(task, at(6.5)), 'in_progress', '被打回就回到进行中')
  assert.equal(client.statusAt(task, at(5.5)), 'review', '第二次提交之后、通过之前')
  assert.equal(client.statusAt(task, at(4.5)), 'done')
  assert.equal(client.statusAt(task, at(1)), 'closed')
  // 时间窗的边界是半开的 [from, to)。
  const bounds = client.windowBounds({ days: 7, now: at(0) })
  assert.equal(bounds.to - bounds.from, 7 * 24 * 3600_000)
  assert.equal(bounds.prevTo, bounds.from)
  assert.equal(bounds.from - bounds.prevFrom, 7 * 24 * 3600_000)
})

await check('panel: 统计视图有窗口开关 / 环比 / 异常清单，且每条异常都接了 onOpenTask', async () => {
  const board = collabBoard([
    // 评审列躺了 30h：异常清单里必须有它
    { id: 'T-1', title: 'awaitingVerdict', status: 'review', assignee: 'cc', reviewer: 'kimi', value: 3, created_at: ago({ d: 3 }), log: [
      { at: ago({ d: 3 }), by: 'human', event: 'created' }, { at: ago({ h: 30 }), by: 'cc', event: 'submitted' },
    ] },
    { id: 'T-2', title: 'wip', status: 'in_progress', assignee: 'kimi', value: 2, created_at: ago({ d: 1 }), log: [
      { at: ago({ d: 1 }), by: 'human', event: 'created' }, { at: ago({ h: 20 }), by: 'kimi', event: 'started' },
    ] },
    { id: 'T-3', title: 'milestoneWork', status: 'done', assignee: 'kimi', tags: ['v1.42.0'], value: 5, created_at: ago({ d: 6 }), log: [
      { at: ago({ d: 6 }), by: 'human', event: 'created' }, { at: ago({ d: 5 }), by: 'kimi', event: 'approved' },
    ] },
    { id: 'T-4', title: 'settled', status: 'closed', assignee: 'kimi', tags: ['v1.42.0'], value: 1, created_at: ago({ d: 9 }), log: [
      { at: ago({ d: 9 }), by: 'human', event: 'created' }, { at: ago({ d: 8 }), by: 'kimi', event: 'approved' }, { at: ago({ d: 2 }), by: 'human', event: 'closed' },
    ] },
  ])
  const { store } = await renderBoard(board)
  store.setGroupBy('stats')
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))

  // 1) 时间窗开关三档都在，默认 14 天（标题里的数字跟着默认走）。
  for (const chip of ['7 days', '14 days', '30 days']) assert.ok(html.includes(chip), `窗口开关 ${chip}`)
  assert.ok(html.includes('Daily flow (last 14 days)'), '默认窗口是 14 天')
  assert.ok(html.includes('vs previous 14d'), '环比说的是"跟前一个等长窗口比"')
  // 2) KPI 分成两组。
  assert.ok(html.includes('Needs you') && html.includes('Background'), 'KPI 分了两组')
  // 3) 现在该动什么：持球人 + 异常清单。
  assert.ok(html.includes('What to do now') && html.includes('Ball holders') && html.includes('Anomalies'), '新块在')
  assert.ok(html.includes('review overdue'), '评审超时被点出来')
  // 4) 每条异常是一颗能点的 button，而且 BoardPanel 真的把 onOpenTask 接上了
  //    （没接上时 StatsView 会把同一行渲染成 data-flat="1"）。
  assert.ok(html.includes('class="tb-stats-row"'), '异常行是按钮')
  assert.ok(html.includes('data-flat="0"'), 'BoardPanel 接上了 onOpenTask')
  // 5) 图表可读数：环形图是 dasharray 画出来的弧、中心有未结清数、里程碑块在。
  assert.ok(html.includes('Milestones'), '里程碑块在（这块板有 v1.42.0）')
  assert.ok((html.match(/stroke-dasharray/g) ?? []).length >= 4, '环形图用 dasharray 画弧')
  assert.ok(html.includes('open'), '环形图中心有未结清数')
  // 没有 onOpenTask 时（单独渲染 StatsView）同一行必须退化成不可点的样子。
  const solo = renderToStaticMarkup(React.createElement(client.StatsView, { board }))
  assert.ok(solo.includes('data-flat="1"'), '没有 onOpenTask 时行不可点')
})

await check('panel: 没有里程碑 tag 时，里程碑块整块不渲染', async () => {
  const board = collabBoard([
    { id: 'T-1', title: 'plain', status: 'in_progress', assignee: 'kimi', tags: ['ios', 'v1.42'], value: 1, created_at: ago({ d: 1 }) },
  ])
  const { store } = await renderBoard(board)
  store.setGroupBy('stats')
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(!html.includes('Milestones'), '一个里程碑 tag 都没有 → 整个块不渲染')
  assert.ok(!html.includes('v1.42.0'), '也不该有编出来的里程碑')
  // 但其它块照常。
  assert.ok(html.includes('At a glance') && html.includes('Daily flow'))
})

// T-42 第 3 条（kimi 的 T-28 遗留 nit ①）：统计页的**数据色**不许再用 brand-primary。
// 那一支在两个主题里都**不是彩色**（light ≈ 近黑 / dark ≈ 近白），拿它画状态色 / 进度条
// / sparkline 只靠明度区分（深色下几乎读不出来），而且会与 in_progress 的 LINK 蓝撞在一起。
// 换完之后统计页干脆**一处都没有** brand-primary（它只该留在边框 / 焦点 / 选中态那类
// 单色强调里），所以这条断言可以下得很硬：整个 StatsView 的渲染结果里不该出现它。
await check('T-42 · 统计页数据色：完成用宿主 success 绿，且整页不再出现 brand-primary', async () => {
  const board = collabBoard([
    { id: 'T-1', title: 'done one', status: 'done', assignee: 'dsh', value: 3, tags: ['v1.42.0'], created_at: ago({ d: 3 }) },
    { id: 'T-2', title: 'closed one', status: 'closed', assignee: 'dsh', value: 1, tags: ['v1.42.0'], created_at: ago({ d: 6 }) },
    { id: 'T-3', title: 'busy one', status: 'in_progress', assignee: 'kimi', value: 2, created_at: ago({ d: 2 }) },
    { id: 'T-4', title: 'review one', status: 'review', assignee: 'kimi', reviewer: 'dsh', created_at: ago({ d: 1 }) },
  ])
  const solo = renderToStaticMarkup(React.createElement(client.StatsView, { board }))
  // 完成 = 宿主 success 绿（两个主题同一个绿）—— 环形图的切片描边走它。
  assert.ok(/stroke:\s*var\(--dsw-alias-state-success-primary/.test(solo), '环形图的「完成」切片是宿主 success 绿')
  assert.ok(solo.includes('--dsw-alias-state-success-primary'), 'success token 真的上了页（状态色盘 / 里程碑条）')
  // 里程碑进度条的两态都是彩色：整版结清 = success 绿，还没结清 = link 蓝。
  assert.ok(/background:\s*var\(--dsw-alias-link/.test(solo), '未结清的里程碑条 / 负载条用 link 蓝')
  assert.ok(/background:\s*var\(--dsw-alias-state-success-primary/.test(solo), '整版结清的里程碑条用 success 绿')
  // 硬断言：数据页里不再有单色强调当数据色。
  assert.ok(!solo.includes('--dsw-alias-brand-primary'), 'StatsView 的渲染结果里不该再出现 brand-primary')
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

// ------------------------------------ T-29: 详情抽屉 v2（结构增强）
//
// 抽屉 v2 的三条不变量（主人 2026-10-01 指定）：
//   ① 每个动作都给「结果列」，不可用的动作**仍然列出**并说明原因；
//   ② 指派列表默认只含在场者，久未活动者必须显式展开才出现；
//   ③ 里程碑 tag 与卡面 / 统计页同一口径（同一谓词、同一字段）。
// 派生全在纯函数里（drawerActions / drawerProps / assigneeChoices /
// milestoneTags / tasksWithTag），所以下面既能断言数据、也能断言渲染。

/** 30 小时前提交、仍在待审核：review 列 SLA 24h ⇒ 必然陈旧。 */
const reviewSubmittedAt = new Date(Date.now() - 30 * 3600_000).toISOString()

/** 抽屉夹具：一张要素齐全的待审核卡 + 一个 42h 没露面的 ghost。 */
function drawerFixture() {
  const board = collabBoard([
    {
      id: 'T-1',
      title: '抽屉 v2',
      status: 'review',
      assignee: 'cc',
      reviewer: 'kimi',
      created_by: 'dsh',
      priority: 'high',
      value: 3,
      tags: ['client', 'v0.7.2', 'ui'],
      detail: Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join('\n'),
      comments: [{ at: reviewSubmittedAt, by: 'kimi', text: '看一下' }],
      log: [{ at: reviewSubmittedAt, by: 'cc', event: 'submitted' }],
    },
    { id: 'T-2', title: '同里程碑的另一张', status: 'open', tags: ['v0.7.2'] },
  ], {
    cc: { kind: 'agent', aliases: [], first_seen_at: reviewSubmittedAt, last_seen_at: new Date().toISOString() },
    // DEFAULT_QUIET_MS = 36h ⇒ 42 小时没动手 = 久未活动
    ghost: { kind: 'agent', aliases: [], first_seen_at: reviewSubmittedAt, last_seen_at: new Date(Date.now() - 42 * 3600_000).toISOString() },
  })
  return board
}

/** 抽屉属性区里的一个字段（T-74：`drawerProps` 返回「人 / 值 / 时」三组，字段在组里）。 */
function drawerField(task, board, key, now = Date.now()) {
  for (const group of client.drawerProps(task, board, now)) {
    const field = group.fields.find((row) => row.key === key)
    if (field) return field
  }
  return undefined
}

/** 渲染抽屉本身（不是整块板）：SSR 直接把 DetailDrawer 丢进去。 */
async function renderDrawer(board, taskId, actors) {
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd(board.workspace)
  await store.refresh()
  const task = store.getState().board.tasks[taskId]
  const list = actors ?? [...client.knownActors(board)]
  const html = renderToStaticMarkup(React.createElement(client.DetailDrawer, {
    task, state: store.getState(), store, actors: list, onClose: () => {},
  }))
  return { store, task, html }
}

await check('T-29 · drawerActions: 每个动作都有结果列，不可用的也给原因而不是消失', () => {
  const now = Date.now()
  const board = drawerFixture()
  const task = board.tasks['T-1']
  const rows = client.drawerActions(task, board, now)
  const by = (action) => rows.find((row) => row.action === action)

  // 九个动作一个都不少 —— 「按钮凭空消失」正是这一版要消灭的东西。
  assert.deepEqual(rows.map((row) => row.action), ['claim', 'unblock', 'start', 'submit', 'approve', 'reject', 'done', 'close', 'reopen'])
  for (const row of rows) {
    assert.ok(row.outcome && row.outcome.length > 0, `${row.action} 必须有结果列`)
    assert.ok(row.disabledReason === null || row.disabledReason.length > 0, `${row.action} 的置灰原因不能是空字符串`)
  }

  // 可执行的：结果列说清「去哪一列 + 球交给谁」（用板子自己的列名）。
  const approve = by('approve')
  assert.equal(approve.disabledReason, null)
  assert.equal(approve.tone, 'primary', '待审核的主操作是通过')
  assert.ok(approve.outcome.includes('To settle') && approve.outcome.includes('dsh'), `通过 → 待收口 · 卡主收口：${approve.outcome}`)
  const reject = by('reject')
  assert.equal(reject.disabledReason, null)
  assert.equal(reject.tone, 'plain')
  assert.ok(reject.outcome.includes('In progress') && reject.outcome.includes('cc'), `打回 → 进行中 · 负责人返工：${reject.outcome}`)
  // 关闭 = 终态动作，危险样式；failed 时也仍然说明可以 reopen 回来。
  const close = by('close')
  assert.equal(close.tone, 'danger', '关闭不是主操作，是危险动作')
  assert.ok(close.outcome.includes('Settled') && close.outcome.includes('reopen'), `关闭 → 已结清（可恢复）：${close.outcome}`)

  // 不可执行的：逐条给出「为什么现在不行」。
  assert.ok(by('claim').disabledReason.includes('already claimed by cc'), '认领：已被 cc 认领')
  assert.ok(by('unblock').disabledReason.includes('nobody is waiting on this card'), '解除等待：没人在等')
  assert.ok(by('start').disabledReason.includes('claim or assign it first'), '开始：先有负责人')
  // 无主的「进行中」是这块板封掉的死路（tests/dnd.test.mjs 同一条不变量）：
  // 池子里的卡不能给出「开始」，只能先认领/指派。
  const unowned = client.drawerActions({ ...task, assignee: null, status: 'open' }, board)
  assert.equal(unowned.find((row) => row.action === 'start').disabledReason, 'nobody owns this card yet — claim or assign it first')
  assert.equal(unowned.find((row) => row.action === 'claim').disabledReason, null, '无主的卡当然能认领')
  assert.equal(by('submit').disabledReason, 'only an “In progress” card can be submitted (now: In review)')
  assert.ok(by('reopen').disabledReason.includes('only a done or settled card can be reopened'), '重开：只有做完的卡能重开')
})

await check('T-29 · drawerActions: 已收口的卡只剩重开可用，且「收口结清」是主操作', () => {
  const board = drawerFixture()
  const closed = { ...board.tasks['T-1'], status: 'closed' }
  const closedRows = client.drawerActions(closed, board)
  assert.deepEqual(closedRows.filter((row) => row.disabledReason === null).map((row) => row.action), ['reopen'])
  assert.ok(closedRows.find((row) => row.action === 'close').disabledReason.includes('already settled'), '已结清不会再关一次')

  const done = client.drawerActions({ ...board.tasks['T-1'], status: 'done' }, board)
  const settle = done.find((row) => row.action === 'close')
  assert.equal(settle.label, 'Settle (close)', 'done 上 close 就是收口，措辞跟着阶段走')
  assert.equal(settle.tone, 'primary', 'done 上收口是主操作，不是危险动作')
  assert.equal(settle.disabledReason, null)
})

await check('T-50 · 等待中的卡被 start：结果列必须说明「等待仍在」', () => {
  const board = drawerFixture()
  const base = board.tasks['T-1']
  // 一张「已指派 + 正在等某人」的卡：host 的 `start` **不清** `waiting_on`
  // （src/host/store.ts 只让 submit/approve/reject/done/close/reopen/unblock 清），
  // 所以它照常落到 in_progress，而那次等待照样在 —— 面板必须把这件事说出来，
  // 否则读的人会以为"开始"顺手把等待解掉了（T-29 ③ 的遗留）。
  const waiting = {
    ...base,
    status: 'open',
    assignee: 'cc',
    reviewer: null,
    waiting_on: { kind: 'agent', who: 'kimi', question: 'T-3 审计结论能给我吗？', since: new Date().toISOString() },
  }
  const startOf = (task) => client.drawerActions(task, board).find((row) => row.action === 'start')

  const row = startOf(waiting)
  assert.equal(row.disabledReason, null, '等待不拦「开始」：start 仍可用（host 语义就是如此）')
  assert.ok(row.outcome.includes('In progress'), `仍要说清落到哪一列：${row.outcome}`)
  assert.match(row.outcome, /the wait is still on \(kimi\)/, `结果列要点明等待仍在：${row.outcome}`)

  // 无名等待（who === null）退化成 kind 措辞，而不是把 null 渲染进文案。
  const anon = startOf({ ...waiting, waiting_on: { kind: 'human', who: null, question: '发不发？', since: new Date().toISOString() } })
  assert.match(anon.outcome, /the wait is still on \(a human\)/, `无名等待也要能读：${anon.outcome}`)
  assert.ok(!anon.outcome.includes('null'), '不许把 null 渲染进文案')

  // 没有等待的卡：措辞保持原样（不许给每张卡都挂一句"等待仍在"）。
  const plain = startOf({ ...waiting, waiting_on: null })
  assert.ok(!plain.outcome.includes('wait'), `没有等待时结果列不许提等待：${plain.outcome}`)
})

await check('T-29 · 指派列表：默认只含在场者，久未活动者要显式展开才出现', async () => {
  const now = Date.now()
  const board = drawerFixture()
  const actors = [...client.knownActors(board), 'ghost']
  const choices = client.assigneeChoices(board, actors, null, now)

  assert.deepEqual(choices.quiet.map((choice) => choice.name), ['ghost'], '42h 没动手 = 久未活动')
  assert.ok(!choices.present.some((choice) => choice.name === 'ghost'), '久未活动者不在默认列表里')
  assert.equal(choices.quiet[0].quiet, true)
  assert.ok(/last seen/.test(choices.quiet[0].seenText), `带「最近活动 X 前」：${choices.quiet[0].seenText}`)
  assert.match(choices.present.find((choice) => choice.name === 'cc').seenText, /^last seen \d+m ago$/, '在场者也有最近活动，只是不渲染琥珀点')

  // 当前负责人永远列出（哪怕它久未活动）：藏着负责人 = 藏着问题。
  const asCurrent = client.assigneeChoices(board, actors, 'ghost', now)
  const ghost = asCurrent.present.find((choice) => choice.name === 'ghost')
  assert.ok(ghost && ghost.current && ghost.quiet, '久未活动者若是当前负责人，仍在默认列表里并带标记')
  assert.equal(asCurrent.quiet.length, 0)

  // 渲染层面（T-74 新形态）：成员列表默认**收起** —— 默认 HTML 里一行成员都没有
  // （在场者也没有），久未活动的 ghost 更不在；「展开」就是那次点击本身。
  const { html } = await renderDrawer(board, 'T-1', actors)
  assert.ok(!html.includes('ghost'), '默认不渲染久未活动者')
  assert.equal((html.match(/tb-picker-row/g) ?? []).length, 0, '成员列表默认收起（一行都不渲染）')
  assert.match(html, /Current: <span[^>]*>cc<\/span>/, '那一行说的是「当前：<谁>」，不是一串成员')
  assert.ok(html.includes('>Change<'), '有成员时给一个展开式 combobox 触发器')
  assert.ok(html.includes('Back to pool'), '「移回待认领」是同一行右侧的小号次操作')
})

await check('T-74 · 指派压成一行：当前值 + combobox 触发器 + 移回待认领（不再逐个成员占行）', async () => {
  const now = Date.now()
  const board = drawerFixture()
  const actors = [...client.knownActors(board), 'ghost']

  // 纯函数仍然给出「在场 / 久未活动」两分（展开后按这个顺序排：在场者在前）。
  const choices = client.assigneeChoices(board, actors, 'cc', now)
  assert.deepEqual(choices.quiet.map((choice) => choice.name), ['ghost'])
  assert.deepEqual([...choices.present, ...choices.quiet].map((choice) => choice.name).sort(), ['cc', 'dsh', 'ghost', 'kimi'])

  // 0.8.0 那一串东西一个都不能在默认 DOM 里：过滤输入框 / 成员行 / 「显示全部」开关。
  const claimed = await renderDrawer(board, 'T-1', actors)
  assert.ok(!/Search members/.test(claimed.html), '过滤输入框默认不在 DOM 里')
  assert.ok(!/Show all \(1 quiet\)/.test(claimed.html), '「显示全部」不再是一行开关')
  assert.equal((claimed.html.match(/tb-picker-row/g) ?? []).length, 0, '成员行默认一行都不渲染')

  // 未指派：那一行如实说「待认领」，触发器改口叫「指派」（不是「更换」）。
  const pool = { ...board.tasks['T-1'], assignee: null }
  const poolBoard = { ...board, tasks: { ...board.tasks, 'T-1': pool } }
  const unclaimed = await renderDrawer(poolBoard, 'T-1', actors)
  assert.match(unclaimed.html, /Current: <span[^>]*>— \(unclaimed\)<\/span>/, '未指派时如实说「待认领」')
  assert.ok(unclaimed.html.includes('>Assign<'), '未指派时触发器说的是「指派」而不是「更换」')
  assert.ok(unclaimed.html.includes('tb-assign-line'), '那一行有稳定的类名')
  assert.ok(unclaimed.html.includes('Back to pool'), '「移回待认领」还在（置灰），不独占一行')

  const nobody = await renderDrawer(poolBoard, 'T-1', [])
  assert.ok(!nobody.html.includes('>Assign<'), '没有可指派成员就不给触发器')
  assert.ok(nobody.html.includes('No assignable members yet'), '没有成员时说明为什么')
})

await check('T-29 · 里程碑 tag 与卡面 / 统计页同一口径', async () => {
  const board = drawerFixture()
  const task = board.tasks['T-1']

  // 同一谓词（stats.ts 的 isMilestoneTag）、同一来源（卡面的 task.tags）。
  assert.deepEqual(client.milestoneTags(task), task.tags.filter((tag) => client.isMilestoneTag(tag)))
  assert.deepEqual(client.milestoneTags(task), ['v0.7.2'], '不是 vX.Y.Z 的 tag 不是里程碑')

  const row = drawerField(task, board, 'milestone')
  assert.equal(row.value, 'v0.7.2', '属性区的里程碑只列里程碑 tag')
  assert.ok(!row.value.includes('ui') && !row.value.includes('client'), '普通 tag 不会混进里程碑')

  // 就地列出同标签的卡：口径与统计页 milestones() 的 ids 完全一致。
  const viaTag = client.tasksWithTag(board, 'v0.7.2').map((row) => row.id).sort()
  const viaMilestone = client.milestones(board).find((stone) => stone.tag === 'v0.7.2').ids.slice().sort()
  assert.deepEqual(viaTag, viaMilestone)
  assert.deepEqual(viaTag, ['T-1', 'T-2'])
  // 空格容错：` v0.7.2 ` 与 `v0.7.2` 是同一个 tag（与 milestones() 一样先 trim）。
  assert.deepEqual(client.tasksWithTag(board, '  v0.7.2  ').map((row) => row.id).sort(), ['T-1', 'T-2'])
})

await check('T-74 · 属性区分组：人 / 值 / 时 三行，字段仍是 0.8.0 那些（只有两处真重复被去掉）', () => {
  const now = Date.now()
  const board = drawerFixture()
  const task = board.tasks['T-1']
  const groups = client.drawerProps(task, board, now)

  // 顺序与行首标签都是规格的一部分（宽时一行、窄时折行，但行的语义不变）。
  assert.deepEqual(groups.map((group) => group.key), ['people', 'values', 'time'])
  assert.deepEqual(groups.map((group) => group.label), ['Who', 'What', 'When'])
  for (const group of groups) {
    assert.ok(group.fields.length > 0, `${group.key} 不能是空行`)
    for (const field of group.fields) {
      assert.ok(field.label && field.value !== undefined, `${field.key} 必须形如「标签 值」—— 去掉标签三个名字并排会歧义`)
    }
  }

  // 0.8.0 的 10 个字段键，去掉的**只有**那两处真重复（status / age）。
  const keys = groups.flatMap((group) => group.fields.map((field) => field.key))
  // 这张 fixture 的卡在 review 列待了 30h > 24h SLA ⇒ 末尾多一个条件字段「已超时」。
  assert.deepEqual(keys, ['assignee', 'reviewer', 'holder', 'priority', 'value', 'milestone', 'created', 'column', 'overdue'])
  for (const gone of ['status', 'age']) {
    assert.ok(!keys.includes(gone), `「${gone}」是同一事实的第二个出口，已并入「当前列」`)
  }
  // 值仍在别处：状态与列龄都在「当前列」的值里（`状态 列龄`），一个都没少。
  const column = drawerField(task, board, 'column', now)
  assert.equal(column.value, `In review ${client.ageLabel(client.stalenessOf(task, now).ageMs)}`)
  assert.match(column.value, /^In review \d/, `状态 + 列龄同值：${column.value}`)

  // 人 / 值 / 时 的分工（字段落在正确的行里）。
  const groupOf = (key) => groups.find((group) => group.fields.some((field) => field.key === key)).key
  assert.equal(groupOf('assignee'), 'people')
  assert.equal(groupOf('reviewer'), 'people')
  assert.equal(groupOf('holder'), 'people')
  assert.equal(groupOf('priority'), 'values')
  assert.equal(groupOf('value'), 'values')
  assert.equal(groupOf('milestone'), 'values')
  assert.equal(groupOf('created'), 'time')
  assert.equal(groupOf('column'), 'time')
})

await check('T-29 · 属性区：值可复制、列龄沿用同一个 stalenessOf、warn 不丢', () => {
  const now = Date.now()
  const board = drawerFixture()
  const task = board.tasks['T-1']
  const by = (key) => drawerField(task, board, key, now)

  for (const key of ['priority', 'value', 'assignee', 'reviewer', 'holder', 'created', 'column', 'milestone']) {
    assert.ok(by(key), `属性区缺 ${key}`)
  }
  assert.equal(by('assignee').copy, 'cc', '负责人可复制')
  assert.equal(by('created').copy, task.created_at, '创建时间可复制的是 ISO 原文，不是「30 小时前」')
  assert.equal(by('reviewer').copy, 'kimi')
  assert.equal(by('holder').copy, 'kimi', '待审核时持球人 = 裁决人')

  // 列龄 / 陈旧标记与卡面读同一个 stalenessOf（同一个 now 必须得出同一个数）。
  const stale = client.stalenessOf(task, now)
  assert.equal(stale.stale, true, '待审核 30h > 24h SLA')
  assert.equal(by('column').copy, client.ageLabel(stale.ageMs), '列龄仍可复制（并入「当前列」）')
  // T-74：warn 从被删掉的「列龄」行搬到独立的「已超时」字段 —— 记号与阈值说明都还在。
  const overdue = by('overdue')
  assert.ok(overdue, '超 SLA 必须有自己的字段')
  assert.equal(overdue.warn, true, '陈旧必须在属性区显形')
  assert.equal(overdue.label, 'Overdue')
  assert.equal(overdue.value, '⚠')
  assert.match(overdue.title, /past its 1d threshold/, `阈值说明在 title 里：${overdue.title}`)

  // 不陈旧时这个字段**根本不存在**（不是空着）—— 属性区因此不会为正常卡拉长一行。
  const fresh = { ...task, status: 'in_progress', updated_at: new Date().toISOString() }
  assert.equal(drawerField(fresh, board, 'overdue', now), undefined, '没过 SLA 就没有「已超时」字段')
  assert.equal(drawerField(fresh, board, 'column', now).copy, client.ageLabel(client.stalenessOf(fresh, now).ageMs))
})

await check('T-74 · 属性区渲染：四行语义行 + 「标签 值」成对出现 + 标签药丸还能筛', async () => {
  const board = drawerFixture()
  const { html } = await renderDrawer(board, 'T-1')

  // 四行：人 / 值 / 时 / 标签（0.8.0 是 11 行属性 + 1 行标签）。
  assert.equal((html.match(/tb-prop-line/g) ?? []).length >= 4, true, '至少四条 tb-prop-line')
  assert.ok(!/tb-prop-row/.test(html), '0.8.0 的一行一个字段没了')
  for (const label of ['Who', 'What', 'When', 'Tags']) {
    assert.ok(html.includes(`>${label}<`), `行首标签「${label}」在页面上`)
  }
  // 字段形如「标签 值」：标签一个都不能少（三个名字并排无标签会歧义）。
  for (const label of ['Owner', 'Reviewer', 'Holder', 'Priority', 'Value', 'Milestone', 'Created', 'In column']) {
    assert.ok(html.includes(`>${label}<`), `字段标签「${label}」在页面上`)
  }
  assert.ok(html.includes('tb-prop-field') && html.includes('tb-prop-fields'), '字段排成会折行的流')
  // 值仍可复制（值本身就是按钮）。
  assert.ok(html.includes('tb-prop-copy'), '可复制的值仍是按钮')
  // 标签仍是药丸按钮，且**没有**被折进动作区。
  assert.ok(html.includes('tb-tag-btn') && html.includes('tb-tagline'), '标签渲染成可点的药丸')
  assert.ok(html.includes('client') && html.includes('ui'), '普通 tag 也在标签行里')
})

await check('T-29 · 抽屉渲染：结果列 / 置灰原因 / 两个 tab 的计数都在页面上', async () => {
  const board = drawerFixture()
  const { html } = await renderDrawer(board, 'T-1')

  assert.ok(html.includes('into “To settle” · dsh owes the settle'), '通过 的结果列渲染出来了')
  assert.ok(html.includes('back to “In progress” · cc reworks'), '打回 的结果列渲染出来了')
  assert.ok(html.includes('only an “In progress” card can be submitted'), '不可用动作的原因渲染出来了')
  assert.ok(html.includes('already claimed by cc'), '认领不可用的原因渲染出来了')
  // T-74：置灰分组收成一行 disclosure（「暂不可用」标题 + 逐条原因仍在 DOM 里）。
  const blockedCount = client.drawerActions(board.tasks['T-1'], board).filter((row) => row.disabledReason !== null).length
  assert.ok(html.includes(`${blockedCount} action(s) not available now`), `置灰分组有一行 disclosure + 数量（${blockedCount}）`)
  assert.ok(html.includes('aria-expanded="false"'), '默认是折起的')
  assert.ok(/<div hidden=""/.test(html), '原因列表默认 hidden（不是删掉）')
  // 九个动作一个都没消失：能按的在胶囊行里，不能按的逐条在（默认折起的）DOM 里。
  const actionRows = client.drawerActions(board.tasks['T-1'], board)
  assert.equal((html.match(/tb-action-row/g) ?? []).length, actionRows.filter((row) => row.disabledReason !== null).length, '置灰动作逐条仍在 DOM 里')
  for (const row of actionRows) {
    assert.ok(html.includes(`>${row.label}<`), `${row.action}（${row.label}）的入口还在页面上`)
  }

  // 两个 tab 都带计数（主人只要计数，不要合并成一条时间线）。
  assert.ok(html.includes('Comments (1)'), '评论 tab 带计数')
  assert.ok(html.includes('Activity (1)'), '动态 tab 也带计数')
  assert.ok(html.includes('Details'), '详情 tab 还在 —— 三个 tab 没有合并')

  // 描述默认折叠 + 展开出路。
  assert.ok(html.includes('Show all'), '长描述给出展开')
})

await check('T-29 · 小派生：未读动态计数与描述折叠阈值', () => {
  assert.equal(client.unseenActivity(4, 4), 0)
  assert.equal(client.unseenActivity(6, 4), 2)
  assert.equal(client.unseenActivity(2, 4), 0, '日志被截断也不能出负数')
  assert.equal(client.detailNeedsFold(''), false)
  assert.equal(client.detailNeedsFold('一行\n两行\n三行'), false)
  assert.equal(client.detailNeedsFold(Array.from({ length: 8 }, (_, i) => `第 ${i} 行`).join('\n')), true, '超过 6 行要折叠')
  assert.equal(client.detailNeedsFold('x'.repeat(400)), true, '超长单行也要折叠')
})

// ------------------------------------------------------------- 0.7.3 (T-35)
// The two cleanups and the「关于」popover. The CSS / dead-key checks read the
// SOURCE (a stylesheet rule and the absence of an identifier are not observable
// from the bundle: TB_CSS is a string and inline styles are object keys); the
// rest is behavior/SSR against the real bundle.

/** The declaration block of one selector inside TB_CSS ('' when absent). */
function cssRule(css, selector) {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return ''
  return css.slice(at, css.indexOf('}', at)).replace(/\s+/g, '')
}

await check('T-35 · theme: every 10px pill truncates instead of spilling out of its border', () => {
  const css = client.TB_CSS
  // The reported defect (kimi's T-20 review): a long actor name visually
  // overflowed the dashed outline of `.tb-badge-outline` and the lane clipped
  // it mid-glyph — it read as broken layout rather than「the name is long」.
  const outline = cssRule(css, '.tb-badge-outline')
  assert.ok(outline, '.tb-badge-outline is still a rule in the sheet')
  for (const decl of ['max-width:100%', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']) {
    assert.ok(outline.includes(decl), `.tb-badge-outline carries ${decl}`)
  }
  // The same audit applied to its siblings: all four text pills must ellipsize.
  for (const selector of ['.tb-badge', '.tb-badge-wait', '.tb-tag']) {
    assert.ok(cssRule(css, selector).includes('text-overflow:ellipsis'), `${selector} ellipsizes`)
  }
  // The「关于」popover's link rows hover via the sheet (inline styles cannot
  // express :hover) and they must hover on a host token, not a hardcoded colour.
  assert.ok(cssRule(css, '.tb-about-link:hover').includes('background:var(--dsw-alias'), 'the about link hovers on a host token')
})

await check('T-76 · TB_CSS 的骨架必须合法：注释之外、每个 `{` 之前只能是选择器', () => {
  // 这条来自一次**真机才发现**的事故（T-76 自查）：把一段注释文字写在了 `*/` 之后，
  // CSS 解析器从错处一路跳到下一个 `}`，于是紧跟着的 `.tb-card-wait` 整条规则被吃掉
  // —— 左侧竖条在页面上根本不存在。tsc 不检查模板串里的 CSS，而"字符串里包含
  // var(--dsw-alias-link)"这种断言照样绿（它查的是文本，不是生效的规则）⇒ 需要一条
  // 查**结构**的判据。
  const css = client.TB_CSS
  // 选择器允许出现的字符（宿主的选择器都是类/属性/伪类/逗号/后代/通配/at-rule）。
  const SELECTOR = /^[\s.,#:\[\]()@%a-zA-Z0-9_\-*>+~="'|^$]*$/
  const chunks = css.split('*/')
  for (let i = 1; i < chunks.length; i += 1) {
    const after = chunks[i].slice(0, chunks[i].indexOf('{') === -1 ? chunks[i].length : chunks[i].indexOf('{'))
    assert.ok(SELECTOR.test(after), `注释结束后到下一个 { 之间只能是选择器，实际：${JSON.stringify(after.trim().slice(0, 60))}`)
  }
  // 花括号必须配平（错位的注释会把整条规则连花括号一起吞掉，剩下一个孤儿的 }）。
  let depth = 0
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    assert.ok(depth >= 0, '出现了多余的 }')
  }
  assert.equal(depth, 0, '去掉注释之后花括号必须配平')
})

await check('T-76 · 颜色纪律：⏳「等你决定」用主色蓝 + 矩形，绝不与琥珀「已超时」混同', () => {
  const css = client.TB_CSS
  const you = cssRule(css, '.tb-badge-you')
  const overdue = cssRule(css, '.tb-badge-wait')
  const cardWait = cssRule(css, '.tb-card-wait')
  assert.ok(you && overdue && cardWait, '三条规则都在样式表里')

  // ① 颜色：一个是 link 蓝（两个主题下都是蓝），一个是 WARN 琥珀 —— 不是同一个 token。
  assert.ok(you.includes('var(--dsw-alias-link'), `「等你决定」用主色蓝：${you}`)
  assert.ok(!you.includes('state-warn'), '「等你决定」绝不能用 WARN 琥珀 —— 那会让"超时"与"等你"在扫视时等价')
  assert.ok(overdue.includes('var(--dsw-alias-state-warn-primary'), '「已超时」仍然是琥珀（这条没被动过）')
  assert.notEqual(you.split('color:')[1].split(';')[0], overdue.split('color:')[1].split(';')[0], '两枚徽章的前景色是两个不同的 token')

  // ② 形状：实心矩形 vs 描边胶囊 —— 形状差异让两种事在**不看颜色**时也分得开。
  assert.ok(you.includes('border-radius:5px'), `「等你决定」是 5px 圆角矩形：${you}`)
  assert.ok(!you.includes('border-radius:999px'), '不是胶囊')
  assert.ok(overdue.includes('border-radius:999px'), '「已超时」仍是胶囊')
  assert.ok(overdue.includes('border:1pxsolid'), '而且是描边（空心），与实心蓝进一步区分')

  // ③ 左侧竖条同样是主色，而不是琥珀 —— 竖条是「等你决定」独有的记号。
  // 竖条必须用 **蓝**（link），不能是 ACCENT —— ACCENT 是宿主的反相单色（浅色下近黑、
  // 深色下近白），做主色会被读成"选中"而不是"等你"。
  assert.ok(cardWait.includes('var(--dsw-alias-link'), `竖条用蓝（link）：${cardWait}`)
  assert.ok(!cardWait.includes('brand-primary'), '竖条不能落在反相单色的 brand-primary 上')
  assert.ok(!cardWait.includes('state-warn'), '竖条不能是琥珀色')
  assert.ok(cssRule(css, '.tb-card-flash').includes('var(--dsw-alias-link'), '「跳过去」的高亮也是同一个蓝')

  // ④ active（选中）与 wait（等你）同时命中时，两条 box-shadow 必须显式合并 ——
  //    否则后写的那条会把前一条吃掉（选中环或竖条凭空消失）。
  assert.ok(cssRule(css, '.tb-card.active.tb-card-wait').includes('inset3px00'), '两个状态同时命中时合并声明')
})

await check('T-35 · the three dead style keys are gone (1 definition / 0 references)', () => {
  const boardSrc = readFileSync(new URL('../src/client/BoardPanel.tsx', import.meta.url), 'utf8')
  // cardSep / reviewerBadge / cardWaitAge were dead BEFORE this release (T-29
  // left them behind to keep that diff small). The styles object is
  // module-private, so「deleted」can only be asserted on the source — which is
  // also the only place a resurrected reference could appear.
  for (const key of ['cardSep', 'reviewerBadge', 'cardWaitAge']) {
    assert.ok(!boardSrc.includes(key), `dead style key「${key}」is gone`)
  }
  // …and the keys that took over their job are still declared AND referenced.
  for (const key of ['cardWait', 'cardHoldMark', 'cardHoldAge']) {
    assert.ok(boardSrc.split(key).length > 2, `「${key}」is still declared and referenced`)
  }
})

await check('T-35 · about: the version falls back to `dev` when the build did not inject one', () => {
  assert.equal(typeof client.aboutVersion, 'function')
  // The fallback is the safety net for a build that forgot the `define`: the
  // panel must print `dev`, never an empty chip or `undefined`.
  assert.equal(client.aboutVersion(undefined), 'dev')
  assert.equal(client.aboutVersion(null), 'dev')
  assert.equal(client.aboutVersion(''), 'dev')
  assert.equal(client.aboutVersion('   '), 'dev')
  assert.equal(client.aboutVersion(42), 'dev')
  assert.equal(client.aboutVersion(' 0.9.9 '), '0.9.9', 'a real version is trimmed and kept')
  assert.equal(client.aboutVersionLabel('dev'), 'dev', 'the fallback is not prefixed into「vdev」')
  assert.equal(client.aboutVersionLabel('0.7.3'), 'v0.7.3')

  // The bundle under test WAS built by scripts/build.mjs, which injects
  // package.json's version — so the injected path is covered too, and a dropped
  // `define` shows up here as 'dev' instead of the version.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(client.TB_VERSION, pkg.version, 'the bundle carries package.json version')
})

await check('T-35 · about: the four GitHub entries are the real URLs with zh/en labels', () => {
  const links = client.aboutLinks()
  assert.deepEqual(links.map((row) => row.key), ['repo', 'issues', 'collab', 'changelog'])
  assert.equal(client.REPO_URL, 'https://github.com/ice5kysl/dsh-taskboard-kit')
  assert.equal(links[0].href, client.REPO_URL)
  assert.equal(links[1].href, `${client.REPO_URL}/issues/new`, 'issue filing goes straight to the new-issue form')
  // The collaboration spec is a FILE IN THE REPO, not the npm page.
  assert.equal(links[2].href, `${client.REPO_URL}/blob/main/docs/COLLABORATION.md`)
  assert.equal(links[3].href, `${client.REPO_URL}/blob/main/README.md#release-notes`, 'release notes use the stable anchor')
  for (const row of links) {
    assert.match(row.href, /^https:\/\/github\.com\//, `${row.key} points at GitHub`)
    assert.ok(row.label.length > 0 && row.hint.length > 0, `${row.key} has a label and a hint`)
  }

  // The transparency block is a pure function: it names the real file and the
  // real counts (no server, no cloud — the numbers come from the live board).
  const facts = client.aboutFacts({ boardFile: null, cwd: '/work/a', tasks: 41, roster: 23, boardVersion: 7, pluginId: client.PLUGIN_ID })
  assert.deepEqual(facts.map((row) => row.key), ['file', 'tasks', 'actors', 'format', 'plugin'])
  assert.equal(facts[0].value, '/work/a/.dsh/taskboard.json', 'no board_file from the host → the convention path')
  assert.equal(facts[1].value, '41')
  assert.equal(facts[2].value, '23')
  assert.equal(facts[3].value, 'v7', 'board.version is the data-format version')
  assert.equal(facts[4].value, 'dsh-taskboard-kit')
  assert.equal(
    client.aboutFacts({ boardFile: '/x/.dsh/taskboard.json', cwd: '/work/a', tasks: 0, roster: 0, boardVersion: null, pluginId: client.PLUGIN_ID })[0].value,
    '/x/.dsh/taskboard.json',
    'the host-reported path wins over the convention',
  )
})

await check('T-35 · about: the ⓘ overlay renders version, facts and 5× target=_blank rel=noreferrer', async () => {
  const board = collabBoard([
    { id: 'T-1', title: 'pool one', status: 'open', assignee: null },
    { id: 'T-2', title: 'wip one', status: 'in_progress', assignee: 'kimi' },
  ])
  const store = client.createTaskboardStore({
    bridge: { board: async () => ({ ok: true, board, board_file: '/work/a/.dsh/taskboard.json' }) },
    pollMs: 10 ** 9,
  })
  store.setCwd(board.workspace)
  await store.refresh()
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store, initialAboutOpen: true }))

  // Identity: the plugin id, the build-injected version, the one-sentence intro.
  assert.ok(html.includes(`v${client.TB_VERSION}`), 'the injected version is shown as vX.Y.Z')
  assert.ok(html.includes(client.aboutTagline()), 'the tagline is rendered')
  assert.ok(html.includes('dsh-taskboard-kit'), 'the plugin id is named')

  // Local transparency — read each fact row as「label then value」so a passing
  // assertion cannot come from an unrelated count elsewhere on the board.
  const factRow = (label) => {
    const at = html.indexOf(`>${label}</span>`)
    return at < 0 ? '' : html.slice(at, at + 400)
  }
  assert.ok(factRow('Board file').includes('>/work/a/.dsh/taskboard.json</span>'), 'the real board file path is on screen')
  assert.ok(factRow('Cards').includes('>2</span>'), 'card count = the fixture’s 2 tasks')
  assert.equal(factRow('Roster').includes(`>${Object.keys(board.actors).length}</span>`), true, 'roster size = the board.actors roster')
  assert.ok(factRow('Data format').includes('>v1</span>'), 'board.version')
  assert.ok(factRow('Plugin id').includes('>dsh-taskboard-kit</span>'), 'plugin id')
  assert.ok(html.includes('Local transparency'), 'the transparency block has a heading')

  // Four outbound links + the author: all of them new-tab and referrer-free.
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 5, 'four links + the author open in a new tab')
  assert.equal((html.match(/rel="noreferrer"/g) ?? []).length, 5, 'and every one of them carries rel=noreferrer')
  for (const url of [client.REPO_URL, client.ISSUES_URL, client.COLLAB_URL, client.CHANGELOG_URL]) {
    assert.ok(html.includes(`href="${url}"`), `href is rendered verbatim: ${url}`)
  }
  assert.ok(html.includes('MIT'), 'the licence is stated')
  assert.ok(html.includes(client.AUTHOR), 'the author is named')
  assert.ok(html.includes('role="dialog"'), 'it renders as a dialog')

  // …and nothing of it is in the markup while ⓘ has never been opened.
  const shut = renderToStaticMarkup(React.createElement(client.BoardPanel, { store }))
  assert.ok(!shut.includes(client.aboutTagline()), 'ⓘ closed → no overlay in the markup')
})

await check('T-35 · mini drawer: one holder line per row (mark + name), not three stacked badges', async () => {
  const now = Date.now()
  const iso = (ms) => new Date(now - ms).toISOString()
  const mk = (id, title, status, over) => ({
    id, title, detail: '', status, assignee: null, priority: 'medium', value: null,
    tags: [], created_by: 'human', created_at: iso(3600_000), updated_at: iso(60_000),
    log: [], comments: [], reviewer: null, waiting_on: null, ...over,
  })
  const board = {
    version: 1, workspace: '/work/a', next_seq: 8,
    actors: {
      dsh: { kind: 'agent', aliases: [], first_seen_at: iso(9 * 24 * 3600_000), last_seen_at: iso(60_000) },
      kimi: { kind: 'agent', aliases: [], first_seen_at: iso(9 * 24 * 3600_000), last_seen_at: iso(120_000) },
      iceskysl: { kind: 'human', aliases: [], first_seen_at: iso(9 * 24 * 3600_000), last_seen_at: iso(300_000) },
    },
    tasks: {
      'T-1': mk('T-1', 'pool one', 'open'),
      'T-2': mk('T-2', 'wip one', 'in_progress', { assignee: 'kimi' }),
      'T-3': mk('T-3', 'review one', 'review', { assignee: 'kimi', reviewer: 'dsh' }),
      'T-4': mk('T-4', 'done one', 'done', { assignee: 'kimi' }),
      'T-5': mk('T-5', 'parked one', 'in_progress', {
        assignee: 'kimi',
        waiting_on: { kind: 'human', who: 'iceskysl', question: '哪一版？', since: iso(3600_000) },
      }),
    },
  }
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd(board.workspace)
  await store.refresh()
  store.setMiniOpen(true)
  const html = renderToStaticMarkup(React.createElement(client.MiniBoardDrawer, { store }))
  // The row as a reader sees it: strip the markup between the mark and the name.
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

  // ONE derivation (currentHolder) drives the row, exactly like the card:
  //   ➤ work · ○ claim/pool · ⚑ decide · ⌂ settle · ◷ answer/reply.
  assert.ok(text.includes('➤ kimi'), 'in_progress + assignee → ➤ kimi')
  assert.ok(text.includes('⚑ dsh'), 'review → ⚑ the reviewer')
  assert.ok(text.includes('⌂ human'), 'done → ⌂ the creator (settle)')
  assert.ok(text.includes('○ the pool'), 'unclaimed → ○ the pool')
  assert.ok(text.includes('◷ iceskysl'), 'parked on a person → ◷ who must answer')
  // The old per-field badges are gone: no separate reviewer / assignee chips.
  assert.ok(!text.includes('review dsh'), 'the「review X」badge is gone')
  assert.ok(!text.includes('unclaimed'), 'the「unclaimed」badge is gone')
  // A waiting row keeps the amber outline (it must not look like ordinary work).
  assert.ok(html.includes('tb-badge-wait'), 'the parked row rides the amber wait chip')
  // Strictly one line: the row is a nowrap flex line, and the name ellipsizes
  // inside the chip (an inline-flex container's text-overflow cannot reach the
  // child, so the child carries its own).
  assert.match(client.TB_CSS, /\.tb-mini-row \{[^}]*display:\s*flex/)
  assert.ok(!/\.tb-mini-row \{[^}]*flex-wrap/.test(client.TB_CSS), 'the mini row never wraps')
  assert.ok(html.includes('text-overflow:ellipsis'), 'the holder name ellipsizes inside the chip')
  // The tooltip leads with the owed action (holderActionLabel) — the one place
  // those words survive, since the lane header already names the status.
  assert.ok(html.includes(`title="${client.holderActionLabel('work')} · `), 'the tooltip leads with the owed action (holderActionLabel)')
})

// ============================================ 导航区重构（T-38, 方案 B）
// 卡上的三件必修：① 「含已关闭」常驻（切视角时不再凭空多/少一个控件）② 三个图标
// 换成同一种度量的内联 SVG ③ 动作与信息分开（刷新不再夹在指南和关于中间）。
//
// 这里钉住的是**纯函数与 SSR 能钉住的**部分：三档边界、每一档在位的控件集合、
// 图标是 SVG 而不是文本字形、组内/组间与外壳常量、`⋯` 接进既有 Esc 分层。
// 伪类（hover / focus-visible / 按下 50ms 反馈）与"宽度真的驱动降级"（ResizeObserver
// 量容器）只能在真浏览器里验：.probe-ui/preview5-toolbar.mjs + toolbar-*.png。

/** 渲染一块板的面板，并把工具栏那段（<header>…</header>）切出来。 */
async function toolbarHeaderOf(board, props = {}) {
  const store = client.createTaskboardStore({ bridge: { board: async () => ({ ok: true, board }) }, pollMs: 10 ** 9 })
  store.setCwd(board.workspace)
  await store.refresh()
  const html = renderToStaticMarkup(React.createElement(client.BoardPanel, { store, ...props }))
  const at = html.indexOf('<header')
  const end = html.indexOf('</header>')
  return { store, html, header: at < 0 || end < 0 ? '' : html.slice(at, end + '</header>'.length) }
}

await check('T-38 · toolbarModeFor: 三档边界是纯函数，阈值就是常量', () => {
  assert.deepEqual([client.TOOLBAR_FULL_MIN, client.TOOLBAR_COMPACT_MIN], [720, 520])
  assert.equal(client.toolbarModeFor(1600), 'full')
  assert.equal(client.toolbarModeFor(720), 'full', '720 是 full 的下界（含）')
  assert.equal(client.toolbarModeFor(719.9), 'compact', '差一点就降一档')
  assert.equal(client.toolbarModeFor(520), 'compact', '520 是 compact 的下界（含）')
  assert.equal(client.toolbarModeFor(519.9), 'menu', '<520 进 menu')
  assert.equal(client.toolbarModeFor(360), 'menu', '极窄仍是 menu，掉不出三档')
  assert.equal(client.toolbarModeFor(0), 'menu', '0（还没布局）算最窄 —— 调用方另行拦掉它')
  // 量不到宽度不猜窄：猜窄会把宽面板画成窄的（收走可点的东西），猜宽只是多几个字。
  for (const bad of [NaN, Infinity, -Infinity, undefined, null]) {
    assert.equal(client.toolbarModeFor(bad), 'full', `${String(bad)} → full`)
  }
})

await check('T-38 · toolbarPlanFor: 身份段按「路径 → 计数 → 标题」的优先级收，chip 文字只活到 compact', () => {
  assert.deepEqual([...client.TOOLBAR_IDENTITY_DROP_ORDER], ['path', 'count', 'title'])
  const full = client.toolbarPlanFor('full')
  assert.deepEqual([...full.identity], ['title', 'path', 'count'], 'full 三段齐全，DOM 序仍是 标题→路径→计数')
  assert.equal(full.chipLabel, true)
  assert.equal(full.toolsInMenu, false)
  const compact = client.toolbarPlanFor('compact')
  assert.deepEqual([...compact.identity], ['title'], 'compact 先舍路径、再舍计数，只留标题')
  assert.equal(compact.chipLabel, false, 'compact 起 chip 只留方框（文字进 tooltip）')
  assert.equal(compact.toolsInMenu, false, 'compact 还没到进 ⋯ 的地步')
  const menu = client.toolbarPlanFor('menu')
  assert.deepEqual([...menu.identity], [], 'menu 连标题都收')
  assert.equal(menu.toolsInMenu, true)
  assert.equal(menu.viewsInMenu, false, '量不到宽度时不搬视图组（只往"留在行里"这边猜）')

  // 极窄档（<360）：视图组**搬进 ⋯**（不是删掉）—— 行里只剩主操作 + ⋯，与卡片的
  // 边界要求一致，同时窄面板上仍然换得了视角。
  assert.equal(client.TOOLBAR_VIEWS_MIN, 360)
  for (const [width, expected] of [[320, true], [359.9, true], [360, false], [400, false], [520, false]]) {
    assert.equal(client.toolbarPlanFor('menu', width).viewsInMenu, expected, `menu @${width}px → viewsInMenu=${expected}`)
  }
  // 只有 menu 档才可能搬：宽档位永远把视图组放在行里。
  for (const width of [320, 100, 0]) {
    assert.equal(client.toolbarPlanFor('full', width).viewsInMenu, false, `full @${width}px 不搬'`)
    assert.equal(client.toolbarPlanFor('compact', width).viewsInMenu, false, `compact @${width}px 不搬'`)
  }
  // 没量到宽度（NaN / undefined）同样不搬。
  assert.equal(client.toolbarPlanFor('menu', NaN).viewsInMenu, false)
})

await check('T-38 · ★「含已关闭」在两个视角都渲染（旧行为 = 只在按负责人视角）', async () => {
  const board = collabBoard([
    { id: 'T-1', title: 'pool work', status: 'open', assignee: null },
    { id: 'T-2', title: 'kimi building it', status: 'in_progress', assignee: 'kimi' },
  ])

  const status = await toolbarHeaderOf(board)
  assert.ok(status.header.includes('tb-chip-toggle'), '按进度视角有这只 chip')
  assert.ok(status.header.includes('>Include closed<'), '按进度视角 chip 带文字')
  // tooltip 分视角两版：这一版管的是"已结清列"（showClosed）。
  assert.ok(status.header.includes('Show the settled column'), '按进度视角的 tooltip 说的是「已结清列」')

  status.store.setGroupBy('owner')
  const owner = renderToStaticMarkup(React.createElement(client.BoardPanel, { store: status.store }))
  const ownerHeader = owner.slice(owner.indexOf('<header'), owner.indexOf('</header>'))
  assert.ok(ownerHeader.includes('tb-chip-toggle'), '按负责人视角也有同一只 chip')
  assert.ok(ownerHeader.includes('>Include closed<'), '按负责人视角 chip 同样带文字')
  assert.ok(ownerHeader.includes('Include settled tasks'), '按负责人视角的 tooltip 说的是「包含已结清」')

  // ★ 变异哨兵：这一条断言正是"改回 groupBy==='owner' 条件 ⇒ 必须红"的落点 ——
  // 两边的 chip 都由同一段 JSX 渲染，任何按视角把它藏起来的写法都会让上面某一条崩。
  assert.equal((status.header.match(/tb-chip-toggle/g) ?? []).length, 1, '整条工具栏只有一只 chip（不会一视角一只）')
})

await check('T-38 · ★ 三个工具按钮渲染的是内联 <svg>，不是文本字形', async () => {
  const board = collabBoard([{ id: 'T-1', title: 'x', status: 'open', assignee: null }])
  const { header } = await toolbarHeaderOf(board)

  const buttons = header.match(/<button[^>]*class="tb-toolbtn"[^>]*>.*?<\/button>/g) ?? []
  assert.equal(buttons.length, 3, '信息组两枚（指南 / 关于）+ 动作组一枚（刷新）')
  for (const button of buttons) {
    assert.ok(button.includes('<svg'), '每个工具按钮里是 SVG')
    assert.ok(button.includes('viewBox="0 0 16 16"'), 'SVG 是 16×16 视口')
    assert.ok(button.includes('stroke-width="1.5"'), '1.5px 描边')
    assert.ok(button.includes('stroke="currentColor"'), '跟随宿主文字色（currentColor）')
    assert.ok(!/>[^<]*[?ⓘ↻][^<]*<\/button>/.test(button), '按钮正文里没有文本字形')
  }
  // 旧版的三个字符（一个 ASCII、两个符号字形）一个都不许留在工具栏的**文本**里：
  // 去掉标签再找 —— 属性值（title / aria-label）里的字不算字形，SVG 路径也不是。
  const toolbarText = header.replace(/<[^>]*>/g, '|')
  for (const glyph of ['?', '↻', 'ⓘ']) {
    assert.ok(!toolbarText.includes(glyph), `工具栏文本里没有「${glyph}」这个字形`)
  }
  // chip 的方框/勾也是同一个 SVG 组件，不是 unicode 复选框。
  assert.ok(header.includes('tb-chip-toggle'), 'chip 在')
  assert.ok(/<button[^>]*class="tb-chip-toggle"[^>]*>\s*<svg/.test(header), 'chip 的方框是 SVG')
})

await check('T-38 · 每一档在位的控件集合：视图组与「+ 新建任务」永远在位', async () => {
  const board = collabBoard([{ id: 'T-1', title: 'x', status: 'open', assignee: null }])
  const headers = {}
  for (const mode of ['full', 'compact', 'menu']) {
    headers[mode] = (await toolbarHeaderOf(board, { initialToolbarMode: mode })).header
  }

  for (const mode of ['full', 'compact', 'menu']) {
    const header = headers[mode]
    for (const label of ['>By status<', '>By owner<', '>Stats<']) {
      assert.ok(header.includes(label), `${mode} 档：视图组「${label}」在位`)
    }
    assert.ok(header.includes('+ New task'), `${mode} 档：主操作永远在位`)
  }

  // 身份段：full 三段 / compact 只留标题（路径、计数都收）/ menu 一段不留。
  assert.ok(headers.full.includes('>Board<') && headers.full.includes('>work/a<') && headers.full.includes('>1 tasks<'), 'full：标题 + 路径 + 计数')
  assert.ok(headers.compact.includes('>Board<'), 'compact：标题还在')
  assert.ok(!headers.compact.includes('>work/a<') && !headers.compact.includes('>1 tasks<'), 'compact：路径与计数已收')
  assert.ok(!headers.menu.includes('>Board<'), 'menu：身份段整段收掉')

  // 筛选 chip：full 带文字 / compact 只留方框（文字进 tooltip）/ menu 收进 ⋯。
  assert.ok(headers.full.includes('>Include closed<'), 'full：chip 带文字')
  assert.ok(!headers.compact.includes('>Include closed<'), 'compact：chip 的文字收了')
  assert.ok(headers.compact.includes('tb-chip-toggle'), 'compact：方框还在')
  assert.ok(headers.compact.includes('aria-label="Include closed"'), 'compact：文字进了 aria-label / tooltip')
  assert.ok(!headers.menu.includes('tb-chip-toggle'), 'menu：chip 不在行里')
  assert.equal((headers.menu.match(/class="tb-toolbtn"/g) ?? []).length, 1, 'menu：行里只剩 ⋯ 这一枚图标按钮（? ⓘ ↻ 都进了菜单）')
  assert.ok(/aria-haspopup="menu"/.test(headers.menu), 'menu：换成 ⋯ 这个菜单按钮')
  assert.ok(headers.menu.includes('<svg'), 'menu：⋯ 也是 SVG（三个点，不是 U+22EF 字形）')
})

await check('T-38 · ⋯ 菜单：四项收得进来，open 时它们是 menuitem / menuitemcheckbox', async () => {
  const board = collabBoard([{ id: 'T-1', title: 'x', status: 'open', assignee: null }])
  const shut = (await toolbarHeaderOf(board, { initialToolbarMode: 'menu' })).header
  assert.ok(!shut.includes('role="menu"'), '关着的时候不渲染菜单本体（Tab 走位里没有隐形项）')

  const open = (await toolbarHeaderOf(board, { initialToolbarMode: 'menu', initialToolbarMenuOpen: true })).header
  assert.ok(open.includes('role="menu"'), '开着时菜单本体在')
  const items = open.match(/<button[^>]*class="tb-menu-item"[^>]*>/g) ?? []
  assert.equal(items.length, 4, '含已关闭 + 指南 + 关于 + 刷新')
  assert.ok(items[0].includes('role="menuitemcheckbox"') && items[0].includes('aria-checked="false"'), '含已关闭是 menuitemcheckbox（带状态）')
  for (const item of items.slice(1)) assert.ok(item.includes('role="menuitem"'), '其余是普通 menuitem')
  for (const text of ['Include closed', 'Guide', 'About', 'Refresh']) {
    assert.ok(open.includes(`<span>${text}</span>`), `菜单里有「${text}」`)
  }
  // 菜单项都是真 <button>：Tab 走位不需要自己实现（原生顺序即可）。
  assert.equal((open.match(/<div[^>]*role="menuitem/g) ?? []).length, 0, '菜单项是真 <button>，不是 div 假按钮（Tab 走位靠原生顺序）')
})

await check('T-38 · ★「⋯」接进既有 escapeTarget 分层：一次 Esc 只关一层', () => {
  const layers = (over) => ({ about: false, guide: false, toolbarMenu: false, picker: false, drawer: false, ...over })
  const all = layers({ about: true, guide: true, toolbarMenu: true, picker: true, drawer: true })
  assert.equal(client.escapeTarget(all), 'about', '关于 (41) 最高')
  assert.equal(client.escapeTarget({ ...all, about: false }), 'guide', '指南 (31) 次之')
  assert.equal(client.escapeTarget({ ...all, about: false, guide: false }), 'toolbarMenu', '⋯ (27) 在指南之下、选择器之上')
  assert.equal(client.escapeTarget({ ...all, about: false, guide: false, toolbarMenu: false }), 'picker', '选择器 (25)')
  assert.equal(client.escapeTarget({ ...all, about: false, guide: false, toolbarMenu: false, picker: false }), 'drawer', '抽屉 (21)')
  assert.equal(client.escapeTarget(layers({})), null, '什么都没开 → Esc 交还给页面')
  // 一个键绝不关两层：菜单开着时选择器与抽屉都不许动。
  assert.notEqual(client.escapeTarget(layers({ toolbarMenu: true, picker: true, drawer: true })), 'picker')
  assert.notEqual(client.escapeTarget(layers({ toolbarMenu: true, picker: true, drawer: true })), 'drawer')
  // 被聚焦控件吃掉的 Esc 谁也不关（与既有四层同一规则）。
  assert.equal(client.escapeTarget(layers({ toolbarMenu: true }), { defaultPrevented: true }), null)
  // 老调用方（mini 抽屉 / 别的插件）的层对象没有 toolbarMenu 这个键：行为不变。
  assert.equal(client.escapeTarget({ guide: false, picker: true, drawer: true }), 'picker', '缺 toolbarMenu 键 = 没开')
})

await check('T-38 · 组内/组间与外壳常量：TB_TOOLBAR 与渲染出来的间距、CSS 外壳一一对上', async () => {
  assert.deepEqual({ ...client.TB_TOOLBAR }, { itemGap: 4, groupGap: 16, primaryGap: 12, controlHeight: 28, radius: 6, padding: '10px 14px' })

  const css = client.TB_CSS
  // 可点控件一律 28px 高 / 6px 圆角。
  for (const selector of ['.tb-toolbtn', '.tb-seg', '.tb-chip-toggle', '.tb-menu-item']) {
    const rule = cssRule(css, selector)
    assert.ok(rule.includes('height:28px'), `${selector} 是 28px 高`)
    assert.ok(rule.includes('border-radius:6px'), `${selector} 是 6px 圆角`)
  }
  assert.ok(cssRule(css, '.tb-toolbtn').includes('width:28px'), '图标按钮是 28×28 的居中盒')
  assert.ok(cssRule(css, '.tb-toolbtn-primary').includes('height:28px'), '主按钮同高')
  assert.ok(cssRule(css, '.tb-toolbtn-primary').includes('border-radius:6px'), '主按钮同圆角')
  // 按下反馈只碰 background / color / transform，过渡 50ms（不许动布局、不引动画库）。
  for (const selector of ['.tb-toolbtn', '.tb-seg', '.tb-chip-toggle', '.tb-menu-item']) {
    const pressed = cssRule(css, `${selector}:active`)
    assert.ok(pressed, `${selector}:active 有按下反馈`)
    assert.ok(/background:|color:|transform:/.test(pressed), `${selector}:active 只反馈 background/color/transform`)
    assert.ok(cssRule(css, selector).includes('transition:background-color50ms'), `${selector} 的过渡是 50ms 的 background-color`)
    assert.ok(!/transition:[^;]*\b(width|height|margin|padding|all)\b/.test(cssRule(css, selector)), `${selector} 的过渡不碰布局属性`)
  }
  // 键盘可见焦点用宿主 token 描边。
  for (const selector of ['.tb-toolbtn', '.tb-seg', '.tb-chip-toggle', '.tb-menu-item']) {
    assert.ok(cssRule(css, `${selector}:focus-visible`).includes('outline:2pxsolidvar(--dsw-alias'), `${selector} 的 focus-visible 用宿主 token`)
  }
  // chip 选中态：宿主 accent 打底 + 配对前景（两个主题都读得出来）。
  const on = cssRule(css, '.tb-chip-toggle[aria-checked="true"]')
  assert.ok(on.includes('background:var(--dsw-alias-brand-primary'), '选中态 = 宿主 accent')
  assert.ok(on.includes('color:var(--dsw-alias-label-primary-foreground'), '前景 = 外壳配对 token')
  assert.ok(client.TB_CSS.includes('.tb-chip-toggle[aria-checked="true"]'), 'chip 的选中态由 aria-checked 驱动（不是 :checked）')

  // 渲染出来的间距：组内 4px、组间 16px、主操作前 12px、行内边距不动。
  const board = collabBoard([{ id: 'T-1', title: 'x', status: 'open', assignee: null }])
  const { header } = await toolbarHeaderOf(board)
  assert.ok(header.includes('gap:4px'), '组内 4px（信息组 ? ⓘ）')
  assert.ok(header.includes('margin-left:16px'), '组间 16px')
  assert.ok(header.includes('margin-left:12px'), '主操作前 12px')
  assert.ok(header.includes('padding:10px 14px'), '行内边距保持既有 10px 14px 不动')
  assert.ok(header.includes('gap:0'), '行本身不再用父级 gap（那会把身份段的 8px 也套成 16）')
})

// ------------------------------------------------- 文案排版：中文里的半角逗号（T-42 第 8 条）
// `store.ts` 里两处「中文串用半角逗号」是 T-10 审计留下的尾巴（`:213` / `:254`：
// `'bridge 返回了残缺的看板数据,已保留上一份。'` —— 同一句里句号是全角、逗号是半角）。
// 这种修复最容易再烂：它没有行为后果，测试也不会红。所以这里给它一条**可咬**的规则 ——
// **夹在两个汉字之间的逗号必须全角**（`据,已` 这种），扫 `src/**` 全部源码。
// 只匹配「汉字 + 半角逗号 + 汉字」：中英混排里 `列内序, 按负责人`（逗号后有空格）这类
// 是正常写法，不误报。
await check('T-42 · 源码里不存在「汉字,汉字」：中文串里的逗号一律全角', () => {
  const root = new URL('../src/', import.meta.url)
  const halfWidth = /[\u4e00-\u9fff],[\u4e00-\u9fff]/
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) { walk(child); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      readFileSync(child, 'utf8').split('\n').forEach((line, index) => {
        if (halfWidth.test(line)) offenders.push(`${entry.name}:${index + 1} ${line.trim()}`)
      })
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], `这些行是半角逗号：\n${offenders.join('\n')}`)
})

// ------------------------------------------------------------------ done

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
