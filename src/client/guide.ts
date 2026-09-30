/**
 * Copy templates of the guide overlay — pure functions so the panel, the
 * tests and any future surface interpolate the same text.
 *
 * The first two teach an external agent (kimi / Claude Code) how to join this
 * workspace's board: never edit the JSON by hand, always drive the CLI. The
 * hook snippets go one step further — the agent checks its own
 * actionable slice on its own (SessionStart / UserPromptSubmit) without anyone
 * mailing it first — and stays silent when that slice is empty.
 * `cli` is the absolute path the host reports; when it is unknown the
 * templates degrade to a placeholder the user can search-replace once.
 *
 * @module dsh-taskboard-kit/client-guide
 */

import { L } from './locale.ts'

/** Placeholder used when the host did not report the CLI's location. The
 *  string is deliberately locale-independent: it is a path, not prose. */
export const CLI_FALLBACK = '<taskboard 插件目录>/bin/taskboard.mjs'

/**
 * The project directory the guide's snippets name. The board file's location
 * (reported by the host, which resolved it server-side) is authoritative; the
 * session cwd detected in the browser is only a fallback, so the snippets
 * always describe the project whose board is actually on screen.
 */
export function guideProjectDir(boardFile: string | null, cwd: string | null): string {
  const suffix = '/.dsh/taskboard.json'
  if (boardFile?.endsWith(suffix)) return boardFile.slice(0, -suffix.length)
  if (boardFile) {
    const cut = boardFile.lastIndexOf('/.dsh/')
    if (cut > 0) return boardFile.slice(0, cut)
  }
  return cwd ?? '<workspace>'
}

/** The AGENTS.md convention template (方式 A: the workspace convention file).
 *  Commands run from the project root, so `$PWD` keeps the file portable —
 *  the same text works verbatim in every project. */
export function conventionSnippet(cli: string | null): string {
  const bin = cli ?? CLI_FALLBACK
  return L(
    `## 任务看板（所有 Agent 必读）
本目录有一块共享任务看板，唯一真实来源是 .dsh/taskboard.json。不要手改 JSON，统一用 CLI：
TB=${bin}
node $TB inbox --cwd "$PWD" --by <你的名字>       # ★ 会话开始第一步：现在压在你身上的事（带该敲的命令）
node $TB list  --cwd "$PWD" --assignee <你的名字>  # 指派给你的任务
node $TB roster --cwd "$PWD"                      # 谁还在场（派活前查）
node $TB claim <id> --cwd "$PWD" --by <你的名字>  # 认领（原子，退出码 3 = 已被抢；等谁的卡不可认领）
node $TB update <id> --cwd "$PWD" --action start --by <你的名字>
node $TB update <id> --cwd "$PWD" --action submit --reviewer <审核人> --by <你的名字>
node $TB update <id> --cwd "$PWD" --action approve|reject --note "审核意见" --by <你的名字>
node $TB update <id> --cwd "$PWD" --action block --on human --question "要人类回答的一句话" --by <你的名字>
node $TB update <id> --cwd "$PWD" --action unblock --by <你的名字>
node $TB comment <id> --cwd "$PWD" --text "…" --by <你的名字>
node $TB stale --cwd "$PWD"                       # 协作健康：在等人类 / 审核没人认领 / 交接断了 / 列陈旧
约定（完整规范见本插件 docs/COLLABORATION.md）：
- 动手前先占位（claim / start）；做完 submit 交审核，**不要自己 done**，并 comment 写清做了什么/验证了什么/还差什么；
- submit 必须有人接审核且不能是自己；approve/reject 归 reviewer、卡主或人类；打回必须 --note 写原因；
- 卡住就 block 说清在等谁（等人类的卡进面板「等你」清单并触发外发通知），等超时会升级催办；
- 状态一变就更新；陈旧（review>24h / in_progress>72h）会被自检点名；
- 你的名字 = harness 名（kimi/claude/dsh）；价值度 --value 1/2|1|2|3|5|8。`,
    `## Task board (required reading for every agent)
This directory has a shared task board; the single source of truth is .dsh/taskboard.json. Never edit the JSON by hand — always use the CLI:
TB=${bin}
node $TB inbox --cwd "$PWD" --by <your-name>       # ★ first thing every session: what is on you (with the command to run)
node $TB list  --cwd "$PWD" --assignee <your-name> # tasks assigned to you
node $TB roster --cwd "$PWD"                       # who is actually around (check before delegating)
node $TB claim <id> --cwd "$PWD" --by <your-name>  # claim (atomic; exit code 3 = already taken; a waiting card cannot be claimed)
node $TB update <id> --cwd "$PWD" --action start --by <your-name>
node $TB update <id> --cwd "$PWD" --action submit --reviewer <name> --by <your-name>
node $TB update <id> --cwd "$PWD" --action approve|reject --note "review note" --by <your-name>
node $TB update <id> --cwd "$PWD" --action block --on human --question "one line the human can answer" --by <your-name>
node $TB update <id> --cwd "$PWD" --action unblock --by <your-name>
node $TB comment <id> --cwd "$PWD" --text "…" --by <your-name>
node $TB stale --cwd "$PWD"                        # health: waiting on the human / review nobody owns / broken handoffs / stale columns
Rules (full spec: the plugin's docs/COLLABORATION.md):
- claim / start BEFORE working; when done SUBMIT for review (never mark it done yourself) and comment what you did, what you verified, what is open;
- submit names a reviewer (never yourself); approve/reject belong to that reviewer, the task creator or the human; a reject must carry --note;
- stuck? block and say who you wait on (human waits surface in the panel and fire the notify hook); waits escalate on an SLA;
- update on every state change; staleness (review>24h / in_progress>72h) is named by the self-audit;
- your name = your harness name (kimi/claude/dsh); value --value 1/2|1|2|3|5|8.`,
  )
}

