# 多 Agent 协作规范（dsh-taskboard-kit）

> 这份文档是**规范**，不是教程。dsh 插件在会话开始就把它的精简版写进系统提示词（`src/host/index.ts` 的
> `protocolText()`），`bin/taskboard.mjs` 的 `--help` 和面板「? 指南」里的片段是它的执行入口。
> 三者必须一致：改协议就同时改这三处。
>
> 一句话：**看板是唯一事实源，占位在动手之前，交接在完成之时，卡住要说清在等谁，能自己推进的不要等人。**

## 0. 为什么需要它

一块共享看板只有两种结局：要么它反映现实，要么它变成一份过期文档。让它活下来的不是工具功能，
而是**每个 Agent 都遵守同一套约定**，以及**不遵守时看板会主动指出**。本规范的每一条都对应一个
真实踩过的坑（见 `T-3`/`T-4`/`T-8` 的卡片留言）：

| 坑 | 规范里的对策 |
|---|---|
| 卡派给一个早已消失的 Agent，在 review 列躺了 3 天没人发现 | §2 名册 + §10 陈旧检测 + §11 升级阶梯 |
| 有张卡其实在等人类排期，却长得跟「待认领」一样 | §9 `block --on human`（等谁的卡不可认领） |
| submit 之后没人知道该谁审，审核列成了黑洞 | §7 `reviewer` 必填 + §8 裁决权 |
| 卡被打回后当事人毫无察觉，一周后才发现 | §10 自检推送（`returned`） |
| 同一个 workspace 两个 dsh 会话，互相看不见对方的动作 | §2.3 会话级身份（`TASKBOARD_SIBLING_NAMES`） |

## 1. 唯一事实源与三条铁律

1. **唯一事实源**是 `<workspace>/.dsh/taskboard.json`。**永远不要手改这个 JSON** —— 锁、原子认领、
   结构校验都在 store 里；手改会绕过并发保护。
2. 一切操作走 `taskboard_*` 工具（dsh 内）或 `bin/taskboard.mjs`（任何 shell）。
   浏览器面板走同一套 bridge，人类的操作记为 actor `human`。
3. **看板是状态的事实源，通知通道是叫人的手段。** 不要把状态讨论留在聊天里、把结论只写在看板上不进 commit；
   也不要指望人类去看聊天记录——该人类拍板的事必须落到卡片上（§9）。

## 2. 角色与身份

### 2.1 三层身份

| 层 | 例子 | 用途 |
|---|---|---|
| Actor（名册里的规范名） | `dsh`、`kimi`、`claude`、`human` | 负责人、审核人、等谁 |
| 别名 | `dsh-agent` ≡ `dsh` | 同一个 Agent 的多个写法统一成一个主人 |
| 会话级名 | `dsh-audit`、`dsh-web` | 同一实例的多个会话，各自署名以便互相可见 |

**别名**由 `TASKBOARD_ACTOR_ALIASES=dsh:dsh-agent|dsh-audit,kimi:kimi-code` 配置；
`TASKBOARD_WATCH_NAMES=dsh,dsh-agent` 的第一位是规范名，其余自动成为别名。
内置默认：`dsh ≡ dsh-agent`。

**人类**：`human` 永远算人类；`TASKBOARD_HUMANS=iceskysl` 把实名也标成人类。
人类的操作永远被允许（见 §8），因为「人类拍板」是协议里的最终出口。

### 2.2 名册（roster）与活性

板级 `actors` 是**活性证据**，不是装饰：

- `last_seen_at` 只在**该 Actor 真的动手**时刷新（创建/认领/更新/留言）。
  **被写进 assignee 不算活着** —— `last_seen_at: null` 表示「从未动手」。
- **旧板自动回填**：v0.5.4 之前写出的板没有名册，读的时候会从 log 与留言里**推导**每个名字的最后活动时间
  （这两处本来就是活动证据），所以老板不会把明明在干活的 Agent 报成「从未动手」；已有记录不会被覆盖。
- 派活前先 `taskboard_roster`：派给一个**已经 36 小时没露面**的 Actor 才是制造孤儿卡；
  派给一个还没开工的新名字是正常交接（看板不会立刻告警，只会在它静默超过窗口后点名）。

### 2.3 同一实例的多个会话（会话级身份）

两个 dsh 会话在同一个 workspace 里共用一个 workspace 看板，但它们**不共享记忆**。默认配置下
两者都署名 `dsh`，于是：

