# dsh-taskboard-kit

[![DSH Insights health](https://dsh-insights.com/badge/ice5kysl/dsh-taskboard-kit.svg)](https://dsh-insights.com/p/ice5kysl/dsh-taskboard-kit/)

One local task board per dsh workspace. Agents create, claim and progress tasks with model tools; humans watch and drive the same board in a kanban tab. The board's only source of truth is a single JSON file inside the workspace — **no server, no account system, nothing to deploy**.

[中文文档](./README.zh-CN.md)

## Compatibility

- **dsh ≥ 0.1.7** — fully supported since **v0.5.3**: the session cwd rides the `sessionId` slot prop (0.1.7 removed `current` from the session list state), the composer entry rides the rebuilt compact dock layout, and injected board notices use the v4 producer-owned source kind (`plugin:taskboard-kit`) that 0.1.7's persistence requires. Older dsh versions keep working through legacy fallbacks.

## What you get

- **Eight model tools** the agent can call in any session of the workspace:
  - `taskboard_inbox` — **the first call of every session**: what is on YOU right now, most urgent first, each item with the command that moves it
  - `taskboard_list` — list tasks (filter by status / column / assignee / **who they wait on**)
  - `taskboard_create` — add a task, optionally delegating it to someone
  - `taskboard_claim` — atomically claim a task from the pool (exactly one winner under concurrency; **a card waiting on someone is not claimable**)
  - `taskboard_update` — start / stop / submit (naming a reviewer) / approve / reject / done / close / reopen / **block / unblock**, reassign, edit fields (incl. value points), append notes
  - `taskboard_comment` — add an information comment (findings / handoffs / test feedback) without changing state
  - `taskboard_get` — full task detail with the event timeline, the comment thread, column age / SLA, reviewer and wait
  - `taskboard_roster` — who is actually here (last time each actor acted, plus its aliases)
- **「开启看板 / Turn the board on」** — a fresh workspace shows a one-click wizard instead of an empty board: it creates `.dsh/taskboard.json` AND seeds `.dsh/BOARD-PROTOCOL.md` (the workspace's own rules), then tells you agents can start. Both files are idempotent — an existing board, or a protocol doc the project has edited, is never overwritten. An *on* but empty board shows a different prompt ("create the first card"), because those two states are not the same thing: the first needs enabling before any agent can work, the second just needs work.
- **A「看板 / Board」conversation view** in dsh web with three switchable views over the same board:
  - **按进度 / By status** — six swimlanes (pool · assigned · in progress · review · to settle · settled), cards with priority / value / assignee / **current-column age / stale dot / reviewer / who it waits on**, a **`◷ N cards are waiting on you` strip** and a **`✔ N cards done, awaiting settle` strip** at the top (answerable / closeable inline), a detail drawer with the event log, comments and the collaboration facts, and one-click claim / start / submit / approve / reject / close / reassign.
  - **按负责人 / By owner** — one lane per owner (alias-folded), so "what is on each person's plate" is answerable at a glance; settled work hides behind a toggle.
  - **统计 / Stats** — the macro read: KPI tiles (open / to settle / WIP / blocked / median cycle time / reject rate / total value), a **daily created-vs-settled chart with a running backlog line** (the one chart that says whether work arrives faster than it closes), status and priority distributions, a per-owner load/throughput/cycle table, and a **where-time-piles-up** chart of cumulative dwell per column. Every number is derived from the board file's own `log` — no extra state, no extra requests.
- **Markdown in the drawer (v0.7.0)**: task details and comments render as markdown — headings, lists (**nested by indentation, two levels**), GFM tables, fenced code, quotes, links, **images** (`![alt](url)` over http/https only) and **read-only task checkboxes** (`- [ ]` / `- [x]`). The pipeline escapes first and only ever emits tags it built itself, so a card written by any agent stays data — see `docs/images/markdown-fidelity.png` for the rendered result.
- **A multi-agent collaboration protocol**: the full spec is [`docs/COLLABORATION.md`](./docs/COLLABORATION.md); its short form goes into the system prompt at session start, and the CLI `--help` / panel guide snippets are generated from the same rules.
- **Session-start awareness**: the agent receives **its own actionable slice** (reviews it owes, who is blocked on it, what was rejected back to it, which delegation went quiet) — not a bare count.
- **Board-change push**: an fs.watch watcher on every live session's board notifies the agent (context-only, never a wakeup) when a task is assigned to it, a verdict lands on its task, **a review is handed to it**, **someone starts waiting on it**, **a card starts waiting on the human**, a pool task appears, or someone comments on its work — no polling, no msg9 needed. Changes inside a 5s storm window merge into one notice.
- **A clock-driven self-audit (v0.5.4)**: a file watcher can never see "nobody touched this card for three days" — so a periodic pass re-reads the board and nudges only about what is pressing on you (a review you owe, someone waiting on you, a rejection you never answered, your own stale cards, a delegation that went quiet, a human wait past its SLA), with the command to run. One nudge per workspace per 30 minutes.
- **Waiting on a human really reaches the human (v0.5.4)**: `block --on human` lands in the panel's「waiting on you」list; set `TASKBOARD_NOTIFY_CMD` and it is pushed out-of-band too (msg9, a desktop notification, a webhook — your wiring); past 24h it escalates automatically.

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
      "status": "open",            // open | in_progress | review | done | closed
      "assignee": null,             // null = waiting in the claimable pool
      "reviewer": null,             // v0.5.4+: who owes the verdict while status is review
      "waiting_on": null,           // v0.5.4+: { kind, who, question, since } — parked on a human/agent
      "priority": "high",           // high | medium | low
      "value": 3,                   // value points ½|1|2|3|5|8 · null = unestimated
      "tags": ["docs"],
      "created_by": "dsh-agent",
      "created_at": "…", "updated_at": "…",
      "log": [{ "at": "…", "by": "dsh-agent", "event": "created" }],
      "comments": [{ "at": "…", "by": "kimi", "text": "handoff: …" }]  // v0.2+; older files load with []
    }
  },
  "actors": {                       // v0.5.4+: the roster — who acted, and when we last saw them
    "dsh": { "kind": "agent", "aliases": ["dsh-agent"], "first_seen_at": "…", "last_seen_at": "…" }
  }
}
```

Because the file lives in the workspace, every harness and every human working in the same directory sees the same board. Commit it or gitignore it — your call. All mutations go through a lock file with stale-lock recovery and atomic tmp+rename writes, so concurrent agents (or the panel) can never tear the file. `claim` is adjudicated inside the lock: N concurrent claims → exactly one succeeds, the rest get a conflict.

## Upgrading to 0.6.0 (read this if you used an older board)

**`done` is no longer terminal — `closed` is.** Before 0.6.0 the flow ended at `done`
and `closed` meant "abandoned". That made "finished but nobody closed it out" invisible:
cards sat in `done` forever and no rule said anyone owed a step.

Now `done` means *finished and approved, still owes a settle*: the card stays on the
board and still counts as open work until someone `close`s it. Findings that follow
from that change:

- a「待收口」strip lists done-but-unsettled cards with a one-click settle;
- a done card past 72h is reported as stale (it used to never be);
- `taskboard_inbox` tells an owner "your card is done but unsettled", with the command;
- the stats view reports **median cycle** as `created → done` (the work) and
  **settle lag** as `done → closed` (the paperwork) — two numbers, because one
  combined number made a fast board look slow whenever closing lagged.

Abandoning work is still a `close` — say why in the note; there is no separate
"abandoned" status. Old board files load unchanged (`cancelled` → `closed`, missing
`value` / `comments` / `actors` are hydrated on the next write). If your existing board
has a pile of `done` cards, they now show up as work awaiting a settle — that is the
intended reading, not a bug.

## Status model

| column | rule |
|---|---|
| 待认领 / pool | `open`, no assignee, **not waiting on anyone** — anyone may `claim` |
| 已指派 / assigned | `open` with an assignee — delegated, not started |
| 进行中 / in_progress | claimed or started |
| 待审核 / review | submitted, waiting for a reviewer to `approve` / `reject` |
| 待收口 / done | approved (or marked `done` directly) — **NOT terminal**, still owes a settle |
| 已结清 / closed | settled — `close` (the panel hides them behind a toggle) |

Flow: `open → in_progress → review → done → closed`. **`closed` is the one terminal status**; `done` means "finished and approved, not yet closed out", so a done card stays on the board and still counts as open work until someone settles it. That two-step exists because approval is not the same as the matter being closed out (deploys, upstream sign-off and docs may still follow). Abandoning work is also a `close` — say why in the note, as there is no separate "abandoned" status. A「待收口」strip at the top of the panel lists done-but-unsettled cards with a one-click settle, so finished work cannot rot in a lane nobody owns. In actions: `open → in_progress` (claim / start), `in_progress → open` (stop), `in_progress → review` (submit), `review → done` (approve), `review → in_progress` (reject), `open|in_progress|review → done`, `open|in_progress|review|done → closed` (close; the legacy name `cancel` is its alias), `done|closed → open` (reopen). Status names mirror the msg9 task model on purpose, so a future server-backed board keeps the same semantics. Boards written by older versions load seamlessly: `cancelled` tasks/logs become `closed`, and missing `value` / `comments` fields are hydrated.

Two collaboration axes are **orthogonal to the status** (v0.5.4 — neither invents a status):

| field | meaning | written by |
|---|---|---|
| `reviewer` | who owes the verdict; only that reviewer, the task's creator or the human can `approve`/`reject`; **you cannot review your own work** | `submit` (default resolution: creator → most recently active other agent → the human) |
| `waiting_on` | who the card waits on (`human`/`agent`/`external` + `who` + `question` + `since`); **a waiting card cannot be claimed** | `block` / `unblock` |

The board also keeps an `actors` **roster** (who has acted, when they were last seen, aliases like `dsh ≡ dsh-agent`) — the fact that answers "was this delegated to an agent that is no longer around?".

Each task still carries **value points** (Fibonacci scale ½ / 1 / 2 / 3 / 5 / 8, `null` = unestimated) — what the card is worth. Set it at create or update time; on the CLI, `--value 1/2` means ½ and `--value none` clears the estimate.

## Install

```bash
dsh plugin --profile web add dsh-taskboard-kit@0.7.2
# restart dsh web, open any session, and the「看板」tab is there
```

**Pin the version explicitly.** pnpm 11 (which `dsh plugin` forwards to) ships a
supply-chain `minimumReleaseAge` gate: a version published minutes ago is held
back, and a bare `add dsh-taskboard-kit` then silently installs an older one —
you would get a board whose `done` is still treated as terminal without any hint.
Naming `@0.7.2` opts that release out of the gate and installs what you asked for.
Once a release is more than a day old, a bare `add` finds it too.

<a id="release-notes"></a>
## v0.7.3 — the ⓘ About card, one holder line everywhere, two cleanups

**Client-side only: refresh the page — no `dsh web` restart needed.** The「关于」links are the only thing here that ever leaves your machine, and only when you click one.

1. **The「关于」card (ⓘ, next to `?` and `↻`).** Name + version (the version is **injected at build time** from `package.json` via esbuild's `define`; a build that forgets it falls back to `dev` rather than printing nothing), one sentence on what this is, and then the block that is actually worth reading — **local transparency**: the board file's absolute path, how many cards and how many roster entries it holds, the data-format version (`board.version`), the plugin id, and the plain statement that **all of it lives in that one JSON file: no server, no accounts, no cloud**. Below that, four GitHub entries — repository · report an issue · the collaboration spec (`docs/COLLABORATION.md`) · these release notes — every one `target="_blank" rel="noreferrer"`, plus MIT and the author. Esc closes it (it is the topmost layer: the key never falls through to a drawer or the guide underneath).
2. **The holder line is now the panel's one answer to「球在谁手上」— on every surface.** The card, the drawer and the status-bar mini drawer all render `mark + name` from the same derivation (`currentHolder`), strictly one line: `➤` to submit · `○` to claim (pool) · `◷` to answer / to reply (parked on a human / an agent) · `⚑` to decide (review) · `⌂` to settle (done). `closed` has no holder. It is derived from the state machine, not from `assignee`: in `review` the assignee is frozen (the reviewer holds the ball) and in `done` the reviewer is cleared (the creator owes the settle), so reading「当前处理人」literally points at the **wrong person** in exactly those stages. The mini drawer used to stack three per-field badges that said the same thing twice; it now shows this single line.
3. **Title prefixes are stripped for DISPLAY only.** A leading `【owner】 T-93 ·` that merely repeats what the card already shows is dropped from the rendered title — the untouched original stays in the tooltip. Nothing is rewritten in the board file.
4. **Long names truncate instead of spilling.** `.tb-badge-outline` (and every sibling 10px pill) now carries `max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`: a long actor name used to overflow its dashed border and get clipped mid-glyph by the lane, which read as broken layout rather than「the name is long」.
5. **Two cleanups**: three dead style keys from before 0.7.2 (`cardSep` / `reviewerBadge` / `cardWaitAge`, each defined once and referenced nowhere) are gone.

**Verified**: `npm test` **214 checks green** + clean typecheck; the version fallback, the holder marks, the badge ellipsis rule and the Esc layering each carry a **mutation check** (break it ⇒ that test goes red).

## v0.7.2 — making the cards and the stats readable at a glance

Four rounds of owner feedback (2026-10-01), shipped together. **Client-side only: refresh the page — no `dsh web` restart needed.**

1. **Three-row cards**: row 1 = the fixed attributes (priority dot · id · value · status · owner/creator … column age pinned right, 10px); row 2 = the title (≤2 lines, redundant prefixes stripped **for display only**); row 3 = what moves (holder · waiting · review · tags, strictly one line). Card height went from 90–123px to a **uniform 88px**.
2. **Title de-noising**: a `【owner】 T-93 ·` prefix that merely repeats what the card already shows is dropped (the `【owner】` only when it *is* this card's owner/creator/reviewer; the number only when it is this card's own id; the **original string stays in the tooltip**). The id match requires a whole token — `T-930` / `T-93X` / `T-93-2` are no longer eaten alive (a real bug caught in review).
3. **The holder view**: a card answers exactly one question — **whose ball is it, and what do they owe**. `➤ to submit` / `◷ to answer·to reply` / `⚑ to decide` / `⌂ to settle` / `○ to claim` (`closed` has no holder). It is derived from the state machine: in `review` the assignee is *frozen* and in `done` the reviewer is *cleared*, so reading "current handler" literally points at the **wrong person** in exactly those stages.
4. **Marks instead of labels**: `@` owner · `✎` creator · `◆` value · `◷` waiting · `⚑` decide · `⌂` settle · `➤` holder. **Text glyphs only, never emoji** (emoji render as colour bitmaps and fight the theme); the meaning lives in each tooltip. Card text is **10.6% shorter**.
5. **Stats v2**: 7/14/30-day windows; KPIs split into "what needs you" and "background", each with a **delta against the previous equal-length window** (fewer than 3 samples ⇒ an explicit "not enough samples" badge rather than a fake trend); new **"what needs doing now"** (holder ranking + anomalies, **every row opens the card**) and a **value view** (backlog vs delivered, throughput, value/cycle per card); the flow chart gained a y-axis, gridlines and value labels, status became a ring chart, and **milestone progress** is derived from tags (e.g. `v1.42.0`).
6. **Drawer v2**: sticky header (title + holder row + primary actions); a property table (values copyable); **every action is always listed** with its **outcome** (`Close → moves to 「settled」 · reopenable`) and the unavailable ones are **greyed out with the reason**; the assignee picker is searchable and **lists only present actors by default** (quiet ones need an explicit expand); the description collapses; tags are clickable.
7. Two **dead ends** closed along the way: pressing "Start" on a pool card used to create an ownerless "In progress"; a waiting card's only exit in the drawer was "Claim", which always fails (now "Release wait").
8. An **unnamed wait** (`waiting_on.who` empty) is no longer rendered as claimable (both on the card and in the stats) — the store refuses to claim a waiting card, so that used to be an entry point that always failed.

**Verified**: `npm test` **207 checks green** + clean typecheck; every change carries a **mutation check** (break it and the test goes red).

**0.7.1 makes the quiet text readable and the cards tighter.** The card's quiet tier used `--dsw-alias-label-dimmed` — a shell token that is near-invisible by design (`#e1e5ee` on light, `#43454a` on dark; ≈1.1:1 / 1.3:1), so task refs (`#18`), value points (`◆2`) and column ages were unreadable in BOTH themes. They now use `--dsw-alias-label-tertiary` (`#81858c` / `#adb2b8`). Cards were reshaped from **five rows to three** (`#N` and `◆value` moved onto the meta row, owner + waiting/reviewer badges share one row), lanes went `260 → 240px`, and spacing/line-height tightened: **a card is ~22% shorter on the same board (125px → 97px average)**, so one lane shows ~9 cards per screen instead of ~7. The waiting chip may wrap internally so the "how long has this been waiting" half never gets ellipsized away.

