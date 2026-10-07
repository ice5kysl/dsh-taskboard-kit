/**
 * 复核尾巴扫描器（review tails）——把"复核留言里的待办"变成可列、可归属、
 * 可收口的清单。
 *
 * 为什么存在：复核结论写在 note / comment 里，而 note **不改变列** ⇒ 没有载体、
 * 没有提醒、没有清单 ⇒ 天生静默。T-40 的审计证明 38 张 closed 卡里至少 10 条
 * 复核遗留掉了地（含"注释声称有测试、其实没有"这种**假绿**）。这跟看板这一周在
 * 治的病同源：**失败与正常，在观测面上不可区分**。
 *
 * 这里的判据是**关键词 + 模式**，刻意选"宁可多列、不可漏报"：误报的代价是有人
 * 扫一眼划掉（还能顺手 `--waive`），漏报的代价是它再也浮不上来。所以每条输出都
 * 带着**原文片段 + 卡号 + 位置 + 命中的判据**，让人一眼判"真待办 / 已接受 / 已作废"。
 *
 * 与其他 shared 模块一样，这里**只产出事实与命令**，措辞留在 CLI 与 locale 层。
 *
 * @module dsh-taskboard-kit/shared/tails
 */

import type { Board, TailSettlement, Task, TaskComment, TaskEvent, TaskLogEntry, TaskStatus } from './types.ts'

// ------------------------------------------------------------------- 判据

/**
 * 判据 id。每个 id 都是**一类**可解释的措辞，而不是一句正则：
 * 单测与变异验证按类打红（去掉某一类 ⇒ 该类样本必须不再被列出）。
 */
export type TailRuleId =
  /** 明确请求 / 提醒 */
  | 'ask'
  /** 「别掉地上」 */
  | 'dont-drop'
  /** 明确推迟：下次 / 下一笔 / 留给 / 待补 / TODO */
  | 'deferral'
  /** 「随 X 一起发 / 发布」——一句承诺，X 那个载体得真的带上它 */
  | 'deferred-ship'
  /** 「不阻塞 / 非回归」——说这话的人自己也知道它可能掉 */
  | 'non-blocking'
  /** 「建议 / 最好 / 应该」 */
  | 'suggest'
  /** 「请补 / 可补 / 补一条」——能指出缺什么的动作词 */
  | 'gap-fill'
  /** 「顺手 / 随手」 */
  | 'handy'
  /** 声明性措辞：声称测试/断言/护栏**已存在**（假绿高发区） */
  | 'claim-check'
  /** 「仍会 / 残留 / 还有一处 / 仍是」——上次指出的问题还在 */
  | 'still-there'
  /** 「口径不齐 / 不一致 / 相悖 / 两套尺度」 */
  | 'inconsistency'

export interface TailRule {
  id: TailRuleId
  /** 这条判据到底在找什么（人读的关键词清单，也是"为什么它被列出来"的答案）。 */
  hint: string
  /** 只测句子，不带 `g`（避免 lastIndex 状态）。 */
  pattern: RegExp
}

/**
 * 判据表。**每一类的 hint 就是"它为什么被列出来"** —— `taskboard tails` 直接
 * 把它打给用户看，所以不存在"莫名其妙被列出来"的条目。
 *
 * 顺序即输出顺序（同类合并、按此表列出命中项）。
 */