- 各自的动作都会被对方当「自回声」过滤掉 → **互相看不见**；
- 或者反过来，把对方的动作当陌生人的 → 刷屏。

约定：

- 每个会话用**自己的** `TASKBOARD_ACTOR`（如 `dsh-audit`）与 `TASKBOARD_WATCH_NAMES`（只写自己）；
- 把同一个实例的其他会话名写进 `TASKBOARD_SIBLING_NAMES=dsh,dsh-web`；
- 用别名把它们统一成一个主人：`TASKBOARD_ACTOR_ALIASES=dsh:dsh-agent|dsh-audit|dsh-web`。

效果：**sibling 的卡算我的**（负责人、陈旧、孤儿都归我盯着），**但它的动作会通知我**（不是自回声）。

## 3. 任务模型

```
状态：open ──▶ in_progress ──▶ review ──▶ done ──▶ closed
        │            │            │                ▲
        └────────────┴────────────┴────────────────┘
        done / closed ──▶ open（reopen）
```

**只有 `closed` 是终态。** `done` 的含义是「干完且审核通过」，**不是**「这件事了了」：

- `done` 的卡**仍在看板上**、**仍计入未结清**，需要卡主 / PO / 人类收口 `close`；
- 为什么分两步：审核通过 ≠ 事情结清（可能还要部署、等上游签字、补文档），把它俩合成一步
  就会出现「看起来完了、但没人负责收尾」的灰区；
- 「这事不做了」也走 `close`，**但必须在 note / comment 里写清原因** —— 没有单独的 abandoned 状态，
  「做完了」和「放弃了」的差别只存在于留言里；
- 面板顶部有「待收口」条：所有 `done` 未结清的卡列在那里，一键收口 —— 这正是为了防止
  「审核过了就没人再动」的腐烂（本轮修的就是这个）。

两条**与状态正交**的协作轴（v0.5.4 新增，都不引入新状态）：

| 字段 | 含义 | 谁写 | 何时清 |
|---|---|---|---|
| `reviewer` | 谁欠这次审核 | `submit`（可显式指定） | `approve`/`reject`/`done`/`close`/`reopen` |
| `waiting_on` | 这张卡在等谁（`human` / `agent` / `external` + `who` + `question` + `since`） | `block` | `unblock`、或 `submit`/`done`/`close`/`reopen` |

> 为什么不给「等人类」加一个状态：因为一张卡**同时**处在「进行中」和「等人类」是常态。
> 把等待塞进状态机，就会被迫在「它到底算不算在做」上撒谎。

`priority`（high/medium/low）与 `value`（½/1/2/3/5/8，`null` = 未评估）用于排优先级与挑活。

## 4. 动作与前置/后置条件

| 动作 | 允许的来源状态 | 结果 | 额外约束 |
|---|---|---|---|
| `claim` | `open` 且**无负责人**且**未在等谁** | `in_progress`，assignee = 我 | 原子：并发下恰好一个成功（CLI 退出码 3 = 冲突） |
| `start` | `open` | `in_progress` | 指派给你的卡用它「占位」 |
| `stop` | `in_progress` | `open`（保留 assignee） | 让出但保留所有权，等人接手 |
| `submit` | `in_progress` | `review`，写 `reviewer` | 审核人不能是自己（见 §7）；清 `waiting_on` |
| `approve` | `review` | `done` | 只有 reviewer / 卡主 / 人类 |
| `reject` | `review` | `in_progress` | 同上；**必须** `--note` 写原因 |
| `done` | `open`/`in_progress`/`review` | `done`（**非终态**） | 自审绕行口，仅用于「无需审核」的琐事；有 reviewer 时优先走 submit。**done 之后仍需 close 收口** |
| `close` | 非终态 + `done` | `closed`（**唯一终态**） | 收口结清；「不做」也走它，但**必须写原因**；`cancel` 是旧别名 |
| `reopen` | `done`/`closed` | `open`（保留 assignee） | 清 `reviewer` / `waiting_on` |
| `block` | `open`/`in_progress`/`review` | **状态不变**，写 `waiting_on` | 必须给 `wait_question`；kind 可由 `wait_who` 推断 |
| `unblock` | 有 `waiting_on` | 状态不变，清 `waiting_on` | 答复写进 `comment` |

## 5. 会话开始：先看自己那一份

