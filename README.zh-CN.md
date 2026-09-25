# dsh-taskboard-kit

[![DSH Insights health](https://dsh-insights.com/badge/ice5kysl/dsh-taskboard-kit.svg)](https://dsh-insights.com/p/ice5kysl/dsh-taskboard-kit/)

给每个 dsh workspace 一块本地任务看板：Agent 用 model tools 创建、认领、推进任务，人类在 dsh web 的「看板」页签里看同一块板、也能直接操作。看板的唯一真实来源是 workspace 里的一个 JSON 文件——**没有服务端、没有账号体系、不需要部署任何东西**。

[English README](./README.md)

## 包含什么

- **5 个 model tools**，Agent 在该 workspace 的任何会话里都能调用：
  - `taskboard_list` — 列出任务（按状态 / 列 / 负责人过滤）
  - `taskboard_create` — 新建任务，可选直接指派给谁
  - `taskboard_claim` — 从待认领池原子认领（并发下恰好一人成功）
  - `taskboard_update` — 开始 / 完成 / 重开 / 取消、改派、改字段、附注
  - `taskboard_get` — 任务全文 + 事件时间线
- **「看板」会话页签**：四条泳道（待认领 · 已指派 · 进行中 · 已完成），卡片带优先级 / 负责人 / 存留时长 / 标签，详情抽屉里有事件流水，一键认领 / 开始 / 完成 / 重开 / 改派。
- **会话开始感知**：Agent 会被告知有几条待认领、几条进行中；系统提示词里写入了「先认领再动手」的协作规则。

## 板文件

每个 workspace 一块：`<workspace>/.dsh/taskboard.json`（形状见英文版 README，字段自解释）。

文件跟着 workspace 走，所以在同一目录干活的每个 harness、每个人都能读写同一块板——提交进 git 或 gitignore 都可以。所有变更经过锁文件（过期锁自动回收）+ tmp+rename 原子写，并发 Agent 和面板同时操作不会写花文件；`claim` 在锁内裁决：N 个并发认领恰好一个成功，其余收到冲突。

## 状态模型

| 列 | 规则 |
|---|---|
| 待认领 | `open` 且无负责人——任何人可 `claim` |
| 已指派 | `open` 且有负责人——已委派、未开始 |
| 进行中 | 已认领或已开始 |
| 已完成 | `done`（已取消的任务默认折叠，toggle 可显示） |

流转：`open → in_progress`（claim / start）、`open|in_progress → done`、`open|in_progress → cancelled`、`done|cancelled → open`（reopen）。状态名刻意对齐 msg9 任务模型，未来接服务端看板时语义不变。

## 安装

```bash
dsh plugin --profile web add dsh-taskboard-kit
# 重启 dsh web，打开任意会话，「看板」页签就在
```

升级注意（0.x 版本锁 minor）：用 `dsh plugin --profile web add dsh-taskboard-kit@latest`，不要用 `dsh plugin update`。

## 给没有插件的 Agent 用（Kimi Code、Claude Code、任何 shell）

板就是一个文件，但**绝不要手改它**——锁和原子认领都在 store 里。kit 自带一个零依赖 CLI，封装的正是同一个 store，让每个 Agent 用同一个安全入口操作：

```bash
taskboard list                              # 看板（待认领在前）
taskboard claim T-3 --by kimi               # 原子认领，log 记 "kimi"
taskboard update T-3 --action done --note "搞定了" --by kimi
taskboard create --title "…" --priority high --by claude
```

`--by` 指定 log 里的操作者（默认 `$TASKBOARD_ACTOR` 或 `cli-agent`）；`--cwd` 指向别的 workspace；`--json` 输出机器可读结果；认领失败退出码 `3` 并给出可读的冲突原因。包还没上 npm 之前，直接从仓库调用：`node /path/to/dsh-taskboard-kit/bin/taskboard.mjs list`。dsh web 跑不跑都能用；web 在跑时，本机进程也可以直接调回环 bridge `/dsh-taskboard/*`。

## 环境开关

| 变量 | 作用 |
|---|---|
| `TASKBOARD_ACTOR` | Agent 工具写进 log 的默认操作者名（默认 `dsh-agent`） |
| `TASKBOARDKIT_LOCALE` | `en` 强制英文工具输出（默认中文） |

## 浏览器桥

面板通过 `/dsh-taskboard/*` 与宿主通信。只接受回环 / 同源调用；所有 POST 必须带 `x-taskboard: mutate` 头。浏览器侧的操作在任务 log 里记为 `human`。

## 开发

```bash
npm install
npm run build       # esbuild → lib/index.js + lib/client.js
npm test            # node 原生 runner：store、host smoke、client
npm run typecheck   # tsc --noEmit
```

零运行时依赖。浏览器 bundle 只 require shell 内置的 `react` / `react/jsx-runtime`。

## License

MIT