export const TAIL_RULES: readonly TailRule[] = [
  { id: 'ask', hint: '请确认 / 请补 / 请随手 / 麻烦 / 务必 / 记得 / 留意', pattern: /请(?:确认|核实|核对|补|改|修|看|注意|留意|说明|同步|评估|判断|决定|裁|拍板|答复|回复|尽快|及早|明确|考虑|安排|处理|检查|顺手|随手)|麻烦|务必|劳驾|记得|留意/ },
  { id: 'dont-drop', hint: '别掉 / 别忘了 / 不要漏 / 勿忘 / 掉地上', pattern: /别[掉忘漏丢落]|不要[掉忘漏丢落]|勿忘|勿漏|掉地上/ },
  {
    id: 'deferral',
    hint: '下次 / 下一笔 / 随下一 / 日后 / 后续 / 留给 / 遗留 / 待补 / 待办 / 暂不 / TODO（"无遗留"不算）',
    pattern: /随下一|下一笔|下次|下一版|下个版本|日后|后续|(?<!无)(?<!有)遗留|(?<!无)(?<!有)留给|待补|待办|待确认|待定|TODO|FIXME|暂不|先不|暂缓|押后/,
  },
  {
    id: 'deferred-ship',
    hint: '随 X 一起（发布 / 发版 / 合并 / 改 / 落地）——"已随 / 并随 X 发布"是既成事实，不算',
    pattern: /(?:^|[^已并])随[^。；;!?\n|]{0,40}(发布|发版|上线|合并|一起|切版|落地)/,
  },
  { id: 'non-blocking', hint: '不阻塞 / 非阻塞 / 非回归 / 不影响 / not a blocker', pattern: /不阻塞|非阻塞|非回归|不影响|不是 ?blocker|not a blocker/i },
  {
    id: 'suggest',
    hint: '建议 X（X 是动作）/ 最好 / 不妨 / 可以考虑 —— "修法建议见留言""与我建议一致"这类元话不算',
    pattern: /建议[^。；\n|]{0,8}(补|改|换|加|开|立|做|用|收录|去|删|收|纳入|考虑|同步|对齐|把|给|随|一并|直接|先|再|重|调|抬|降|拆|合并|统一|归一)|最好|不妨|可以考虑/,
  },
  {
    id: 'gap-fill',
    hint: '待补 / 请补 / 可补 / 补一条 / 补上 / 补测试 / 补断言 / 补边界',
    pattern: /待补|建议补|请补|可补|需补|要补|补一条|补上|补个|补测试|补断言|补边界|补位|补一句|补图例/,
  },
  {
    id: 'handy',
    hint: '顺手 X / 随手 X（X 是动作）—— "顺手挖出…"这种叙述不算',
    pattern: /(顺手|随手)[^。；\n|]{0,6}(补|改|开|清|去|做|收|修|带|加|删|处理|挪|换|记)/,
  },
  {
    id: 'claim-check',
    hint: '声称/号称有测试·断言·护栏；已有测试；测试会钉住（"护栏已存在"这类声明 —— 假绿高发区）',
    pattern: /声称[^，。；\n|]{0,10}(测试|断言|护栏|回归|用例)|号称[^，。；\n|]{0,10}(测试|断言|护栏)|已有?[^，。；\n|]{0,6}(测试|断言|护栏|回归)|(已|都|全|均)(加|补|上|新增|写了)[^，。；\n|]{0,6}(测试|断言|护栏|回归)|(测试|断言|用例|护栏)[^，。；\n|]{0,6}(会|能|可以)(钉|锁|守|固定|覆盖|抓|逮)|(有|加了|上了|补了)[^，。；\n|]{0,6}(回归测试|回归断言|护栏)/,
  },
  {
    id: 'still-there',
    hint: '残留 / 仍有 / 仍会 / 仍用 / 还有一处 / 仍是 / 未改（上次指出的还在）——"零残留""残留为 0"这种验收结论不算',
    pattern: /(?<!零)(?<!无)残留(?!\s*(为|＝|=)\s*0)|仍有|仍会|仍用|仍被|仍以|仍是|还有一处|还是旧|未改|没改|漏改/,
  },
  { id: 'inconsistency', hint: '口径不齐 / 不一致 / 不统一 / 相悖 / 矛盾 / 两套尺度', pattern: /口径不齐|不一致|不统一|相悖|矛盾|两套尺度|两套标准/ },
]

/** 一句话命中了哪些判据（没命中 = 空数组 ⇒ 它不是尾巴）。 */
export function matchRules(text: string): TailRuleId[] {
  const hits: TailRuleId[] = []
  for (const rule of TAIL_RULES) {
    if (rule.pattern.test(text)) hits.push(rule.id)
  }
  return hits
}

/** 判据 id → 它找什么（给 CLI / 报告用）。 */
export function ruleHint(id: TailRuleId): string {
  return TAIL_RULES.find((rule) => rule.id === id)?.hint ?? id
}

// ----------------------------------------------------------------- 句切分

/**
 * 句末标点 —— 只认全角 `。！？`。
 *
 * 刻意**不切** `；`：中文复核留言里成串的待办就是拿分号串起来的
 * （"两个不阻塞的 follow-up 请随手或开微卡：a) …；b) …"），切开会让后半句
 * 丢掉前半句的判据与服务对象 —— 实测漏掉 T-21 的"daemon.log 无轮转"那条。
 * 也**不切**裸 `?`/`!`：它们在代码、路径、`「? 指南」` 这种字面量里满地都是，
 * 切在 `?` 上会把一句完整的话劈成"非阻塞建议两条：a) 「"（实测，T-27）。
 */
