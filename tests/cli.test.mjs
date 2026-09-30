/**
 * CLI smoke test: `bin/taskboard.mjs` drives a real board file in a tmp
 * workspace, exactly the way a shell agent (Kimi Code, Claude Code) would.
 *
 * Run: npm test   (or: node tests/cli.test.mjs)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'taskboard.mjs')
const ws = await mkdtemp(join(tmpdir(), 'dsh-taskboard-cli-'))

let checks = 0
function ok(name) {
  checks += 1
  console.log(`  [ok] ${name}`)
}

async function cli(...args) {
  const { stdout } = await run('node', [bin, '--cwd', ws, '--by', 'kimi', ...args])
  return stdout.trim()
}

async function cliFails(...args) {
  try {
    await run('node', [bin, '--cwd', ws, '--by', 'claude', ...args])
  } catch (error) {
    return error
  }
  throw new Error(`expected failure: ${args.join(' ')}`)
}

console.log('dsh-taskboard-kit cli test:')

const created = JSON.parse(await cli('create', '--title', 'cli 验证任务', '--priority', 'high', '--json'))
// A mistyped --cwd must not read as "the board is empty" (T-3 m3): the path
// goes to stderr, stdout (and --json) stays untouched.
{
  const missing = join(ws, 'no-such-workspace')
  const expected = join(missing, '.dsh', 'taskboard.json')
  const json = await run('node', [bin, '--cwd', missing, '--by', 'kimi', 'list', '--json'])
  assert.deepEqual(JSON.parse(json.stdout), [], '--json stdout stays parseable')
  assert.ok(json.stderr.includes(expected), 'stderr names the board file it looked for')
  const plain = await run('node', [bin, '--cwd', missing, '--by', 'kimi', 'list'])
  assert.equal(plain.stdout.trim(), '(board is empty)', 'stdout text unchanged')
  assert.ok(plain.stderr.includes(expected), 'and the warning is not swallowed')
  // The real workspace has a board: no warning there.
  const here = await run('node', [bin, '--cwd', ws, '--by', 'kimi', 'list'])
  assert.equal(here.stderr.trim(), '', 'an existing board prints nothing to stderr')
}
ok('a mistyped --cwd is told apart from an empty board')

assert.equal(created.id, 'T-1')
assert.equal(created.created_by, 'kimi')
ok('create allocates T-1 and stamps the --by actor')

const listed = await cli('list')
assert.match(listed, /T-1 · open · ·pool· · high · cli 验证任务/)
ok('list renders the pool summary line')

const claimed = JSON.parse(await cli('claim', 'T-1', '--json'))
assert.equal(claimed.status, 'in_progress')
assert.equal(claimed.assignee, 'kimi')
ok('claim moves the task to in_progress for kimi')

const conflict = await cliFails('claim', 'T-1')
assert.equal(conflict.code, 3)
assert.match(conflict.stderr, /held by kimi/)
ok('a second claim exits 3 with a readable conflict')

const done = JSON.parse(await cli('update', 'T-1', '--action', 'done', '--note', '验收通过', '--json'))
assert.equal(done.status, 'done')
assert.equal(done.log.at(-1).note, '验收通过')
ok('update --action done lands with the note on the log')

const fetched = await cli('get', 'T-1')
assert.match(fetched, /T-1 · done · high/)
assert.match(fetched, /负责人：kimi/)
assert.match(fetched, /当前列：done/)
assert.match(fetched, /kimi · claimed/)
ok('get shows status, column age and the event timeline')

const missing = await cliFails('get', 'T-99')
assert.equal(missing.code, 2)
ok('unknown id exits 2 (not found)')

const commented = JSON.parse(await cli('comment', 'T-1', '--text', '交接：CLI 路径验证完毕', '--json'))
assert.equal(commented.comments.length, 1)
assert.equal(commented.comments[0].by, 'kimi')
assert.equal(commented.comments[0].text, '交接：CLI 路径验证完毕')
assert.equal(commented.status, 'done', 'commenting never moves the state')
assert.equal(commented.log.filter((e) => e.event === 'done').length, 1, 'log untouched')
ok('comment appends to comments (and stays out of the log)')

const plain = await cli('comment', 'T-1', '--text', 'second note')
assert.match(plain, /^commented T-1 · by kimi$/)
ok('plain output renders "commented T-1 · by kimi"')

const shown = await cli('get', 'T-1')
assert.match(shown, /留言：/)
assert.match(shown, /交接：CLI 路径验证完毕/)
ok('get shows the comment thread')

const noText = await cliFails('comment', 'T-1')
assert.equal(noText.code, 2)
assert.match(noText.stderr, /--text is required/)
ok('comment without --text exits 2')

const half = JSON.parse(await cli('create', '--title', '半个点的任务', '--value', '1/2', '--json'))
assert.equal(half.id, 'T-2')
assert.equal(half.value, 0.5, '"1/2" maps to 0.5')
ok('create --value 1/2 maps to 0.5')

const halfListed = await cli('list')
assert.match(halfListed, /T-2 · open · ·pool· · medium · v0\.5 · 半个点的任务/)
ok('list renders the value suffix')

await cli('claim', 'T-2')
const submitted = JSON.parse(await cli('update', 'T-2', '--action', 'submit', '--json'))
assert.equal(submitted.status, 'review')
const approved = JSON.parse(await cli('update', 'T-2', '--action', 'approve', '--json'))
assert.equal(approved.status, 'done')
assert.deepEqual(approved.log.slice(-2).map((e) => e.event), ['submitted', 'approved'])
ok('submit → approve walks the review flow')

const badValue = await cliFails('create', '--title', 'bad points', '--value', '4')
assert.equal(badValue.code, 2)
assert.match(badValue.stderr, /--value must be one of/)
ok('illegal --value exits 2')

const closed = JSON.parse(await cli('update', 'T-2', '--action', 'cancel', '--json'))
assert.equal(closed.status, 'closed')
assert.equal(closed.log.at(-1).event, 'closed')
ok('cancel still works as the close alias')

const cleared = JSON.parse(await cli('update', 'T-2', '--value', 'none', '--json'))
assert.equal(cleared.value, null, '"none" clears the estimate')
ok('update --value none clears back to unestimated')

await rm(ws, { recursive: true, force: true })
console.log(`all checks passed (${checks})`)