```
taskboard_inbox            # 必做第一步：按急迫度排好、每条都带该敲的命令
taskboard_get <id>         # 需要细节（时间线 + 留言 + 列龄 + SLA）
taskboard_roster           # 不熟这块板：谁还在场
taskboard_list             # 扫全板（含 reviewer / 等谁 / 陈旧标记）
```

`inbox` 的排序（越靠前越急）：`review_owed`（我欠审核）→ `unblock_me`（有人等我）→
`returned`（我的卡被打回）→ `stalled_mine`（我的卡陈旧）→ `orphaned_mine`（我派的活接的人不见了）→
`start_assigned`（指派给我没开工）→ `human_blocked`（在等人类，**去叫人**）→ `pool_pick`（池子里值得拿）。

> 会话开始时系统也会注入一份同样的摘要；不用等它，直接调 `taskboard_inbox`。

## 6. 动手之前先占位

- 池里的卡 → `claim`。**冲突 = 别人抢到了**，换一张或请示人类，**绝不做同一张**。
- 指派给你的卡 → `start`。
- 两张卡有先后关系时，别并行硬做：把后者 `block --on agent --who <对方>` 说明依赖。

## 7. 完成 → 交审核（不要自己 done）

```
taskboard_update <id> --action submit --reviewer <名字>
taskboard_comment <id> --text "做了什么 / 验证了什么 / 还差什么"
```

- **交接留言是提交的一部分**：没有它，审核人无法验收 —— 这是最常被省略、也最贵的一步。
- 审核人的解析顺序：显式 `--reviewer` → 卡上已有的 reviewer（重提）→ **卡主**（对自己派的活负责）
  → 名册里最近活跃的**其他** Agent → 都没有就交给 `human`。
- **不能审自己的活**：`--reviewer` 指到自己会被拒（唯一例外：`TASKBOARD_ALLOW_SELF_REVIEW=1`，
  只给「一个 Agent 独占一个 workspace」的场景）。

## 7.5 收口：done 之后必须有人 close

```
# 审核通过后的收口（卡主 / PO / 人类都能做）
taskboard_update <id> --action close --note "已部署上线"      # 结清
taskboard_update <id> --action close --note "方向变了，不做"  # 放弃（同样走 close，写清原因）
```

- **`done` 不是终点**：它只代表「干完且审核通过」，卡还在活跃视图里、还算未结清。
- 收口动作是 `close`，**它是唯一的终态**。收口后卡离开活跃计数（仍在「已结清」列，可 reopen 退回）。
- **不收口就是腐烂**：panel 顶部「待收口」条会一直挂着它，超过 72h 会被自检点名。
- 放弃也走 `close`：没有单独的 abandoned 状态，**「做完了」与「放弃了」的差别只存在于你写的 note 里**，
  所以 note 不是可选项。

## 8. 审核：有归属、有期限、有原因

- **裁决权**：`reviewer` 本人、任务卡主、`human`。其他 Agent 一律被拒（`conflict`）。
  —— 这样「审核」不会被不相干的人顺手点掉，卡主也永远能救活一个卡死的审核。
- **打回必须写原因**：`reject --note "…"`。打回后卡回到作者手上，作者改完再 submit。
- **期限**：review 列的陈旧阈值是 24h（见 §10）；到期后 reviewer 会收到自检点名。
- 交接对象消失（久未活动）时，**卡主的责任**是改派：`--assignee none` 放回池子或 `--assignee <活人>`。

## 9. 卡住：说清在等谁

```
# 等人类拍板（会进「等你」清单 + 触发外发通知 hook）
taskboard_update <id> --action block --on human --who iceskysl \
  --question "0.5.4 现在就发，还是等 T-8 的安全修复一起发？"

# 等另一个 Agent
taskboard_update <id> --action block --on agent --who kimi --question "T-3 审计结论能给我吗？"

# 答复到了
taskboard_comment <id> --text "答复：…"
taskboard_update <id> --action unblock
```

铁律：

1. **等谁的卡不能被认领**（`claim` 会被拒并说明原因）。「在等决定」≠「没人要」——这是 `T-8` 的教训。
2. `wait_question` 必须是**一句能原样转发给人**的问句。写「看看」「你觉得呢」等于没写。
3. **等人类不等于可以撒手**：block 之后**你有责任叫人**（你自己的通知通道 / 通知 hook），并在超时后按 §11 升级。
4. 只有三种情况值得把卡挂到人类身上：**对外动作**（发布、部署、发信）、**资源**（钱、账号、额度）、
   **方向取舍**（做哪个、砍哪个）。其余的自己决定并记录下来。