const SENTENCE_END = /[。！？]/
/** 比这还短的片段没有信息量（`①`、`-` 之类）。 */
const MIN_SEGMENT = 4

export interface TextSegment {
  text: string
  /** 该片段在原文中的字符偏移（人回原文核对的锚点）。 */
  offset: number
}

/**
 * 把一段 markdown 拆成"句子"。
 *
 * 两级：先按行，**表格行再按单元格**（整行当一个片段会把一格里命中的关键词糊到
 * 整行上，读起来像神来之笔）；然后按中英文句末标点切。偏移一路带着走，所以每条
 * 尾巴都能回到原文的位置。
 */
export function splitSegments(text: string): TextSegment[] {
  const out: TextSegment[] = []
  let base = 0
  for (const line of text.split('\n')) {
    pushLine(line, base, out)
    base += line.length + 1
  }
  return out
}

function pushLine(line: string, base: number, out: TextSegment[]): void {
  if (line.trim() === '') return
  if (line.trimStart().startsWith('|')) {
    let offset = 0
    for (const cell of line.split('|')) {
      pushSegment(cell, base + offset, out)
      offset += cell.length + 1
    }
    return
  }
  let start = 0
  for (let index = 0; index < line.length; index += 1) {
    if (SENTENCE_END.test(line[index]!)) {
      pushSegment(line.slice(start, index + 1), base + start, out)
      start = index + 1
    }
  }
  if (start < line.length) pushSegment(line.slice(start), base + start, out)
}

function pushSegment(raw: string, offset: number, out: TextSegment[]): void {
  const leading = raw.length - raw.trimStart().length
  const text = raw.trim()
  if (text.length < MIN_SEGMENT) return
  out.push({ text, offset: offset + leading })
}

// ------------------------------------------------------------------- 扫描

/** 默认只扫这两列：`closed`（结清了）与 `done`（审核过了、还没收口）。 */
export const TAIL_STATUSES: readonly TaskStatus[] = ['closed', 'done']

/** 会带"裁决 note"的日志事件。`updated` / `blocked` 之类的流水账不扫。 */
const DECISION_EVENTS: ReadonlySet<TaskEvent> = new Set<TaskEvent>([
  'approved', 'rejected', 'closed', 'done', 'reopened',
])

/**
 * 作者**自己**写下的留言里，只认这几类判据：推迟 / 随某批一起 / 别掉。
 *
 * 为什么需要这道门：卡主在卡上写的交付说明动辄几千字（审计报告、逐条交付表），
 * 里面满是「建议…」「请…」——那是**交付物本身**，不是留给谁的待办。真实数据上
 * 放开这一条会从 ~30 条涨到 ~240 条（T-3 的一篇审计报告一个人就贡献 29 条），
 * 清单直接变成没人看的墙纸。
 *
 * 但作者的**承诺**恰恰是最容易掉地的一类（"这条随下一笔一起改"就是这么丢的），
 * 所以只放这一类进来 —— 而不是"建议 / 请"，并且**按句过滤**（不是整条评论放行：
 * 一条长评论里只要出现一个"遗留"，整篇的建议项都会被拉进来）。
 */
const PROMISE_RULES: ReadonlySet<TailRuleId> = new Set<TailRuleId>(['deferral', 'deferred-ship', 'dont-drop'])

export interface TailSourceRef {
  kind: 'log' | 'comment'
  /** 在 `task.log` / `task.comments` 数组里的下标（尾巴 id 的一半）。 */
  index: number
  at: string
  by: string
  /** 仅 log：裁决事件类型。 */
  event?: TaskEvent
}

