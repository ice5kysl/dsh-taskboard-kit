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

## 明确不做（v0.1）

远程服务端、msg9 依赖、watcher/推送、settings 页、slash 命令、拖拽排序、markdown 渲染（detail 走 pre-wrap 纯文本，保持 client bundle 只 require react）。

## bridge 错误分层

领域错误（conflict / not-found / invalid-input / invalid-transition）→ HTTP 200 + `{ ok:false, code }` 信封；传输层问题（不可信调用方、缺 mutate 头、坏 JSON、超限、未知路由）→ 真实 HTTP 状态码 + 同款信封。
