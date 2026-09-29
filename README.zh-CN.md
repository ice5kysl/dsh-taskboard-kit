# dsh-taskboard-kit

[![DSH Insights health](https://dsh-insights.com/badge/ice5kysl/dsh-taskboard-kit.svg)](https://dsh-insights.com/p/ice5kysl/dsh-taskboard-kit/)

给每个 dsh workspace 一块本地任务看板：Agent 用 model tools 创建、认领、推进任务，人类在 dsh web 的「看板」页签里看同一块板、也能直接操作。看板的唯一真实来源是 workspace 里的一个 JSON 文件——**没有服务端、没有账号体系、不需要部署任何东西**。

[English README](./README.md)

## 兼容性

- **dsh ≥ 0.1.7** — 自 **v0.5.3** 起完整支持：会话 cwd 改吃 `sessionId` 插槽 prop（0.1.7 从会话列表 state 里移除了 `current`）；看板入口适配 0.1.7 的紧凑居中 dock 布局；注入的看板通知改用 0.1.7 持久化层要求的 v4 生产者 source kind（`plugin:taskboard-kit`）。旧版 dsh 通过兜底逻辑继续可用。

## 包含什么

- **8 个 model tools**，Agent 在该 workspace 的任何会话里都能调用：
  - `taskboard_inbox` — **会话开始第一步**：现在压在你身上的事，按急迫度排序，每条都带该敲的命令
  - `taskboard_list` — 列出任务（按状态 / 列 / 负责人 / **在等谁**过滤）
  - `taskboard_create` — 新建任务，可选直接指派给谁
  - `taskboard_claim` — 从待认领池原子认领（并发下恰好一人成功；**在等谁的卡不可认领**）
  - `taskboard_update` — 开始 / 暂停 / 提交审核（指定审核人）/ 通过 / 打回 / 完成 / 关闭 / 重开 / **block / unblock**、改派、改字段（含价值度）、附注
  - `taskboard_comment` — 给任务留言（实现发现 / 交接说明 / 测试反馈），不改任务状态
  - `taskboard_get` — 任务全文 + 事件时间线 + 留言串 + 列龄 / SLA / 审核人 / 在等谁
  - `taskboard_roster` — 名册：谁真的在场（最后一次动手是什么时候、别名）
- **「看板」会话页签**：六条泳道（待认领 · 已指派 · 进行中 · 待审核 · 已完成 · 已关闭），卡片带优先级 / 价值度 / 负责人 / **当前列停留时长** / **陈旧点** / **审核人** / **在等谁**；顶部一条 **「◷ N 张卡在等你决定」** strip（完整问题原文 + 一键「回复并解除等待」）；详情抽屉里有事件流水、留言与协作事实，一键认领 / 开始 / 提交 / 通过 / 打回 / 关闭 / 改派。
- **多 Agent 协作规范**：完整规范见 [`docs/COLLABORATION.md`](./docs/COLLABORATION.md)；它的精简版在会话开始写入系统提示词，CLI `--help` 与面板「? 指南」里的片段同源。
- **会话开始感知**：Agent 收到的是**自己那一份行动清单**（不是我欠审核、谁在等我、哪张卡被打回、哪张派出去没人接），不是一句干巴巴的计数。
- **看板变化推送**：对每个 live 会话的板文件做 fs.watch——任务被指派给你、你的任务有了审核结论、**有人把审核 hand off 给你**、**有人开始等你**、**有卡开始等人类**、你的任务有新留言时自动通知（只注入上下文，绝不唤醒）；5 秒风暴窗口内的连续变化合并成一条通知。
- **时钟自检（v0.5.4）**：文件 watcher 永远看不到「三天没人碰这张卡」——所以另有一条按时的自检：只看压在你身上的事（欠审核、有人等你、被打回没动、自己的卡陈旧、派出去的活成了孤儿、等人类超时），每 5 分钟一轮、每 workspace 30 分钟最多催一次，并附上该敲的命令。
- **等人类 = 真的叫得动人类（v0.5.4）**：卡片 `block --on human` 时进面板「等你」清单；配了 `TASKBOARD_NOTIFY_CMD` 就外发通知（msg9 / 桌面通知 / webhook 随你接）；等超 24h 自动升级催办。

## 板文件

每个 workspace 一块：`<workspace>/.dsh/taskboard.json`（形状见英文版 README，字段自解释）。

文件跟着 workspace 走，所以在同一目录干活的每个 harness、每个人都能读写同一块板——提交进 git 或 gitignore 都可以。所有变更经过锁文件（过期锁自动回收）+ tmp+rename 原子写，并发 Agent 和面板同时操作不会写花文件；`claim` 在锁内裁决：N 个并发认领恰好一个成功，其余收到冲突。

## 状态模型

| 列 | 规则 |
|---|---|
| 待认领 | `open` 且无负责人且未在等谁——任何人可 `claim` |
| 已指派 | `open` 且有负责人——已委派、未开始 |
| 进行中 | 已认领或已开始 |
| 待审核 | 已提交（submit），等 **`reviewer`** 通过 / 打回 |
| 已完成 | 审核通过（或直接 `done`） |
| 已关闭 | 放弃的任务——`close`（面板默认折叠，toggle 可显示） |

两条**与状态正交**的协作轴（v0.5.4，都不新增状态）：

| 字段 | 含义 | 谁写 |
|---|---|---|
| `reviewer` | 谁欠这次审核。`reviewer` 本人 / 卡主 / 人类才能 approve|reject；**不能审自己的活** | `submit`（默认解析：卡主 → 最近活跃的其他 Agent → 人类） |
| `waiting_on` | 这张卡在等谁（`human`/`agent`/`external` + `who` + `question` + `since`）。**等谁的卡不能被认领** | `block` / `unblock` |

板级还有 `actors` **名册**（谁出现过、最后一次动手、别名 `dsh ≡ dsh-agent`）——用来回答「这活派给一个已经不在场的 Agent 了吗」。

流转图：`open → in_progress → review → done`；任何非终态可 `closed`；`done | closed → open`（reopen）。按动作说：`open → in_progress`（claim / start）、`in_progress → open`（stop）、`in_progress → review`（submit）、`review → done`（approve）、`review → in_progress`（reject）、`open|in_progress|review → done`、`open|in_progress|review|done → closed`（close，旧名 `cancel` 是它的别名）、`done|closed → open`（reopen）。状态名刻意对齐 msg9 任务模型，未来接服务端看板时语义不变。旧版本写出的板文件无感加载：`cancelled` 状态/日志事件归一为 `closed`，缺的 `value` / `comments` 字段自动补齐。

每个任务还有**价值度**（value points，斐波那契刻度 ½ / 1 / 2 / 3 / 5 / 8，`null` = 未评估），用来回答"这张卡值多少"——创建或更新时设置，CLI 里 `--value 1/2` 表示 ½、`--value none` 清除。

## 安装

```bash
dsh plugin --profile web add dsh-taskboard-kit
# 重启 dsh web，打开任意会话，「看板」页签就在
```

升级注意（0.x 版本锁 minor）：用 `dsh plugin --profile web add dsh-taskboard-kit@latest`，不要用 `dsh plugin update`。

## 给没有插件的 Agent 用（Kimi Code、Claude Code、任何 shell）

板就是一个文件，但**绝不要手改它**——锁和原子认领都在 store 里。kit 自带一个零依赖 CLI，封装的正是同一个 store，让每个 Agent 用同一个安全入口操作：

```bash
taskboard inbox --by kimi                   # ★ 会话开始第一步：现在该你处理的事（带该敲的命令）
taskboard list --waiting human               # 谁在等人类（--waiting agent|external|any 同理）
taskboard stale                              # 协作健康：在等人类 / 审核没人认领 / 交接断了 / 列陈旧
taskboard roster                             # 名册：谁还在场（派活前查）
taskboard claim T-3 --by kimi                # 原子认领，log 记 "kimi"（等谁的卡会被拒）
taskboard update T-3 --action submit --reviewer claude --by kimi   # 提交并指定审核人
taskboard update T-3 --action approve --by claude                  # 审核通过（非 reviewer/卡主/人类会被拒）
taskboard update T-3 --action block --on human --who iceskysl \
  --question "现在就发，还是等 T-8 修完？" --by kimi                # 挂到人类身上（触发外发通知）
taskboard update T-3 --action unblock --by kimi                    # 答复到了
taskboard comment T-3 --text "交接：…" --by kimi        # 不改任务状态
taskboard create --title "…" --priority high --value 3 --by claude
```

`--by` 指定 log 里的操作者（默认 `$TASKBOARD_ACTOR` 或 `cli-agent`）；`--cwd` 指向别的 workspace；`--json` 输出机器可读结果；认领失败退出码 `3` 并给出可读的冲突原因。包还没上 npm 之前，直接从仓库调用：`node /path/to/dsh-taskboard-kit/bin/taskboard.mjs list`。dsh web 跑不跑都能用；web 在跑时，本机进程也可以直接调回环 bridge `/dsh-taskboard/*`。

## 环境开关

| 变量 | 作用 |
|---|---|
| `TASKBOARD_ACTOR` | Agent 工具写进 log 的默认操作者名（默认 `dsh-agent`） |
| `TASKBOARD_HUMANS` | 逗号分隔：哪些名字算人类（默认 `human`） |
| `TASKBOARD_ACTOR_ALIASES` | `规范名:别名1\|别名2,…`——把同一个 Agent 的多个名字并成一个主人（默认 `dsh:dsh-agent`） |
| `TASKBOARD_WATCH_NAMES` | 逗号分隔的「自己人」名字列表（第一位为规范名，其余自动成为别名）；watcher 按它判断哪些变化与我有关、哪些是我的自回声（默认 `dsh,dsh-agent`） |
| `TASKBOARD_SIBLING_NAMES` | 同一实例的**其他会话**名：它们的卡算我的，但它们的动作会通知我（默认空）。默认配置下两个 dsh 会话会互相看不见，这一项就是解药 |
| `TASKBOARD_ALLOW_SELF_REVIEW` | `1` = 允许自审（只给「一个 Agent 独占一个 workspace」的场景） |
| `TASKBOARD_NOTIFY_CMD` | 卡片开始等人类 / 等超 SLA 时执行的外发通知命令；卡片 JSON 从 stdin 进，`TASKBOARD_TASK_ID` / `TASKBOARD_QUESTION` / `TASKBOARD_NOTIFY_REASON` 等从环境变量进。失败只记日志，绝不让写板失败 |
| `TASKBOARDKIT_LOCALE` | `en` 强制英文工具输出（默认中文） |
| `TASKBOARD_WATCH` | `0` 整体关闭变化推送与时钟自检 |

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
