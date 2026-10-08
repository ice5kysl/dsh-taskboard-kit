/**
 * The reviewer-facing half of dsh-taskboard-kit — 「我该审核什么」必须有主动信号。
 *
 * T-56 的现场：9 张卡挂在 review 列、`reviewer=kimi`，而 kimi 本人反馈
 * 「没有他待办的」。板是对的（`inbox --by kimi` 能列出 13 条），**但没人告诉他**：
 * 他 cwd 不在这个工作区、看的是"指派给我"而不是"欠我审核"，于是那 9 张卡
 * 在他那里等于不存在。这和本周治的病同源 —— **「我该做的事」与「没有任何信号」
 * 不可区分**。
 *
 * 所以：`submit` 成功之后，**指定 reviewer 必须收到一个主动信号**。
 * 三条纪律，缺一不可：
 *
 *   1. **不阻断**：通知是附属动作。没有 msg9 / 地址未知 / 发送失败 / 超时，
 *      一律降级成"只打印可复制的提示"，`submit` 照常成功。这个模块
 *      **对外承诺绝不抛错**（`notifyReviewer` 的整个函数体在一个 try 里）。
 *   2. **幂等**：锚点是卡上最后一条 `submitted` 事件（`<卡号>#log:<下标>`），
 *      记录写进板级 `review_notices`。同一轮提交重放 ⇒ 跳过，不再发第二封。
 *   3. **可见**：无论发没发出去都有日志（"已通知 kimi@…" / "未找到 msg9，已打印提示"），
 *      并且**总是**打印一条可直接复制发送的命令 —— 人肉通道永远在。
 *
 * **地址绝不猜。** 只有板里已有的信息才算数：名册（`board.actors`）里出现的
 * 完整地址、或名字本身就是地址。解析不到就只打印（并在提示里说明地址未知），
 * 绝不去拼一个看起来像的地址 —— 发错的信不会报错，只会静默躺着。
 *
 * 通道**不硬编码**：msg9 只是"环境里恰好有就用"的一个默认动作，和
 * `TASKBOARD_NOTIFY_CMD` 对人类的做法一样，换掉它不需要动看板。
 *
 * @module dsh-taskboard-kit/review-notify
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Board, ReviewNotice, Task } from '../shared/types.ts'
import { actorKeyOf } from '../shared/board.ts'
import { L } from './locale.ts'
import { loadBoard, saveBoard, withBoardLock } from './store.ts'

/** 环境里默认要找的可执行文件。 */
const MSG9 = 'msg9'

/** 发送的硬超时：通知卡住绝不能拖住一次提交。 */
const SEND_TIMEOUT_MS = 8_000

/** 地址判定：**只认完整地址形状**，不做域名补全。 */
const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/
/** 「整个字符串就是一个地址」——不完整的一律不当地址用（`…@x.io（旧）` 这种不能原样发出去）。 */
const FULL_ADDRESS_RE = new RegExp(`^${ADDRESS_RE.source}$`)

/**
 * 从板里已有的信息里找 `who` 的 msg9 地址。**找不到就返回 null**（绝不构造）。
 *
 * 优先级：名字本身就是地址 > 名册里"本地部分相同"的地址 > 没有。
 * 同一个本地部分对应多条地址时取字典序 —— 仍是"不猜"，但结果可复现。
 */
