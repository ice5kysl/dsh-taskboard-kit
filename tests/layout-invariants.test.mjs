/**
 * 布局不变量（T-85）—— **"看板在任何宽度下都不得横向溢出，而且必须铺满可用宽度"**。
 *
 * 为什么单独一个套件：这块布局原先**从来没有过宽度层面的不变量**，历轮验证都是按
 * 功能做的（抽屉 320/560/900 ✓），于是没人断言过"整排泳道一共要多宽"。结果是泳道行
 * 是一排刚性的 240px（`width:240` + `flexShrink:0`）：面板比它窄时右侧的列被裁掉，
 * 比它宽时右侧留一大片空白。主人 2026-10-10 的报障（宽屏下"没占满 + 右边被挡住"）
 * 就是这个——所以这里补的不是"再测一次功能"，是**宽度不变量本身**。
 *
 * 口径（三条，任一条红就是回归）：
 *   1. 文档无横向溢出：`documentElement.scrollWidth === clientWidth`；
 *   2. 泳道行**不被裁**：`lanes.scrollWidth <= lanes.clientWidth`（列没被切）；
 *   3. 泳道行**铺满**：最后一个孩子的右边界 == 泳道行的右内边界（右侧不留白），
 *      且最后一列的右边界 ≤ `innerWidth`，各列宽度 ≥ 规格下限 `TB_LANE.min`。
 *
 * 测的是**构建产物 `lib/client.js`**（浏览器真正加载的那一份，走 dsh 的
 * `window.__ModuleLoader__.load` 信封），不是源码、也不是另写一份 CSS —— 否则
 * "测过的样式"和"发出去的样式"就是两条路了。
 *
 * 无头浏览器：Chrome/Chromium 的 `--headless=new --dump-dom`（不需要 playwright /
 * puppeteer，也不需要网络）。机器上没装浏览器时**明确 skip**（打印原因，退出码 0），
 * 不假装测过。
 *
 * 负面对照（必须真红，否则这套断言是装饰）：
 *   · `?sabotage=rigid` —— 把真凶塞回去（`.tb-column { flex:0 0 240px }`）；
 *   · `?sabotage=100vw` —— 卡面点名的那条（`.tb-lanes { width: 100vw }`）。
 * 两个对照都在本套件里断言 `assertLayout` 抛错，并同时断言 saboteur **真的生效**
 * （否则"没生效所以没红"会被误读成"拦住了"）。
 *
 * 也可以拿别的构建产物做对照（人工回归复核用）：
 *   TB_LAYOUT_CLIENT=/path/to/other/lib/client.js node tests/layout-invariants.test.mjs
 * 例：`npm pack dsh-taskboard-kit@0.9.0` 解出一个快照再指过去 ⇒ 必须红。
 *
 * Run: node tests/layout-invariants.test.mjs   (or: npm test)
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const WIDTHS = [1280, 1440, 1680, 2560]
/** 宿主左侧工作区导航的宽度（真机实测：面板从 x=280 开始）。 */
const SIDEBAR = 280
const HEIGHT = 900
const CLIENT = process.env.TB_LAYOUT_CLIENT || join(root, 'lib', 'client.js')
/** 拿外部产物做对照（TB_LAYOUT_CLIENT）时只跑主不变量：负面对照针对本仓构建。 */
const reference = Boolean(process.env.TB_LAYOUT_CLIENT)

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

// ------------------------------------------------------------ 浏览器定位

function findChrome() {
  const named = [process.env.CHROME_PATH, process.env.CHROME_BIN].filter(Boolean)
  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
  for (const path of [...named, ...fixed]) if (path && existsSync(path)) return path
  try {
    for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
      const found = execFileSync('/usr/bin/env', ['which', name], { encoding: 'utf8' }).trim()
      if (found) return found
    }
  } catch {
    /* none on PATH */
  }
  return null
}