## 10. 及时性：状态一改就更，陈旧会被点名

**默认陈旧阈值**（超过即「陈旧」，可被环境变量覆盖）：

| 列 | 阈值 | 含义 |
|---|---|---|
| 待认领（open 无负责人） | 72h | 没人要 |
| 已指派（open 有负责人） | 48h | 指派了没开工 |
| 进行中 | 72h | 三天没动静 |
| 待审核（review） | 24h | 审核人欠一天 |
| 待收口（done） | 72h | 审核过了没人收口 |
| 已结清（closed） | — | 永不陈旧 |
| **等人类** | 24h | 超过即升级催办 |
| 等 Agent | 8h | 超过即升级催办 |
| 等外部 | — | 只能等 |

**一条重要的反误报规则**：「派给的 Agent 不见了」**不是立刻成立**的判定。刚把卡派给一个还没开工
（名册里 `last_seen_at: null`）的 Agent 是**正常交接**，不是孤儿卡；只有卡自己已经待够 36h 的静默窗口，
才算出问题。同理，有活动记录的名字要**距今超过 36h** 才被标为「久未活动」。默认静默窗口 36h（`DEFAULT_QUIET_MS`）。

**列龄的算法**：取 log 里**最后一次改变列的事件**时间。留言、`updated`、`block` **不算** ——
否则「留言刷活、实事没做」就永远暴露不出来。

**谁会被通知**：

- **变化推送**（fs.watch）：指派给你、审核结论、新留言、有人把审核 hand off 给你、有人开始等你、
  卡片开始等人类。5 秒风暴窗口内合并成一条，只注入 context，**绝不唤醒**。
- **时钟自检**（每 5 分钟一次，同一 workspace 30 分钟内最多催一次）：只看**压在你身上的**事
  （欠审核、有人等你、被打回没动、自己的卡陈旧、派出去的活成了孤儿、等人类超时），
  并附上该敲的命令。**文件 watcher 永远看不到「三天没人碰这张卡」，所以必须有这一个。**

## 11. 升级阶梯（能不依赖人类的就不依赖人类）

```
① 自己能做完的 → 做完，submit
② 依赖另一个 Agent → block --on agent，并在等超 8h 后催一次；对方消失 → 改派（卡主的责任）
③ 依赖人类 → block --on human + 主动叫人（msg9 / 桌面通知 / webhook，见 §12）；等超 24h → 升级催办（面板 + 外发 hook + Agent 再叫一次）
④ 真无法推进 → 保持 blocked，把「能自己推进的部分」拆成新卡先做掉，不要整张卡空等
```

**永远不要**：因为等人类而停止一切；把卡留在旧状态里假装在做；在聊天里承诺而不落到卡片上。

## 12. 人类这一侧（依赖人类的就加上人类）

人类不在 Agent 的循环里，所以「等人类」的卡必须真的能到达人类。三条通道，可靠性递减：

1. **面板「等你」清单**（始终可用，零配置）：看板页顶部一条 `◷ N 张卡在等你决定`，逐卡显示
   `等谁 / 已等多久 / 超时标记 / 完整问题原文`；点开即可看详情，输入回复后按「回复并解除等待」
   （先写 comment、再 unblock，顺序有测试保证）。mini 看板上也有 `◷N` 计数。
   ![面板「等你」清单](images/waiting-strip.png)
   *（面板用固定夹具板渲染的示意：顶部「◷ N 张卡在等你决定」给出等谁、等了多久、是否超时与问题原文；
   卡片上的 `等人类 iceskysl · 3d` / `等 Agent kimi · 5h` / `审核 kimi（久未活动）` 都是同一份派生数据。）*

2. **外发通知 hook**：`TASKBOARD_NOTIFY_CMD` —— 卡片开始等人类、或等超 SLA 时执行。
   卡片以 JSON 从 stdin 传入，同时注入 `TASKBOARD_TASK_ID` / `TASKBOARD_QUESTION` /
   `TASKBOARD_NOTIFY_REASON`（`blocked` / `overdue`）等环境变量。
   钩子失败**只记日志，绝不让写板失败**。接什么通道由你决定，例（换成 `notify-send` / `curl` webhook 同样成立）：
   ```bash
   TASKBOARD_NOTIFY_CMD='printf "%s\n" "$TASKBOARD_TASK_ID 等你决定" "$TASKBOARD_QUESTION" \
     | msg9 send --to dsh@proj.ice.msg9.io --subject "看板 $TASKBOARD_TASK_ID 等你决定"'
   ```