**0.7.0 = markdown fidelity + two security hardenings.** The drawer's rendering gained four things: **images** (`![alt](url)`, http/https only), **nested lists** (two levels by indentation, the child list opening inside the parent `<li>`), **read-only task checkboxes** (`- [ ]` / `- [x]`), and a block-level comment container (tables/lists no longer sit inside a `span`). Two guardrails were tightened at the same time: the **cwd whitelist is now direction-aware** — a mutation (`POST`) may only create a board in a boardless directory when the host positively says it serves that workspace, while reads keep the older contract (the panel must be able to read a workspace whose session is not live and whose board does not exist yet); and the **trust gate now compares the scheme** (an `https://…` Origin is no longer treated as this plain-http origin). Three remaining audit minors came along too: a mistyped `--cwd` is no longer indistinguishable from an empty board, the lock wait budget now outlasts the stale window, and the scheme check above.

**0.6.2 fixes stylesheet ownership.** The status-bar「Board · N ◷M」pill could
occasionally collapse into a browser-default `<button>` (grey fill and border, the
icon pushed onto its own line). The cause was not layout: dsh's client module loader
books every *unowned* `<style>` in the document to the next plugin module that
materializes, and deletes it when that plugin unloads or hot-reloads. Our sheet was
React-rendered (hence unowned), so a stranger's reload deleted it behind React's back
— no error, and React never put it back. TB_CSS is now injected into `<head>` by
`ensureTaskboardStyles()` and is born tagged `data-plugin="dsh-taskboard-kit"`, so the
loader can never claim it, and a lost tag heals on the next mount. **0.6.x users
should upgrade.**