// ------------------------------------------------------------ 夹具页面

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>tb-layout-invariant</title>
<style>
  html, body { margin: 0; height: 100%; }
  /* 宿主给面板的槽位：左侧 280px 工作区导航 + 右侧面板（真机 chain 的化简版，
     关键是"面板根拿到的是 vw-280 的可用宽度"这一条，而不是某个 width:100%）。 */
  #shell { display: flex; height: 100%; }
  #sidebar { flex: 0 0 ${SIDEBAR}px; height: 100%; background: #101012; }
  #slot { flex: 1 1 auto; min-width: 0; display: flex; height: 100%; overflow: hidden; }
  #result { display: none; }
</style></head><body>
<div id="shell"><div id="sidebar"></div><div id="slot"></div></div>
<pre id="result">pending</pre>
<script>window.__ModuleLoader__ = { load: function (envelope) { window.__TB_ENVELOPE__ = envelope } }</script>
<script src="react.development.js"></script>
<script src="react-dom.development.js"></script>
<script src="client.js"></script>
<script>
(function () {
  var logs = []
  window.addEventListener('error', function (event) {
    logs.push('window.onerror: ' + (event.message || String(event.error)))
  })
  var consoleError = console.error
  console.error = function () {
    logs.push('console.error: ' + [].slice.call(arguments).map(String).join(' ').slice(0, 320))
    consoleError.apply(console, arguments)
  }
  function stage(text) {
    document.getElementById('result').textContent = 'stage:' + text
  }
  function finish(value) {
    document.getElementById('result').textContent = 'ok:' + btoa(unescape(encodeURIComponent(JSON.stringify(value))))
  }
  function rect(el) {
    var b = el.getBoundingClientRect()
    return { left: Math.round(b.left * 100) / 100, right: Math.round(b.right * 100) / 100, width: Math.round(b.width * 100) / 100 }
  }
  function waitFor(predicate, budgetMs) {
    return new Promise(function (resolve, reject) {
      var started = Date.now()
      ;(function poll() {
        if (predicate()) return resolve()
        if (Date.now() - started > budgetMs) {
          return reject(
            new Error(
              'timeout waiting for .tb-lanes; slot innerHTML = ' +
                document.getElementById('slot').innerHTML.slice(0, 300) +
                ' | state: ' +
                (window.__TB_STATE__ ? JSON.stringify(window.__TB_STATE__).slice(0, 500) : 'n/a') +
                ' | logs: ' +
                logs.join(' ⏐ ').slice(0, 900),
            ),
          )
        }
        setTimeout(poll, 50)
      })()
    })
  }
  var params = new URLSearchParams(location.search)
  var sabotage = params.get('sabotage')

  function sabotageCss() {
    // 必须 !important：真凶那一版是**内联样式**（styles.column 是 inline style 对象），
    // 外部样式表不加 !important 根本压不过它 —— 压不过就变成"对照没生效"，而不是"拦住了"。
    if (sabotage === 'rigid') return '#slot .tb-lanes > .tb-column { flex: 0 0 240px !important; width: 240px !important; min-width: 240px !important; }'
    if (sabotage === '100vw') return '#slot .tb-lanes { width: 100vw !important; }'
    return null
  }

  ;(async function () {
    try {
      stage('bundle')
      // 自动 JSX runtime 的口径是 jsx(type, props, key)：**children 在 props 里**，
      // key 是第三个参数。这里必须只在真的有 key 时才把第三个实参传给
      // React.createElement —— 传了就会踩 createElement 的口径（3 个实参 ⇒
      // childrenLength === 1 ⇒ props.children 被覆盖成 undefined），于是整个面板
      // 渲染成一个**空壳**且不报任何错。（这个坑本项目实测踩过一次，写在这里。）
      function create(type, props, key) {
        if (key === undefined || key === null) return React.createElement(type, props)
        return React.createElement(type, Object.assign({}, props, { key: String(key) }))
      }
      var jsxRuntime = { Fragment: React.Fragment, jsx: create, jsxs: create, jsxDEV: create }
      var client = window.__TB_ENVELOPE__.factory(function (spec) {
        if (spec === 'react') return React
        if (spec === 'react/jsx-runtime') return jsxRuntime
        throw new Error('unexpected external: ' + spec)
      })

      var now = new Date().toISOString()
      function task(id, status, extra) {
        return Object.assign({
          id: id, title: 'Card ' + id + ' — a title long enough to wrap once', detail: '',
          status: status, assignee: status === 'pool' ? null : 'dsh', reviewer: null, waiting_on: null,
          priority: 'medium', value: null, tags: ['taskboard-kit'], created_by: 'dsh',
          created_at: now, updated_at: now, log: [], comments: [],
        }, extra || {})
      }
      var list = [
        task('T-1', 'open'),
        task('T-2', 'open', { assignee: 'dsh' }),
        task('T-3', 'in_progress'),
        task('T-4', 'review'),
        task('T-5', 'done'),
        task('T-6', 'closed'),
      ]
      var board = {
        version: 1, workspace: '/fixture/workspace', next_seq: 7, tails: {},
        actors: { dsh: { kind: 'agent', aliases: [], first_seen_at: now, last_seen_at: now } },
        tasks: list.reduce(function (acc, t) { acc[t.id] = t; return acc }, {}),
      }

      var store = client.createTaskboardStore({
        bridge: { board: async function () { return { ok: true, board: board } } },
        pollMs: 1000000000,
      })
      store.setCwd(board.workspace)
      // 泳道行是**同一个** styles.column（按进度与按负责人共用），所以两个视角
      // 都必须在同一条不变量之下 —— 用 view=owner 把它也量一遍。
      if (params.get('view') === 'owner') store.setGroupBy('owner')
      await store.refresh()
      window.__TB_STATE__ = { status: store.getState().status, cwd: store.getState().cwd, error: store.getState().error, tasks: Object.keys(store.getState().board ? store.getState().board.tasks : {}).length, boardExists: store.getState().boardExists }

      var css = sabotageCss()
      if (css) {
        var style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
      }

      // React 18 的并发 root 在无头（没有合成器帧）里可能一直不提交：用 flushSync
      // 强制同步 commit。等布局用 setTimeout（虚拟时间会瞬间推进它），不用 rAF ——
      // 无头窗口没有帧，rAF 可能永远不触发。
      var container = document.getElementById('slot')
      // 宿主会把 useSessions 注进来（面板用它解析「当前会话的 cwd」）；不注的话
      // useSessionCwd 返回 undefined，挂载后的 effect 会把 cwd 覆盖成 null，
      // 面板就退化成「没有选中的会话」空态 —— 测不到泳道。
      var useSessions = function (selector) {
        return selector({ current: 'S-1', byId: { 'S-1': { cwd: board.workspace } } })
      }
      ReactDOM.flushSync(function () {
        ReactDOM.createRoot(container).render(React.createElement(client.BoardPanel, { store: store, useSessions: useSessions }))
      })
      // 泳道行的定位：新版自带 .tb-lanes；旧产物（0.9.x 及以前）没有这个类，
      // 退回「第一个列的父节点」—— 两条都指向同一个元素，所以这条不变量能拿来
      // 对照**历史产物**（TB_LAYOUT_CLIENT 指一份 0.9.0），而不是只认自家新加的类名。
      function lanesEl() {
        var byClass = document.querySelector('.tb-lanes')
        if (byClass) return byClass
        var column = document.querySelector('.tb-column, .tb-closed-strip')
        return column ? column.parentElement : null
      }
      await waitFor(function () { return lanesEl() }, 5000)
      await new Promise(function (r) { setTimeout(r, 150) })

      var lanes = lanesEl()
      var panelRoot = lanes.parentElement
      var slot = document.getElementById('slot')
      var lanesStyle = getComputedStyle(lanes)
      var children = [].slice.call(lanes.children)
      // 收起的「已结清」是一条 36px 的窄条，不是泳道 —— 它不在「列宽 ≥ 下限」的口径里。
      var laneWidths = children
        .filter(function (el) { return !el.classList.contains('tb-closed-strip') })
        .map(function (el) { return el.getBoundingClientRect().width })
      var last = children[children.length - 1]

      function offenders(scope) {
        return [].slice.call(scope.querySelectorAll('*')).filter(function (el) {
          return el.getBoundingClientRect().right > window.innerWidth + 1
        }).slice(0, 12).map(function (el) {
          var chain = []
          var cur = el
          for (var i = 0; i < 5 && cur && cur !== document.body; i++) {
            chain.push(cur.tagName + '.' + String(cur.className || '').slice(0, 40))
            cur = cur.parentElement
          }
          return { tag: el.tagName, cls: String(el.className || '').slice(0, 60), right: Math.round(el.getBoundingClientRect().right), chain: chain.join(' < ') }
        })
      }

      finish({
        sabotage: sabotage,
        sabotageApplied: sabotage
          ? {
              firstLaneWidth: Math.round(children[0].getBoundingClientRect().width * 100) / 100,
              lanesWidth: Math.round(lanes.getBoundingClientRect().width * 100) / 100,
              lanesComputedWidth: getComputedStyle(lanes).width,
              lanesFlex: getComputedStyle(lanes).flex,
              innerWidth: window.innerWidth,
            }
          : null,
        vw: window.innerWidth,
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        sidebar: rect(document.getElementById('sidebar')),
        slot: rect(slot),
        panelRoot: rect(panelRoot),
        lanes: {
          rect: rect(lanes), clientWidth: lanes.clientWidth, scrollWidth: lanes.scrollWidth,
          scrollLeft: lanes.scrollLeft, gap: parseFloat(lanesStyle.columnGap || lanesStyle.gap || '0'),
          paddingLeft: parseFloat(lanesStyle.paddingLeft), paddingRight: parseFloat(lanesStyle.paddingRight),
        },
        laneCount: children.length,
        lanesList: children.map(function (el) { return Object.assign({ cls: String(el.className || '') }, rect(el)) }),
        minLaneWidth: Math.min.apply(null, laneWidths),
        maxLaneWidth: Math.max.apply(null, laneWidths),
        last: rect(last),
        laneSpec: client.TB_LANE,
        offenders: offenders(document),
        ownOffenders: offenders(panelRoot),
      })
    } catch (error) {
      finish({ error: String((error && error.stack) || error) })
    }
  })()
})()
</script>
</body></html>
`

function buildFixture(chromeDir) {
  const reactUmd = join(root, 'node_modules', 'react', 'umd', 'react.development.js')
  const domUmd = join(root, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js')
  if (!existsSync(reactUmd) || !existsSync(domUmd)) return { error: 'react/react-dom UMD builds missing in node_modules' }
  if (!existsSync(CLIENT)) return { error: `client bundle not found: ${CLIENT} (run npm run build)` }
  mkdirSync(chromeDir, { recursive: true })
  copyFileSync(reactUmd, join(chromeDir, 'react.development.js'))
  copyFileSync(domUmd, join(chromeDir, 'react-dom.development.js'))
  copyFileSync(CLIENT, join(chromeDir, 'client.js'))
  writeFileSync(join(chromeDir, 'index.html'), PAGE)
  return { dir: chromeDir }
}

/**
 * 跑一次 `--dump-dom` 并把 DOM 取回来。
 *
 * 为什么不用 `execFileSync`：Chrome 154 的 `--headless=new --dump-dom` **打印完不退出**
 * （updater 之类的进程吊着），同步等待会把这个套件挂死。所以读 stdout，等到 `</html>`
 * 就当成"dump 完成"，随即 SIGKILL —— 判定不依赖进程退出码，也不会漏读。
 */
function dumpDom(chrome, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`chrome --dump-dom 超时（${timeoutMs}ms）`)), timeoutMs)
    proc.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('</html>')) finish(resolve, out)
    })
    proc.on('error', (error) => finish(reject, error))
    proc.on('exit', () => finish(reject, new Error(`chrome 没 dump 出 DOM 就退出了（stdout ${out.length} 字节）`)))
  })
}

/** 跑一次无头 Chrome，取回页面里的测量 JSON。 */
async function measure(chrome, dir, width, sabotage, view) {
  const url = `file://${join(dir, 'index.html')}?w=${width}${sabotage ? `&sabotage=${sabotage}` : ''}${view ? `&view=${view}` : ''}`
  const out = await dumpDom(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-sync',
    `--user-data-dir=${join(dir, 'chrome-profile')}`,
    `--window-size=${width},${HEIGHT}`,
    '--virtual-time-budget=8000',
    '--dump-dom',
    url,
  ])
  const match = /<pre id="result">([^<]*)<\/pre>/.exec(out)
  if (!match) throw new Error(`@${width}${sabotage ? ` sabotage=${sabotage}` : ''}: no measurement in the page (DOM dump ${out.length} bytes)`)
  const raw = match[1]
  if (!raw.startsWith('ok:')) {
    throw new Error(`@${width}${sabotage ? ` sabotage=${sabotage}` : ''}: 页面没跑完（停在 ${raw.slice(0, 200)}）`)
  }
  const value = JSON.parse(Buffer.from(raw.slice(3), 'base64').toString('utf8'))
  if (value.error) throw new Error(`@${width}${sabotage ? ` sabotage=${sabotage}` : ''}: fixture failed: ${value.error}`)
  return value
}

