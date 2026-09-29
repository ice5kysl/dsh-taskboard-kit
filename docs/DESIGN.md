# dsh-taskboard-kit — 设计笔记

## 定位

每个 dsh workspace 一块本地任务看板。单一真实来源 = `<workspace>/.dsh/taskboard.json`，无服务端、无账号体系。板文件放 workspace 内（而不是 `~/.dsh/`）是有意为之：同一目录干活的多个 harness（dsh / kimi-code / claude-code）和人类都能读写同一块板。

## 分层

```
Agent ── taskboard_* tools ─┐
                            ├─ src/host/store.ts（领域操作，锁内读-改-写）
浏览器 ─ /dsh-taskboard/* ──┘            │
        （信任门：回环/同源 + mutate 头） ▼
                              <workspace>/.dsh/taskboard.json（tmp+rename，0600）
```

- `src/shared/types.ts` / `src/shared/bridge.ts` 是 host/client 双面契约的唯一入口，禁止漂移。
- 存储层只留两个原语（`loadBoard` / `withBoardLock`），未来 msg9 服务端后端实现同一接口即可替换；状态名（open / in_progress / done / cancelled）刻意对齐 msg9 任务模型。
- claim 的原子性 = 锁内判定 `status==='open' && !assignee`：N 个并发认领恰好一个成功。锁文件 `taskboard.json.lock`：`open(wx)` 排他创建 + mtime>10s 过期回收 + 持锁 pid 死亡检测。

## 明确不做

远程服务端、msg9 依赖、watcher/推送、settings 页、slash 命令、列内拖拽排序。

v0.2 已移出此清单：**列间拖拽**（`src/shared/dnd.ts` 的 `planDrop` 把拖放编译成 claim/update 操作序列，含为此新增的 `stop` 流转）和**任务评论**（`Task.comments`，tool/bridge/CLI/UI 四通道，只留信息不动状态机）。

v0.5.1 已移出此清单：**markdown 渲染**——`src/client/markdown.ts` 是一个零依赖 mini renderer（先转义、只注入自己造的标签，链接限 http/https，bundle 仍只 require react），detail 与评论共用；随后补上了 **GFM 表格**（表头 + `|---|` 分隔行 + `:--`/`--:` 列对齐，单元格沿用同一套 escape-first inline 规则，`\|` 与 code span 内的竖线不切列）、`---` 分隔线与 **setext 标题**（`标题\n---` 按 GFM 出 h2，不会被误当成分隔线），表格样式（`.tb-table-wrap` 横向滚动 + th/td 边框）放在 `TB_CSS` 的 `.tb-md` 段内，两套主题都吃 token。

仍未做（写卡给下一轮）：图片（`![alt](url)` 现在会退化成 `!` + 链接）、嵌套列表（缩进被抹平）、任务清单复选框（`- [ ]` 保持字面量）。

v0.5.4 已移出此清单：**多 Agent 协作协议**——规范文本见 `docs/COLLABORATION.md`，精简版进系统提示词
（`src/host/index.ts` 的 `protocolText()`），CLI `--help` 与面板「? 指南」片段同源。落地的东西：

- `Task.reviewer`（谁欠审核；approve/reject 只归 reviewer / 卡主 / 人类，自审被拒）与 `Task.waiting_on`
  （在等谁，**与状态正交**：一张卡同时「进行中」和「等人类」是常态，塞进状态机只会逼人撒谎）；
  `block`/`unblock` 因此是**不动状态机**的动作。
- 板级 `actors` 名册（`last_seen_at` 是活性唯一证据，别名 `dsh ≡ dsh-agent`）+ `TASKBOARD_ACTOR_ALIASES`
  / `TASKBOARD_HUMANS` / `TASKBOARD_SIBLING_NAMES`（同实例多会话：算我的，但动作会通知我）。
- `src/shared/board.ts`：host 与 client 共用的派生层——列龄（取最后一次**改变列**的事件，留言不算，
  否则「留言刷活」会掩盖停滞）、每列 SLA、`boardHealth`（交接断了 / 审核没人认领 / 在等人类 / 列陈旧，
  **只让事实可见，绝不自动裁决**）、`inboxFor`（按急迫度排序的行动清单）。
- 看板从「等你来查」变成「主动推给你」：会话开始注入**自己那一份** inbox；watcher 增加**时钟自检**
  （文件 watcher 看不到「三天没人碰这张卡」这个最主要的失效模式）；等人类超 SLA 触发升级与
  `TASKBOARD_NOTIFY_CMD` 外发通知（看板不依赖 msg9，接什么由使用者决定）。

**明确不做**（协作面）：不自动 approve / reject / close / 改派；不做跨 workspace 看板；不做服务端。

## bridge 错误分层

领域错误（conflict / not-found / invalid-input / invalid-transition）→ HTTP 200 + `{ ok:false, code }` 信封；传输层问题（不可信调用方、缺 mutate 头、坏 JSON、超限、未知路由）→ 真实 HTTP 状态码 + 同款信封。
