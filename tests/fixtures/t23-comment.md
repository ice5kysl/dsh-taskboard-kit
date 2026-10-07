## T-23 交接：客户端省配额两条（已完成，待审）

### 一句话
**两条重复请求都消掉了，而且是"数出来"的**：1 小时 28 信箱的徽章对账从 **840 次 `folder=all&limit=1` → 0 次**；22 次同一地址解析从 **22 次 `/resolve` → 1 次**。兜底（通道断了/快照过期/本地快照读不到 ⇒ 退回服务器直查）一条都没省。

### 改了什么（8 个源文件 + 2 个新文件）
| 文件 | 改动 |
|---|---|
| `src/host/http.ts` | 新增**未读快照登记表**（按 workspace key）+ `computeUnread` 三级取值（流页 → 本机 daemon → REST 兜底）+ `invalidateUnreadCache(key?)` 按 key 失效 |
| `src/host/watch.ts` | 新增 `deps.onInboxSnapshot`：stream 页 / 轮询页**已经拿到**的未读读数交出去（0 额外请求） |
| `src/host/index.ts` | 接线：流页喂快照；循环退出时 `clearInboxSnapshot`；daemon 连上时把 `/unread` 接进 `readLocalSnapshots` |
| `src/host/api.ts` | `/resolve` 的 **LRU + TTL 缓存**（`createResolveCache`，进程级共享） |
| `src/host/daemon/engine.ts` | 每次 fetch 把 `unread_count` 记进 state；`unreadSnapshot()` 暴露给控制面 |
| `src/host/daemon/state.ts` | `unread_count` / `mailbox_total` / `unread_at`（持久化，重启后首轮 fetch 前也可展示） |
| `src/host/daemon/server.ts` | `GET /unread`（127.0.0.1 + token 鉴权） |
| `src/host/daemonclient.ts` | `readUnread()`；老 daemon 404 / 不可达 ⇒ 空数组（自动退回 REST） |
| `scripts/quota-probe.mjs`（新） | **按 path 计数的配额探针**（假 msg9 服务器 + 真实代码路径），改前改后同一脚本 |
| `tests/quota.test.mjs`（新，21 项） | 省配额 / 同义化契约 / 兜底 / 缓存 / daemon 侧 |

### 关键取舍

**① 去掉 per-inbox 未读轮询 —— 靠什么兜底**
未读数有**三个来源**，越靠前越省配额，源头是"推送通道已经付过配额的那一页"：
1. 进程内 `/inbox/stream` 页的快照（v1.41.5 **T-74** 之后 `Total` 与 REST 同义、`unread_count` 本来就是同一个 `CountUnread(address)`）→ **0 次上游**；
2. 机器级 **daemon** 的快照（它才是本机推送通道持有者；我实测本机 daemon PID 40019 活着、本实例已注册，所以**这条才是生产上真正生效的那条**）→ **0 次上游**（只走 127.0.0.1）；
3. **REST 兜底** `folder=all&limit=1` —— 只对"**没有新鲜快照**"的信箱发一次。

兜底触发条件（都测试锁死，见变异 ②③）：
- 通道**结束**时 `clearInboxSnapshot` 立即失效（不是等年龄过期）；
- 快照超过 `INBOX_SNAPSHOT_MAX_AGE_MS = 240s`；
- 本机 daemon 读不到（挂/404/没启动）⇒ `readLocalSnapshots` 返回空 ⇒ 全部走 REST。

**240s 的理由**：必须**明显大于最慢那条通道的刷新周期**，否则安静信箱会在"用快照/退回 REST"之间抖，而退回 REST 正是本卡要消的开销。两条周期：流 `wait=25s`（**超时也返回带 `unread_count` 的空页**，服务端 `StreamInbox` deadline 分支）／ daemon 安全网 `safetyNetMs=120s`。取 2× 最慢 = 240s。

**⚠️ 有界的新鲜度代价（要知情）**：面板**自己**标已读/闭环会 `invalidateUnreadCache(key)` ⇒ 那个信箱立刻 REST 直查，徽章马上掉（**没有退化**）。但"**别处**（另一台机器/另一个客户端）读了信"时，徽章现在的滞后上界从 ≤10s 变成"daemon 读数年龄 ≤120s + 对账周期 120s"。**只影响侧栏那个数字**，`msg9_inbox` / 服务器 inbox 这条真相源一点没动。

**② `/resolve` 缓存 —— 缓存键、失效、TTL**
- **键** = `apiUrl + '\0' + address`（**原样**，不自造大小写/空白归一 —— 缓存键必须与真正发出的请求一一对应）；
- **只缓存正结果**：`exists === false` **不进缓存**（否则刚建好的对端会被"不存在"钉住 —— 正是 AGENTS.md 里"发错地址不报错、只会静默躺着"那类事故的温床）；抛错同样不缓存（测试锁死，见变异 ⑦）；
- **TTL = 5 分钟**（卡上下限）+ **LRU 上限 256**。理由：地址记录（存在性/inbox_url/公钥/黄页）极少变；5 分钟既是"对端换 key/重挂最多被藏 5 分钟"的上界，又覆盖实测一天 591 次同址解析。**不许永不过期**（变异 ⑥）。

