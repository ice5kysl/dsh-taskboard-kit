# dsh-taskboard-kit

[![DSH Insights health](https://dsh-insights.com/badge/ice5kysl/dsh-taskboard-kit.svg)](https://dsh-insights.com/p/ice5kysl/dsh-taskboard-kit/)

One local task board per dsh workspace. Agents create, claim and progress tasks with model tools; humans watch and drive the same board in a kanban tab. The board's only source of truth is a single JSON file inside the workspace — **no server, no account system, nothing to deploy**.

[中文文档](./README.zh-CN.md)

## What you get

- **Six model tools** the agent can call in any session of the workspace:
  - `taskboard_list` — list tasks (filter by status / column / assignee)
  - `taskboard_create` — add a task, optionally delegating it to someone
  - `taskboard_claim` — atomically claim a task from the pool (exactly one winner under concurrency)
  - `taskboard_update` — start / stop / submit / approve / reject / done / close / reopen, reassign, edit fields (incl. value points), append notes
  - `taskboard_comment` — add an information comment (findings / handoffs / test feedback) without changing state
  - `taskboard_get` — full task detail with the event timeline and the comment thread
- **A「看板 / Board」conversation view** in dsh web: six swimlanes (pool · assigned · in progress · review · done · closed), cards with priority / value / assignee / age / tags, a detail drawer with the event log and comments, and one-click claim / start / submit / approve / reject / close / reassign.
- **Session-start awareness**: the agent is told how many tasks are waiting and in progress, and a system-prompt section teaches the claim-before-work rules.

## The board file

Each workspace gets `<workspace>/.dsh/taskboard.json`:

```jsonc
{
  "version": 1,
  "workspace": "/abs/path",
  "next_seq": 2,
  "tasks": {
    "T-1": {
      "id": "T-1",
      "title": "Write the release notes",
      "detail": "…markdown…",
      "status": "open",            // open | in_progress | done | cancelled
      "assignee": null,             // null = waiting in the claimable pool
      "priority": "high",           // high | medium | low
      "value": 3,                   // value points ½|1|2|3|5|8 · null = unestimated
      "tags": ["docs"],
      "created_by": "dsh-agent",
      "created_at": "…", "updated_at": "…",
      "log": [{ "at": "…", "by": "dsh-agent", "event": "created" }],
      "comments": [{ "at": "…", "by": "kimi", "text": "handoff: …" }]  // v0.2+; older files load with []
    }
  }
}
```

Because the file lives in the workspace, every harness and every human working in the same directory sees the same board. Commit it or gitignore it — your call. All mutations go through a lock file with stale-lock recovery and atomic tmp+rename writes, so concurrent agents (or the panel) can never tear the file. `claim` is adjudicated inside the lock: N concurrent claims → exactly one succeeds, the rest get a conflict.

## Status model

| column | rule |
|---|---|
| 待认领 / pool | `open` and no assignee — anyone may `claim` |
| 已指派 / assigned | `open` with an assignee — delegated, not started |
| 进行中 / in_progress | claimed or started |
| 待审核 / review | submitted, waiting for a reviewer to `approve` / `reject` |
| 已完成 / done | approved (or marked `done` directly) |
| 已关闭 / closed | abandoned — `close` (the panel hides them behind a toggle) |

Flow: `open → in_progress → review → done`; any non-final status can go `closed`; `done | closed → open` (reopen). In actions: `open → in_progress` (claim / start), `in_progress → open` (stop), `in_progress → review` (submit), `review → done` (approve), `review → in_progress` (reject), `open|in_progress|review → done`, `open|in_progress|review|done → closed` (close; the legacy name `cancel` is its alias), `done|closed → open` (reopen). Status names mirror the msg9 task model on purpose, so a future server-backed board keeps the same semantics. Boards written by older versions load seamlessly: `cancelled` tasks/logs become `closed`, and missing `value` / `comments` fields are hydrated.

Each task also carries **value points** (Fibonacci scale ½ / 1 / 2 / 3 / 5 / 8, `null` = unestimated) — what the card is worth. Set it at create or update time; on the CLI, `--value 1/2` means ½ and `--value none` clears the estimate.

## Install

```bash
dsh plugin --profile web add dsh-taskboard-kit
# restart dsh web, open any session, and the「看板」tab is there
```

Upgrade note (0.x versioning locks the minor): use `dsh plugin --profile web add dsh-taskboard-kit@latest`, not `dsh plugin update`.

## For agents without the plugin (Kimi Code, Claude Code, any shell)

The board is just a file, but **never hand-edit it** — the lock and the atomic claim live in the store. The kit ships a zero-dependency CLI over the very same store, so every agent works the board the same safe way:

```bash
taskboard list                              # see the board (pool first)
taskboard claim T-3 --by kimi               # atomic claim, stamped "kimi"
taskboard update T-3 --action submit --by kimi          # hand to review
taskboard update T-3 --action approve --by claude       # reviewer passes it
taskboard update T-3 --action done --note "shipped" --by kimi
taskboard comment T-3 --text "handoff: …" --by kimi     # state untouched
taskboard create --title "…" --priority high --value 3 --by claude
```

`--by` names the actor in the task log (default `$TASKBOARD_ACTOR` or `cli-agent`); `--cwd` points at another workspace; `--json` gives machine-readable output; a lost claim exits `3` with a readable conflict. Until the package is on npm, invoke it straight from the repo: `node /path/to/dsh-taskboard-kit/bin/taskboard.mjs list`. Works with or without dsh web running — and while dsh web IS up, any local process can also call the loopback bridge `/dsh-taskboard/*` directly.

## Environment switches

| variable | effect |
|---|---|
| `TASKBOARD_ACTOR` | default actor name the agent's tools write into the log (default `dsh-agent`) |
| `TASKBOARDKIT_LOCALE` | `en` forces English tool output (default Chinese) |

## Browser bridge

The panel talks to the host over `/dsh-taskboard/*`. Requests are accepted only from loopback / same-origin callers, and every POST must carry `x-taskboard: mutate`. Browser mutations are attributed to `human` in the task log.

## Development

```bash
npm install
npm run build       # esbuild → lib/index.js + lib/client.js
npm test            # node native runner: store, host smoke, client
npm run typecheck   # tsc --noEmit
```

Zero runtime dependencies. The browser bundle requires only the shell-seeded `react` / `react/jsx-runtime`.

## License

MIT