export function msg9AddressOf(board: Board, who: string): string | null {
  const wanted = who.trim()
  if (wanted === '') return null
  if (FULL_ADDRESS_RE.test(wanted)) return wanted.toLowerCase()

  const wantedKey = actorKeyOf(board, wanted)
  const wantedLocal = wanted.toLowerCase()
  const found: string[] = []
  for (const [name, entry] of Object.entries(board.actors ?? {})) {
    for (const raw of [name, ...(entry?.aliases ?? [])]) {
      const text = String(raw)
      // 名册条目本身是地址（真实数据：`dsh@msg9.ice.msg9.io`），
      // 或者标签里嵌着地址（真实数据：`msg9 平台（PO 信箱 dsh@msg9.ice.msg9.io）`）。
      const candidate = ADDRESS_RE.test(text) ? text.match(ADDRESS_RE)![0] : null
      if (!candidate) continue
      const local = candidate.slice(0, candidate.indexOf('@')).toLowerCase()
      // 认人的三条判据（都**只依据板里已有的信息**，不做任何构造/补全）：
      //   ① 地址的本地部分就是 wanted；② 本地部分按名册别名规则与 wanted 同一个人
      //   （dsh ≡ dsh-agent）；③ 整条名册名字与 wanted 是同一个 Actor。
      const sameByRoster = actorKeyOf(board, local) === wantedKey
      if (local === wantedLocal || sameByRoster || actorKeyOf(board, text) === wantedKey) found.push(candidate.toLowerCase())
    }
  }
  return found.length > 0 ? found.sort()[0]! : null
}

/**
 * 本轮提交的稳定锚点：卡上**最后一条** `submitted` 事件的下标。
 * 用下标而不是时间戳：同一毫秒内的两次提交也不会撞号。
 */
export function submitAnchor(task: Pick<Task, 'id' | 'log'>): string | null {
  const index = task.log.map((entry) => entry.event).lastIndexOf('submitted')
  return index < 0 ? null : `${task.id}#log:${index}`
}

/** 幂等记录的 key：同一次提交 + 同一个收件人 = 同一条。 */
export function noticeKey(anchor: string, board: Board, reviewer: string): string {
  return `${anchor}@${actorKeyOf(board, reviewer)}`
}

export type ReviewerNotifyReason = 'no-msg9' | 'no-address' | 'send-failed' | 'disabled'

export interface ReviewerNotice {
  cwd: string
  task: Task
  /** submit 时任命的 reviewer（卡上的 `task.reviewer`）。 */
  reviewer: string
  /** 谁交出去的 —— 写进正文，reviewer 才知道该找谁问。 */
  submittedBy: string
}

export interface ReviewerNotifyResult {
  /** `msg9` = 真的发出去了；`printed` = 只给了可复制的提示；`skipped` = 幂等命中。 */
  how: 'msg9' | 'printed' | 'skipped'
  reviewer: string
  address: string | null
  reason?: ReviewerNotifyReason
  /** 可直接复制发送的提示（`skipped` 时为空串 —— 不重复轰炸也不重复刷屏）。 */
  hint: string
  /** 一行日志：无论发没发出去都要说出来。 */
  message: string
  error?: string
}

export interface ReviewerNotifyDeps {
  /** Seam for tests: 找 msg9 二进制。默认扫 PATH（`TASKBOARD_MSG9_BIN` 可覆盖）。 */
  findBinary?(name: string): string | null
  /** Seam for tests: 执行发送。默认 spawn 一个真实进程。 */
  runSend?(binary: string, args: string[], cwd: string): Promise<void>
  log(message: string): void
}

/** 可执行文件判定（真文件 + 有 x 位；目录不算）。 */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 在 PATH 里找二进制。`TASKBOARD_MSG9_BIN` 优先（指向 wrapper 时可自己加
 * `--project` 之类的凭据参数 —— 凭据怎么解析是 msg9 的事，看板不猜）。
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.TASKBOARD_MSG9_BIN?.trim()
  if (override) return isExecutableFile(override) ? override : null
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/** 真的跑一次 `msg9 send`；非 0 退出／超时／spawn 失败都变成 reject（由上层降级）。 */
export function defaultRunSend(binary: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`msg9 send timed out after ${SEND_TIMEOUT_MS}ms`))
    }, SEND_TIMEOUT_MS)
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.stdout?.resume()
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`msg9 send exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`))
    })
  })
}

/** 一句话正文：卡号 + 标题 + reviewer 该敲的命令（带 --cwd，因为他可能不在这个工作区）。 */
export function reviewNoticeBody(notice: ReviewerNotice): string {
  return L(
    '{id} · {status} · 等你审核：{title} —— 跑：taskboard inbox --by {reviewer} --cwd {cwd}',
    '{id} · {status} · awaiting your review: {title} — run: taskboard inbox --by {reviewer} --cwd {cwd}',
    {
      id: notice.task.id,
      status: notice.task.status,
      title: shorten(notice.task.title, 80),
      reviewer: notice.reviewer,
      cwd: notice.cwd,
    },
  )
}