export interface ReviewTail {
  /** 稳定 id：`T-25#log:6:2`（卡号 # 位置 : 句序号）。收口记录就用它当 key。 */
  id: string
  task_id: string
  task_title: string
  task_status: TaskStatus
  source: TailSourceRef
  /** 命中的判据（可解释：为什么它被列出来）。 */
  rules: TailRuleId[]
  /**
   * 命中的判据各自在找什么（人读的关键词清单）。
   * 与 `rules` 一起带上，是为了让**报告本身**自解释 —— CLI 只依赖包已经导出的
   * `health()`（`reviewTails`）就能把它打给人看，不需要再多开一个导出面。
   */
  reasons: string[]
  /** 原文片段（整句，过长会截断并加省略号）。 */
  snippet: string
  /** 该句在原文里的字符偏移。 */
  offset: number
  /** 谁该看这条：卡主 / 卡创建者 / 写这条复核的人（别名归一化交给调用方）。 */
  responsibles: string[]
  /** 收口记录；`null` = 还没人消化它。 */
  settlement: TailSettlement | null
}

export interface TailScanOptions {
  /** 扫哪些状态（默认 closed + done）。 */
  statuses?: readonly TaskStatus[]
  /**
   * 评论扫到什么程度：
   *   · `review`（默认）—— 复核人的留言整条扫；卡主自己的留言只按"承诺"类判据扫
   *     （推迟 / 随某批一起 / 别掉）—— 他的交付说明不是待办；
   *   · `all` —— 卡上所有留言按全部判据扫（更吵，连交付说明里的"建议"一起捞）。
   */
  commentScope?: 'review' | 'all'
  /**
   * 别名感知的"是不是同一个 Actor"（`dsh ≡ dsh-agent`）。
   *
   * 名册解析（`resolveActor` / `sameActor`）住在 `shared/board.ts`，而 board.ts
   * 依赖本模块 ⇒ 由调用方注入，避免循环依赖。省略时退化成**大小写不敏感的字符串
   * 比较**（名册不可用时，例如对一块裸板跑单测）。真实调用点（`boardHealth` /
   * `inboxFor` / CLI）一律注入名册版 —— 少了它会认不出 `dsh-agent` 就是 `dsh`，
   * 于是把一个 Agent 自己的交付说明误当成"复核意见"（实测：T-3 一篇审计报告
   * 一个人就能刷出 29 条）。
   */
  sameActor?: (a: string, b: string) => boolean
}

export interface TailsReport {
  /** 全部尾巴（含已收口）。 */
  all: ReviewTail[]
  /** 未收口 = 还得有人处理。 */
  open: ReviewTail[]
  /** 已落卡。 */
  filed: ReviewTail[]
  /** 已作废。 */
  waived: ReviewTail[]
  /**
   * 收口记录里"再也对不上任何尾巴"的 id（判据/切句改了，或原文被编辑过）。
   * 不静默吞掉：收口记录不该变成孤儿。
   */
  orphans: string[]
  stats: {
    /** 扫了几张 closed/done 卡。 */
    cards: number
    /** 扫了几处 note / comment。 */
    sources: number
    /** 拆成几句。 */
    segments: number
    /** 其中被判定成尾巴的句数。 */
    hits: number
  }
}

/** 扫描全板，得到复核尾巴清单（纯函数：只读 board，不落盘）。 */
export function scanTails(board: Board, options: TailScanOptions = {}): TailsReport {
  const statuses = new Set<TaskStatus>(options.statuses ?? TAIL_STATUSES)
  const settlements = board.tails ?? {}
  const same = options.sameActor ?? plainSameActor
  const all: ReviewTail[] = []
  let cards = 0
  let sources = 0
  let segments = 0

  for (const task of Object.values(board.tasks)) {
    if (!statuses.has(task.status)) continue
    cards += 1
    for (const ref of sourcesOf(task, options.commentScope ?? 'review', same)) {
      sources += 1
      const pieces = splitSegments(ref.text)
      segments += pieces.length
      pieces.forEach((segment, index) => {
        const hits = matchRules(segment.text)
        // 作者自己写的留言：只认"承诺"类判据（见 PROMISE_RULES）。
        const rules = ref.ownerAuthored ? hits.filter((id) => PROMISE_RULES.has(id)) : hits
        if (rules.length === 0) return
        const id = tailId(task.id, ref, index)
        all.push({
          id,
          task_id: task.id,
          task_title: task.title,
          task_status: task.status,
          source: ref,
          rules,
          reasons: rules.map(ruleHint),
          snippet: snippetFor(segment.text, rules),
          offset: segment.offset,
          responsibles: responsiblesOf(task, ref),
          settlement: settlements[id] ?? null,
        })
      })
    }
  }

  all.sort((a, b) =>
    a.task_id.localeCompare(b.task_id, undefined, { numeric: true })
    || a.source.kind.localeCompare(b.source.kind)
    || a.source.index - b.source.index
    || a.offset - b.offset)

  const open = all.filter((tail) => tail.settlement === null)
  const filed = all.filter((tail) => tail.settlement?.status === 'filed')
  const waived = all.filter((tail) => tail.settlement?.status === 'waived')
  const seen = new Set(all.map((tail) => tail.id))
  const orphans = Object.keys(settlements).filter((id) => !seen.has(id)).sort()

  return {
    all,
    open,
    filed,
    waived,
    orphans,
    stats: { cards, sources, segments, hits: all.length },
  }
}