### 前后请求次数实测对照（同一脚本、固定工作量：28 信箱 / 30 轮对账 = 生产 1 小时；`ttlMs:0` 忠实模拟"TTL 早已过期"）

| 场景 | `folder=all&limit=1` 改前 → 改后 | `/resolve` 改前 → 改后 |
|---|---|---|
| S1 进程内 stream 在跑（+56 次 stream 页不变） | **840 → 0** | — |
| S2 daemon 拥有推送通道（本机生产形态） | **840 → 0** | — |
| S3 /resolve 热路径（22 次同址 + 8 个异址） | — | **30 → 9**（同址 22 → 1） |

> 复现：`node scripts/quota-probe.mjs --label 改前|改后 --json <out>`（探针用 `??` 兜底新导出，**旧产物也能跑**，所以同一份脚本能给出两侧数字）。
> 与生产日志的比例对照：PO 数出 3380 次/天 = 28 信箱 × ~120 轮/天，正是这条 per-inbox 轮询。

### 测试 / typecheck 原始尾部
```
—— smoke: 通过（0.1s）   —— client: 通过（1.6s）   —— cordis: 通过（0.1s）
—— watch: 通过（0.1s）   —— watch-integration: 通过（3.8s）  —— host-fixes: 通过（6.6s）
—— credentials: 通过（0.2s） —— explicit-provision: 通过（0.1s） —— relink: 通过（0.1s）
—— org-pod: 通过（0.1s） —— daemon: 通过（3.1s） —— ledger: 通过（0.1s）
—— quota: 通过（0.1s）
✅ 13 个套件全部通过
```
```
$ npx tsc -p tsconfig.json --noEmit
typecheck exit=0 (无输出=干净)
```

### 变异验证（9 个变异，全部变红；每次都是"改源码 → 构建 → 跑 quota 套件"）
| 变异 | 结果 |
|---|---|
| ① 忽略未读快照（把 per-inbox 轮询开回来） | **红 9 项**（A1/A2/A3/A4/A5/C2/C3/C4/C5） |
| ② 快照永不过期（流断了也不退回 REST） | 红 1（C2） |
| ③ 通道结束时不清快照 | 红 1（C1） |
| ④ 缺字段当成 0（中断即清零徽章） | 红 2（C3/C4） |
| ⑤ 失效不按 key（一次已读直查所有信箱） | 红 1（C5） |
| ⑥ `/resolve` TTL 变永不过期 | 红 1（B7） |
| ⑥b 把 `/resolve` 缓存关掉（TTL=0） | 红 4（B1/B2/B3/B7） |
| ⑦ `exists:false` 也缓存 | 红 1（B5） |
| ⑧ daemon 把 since 模式的 total 当信箱大小（T-74 语义分叉） | 红 1（D1） |

> ⑥ 第一次跑是**绿的** —— 暴露了我最初那条 TTL 断言只测了机制、没测默认值（用注入 TTL）。已补 `B7`（下界 ≥5min、上界 ≤1h、且默认 TTL 行为上必须过期），并**人工确认变异确实落到 `lib/index.js`** 后重跑 ⇒ 红。

### 没做的部分与原因
1. **`onlyUnprocessed` 的 `folder=unprocessed&limit=100`**（每批投递一次）：不在卡的 3380 口径里，且它是 v1.20「已在别处闭环的信不得再唤醒」的判定依据 —— 砍了会动可靠性语义，需要单独评估，未动。
2. **T-13 二期**（ingest 换租户级流）：卡上明确"不依赖二期、可以先做"，未触碰。
3. **daemon 的 WS 帧不带未读**：目前 daemon 的读数在每次 fetch 时记录（WS 帧→fetch、安全网 120s）。要更实时得让平台在 WS 帧里带 `unread_count`，属平台侧，不在本卡。
4. **没 commit / 没 push / 没 bump / 没 publish**（按卡上要求，远端历史与发布决策归卡主/人类）。`lib/` 已按仓库既有 `npm run build` 重建（`lib/index.js` 变了、`lib/client.js` 未变）。
5. **本机正在跑的 daemon（PID 40019）与 dsh web 没有重启** ⇒ 新代码要等**下一次重启**才生效（老 daemon 没有 `GET /unread`，插件会静默退回 REST，是安全的降级）。

### 两个必须知情的环境事实
1. **`npm run build` 会整体替换 `lib/`** ⇒ 本次构建顺带清掉了工作区里两个**未跟踪**的 iCloud 重复文件 `lib/index 2.js` / `lib/client 2.js`（内容是 `lib/index.js` / `lib/client.js` 的重复副本，非仓库资产）。未跟踪、无唯一内容，但确有消失，如实报备。
2. **`daemon` 套件有一条既存的 flaky**（`orphan pending: 假死 key 的批次超阈值…`，断言归档日志但 `waitFor(pending.length===0)` 可能在日志落地前返回）。**与本卡无关**：把 `src/` 全部还原后重跑 6 次仍失败 2 次；带本卡改动跑 6 次失败 3 次（同量级噪声）。未改该测试（不动既有口径）。