// ------------------------------------------------------------ 不变量

/** 三条口径 + 两条附加约束；红的时候必须说清是哪一条、差多少。 */
function assertLayout(m, width, label) {
  const at = `${label}@${width}`
  assert.equal(m.vw, width, `${at}: 视口宽度不是 ${width}（量到 ${m.vw}）`)
  assert.ok(m.panelRoot, `${at}: 面板没渲染出来（.tb-lanes 不在 DOM 里）`)
  assert.equal(m.overflow, false, `${at}: 文档横向溢出（scrollWidth ${m.docScroll} > clientWidth ${m.docClient}）`)
  assert.ok(
    m.panelRoot.width >= width - SIDEBAR - 8,
    `${at}: 面板根没占满可用宽度（面板 ${m.panelRoot.width}px，可用 ${width - SIDEBAR}px）`,
  )
  assert.ok(
    m.lanes.rect.right <= m.slot.right + 0.5,
    `${at}: 泳道行溢出面板（lanes.right ${m.lanes.rect.right} > slot.right ${m.slot.right}）`,
  )
  assert.ok(
    m.lanes.scrollWidth <= m.lanes.clientWidth + 1,
    `${at}: 泳道行被裁（scrollWidth ${m.lanes.scrollWidth} > clientWidth ${m.lanes.clientWidth}）—— 右侧的列有 ${m.lanes.scrollWidth - m.lanes.clientWidth}px 看不见`,
  )
  assert.ok(m.last.right <= width + 0.5, `${at}: 最后一列右边界 ${m.last.right} > innerWidth ${width}`)
  const fillGap = m.lanes.rect.right - m.lanes.paddingRight - m.last.right
  assert.ok(fillGap <= 1.5, `${at}: 泳道行没铺满，右侧留白 ${Math.round(fillGap)}px`)
  assert.ok(
    m.minLaneWidth >= m.laneSpec.min - 0.5,
    `${at}: 有列被压到 ${Math.round(m.minLaneWidth)}px < 规格下限 ${m.laneSpec.min}px`,
  )
  assert.equal(m.ownOffenders.length, 0, `${at}: 面板内有元素越界：${JSON.stringify(m.ownOffenders)}`)
}