/** 只有未收口的尾巴（`stale` / `inbox` 要用的那一份）。 */
export function openTails(board: Board, options?: TailScanOptions): ReviewTail[] {
  return scanTails(board, options).open
}

/** 尾巴的稳定 id（`T-25#log:6:2` / `T-25#c:0:1`）。 */
export function tailId(taskId: string, ref: Pick<TailSourceRef, 'kind' | 'index'>, segmentIndex: number): string {
  return `${taskId}#${ref.kind === 'log' ? `log:${ref.index}` : `c:${ref.index}`}:${segmentIndex}`
}

/**
 * 谁该看这条尾巴：**卡主 / 卡创建者 / 写这条复核的人**。
 * 别名（dsh ≡ dsh-agent ≡ …）的归一化属于名册的事，这里只去重不解析。
 */
export function responsiblesOf(task: Task, ref: Pick<TailSourceRef, 'by'>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of [task.assignee, task.created_by, ref.by]) {
    if (!name) continue
    const key = name.trim().toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** 一条尾巴是不是该落在这个 Actor 头上（大小写不敏感，别名由调用方先归一）。 */
export function tailBelongsTo(tail: ReviewTail, actor: string): boolean {
  const key = actor.trim().toLowerCase()
  return tail.responsibles.some((name) => name.trim().toLowerCase() === key)
}

const SNIPPET_MAX = 200

/** 没有名册时的退化比较：大小写不敏感。真实调用点一律注入名册版。 */
function plainSameActor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * 原文片段：整句优先；超长时**以命中的判据为中心**截一段（两边加省略号），
 * 而不是从句子开头砍 —— 砍掉命中处等于让人对着一句话发呆。
 */
function snippetFor(text: string, rules: readonly TailRuleId[]): string {
  if (text.length <= SNIPPET_MAX) return text
  let at = 0
  for (const rule of TAIL_RULES) {
    if (!rules.includes(rule.id)) continue
    const match = rule.pattern.exec(text)
    if (match) {
      at = match.index
      break
    }
  }
  const start = Math.max(0, Math.min(at - 40, text.length - SNIPPET_MAX))
  const end = Math.min(text.length, start + SNIPPET_MAX)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function sourcesOf(
  task: Task,
  scope: 'review' | 'all',
  same: (a: string, b: string) => boolean,
): (TailSourceRef & { text: string; ownerAuthored: boolean })[] {
  const out: (TailSourceRef & { text: string; ownerAuthored: boolean })[] = []
  task.log.forEach((entry: TaskLogEntry, index: number) => {
    if (!entry.note || !DECISION_EVENTS.has(entry.event)) return
    // 裁决 note 是"结论"，不分作者：结清记录里那句"随 T-31 发布"正是丢掉尾巴
    // 的那句话，而它往往是卡主自己写的。（只在 note 里，作者自己的长评论不算。）
    out.push({ kind: 'log', index, at: entry.at, by: entry.by, event: entry.event, text: entry.note, ownerAuthored: false })
  })
  const authors = [task.assignee, task.created_by]
    .filter((name): name is string => typeof name === 'string')
  task.comments.forEach((comment: TaskComment, index: number) => {
    const ownerAuthored = authors.some((name) => same(name, comment.by))
    // `review`（默认）：复核人的留言整条扫；作者自己的留言只按"承诺"类判据扫
    // （`ownerAuthored: true` 让 scanTails 过滤），因为他的交付说明不是待办。
    // `all`：连作者的交付说明一起扫 —— 只在"我就是想看看全量"时用。
    out.push({
      kind: 'comment',
      index,
      at: comment.at,
      by: comment.by,
      text: comment.text,
      ownerAuthored: scope === 'review' && ownerAuthored,
    })
  })
  return out
}