/** 主题行。 */
export function reviewNoticeSubject(notice: ReviewerNotice): string {
  return L(
    '[看板] {id} 请你审核：{title}',
    '[board] {id} awaits your review: {title}',
    { id: notice.task.id, title: shorten(notice.task.title, 60) },
  )
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** shell 单引号转义（提示要能被原样复制粘贴，标题里带引号也不能炸）。 */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * 打印用提示：一条**可直接复制发送**的命令。地址未知时收件人位置留占位符，
 * 并说明"地址未知"—— 绝不替他编一个。
 */
export function reviewNotifyHint(
  notice: ReviewerNotice,
  address: string | null,
  outcome: { how: 'msg9' | 'printed'; reason?: ReviewerNotifyReason },
): string {
  const to = address ?? '<reviewer 的 msg9 地址>'
  const command = `msg9 send --to ${shellQuote(to)} --subject ${shellQuote(reviewNoticeSubject(notice))} --body ${shellQuote(reviewNoticeBody(notice))}`
  const head = address === null
    ? L(
      '⚠ {reviewer} 的 msg9 地址未知（板里名册没有，地址不猜）—— 补上收件人再发：',
      '⚠ no msg9 address on this board for {reviewer} (never guessed) — fill in the recipient and send:',
      { reviewer: notice.reviewer },
    )
    : L(
      '{reviewer} 不在这个工作区就看不到这张卡 —— 主动告他一声：',
      '{reviewer} cannot see this card unless told (their cwd may differ) — ping them:',
      { reviewer: notice.reviewer },
    )
  const tail = outcome.how === 'msg9'
    ? L('（已自动发出 ✓ 这行只是留底）', '(already sent automatically ✓ this line is just a record)')
    : L('（{why}，未自动发送；提交已完成，不受影响）', '({why}; not sent automatically — the submit itself is done and unaffected)', {
      why: reasonLabel(outcome.reason),
    })
  return `${head}\n  ${command}\n  ${tail}`
}

function reasonLabel(reason: ReviewerNotifyReason | undefined): string {
  switch (reason) {
    case 'no-msg9':
      return L('环境里没有 msg9 二进制', 'no msg9 binary on this machine')
    case 'no-address':
      return L('没有他的 msg9 地址', 'no msg9 address on record')
    case 'send-failed':
      return L('msg9 send 失败', 'msg9 send failed')
    case 'disabled':
      return L('TASKBOARD_REVIEW_NOTIFY 关掉了自动发送', 'TASKBOARD_REVIEW_NOTIFY turned auto-send off')
    default:
      return L('未发送', 'not sent')
  }
}

function noticeDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(0|off|false|no)$/i.test((env.TASKBOARD_REVIEW_NOTIFY ?? '').trim())
}

/**
 * 通知 `notice.reviewer`：这张卡交给他审核了。
 *
 * **绝不抛错**（合同，见模块头）：任何意外都在这里变成一条日志 + 一个
 * `printed` 结果，`submit` 不受影响。发送成功与否都会写幂等记录。
 */
export async function notifyReviewer(
  notice: ReviewerNotice,
  deps: ReviewerNotifyDeps,
): Promise<ReviewerNotifyResult> {
  try {
    return await attemptNotify(notice, deps)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.log(L(
      '通知 reviewer 时出错（已忽略，提交不受影响）：{error}',
      'reviewer notification blew up (ignored; the submit is unaffected): {error}',
      { error: message },
    ))
    return {
      how: 'printed',
      reviewer: notice.reviewer,
      address: null,
      reason: 'send-failed',
      hint: '',
      message,
      error: message,
    }
  }
}