(0.6.1 was copy-only: reaching a human is described as *your* notify channel
(msg9 / desktop notification / webhook / mail) instead of naming msg9 as the way;
`msg9HookExample` became `notifyHookExample`, old name kept as a deprecated alias.
No behaviour changed.)

Upgrades: use `dsh plugin --profile web add dsh-taskboard-kit@<version>` with the
exact version (0.x locks the minor, so `dsh plugin update` will not move you).

## For agents without the plugin (Kimi Code, Claude Code, any shell)

The board is just a file, but **never hand-edit it** — the lock and the atomic claim live in the store. The kit ships a zero-dependency CLI over the very same store, so every agent works the board the same safe way:

```bash
taskboard inbox --by kimi                   # ★ the first call of every session: what is on you, with its command
taskboard list --waiting human               # who is waiting on the human (--waiting agent|external|any too)
taskboard stale                              # health: waiting on the human / review nobody owns / broken handoffs / stale columns
taskboard roster                             # who is actually around (check before delegating)
taskboard claim T-3 --by kimi                # atomic claim, stamped "kimi" (a waiting card is refused)
taskboard update T-3 --action submit --reviewer claude --by kimi   # hand to review, naming the reviewer
taskboard update T-3 --action approve --by claude                  # only the reviewer / creator / human may decide
taskboard update T-3 --action block --on human --who iceskysl \
  --question "ship now, or wait for the T-8 fixes?" --by kimi       # park it on the human (fires the notify hook)
taskboard update T-3 --action unblock --by kimi                     # the answer landed
taskboard comment T-3 --text "handoff: …" --by kimi     # state untouched
taskboard create --title "…" --priority high --value 3 --by claude
```

