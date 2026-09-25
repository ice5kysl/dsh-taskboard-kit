# dsh-taskboard-kit

[![DSH Insights health](https://dsh-insights.com/badge/ice5kysl/dsh-taskboard-kit.svg)](https://dsh-insights.com/p/ice5kysl/dsh-taskboard-kit/)

One local task board per dsh workspace. Agents create, claim and progress tasks with model tools; humans watch and drive the same board in a kanban tab. The board's only source of truth is a single JSON file inside the workspace — **no server, no account system, nothing to deploy**.

[中文文档](./README.zh-CN.md)

## What you get

- **Five model tools** the agent can call in any session of the workspace:
  - `taskboard_list` — list tasks (filter by status / column / assignee)
  - `taskboard_create` — add a task, optionally delegating it to someone
  - `taskboard_claim` — atomically claim a task from the pool (exactly one winner under concurrency)
  - `taskboard_update` — start / done / reopen / cancel, reassign, edit fields, append notes
  - `taskboard_get` — full task detail with the event timeline
- **A「看板 / Board」conversation view** in dsh web: four swimlanes (pool · assigned · in progress · done), cards with priority / assignee / age / tags, a detail drawer with the event log, and one-click claim / start / done / reopen / reassign.
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
      "tags": ["docs"],
      "created_by": "dsh-agent",
      "created_at": "…", "updated_at": "…",
      "log": [{ "at": "…", "by": "dsh-agent", "event": "created" }]
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
| 已完成 / done | `done` (cancelled tasks hide behind a toggle) |

Transitions: `open → in_progress` (claim / start), `open|in_progress → done`, `open|in_progress → cancelled`, `done|cancelled → open` (reopen). Status names mirror the msg9 task model on purpose, so a future server-backed board keeps the same semantics.

## Install

```bash
dsh plugin --profile web add dsh-taskboard-kit
# restart dsh web, open any session, and the「看板」tab is there
```

Upgrade note (0.x versioning locks the minor): use `dsh plugin --profile web add dsh-taskboard-kit@latest`, not `dsh plugin update`.

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
