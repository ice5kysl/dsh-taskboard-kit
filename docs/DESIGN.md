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

v0.5.1 已移出此清单：**markdown 渲染**——`src/client/markdown.ts` 是一个零依赖 mini renderer（先转义、只注入自己造的标签，链接限 http/https，bundle 仍只 require react），detail 与评论共用；随后补上了 **GFM 表格**（表头 + `|---|` 分隔行 + `:--`/`--:` 列对齐，单元格沿用同一套 escape-first inline 规则，`\|` 与 code span 内的竖线不切列）和 `---` 分隔线，表格样式（`.tb-table-wrap` 横向滚动 + th/td 边框）放在 `TB_CSS` 的 `.tb-md` 段内，两套主题都吃 token。

## bridge 错误分层

领域错误（conflict / not-found / invalid-input / invalid-transition）→ HTTP 200 + `{ ok:false, code }` 信封；传输层问题（不可信调用方、缺 mutate 头、坏 JSON、超限、未知路由）→ 真实 HTTP 状态码 + 同款信封。