/** The dispatch template (方式 B/C: mail or a paste into their session — the channel is the sender's choice). */
export function dispatchSnippet(cli: string | null, cwd: string): string {
  const bin = cli ?? CLI_FALLBACK
  return L(
    `我们在 ${cwd} 有一块共享任务看板（多 Agent 协同），请你加入：
1) 不要手改 .dsh/taskboard.json，统一用 CLI：TB=${bin}
2) 会话开始先跑：node $TB inbox --cwd ${cwd} --by <名字>  # 现在压在你身上的事，带该敲的命令
3) 流程：动手前先占位（池里 claim / 指派给你的 start）；做完 submit --reviewer <审核人> + comment 交接（不要自己 done）；
   审核用 approve/reject（打回必留 --note）；卡住用 block 说清在等谁
4) 你的名字 = <名字>（--by 和 assignee 都用它）
5) 你的第一个任务：T-__（也可自己从待认领池挑）`,
    `We have a shared task board (multi-agent collaboration) in ${cwd} — please join in:
1) Never edit .dsh/taskboard.json by hand; always use the CLI: TB=${bin}
2) At session start, run: node $TB inbox --cwd ${cwd} --by <name>  # what is on you, each item with its command
3) Flow: claim / start BEFORE working; when done submit --reviewer <name> + comment a handoff (never mark it done yourself);
   reviewers approve/reject (a reject must carry --note); if stuck, block and say who you are waiting on
4) Your name = <name> (use it for both --by and assignee)
5) Your first task: T-__ (or pick one yourself from the claimable pool)`,
  )
}

/**
 * The self-monitoring hook command (one shared shape for both harnesses):
 * guarded by the board file so board-less projects stay untouched, and
 * silent when the board has nothing assigned to this actor — SessionStart
 * and UserPromptSubmit inject stdout into the agent's context, so noise is
 * the enemy. The echo stays Chinese in every locale: it is a prompt for the
 * agent on the other side, not UI prose.
 */
function hookCommand(bin: string, name: string): string {
  return `[ -f .dsh/taskboard.json ] && { OUT=$(node ${bin} inbox --cwd "$PWD" --by ${name} --limit 8 2>/dev/null); case "$OUT" in ""|*"nothing is on you"*|*"没有该你处理的事"*) ;; *) echo "任务看板 · ${name} 现在该处理的："; echo "$OUT";; esac; } || true`
}

/** kimi-code hooks (append to ~/.kimi-code/config.toml): two TOML blocks. */
export function hookSnippetKimi(cli: string | null): string {
  const bin = cli ?? CLI_FALLBACK
  const command = hookCommand(bin, 'kimi')
  return `${L('# 追加到 ~/.kimi-code/config.toml —— 任务看板自监控（名字 = kimi）', '# Append to ~/.kimi-code/config.toml — task board self-monitoring (name = kimi)')}
[[hooks]]
event = "SessionStart"
command = '${command}'
timeout = 10

[[hooks]]
event = "UserPromptSubmit"
command = '${command}'
timeout = 10`
}

/** Claude Code hooks (merge into ~/.claude/settings.json). Serialized with
 *  JSON.stringify so the embedded shell command's quotes are always escaped
 *  correctly — never hand-write the escaping. */
export function hookSnippetClaude(cli: string | null): string {
  const command = hookCommand(cli ?? CLI_FALLBACK, 'claude')
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
      },
    },
    null,
    2,
  )
}