3. **Agent 自己去叫**：watcher 会把「有卡在等人类」注给该 workspace 的活跃会话，
   Agent 应当用**自己手上有的通道**直接叫人（msg9 / 邮件 / 任何能触达人类的方式）——**这是 Agent 的责任，不是看板的责任**（看板不知道人类的地址，也不预设通道）。

人类在面板上的操作记为 `human`，被允许做任何裁决；人类做的修改同样会推给相关 Agent。

## 13. 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `TASKBOARD_ACTOR` | 工具/CLI 写进 log 的操作者名 | 工具 `dsh-agent`；CLI `cli-agent` |
| `TASKBOARD_HUMANS` | 逗号分隔：哪些名字算人类 | `human` |
| `TASKBOARD_ACTOR_ALIASES` | `规范名:别名1\|别名2,…`：把多个名字并成一个主人 | `dsh:dsh-agent` |
| `TASKBOARD_WATCH_NAMES` | 本实例回答的所有名字（第一位为规范名，其余为别名） | `dsh,dsh-agent` |
| `TASKBOARD_SIBLING_NAMES` | 同实例的其他会话名：算我的，但动作会通知我 | 空 |
| `TASKBOARD_ALLOW_SELF_REVIEW` | `1` = 允许自审（单 Agent 独占 workspace 时的逃生门） | 关闭 |
| `TASKBOARD_NOTIFY_CMD` | 等人类的卡外发通知命令（见 §12） | 空（仅面板） |
| `TASKBOARD_WATCH` | `0` = 关掉推送与自检（工具/bridge 不受影响） | 开启 |
| `TASKBOARDKIT_LOCALE` | `en` 强制英文输出 | 中文 |

## 14. 反模式（看到就要修）

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| 不认领就开工 | 两个 Agent 做同一件事 | `claim` / `start` 先占位 |
| 自己 `done` 自己的活 | 没有验收，卡主不知情 | `submit` + `reviewer` |
| `submit` 不写交接留言 | 审核人无法验收 | 配一条 `taskboard_comment` |
| `reject` 不写原因 | 作者只能猜 | `--note` 写清哪里不够 |
| 把「等人类排期」的卡扔在池子里 | 看起来像没人要的活，人类也不知道 | `block --on human` + 主动叫人 |
| 用留言把卡「刷活」 | 列龄被清零，陈旧检测失效 | 留言不改列龄；该 `submit`/`block`/`close` 就改状态 |
| 派活给久未露面的名字 | 孤儿卡 | 先 `taskboard_roster` |
| 手改 `.dsh/taskboard.json` | 破坏锁与原子性 | 走工具/CLI |
| 只在聊天里答应，不落卡 | 看板与现实脱节 | 结论写进卡片 comment |

## 15. 与 msg9 任务模型的关系

状态名（`open` / `in_progress` / `done`）刻意对齐 msg9 的任务模型，未来接服务端看板时语义不变。
本 kit **不依赖** msg9，也**不依赖任何特定通知通道**：看板是本地文件，外发通知是可选 hook
（`TASKBOARD_NOTIFY_CMD`，接 msg9 / 桌面通知 / webhook 由你自己决定）。二者的分工是——
**看板记事实，通知通道叫人。**

> 本文档早期版本把 msg9 写成了唯一通道——那是针对本机装了消息插件（dsh-msg9-kit）的环境写的操作手册。
> msg9 只是**一个例子**，不是前置条件：没装消息插件的工作区，面板「等你」清单 + 自监控 hook 已经闭环。

## 16. 仍未做（明确留在这一轮之外）

- 不自动裁决：**没有任何自动 approve / reject / close / 改派**。看板只让事实可见（§10）。
- 不做跨 workspace 的看板：一块板属于一个目录；跨项目协作走 msg9（见全局 AGENTS.md）。
- 不做远端服务端 / 账号体系：仍是「一个 JSON 文件 + 一个锁」。
- 面板不做拖拽以外的批量操作、不做实时协同编辑。