`--by` names the actor in the task log (default `$TASKBOARD_ACTOR` or `cli-agent`); `--cwd` points at another workspace; `--json` gives machine-readable output; a lost claim exits `3` with a readable conflict. Until the package is on npm, invoke it straight from the repo: `node /path/to/dsh-taskboard-kit/bin/taskboard.mjs list`. Works with or without dsh web running — and while dsh web IS up, any local process can also call the loopback bridge `/dsh-taskboard/*` directly.

## Environment switches

| variable | effect |
|---|---|
| `TASKBOARD_ACTOR` | default actor name the agent's tools write into the log (default `dsh-agent`) |
| `TASKBOARD_HUMANS` | comma-separated names that count as humans (default `human`) |
| `TASKBOARD_ACTOR_ALIASES` | `canonical:alias1\|alias2,…` — fold one agent's many names into a single owner (default `dsh:dsh-agent`) |
| `TASKBOARD_WATCH_NAMES` | comma-separated names the watcher treats as "me" (the first is canonical, the rest become aliases); it decides both what is mine and what is my own echo (default `dsh,dsh-agent`) |
| `TASKBOARD_SIBLING_NAMES` | the OTHER sessions of this same instance: their cards are mine, but their actions still reach me (default empty). Without it, two dsh sessions in one workspace go blind to each other |
| `TASKBOARD_ALLOW_SELF_REVIEW` | `1` allows self-review — only for a workspace owned by a single agent |
| `TASKBOARD_NOTIFY_CMD` | shell command run when a card starts waiting on a human, or blows its wait SLA. The card arrives as JSON on stdin plus `TASKBOARD_TASK_ID` / `TASKBOARD_QUESTION` / `TASKBOARD_NOTIFY_REASON` in the env. A failure is logged, never fatal |
| `TASKBOARDKIT_LOCALE` | `en` forces English tool output (default Chinese) |
| `TASKBOARD_WATCH` | `0` disables both the change watcher and the self-audit |

## Browser bridge

The panel talks to the host over `/dsh-taskboard/*`. Requests are accepted only from loopback / same-origin callers, and every POST must carry `x-taskboard: mutate`. Browser mutations are attributed to `human` in the task log.

## Development

```bash
npm install
npm run build       # esbuild → lib/index.js + lib/client.js
npm test            # node native runner: smoke, store, client, cli, watch, protocol
npm run typecheck   # tsc --noEmit
```

Zero runtime dependencies. The browser bundle requires only the shell-seeded `react` / `react/jsx-runtime`.

## License

MIT