// ------------------------------------------------------------ 主流程

console.log('dsh-taskboard-kit layout invariants (headless browser):')

const chrome = findChrome()
if (!chrome) {
  console.log('  [skip] 本机没有 Chrome/Chromium —— 布局不变量未验证（设 CHROME_PATH 指一个浏览器再跑）')
  process.exit(0)
}
console.log(`  [env] browser: ${chrome}`)
console.log(`  [env] client bundle: ${CLIENT}`)

const dir = mkdtempSync(join(tmpdir(), 'tb-layout-'))
let fixture
try {
  fixture = buildFixture(dir)
  if (fixture.error) {
    console.log(`  [skip] ${fixture.error}`)
    process.exit(0)
  }

  const results = new Map()
  await check(`四个宽度都不横向溢出、且泳道行铺满（${WIDTHS.join(' / ')}）`, async () => {
    const failures = []
    for (const width of WIDTHS) {
      let m
      try {
        m = await measure(chrome, dir, width)
      } catch (error) {
        failures.push(error.message)
        continue
      }
      results.set(width, m)
      console.log(
        `  [info] @${width}: panel ${m.panelRoot.width} · lanes client ${m.lanes.clientWidth}/scroll ${m.lanes.scrollWidth} · 列宽 ${Math.round(m.minLaneWidth)}~${Math.round(m.maxLaneWidth)} · 末列右边界 ${m.last.right}`,
      )
      try {
        assertLayout(m, width, reference ? 'reference' : 'fixed')
      } catch (error) {
        failures.push(error.message)
      }
    }
    // 四个宽度全红的时候也要把四条都列出来（不是只报第一条）
    if (failures.length > 0) throw new Error(failures.join(' ⏐ '))
    // 让"铺满"这件事有数字可看：宽屏下每列不再停在 240px
    const wide = results.get(2560)
    const narrow = results.get(1280)
    assert.ok(wide.maxLaneWidth > narrow.maxLaneWidth + 100, `2560 的列宽 ${wide.maxLaneWidth} 没有随可用宽度伸展（1280 是 ${narrow.maxLaneWidth}）`)
    assert.ok(narrow.minLaneWidth < 240, `1280 的列宽 ${narrow.minLaneWidth} 没有收缩（还是刚性的 240）`)
  })

  await check('「按负责人」视角共用同一个泳道样式 ⇒ 同一条不变量（1280 / 1680）', async () => {
    for (const width of [1280, 1680]) {
      const m = await measure(chrome, dir, width, null, 'owner')
      assertLayout(m, width, 'owner')
      console.log(
        `  [info] owner@${width}: lanes client ${m.lanes.clientWidth}/scroll ${m.lanes.scrollWidth} · 泳道数 ${m.laneCount} · 列宽 ${Math.round(m.minLaneWidth)}~${Math.round(m.maxLaneWidth)} · 末列右边界 ${m.last.right}`,
      )
    }
  })

  if (reference) {
    console.log(`  [note] TB_LAYOUT_CLIENT 指向外部产物（${CLIENT}）⇒ 只跑主不变量；负面对照是本仓构建的事，跳过`)
  } else {
    await check('负面对照 · 把真凶塞回去（.tb-column flex:0 0 240px）⇒ 断言必须真红', async () => {
      const m = await measure(chrome, dir, 1440, 'rigid')
      assert.ok(
        Math.abs(m.sabotageApplied.firstLaneWidth - 240) < 0.5,
        `saboteur 没生效 ⇒ 这条对照不成立（不是"拦住了"）：${JSON.stringify(m.sabotageApplied)}`,
      )
      assert.throws(() => assertLayout(m, 1440, 'sabotage-rigid'), /被裁|留白|右边界|越界/)
      console.log(`  [info] 对照 rigid@1440：列宽 ${m.sabotageApplied.firstLaneWidth}px · lanes scroll ${m.lanes.scrollWidth} vs client ${m.lanes.clientWidth}`)
    })
  }

  if (!reference) {
    await check('负面对照 · width:100vw ⇒ 断言必须真红', async () => {
      const m = await measure(chrome, dir, 1440, '100vw')
      // computed width 是内容盒宽度（100vw = 1440）；getBoundingClientRect 还要加左右 padding，
      // 所以这里比 computed width，避免把"生效了"误判成"没生效"。
      assert.ok(
        Math.abs(parseFloat(m.sabotageApplied.lanesComputedWidth) - 1440) < 1,
        `saboteur 没生效 ⇒ 这条对照不成立（不是"拦住了"）：${JSON.stringify(m.sabotageApplied)}`,
      )
      assert.throws(() => assertLayout(m, 1440, 'sabotage-100vw'), /溢出|被裁|留白|右边界|越界/)
      console.log(`  [info] 对照 100vw@1440：lanes computed ${m.sabotageApplied.lanesComputedWidth} · 外框宽 ${m.sabotageApplied.lanesWidth}px · last.right ${m.last.right}`)
    })
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? '布局不变量：全部通过' : `布局不变量：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
