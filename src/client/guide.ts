/**
 * Copy templates of the guide overlay — pure functions so the panel, the
 * tests and any future surface interpolate the same text.
 *
 * The first two teach an external agent (kimi / Claude Code) how to join this
 * workspace's board: never edit the JSON by hand, always drive the CLI. The
 * hook snippets go one step further — the agent checks the board on its own
 * (SessionStart / UserPromptSubmit) without anyone mailing it first.
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
node $TB list --cwd "$PWD" --assignee <你的名字>   # 会话开始先查指派给你的任务
node $TB claim <id> --cwd "$PWD" --by <你的名字>   # 认领（原子，失败退出码 3 = 已被抢）
node $TB update <id> --cwd "$PWD" --action start|stop|submit|done --by <你的名字>
node $TB update <id> --cwd "$PWD" --action approve|reject --note "审核意见" --by <你的名字>
node $TB comment <id> --cwd "$PWD" --text "…" --by <你的名字>
约定：做完 submit 并 comment 交接；打回必须 comment 原因；价值度 --value 1/2|1|2|3|5|8；你的名字 = harness 名（kimi/claude/dsh）。`,
    `## Task board (required reading for every agent)
This directory has a shared task board; the single source of truth is .dsh/taskboard.json. Never edit the JSON by hand — always use the CLI:
TB=${bin}
node $TB list --cwd "$PWD" --assignee <your-name>   # at session start, check the tasks assigned to you
node $TB claim <id> --cwd "$PWD" --by <your-name>   # claim (atomic; exit code 3 = already taken)
node $TB update <id> --cwd "$PWD" --action start|stop|submit|done --by <your-name>
node $TB update <id> --cwd "$PWD" --action approve|reject --note "review note" --by <your-name>
node $TB comment <id> --cwd "$PWD" --text "…" --by <your-name>
Rules: when done, submit and comment a handoff; a reject must come with a comment; value --value 1/2|1|2|3|5|8; your name = your harness name (kimi/claude/dsh).`,
  )
}

/** The dispatch template (方式 B/C: msg9 mail or a paste into their session). */
export function dispatchSnippet(cli: string | null, cwd: string): string {
  const bin = cli ?? CLI_FALLBACK
  return L(
    `我们在 ${cwd} 有一块共享任务看板（多 Agent 协同），请你加入：
1) 不要手改 .dsh/taskboard.json，统一用 CLI：TB=${bin}
2) 会话开始先跑：node $TB list --cwd ${cwd} --assignee <名字>  # 查指派给你的任务
3) 流程：待认领先 claim；指派给你的先 start；做完 submit + comment 交接；审核 approve/reject（打回必留 comment）
4) 你的名字 = <名字>（--by 和 assignee 都用它）
5) 你的第一个任务：T-__（也可自己从待认领池挑）`,
    `We have a shared task board (multi-agent collaboration) in ${cwd} — please join in:
1) Never edit .dsh/taskboard.json by hand; always use the CLI: TB=${bin}
2) At session start, run: node $TB list --cwd ${cwd} --assignee <name>  # find the tasks assigned to you
3) Flow: claim pool tasks first; start tasks assigned to you; when done submit + comment a handoff; reviewers approve/reject (a reject must come with a comment)
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
  return `[ -f .dsh/taskboard.json ] && { OUT=$(node ${bin} list --cwd "$PWD" --assignee ${name} 2>/dev/null); [ -n "$OUT" ] && [ "$OUT" != "(board is empty)" ] && echo "任务看板 · 指派给 ${name}：" && echo "$OUT"; } || true`
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
