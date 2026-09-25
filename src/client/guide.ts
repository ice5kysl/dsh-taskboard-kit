/**
 * Copy templates of the guide overlay — pure functions so the panel, the
 * tests and any future surface interpolate the same text.
 *
 * Both templates teach an external agent (kimi / Claude Code) how to join
 * this workspace's board: never edit the JSON by hand, always drive the CLI.
 * `cli` is the absolute path the host reports; when it is unknown the
 * templates degrade to a placeholder the user can search-replace once.
 *
 * @module dsh-taskboard-kit/client-guide
 */

import { L } from './locale.ts'

/** Placeholder used when the host did not report the CLI's location. The
 *  string is deliberately locale-independent: it is a path, not prose. */
export const CLI_FALLBACK = '<taskboard 插件目录>/bin/taskboard.mjs'

/** The AGENTS.md convention template (方式 A: the workspace convention file). */
export function conventionSnippet(cli: string | null, cwd: string): string {
  const bin = cli ?? CLI_FALLBACK
  return L(
    `## 任务看板（所有 Agent 必读）
本目录有一块共享任务看板，唯一真实来源是 .dsh/taskboard.json。不要手改 JSON，统一用 CLI：
TB=${bin}
node $TB list --cwd ${cwd} --assignee <你的名字>   # 会话开始先查指派给你的任务
node $TB claim <id> --cwd ${cwd} --by <你的名字>   # 认领（原子，失败退出码 3 = 已被抢）
node $TB update <id> --cwd ${cwd} --action start|stop|submit|done --by <你的名字>
node $TB update <id> --cwd ${cwd} --action approve|reject --note "审核意见" --by <你的名字>
node $TB comment <id> --cwd ${cwd} --text "…" --by <你的名字>
约定：做完 submit 并 comment 交接；打回必须 comment 原因；价值度 --value 1/2|1|2|3|5|8；你的名字 = harness 名（kimi/claude/dsh）。`,
    `## Task board (required reading for every agent)
This directory has a shared task board; the single source of truth is .dsh/taskboard.json. Never edit the JSON by hand — always use the CLI:
TB=${bin}
node $TB list --cwd ${cwd} --assignee <your-name>   # at session start, check the tasks assigned to you
node $TB claim <id> --cwd ${cwd} --by <your-name>   # claim (atomic; exit code 3 = already taken)
node $TB update <id> --cwd ${cwd} --action start|stop|submit|done --by <your-name>
node $TB update <id> --cwd ${cwd} --action approve|reject --note "review note" --by <your-name>
node $TB comment <id> --cwd ${cwd} --text "…" --by <your-name>
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
