#!/usr/bin/env node
/**
 * taskboard — shell entry to a workspace's task board.
 *
 * The same store the dsh plugin's model tools and the browser bridge use,
 * wrapped as a zero-dependency CLI so agents WITHOUT the dsh plugin (Kimi
 * Code, Claude Code, any shell) work the same board through the same lock
 * and the same atomic claim — never by hand-editing the JSON.
 *
 *   taskboard list [--status open|in_progress|done|cancelled] [--assignee NAME|none]
 *   taskboard get <id>
 *   taskboard create --title T [--detail D] [--assignee A] [--priority high|medium|low] [--tags a,b]
 *   taskboard claim <id>
 *   taskboard update <id> [--action start|done|reopen|cancel] [--assignee A|none]
 *                         [--title T] [--detail D] [--priority P] [--tags a,b] [--note N]
 *   taskboard path
 *
 * Global flags: --cwd DIR (default: pwd) · --by NAME (default: $TASKBOARD_ACTOR
 * or "cli-agent") · --json (machine-readable output).
 * Exit codes: 0 ok · 1 usage/internal error · 2 not found / invalid · 3 claim conflict.
 *
 * @module dsh-taskboard-kit/bin
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'))
const { StoreError, boardFilePath, claimTask, createTask, getTask, listTasks, updateTask } = lib

const EXIT = { ok: 0, error: 1, invalid: 2, conflict: 3 }

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i += 1
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function line(task) {
  const who = task.assignee ?? '·pool·'
  return `${task.id} · ${task.status} · ${who} · ${task.priority} · ${task.title}`
}

function full(task) {
  const head = [
    `${task.id} · ${task.status} · ${task.assignee ?? '·pool·'} · ${task.priority}`,
    `title: ${task.title}`,
    task.tags.length ? `tags: ${task.tags.join(', ')}` : '',
    `created by ${task.created_by} at ${task.created_at} · updated ${task.updated_at}`,
  ].filter(Boolean).join('\n')
  const detail = task.detail ? `\n\n${task.detail}` : ''
  const log = task.log.length
    ? `\n\nlog:\n${task.log.map((e) => `  ${e.at} · ${e.event} · ${e.by}${e.note ? ` · ${e.note}` : ''}`).join('\n')}`
    : ''
  return `${head}${detail}${log}`
}

function print(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2))
  else if (typeof value === 'string') console.log(value)
}

function fail(error) {
  if (error instanceof StoreError) {
    console.error(error.message)
    if (error.code === 'conflict') return EXIT.conflict
    if (error.code === 'not-found' || error.code === 'invalid-input' || error.code === 'invalid-transition') return EXIT.invalid
    return EXIT.error
  }
  console.error(`taskboard: ${error?.message ?? String(error)}`)
  return EXIT.error
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [command, ...rest] = positional
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd()
  const by = typeof flags.by === 'string' ? flags.by : (process.env.TASKBOARD_ACTOR ?? 'cli-agent')
  const asJson = flags.json === true

  switch (command) {
    case 'path':
      print(boardFilePath(cwd), asJson)
      return EXIT.ok
    case 'list': {
      const filter = {}
      if (typeof flags.status === 'string') filter.status = flags.status
      if (typeof flags.assignee === 'string') filter.assignee = flags.assignee
      const tasks = await listTasks(cwd, filter)
      if (asJson) print(tasks, true)
      else print(tasks.length ? tasks.map(line).join('\n') : '(board is empty)', false)
      return EXIT.ok
    }
    case 'get': {
      const task = await getTask(cwd, rest[0])
      print(asJson ? task : full(task), asJson)
      return EXIT.ok
    }
    case 'create': {
      if (typeof flags.title !== 'string') {
        console.error('create: --title is required')
        return EXIT.invalid
      }
      const input = { title: flags.title }
      if (typeof flags.detail === 'string') input.detail = flags.detail
      if (typeof flags.assignee === 'string') input.assignee = flags.assignee
      if (typeof flags.priority === 'string') input.priority = flags.priority
      if (typeof flags.tags === 'string') input.tags = flags.tags.split(',').map((t) => t.trim()).filter(Boolean)
      const task = await createTask(cwd, input, by)
      print(asJson ? task : `created ${line(task)}`, asJson)
      return EXIT.ok
    }
    case 'claim': {
      const task = await claimTask(cwd, rest[0], by)
      print(asJson ? task : `claimed ${line(task)}`, asJson)
      return EXIT.ok
    }
    case 'update': {
      const patch = {}
      if (typeof flags.action === 'string') patch.action = flags.action
      if (typeof flags.assignee === 'string') patch.assignee = flags.assignee === 'none' ? null : flags.assignee
      if (typeof flags.title === 'string') patch.title = flags.title
      if (typeof flags.detail === 'string') patch.detail = flags.detail
      if (typeof flags.priority === 'string') patch.priority = flags.priority
      if (typeof flags.tags === 'string') patch.tags = flags.tags.split(',').map((t) => t.trim()).filter(Boolean)
      if (typeof flags.note === 'string') patch.note = flags.note
      const { task, events } = await updateTask(cwd, rest[0], patch, by)
      print(asJson ? task : `updated ${line(task)}  (${events.join(', ')})`, asJson)
      return EXIT.ok
    }
    default: {
      console.error(command ? `taskboard: unknown command "${command}"` : 'taskboard: a command is required')
      console.error('commands: list | get <id> | create --title T | claim <id> | update <id> [--action …] | path  (try --help-style flags: --cwd --by --json)')
      return EXIT.error
    }
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error) => { process.exitCode = fail(error) },
)
