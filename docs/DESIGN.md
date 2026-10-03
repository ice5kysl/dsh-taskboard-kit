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

远程服务端、msg9 依赖、settings 页、slash 命令、列内拖拽排序。

v0.5.0 已移出此清单：**board watcher / 主动推送**——`src/host/watch.ts` 每个 live session 的 `.dsh/` 目录一个 `fs.watch`，300ms 去抖 + 每 workspace 5s 风暴窗口合并成一条 `agent.inject` 通知（只注入上下文，不打断回合），`TASKBOARD_WATCH=0` 可整体关掉。

v0.2 已移出此清单：**列间拖拽**（`src/shared/dnd.ts` 的 `planDrop` 把拖放编译成 claim/update 操作序列，含为此新增的 `stop` 流转）和**任务评论**（`Task.comments`，tool/bridge/CLI/UI 四通道，只留信息不动状态机）。

v0.5.1 已移出此清单：**markdown 渲染**——`src/client/markdown.ts` 是一个零依赖 mini renderer（先转义、只注入自己造的标签，链接限 http/https，bundle 仍只 require react），detail 与评论共用；随后补上了 **GFM 表格**（表头 + `|---|` 分隔行 + `:--`/`--:` 列对齐，单元格沿用同一套 escape-first inline 规则，`\|` 与 code span 内的竖线不切列）、`---` 分隔线与 **setext 标题**（`标题\n---` 按 GFM 出 h2，不会被误当成分隔线），表格样式（`.tb-table-wrap` 横向滚动 + th/td 边框）放在 `TB_CSS` 的 `.tb-md` 段内，两套主题都吃 token。

v0.7.0 交付（T-12，B 项的剩余四条，安全模型不变）：

- **图片** `![alt](url)` → `<img src alt loading="lazy" referrerpolicy="no-referrer">`，`src` 只放行 http/https（`data:` / `javascript:` / `file:` 保持字面量不动）；CSS 限 `max-width:100%; height:auto`。旧行为是退化成 `!` + 链接（inline() 的链接正则先于图片命中），现在是真标签。**图片规则必须跑在链接规则之前** —— `![alt](url)` 里就含 `[alt](url)`。
- **嵌套列表**：按缩进分两级（更深的压到第 2 层），子列表开在父 `<li>` **内部**（`<ul><li>a<ul>…</ul></li></ul>`，而不是浏览器勉强容忍的 `<li>a</li><ul>…`）；同一层换标记（`-` ↔ `1.`）开新列表。实现是 `renderList` 的栈式开合（`liOpen` 决定何时补 `</li>`）。
- **任务清单复选框** `- [ ]` / `- [x]` → `<input type="checkbox" disabled [checked]>`，只读、不写回 detail（看板不是编辑器）。规则锚在片段**开头**（`TASK_BOX`），所以正文中间的 `[x]` 保持字面量，而列表项去掉标记后的文本、以及表格单元格，都天然是"片段开头" —— 图片与复选框因此在单元格里同样生效；嵌套列表不可能出现在单元格里（单元格是单行 inline 内容，一行只能有一个条目）。
- **评论容器**从 `span + white-space:pre-wrap` 改成块级 `div`：表格/列表是块内容，塞在 span 里不规范（`commentText` 的 pre-wrap 一并去掉 —— 渲染器已用 `<br>` 表达软换行，pre-wrap 只会把间距翻倍）。

目视证据：`docs/images/markdown-fidelity.png`（真实 `renderMarkdown` + 真实 `TB_CSS`，Chrome 截图；左侧详情、右侧评论）。

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

## 浏览器侧样式表的归属（T-15，0.6.x 的教训）

**规矩：TB_CSS 只允许由 `ensureTaskboardStyles()` 注入 `document.head`，并且出生就带 `data-plugin="dsh-taskboard-kit"` + `data-plugin-css`；永远不要用 React 渲染 `<style>`。**

原因不是审美，是 dsh 客户端的模块加载器（`@deepseek-ai/dsh-client-modules/lib/client.js`）有两条既成行为：

```js
// 每个插件模块 materialize 完，把文档里所有【还没有主】的 <style> 收编给这个模块
const claimStyles = (id) => {
  for (const el of document.querySelectorAll('style:not([data-plugin])')) el.setAttribute('data-plugin', id)
}
// 插件卸载 / HMR 重载时，删掉它名下所有样式表
function removeOwnedStyles(id) {
  for (const el of document.querySelectorAll('style[data-plugin]')) if (el.getAttribute('data-plugin') === id) el.remove()
}
```

React 树里的 `<style>{TB_CSS}</style>` 天然是「无主」的，于是：

1. 任何晚一步 materialize 的插件模块（延迟批次、HMR 重载、市场里开关插件、版本更新）把它记到自己名下；
2. 那个插件后来重载/卸载 → 我们的样式表被删；
3. 删除**绕过 React**：fiber 仍以为节点在 DOM 里，于是永远不会补回来 —— 整片 TB_CSS 消失，直到组件重新挂载或刷新页面。

症状就是「有的时候」状态栏的「▤ 看板 · N ◷M」胶囊退化成浏览器默认 `<button>`（1px 灰边 + `#EFEFEF` 底 + 图标被挤到上一行 + 字号/颜色变 UA 默认）：内联样式还在（`· N` 的灰、`◷M` 的琥珀是对的），只有类规则没了 —— 这正是判定「不是布局挤坏、而是样式表整片丢失」的指纹。

dsh 自己的包（ui-conversation 等）建标签时就打 `data-plugin`，所以从不被抢；kit 现在同款做法。`ensureTaskboardStyles` 幂等（按 `data-plugin-css` 去重）且自愈（标签没了下次挂载补回），`apply()` 与每个 surface 挂载都会调一次。回归测试用假 DOM 把 loader 的 claim → remove 两步都跑了一遍（`tests/client.test.mjs`），去掉 `data-plugin` 即红。

## 不要用中文/图标去 grep 构建产物（0.7.x 的坑，两次差点误判）

esbuild 默认 `charset: 'ascii'`，会把**所有非 ASCII 字符转义成 `\uXXXX`** 写进 `lib/*.js`：

```
源码里的  ➤  ✎  ◷  ⚑  ⌂  ○          以及全部中文文案
产物里是  \u27a4 \u270e \u25f7 \u2691 \u2302 \u25cb   以及 \u5f85\u8ba4\u9886 …
```

**后果**：`grep '➤' lib/client.js`、`grep '待认领' lib/client.js` 一律**返回 0** —— 看起来像"构建没生效/特性没打进去"，而实际只是转义了。

**正确核法**（按可靠性排序）：

1. **渲染**：看页面/截图（最终真相）；
2. **查转义码**：`grep -c '\\u27a4' lib/client.js`（注意 shell 里要写成 `'\\u27a4'`）；
3. **查 ASCII 标识符**：函数名/样式键/导出名（`currentHolder`、`cardMetaTop`、`drawerActions`）不受转义影响，是最省事的探针。

线上排查同理：`curl "…/plugins/??dsh-taskboard-kit/client.js&rev=<内容指纹>"` 之后，**用 ASCII 名或转义码核**，别用中文/字形。

**这条的代价**：0.7.x 期间我两次据此差点误判"构建没生效/特性没打进去"，白查一轮；写在这里，下次直接查 ASCII 名。