async function attemptNotify(notice: ReviewerNotice, deps: ReviewerNotifyDeps): Promise<ReviewerNotifyResult> {
  const board = await loadBoard(notice.cwd)
  const anchor = submitAnchor(notice.task)
  const address = msg9AddressOf(board, notice.reviewer)

  // 没有 submitted 事件就没有"这一轮提交"可锚定：只打印，不记幂等（无锚点可记）。
  if (anchor === null) {
    const hint = reviewNotifyHint(notice, address, { how: 'printed' })
    const message = L(
      '{id} 找不到本轮 submit 事件，未发送，只打印提示',
      '{id} has no submitted event to anchor on; printed the hint only',
      { id: notice.task.id },
    )
    deps.log(message)
    return { how: 'printed', reviewer: notice.reviewer, address, reason: 'send-failed', hint, message }
  }

  const key = noticeKey(anchor, board, notice.reviewer)
  const recorded = (board.review_notices ?? {})[key]
  if (recorded) {
    const message = L(
      '{id} 这一轮提交已经通知过 {reviewer}（{at}，幂等跳过）',
      '{id}: {reviewer} was already notified for this submission ({at}; idempotent skip)',
      { id: notice.task.id, reviewer: notice.reviewer, at: recorded.at },
    )
    deps.log(message)
    return { how: 'skipped', reviewer: notice.reviewer, address: recorded.address, hint: '', message }
  }

  let how: 'msg9' | 'printed' = 'printed'
  let reason: ReviewerNotifyReason | undefined
  let error: string | undefined
  const env = process.env
  if (noticeDisabled(env)) {
    reason = 'disabled'
  } else if (address === null) {
    reason = 'no-address'
  } else {
    const binary = (deps.findBinary ?? ((name: string) => findOnPath(name)))(MSG9)
    if (binary === null) {
      reason = 'no-msg9'
    } else {
      const args = [
        'send',
        '--to', address,
        '--subject', reviewNoticeSubject(notice),
        '--body', reviewNoticeBody(notice),
        // 服务端幂等：同一次提交重放时返回原消息，而不是再发一封。
        '--idempotency-key', `taskboard-review-${anchor.replace('#', '-')}-${actorKeyOf(board, notice.reviewer)}`,
      ]
      try {
        await (deps.runSend ?? defaultRunSend)(binary, args, notice.cwd)
        how = 'msg9'
      } catch (sendError) {
        reason = 'send-failed'
        error = sendError instanceof Error ? sendError.message : String(sendError)
      }
    }
  }

  const hint = reviewNotifyHint(notice, address, { how, ...(reason ? { reason } : {}) })
  const message = how === 'msg9'
    ? L(
      '已通知 {reviewer}{addr}（msg9 send 成功）',
      'notified {reviewer}{addr} (msg9 send ok)',
      { reviewer: notice.reviewer, addr: address ? ` <${address}>` : '' },
    )
    : L(
      '未自动发送（{why}）—— 已打印可直接复制发送的提示；提交已完成',
      'not sent automatically ({why}) — printed a ready-to-copy hint; the submit is done',
      { why: reasonLabel(reason) },
    )
  if (error) deps.log(L('msg9 send 失败：{error}', 'msg9 send failed: {error}', { error }))
  deps.log(message)

  // 无论发没发出去都记下来：否则同一个命令重放会再炸一次（也是幂等的唯一载体）。
  try {
    await recordNotice(notice.cwd, key, {
      task: notice.task.id,
      reviewer: notice.reviewer,
      anchor,
      how,
      reason: reason ?? null,
      address,
      at: new Date().toISOString(),
    })
  } catch (recordError) {
    deps.log(L(
      '写幂等记录失败（忽略，不影响提交）：{error}',
      'could not persist the idempotency record (ignored): {error}',
      { error: recordError instanceof Error ? recordError.message : String(recordError) },
    ))
  }

  return { how, reviewer: notice.reviewer, address, ...(reason ? { reason } : {}), hint, message, ...(error ? { error } : {}) }
}

/** 落一条去重记录（板文件里 `review_notices`；旧板读端容忍缺失，不需要迁移）。 */
async function recordNotice(cwd: string, key: string, record: ReviewNotice): Promise<void> {
  await withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd)
    const notices = (board.review_notices ??= {})
    notices[key] = record
    await saveBoard(cwd, board)
  })
}
