/**
 * Theme tokens and the interactive-state stylesheet of dsh-taskboard-kit's
 * browser face — shared by the board tab (BoardPanel) and the composer-side
 * mini board (MiniBoard), so both inject the same rules and read the same
 * palette.
 *
 * Colors ride the dsh shell's `--dsw-alias-*` design tokens with fallbacks
 * for older shells. Inline styles cannot express :hover / :focus / :disabled,
 * so every interactive element carries a class from `TB_CSS`, injected ONCE
 * into document.head by {@link ensureTaskboardStyles} — see that function for
 * why the tag must be born tagged `data-plugin` and must NOT live in the React
 * tree.
 *
 * Token lessons baked in (see the commit history for the evidence trail):
 *  - brand-primary is the shell's INVERTED monochrome (near-black in light,
 *    near-white in dark) — never a colored fill; button-primary-fill is just
 *    its alias. The shell's blue primary button (composer send key) is
 *    `link` + `label-primary-foreground` + `button-info-hover`.
 *  - Text-level accents (links, badges, active chip/tab text) use `link` —
 *    blue in both themes.
 *  - The only hardcoded colors left are the three box-shadow alphas (the
 *    shell has no shadow tokens — verified against the full
 *    dsh-client-ui-theme dump) and the light fallbacks inside var(), which
 *    only fire on pre-token shells.
 *
 * @module dsh-taskboard-kit/client-theme
 */

import type { TaskPriority } from '../shared/types.ts'

export const FG = 'var(--dsw-alias-label-primary, #1f2328)'
export const DIM = 'var(--dsw-alias-label-secondary, #6b7280)'
export const TERTIARY = 'var(--dsw-alias-label-tertiary, #8a919c)'
/**
 * The quietest *readable* tier. NOT `--dsw-alias-label-dimmed`: that shell
 * token is the near-INVISIBLE tier on purpose — it resolves to #e1e5ee on the
 * light theme's white and #43454a on the dark theme's #2c2c2e (≈1.1:1 / 1.3:1),
 * which is fine for a decorative mark and fatal for text. Using it for task
 * refs (`#17`), value points (`◆2`) and column ages made them unreadable in
 * BOTH themes (owner report + screenshot, 2026-09-30). The quiet-but-legible
 * tier is `label-tertiary` (#81858c / #adb2b8).
 */
export const FAINT = 'var(--dsw-alias-label-tertiary, #8a919c)'
export const BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
export const BG_SUNK = 'var(--dsw-alias-bg-layer-1, #f5f7fa)'
export const BG_RAISED = 'var(--dsw-alias-bg-layer-3, #ffffff)'
export const BORDER = 'var(--dsw-alias-border-l1, rgba(28,35,51,0.12))'
export const BORDER_STRONG = 'var(--dsw-alias-border-l2, rgba(28,35,51,0.20))'
export const ACCENT = 'var(--dsw-alias-brand-primary, #2d66f7)'
export const DANGER = 'var(--dsw-alias-state-error-primary, #dc2626)'
/**
 * 「完成 / 已交付」的语义色（T-42 第 3 条，kimi 在 T-28 复审里的遗留 nit ①）。
 *
 * 宿主在两个主题里都是同一个绿（`--dsw-static-green-500` = #22c55e），所以它能当
 * **数据色**用 —— 而 `ACCENT`（brand-primary）在 light ≈ 近黑 / dark ≈ 近白，拿它画
 * 图表只靠明度区分、深色下几乎读不出来。它只做**填充**（图例色块 / 环形切片 /
 * 进度条），不做正文色：绿在浅色底上小字号正文的对比度不够。
 */
export const SUCCESS = 'var(--dsw-alias-state-success-primary, #22c55e)'
export const HOVER_BG = 'var(--dsw-alias-interactive-bg-hover, rgba(28,35,51,0.06))'
/** The shell's blue primary action (composer send key, measured): link fill. */
export const PRIMARY_FILL = 'var(--dsw-alias-link, #2d66f7)'
/** No link-hover token exists; button-info-hover is the official pair of the
 *  fill that equals link in both themes (light #679efe / dark #4176e6). */
export const PRIMARY_FILL_HOVER = 'var(--dsw-alias-button-info-hover, #5686fe)'
export const ON_PRIMARY = 'var(--dsw-alias-label-primary-foreground, #ffffff)'
export const LINK = 'var(--dsw-alias-link, #2d66f7)'
export const WARN = 'var(--dsw-alias-state-warn-primary, #d97706)'
export const FOCUS_HALO = 'var(--dsw-alias-interactive-bg-hover-accent, rgba(45,102,247,0.18))'
export const DANGER_BG = 'var(--dsw-alias-interactive-bg-hover-danger, rgba(220,38,38,0.12))'
export const MASK = 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.28))'

export const PRIORITY_COLORS: Record<TaskPriority, string> = { high: DANGER, medium: WARN, low: FAINT }

/**
 * 导航区（topbar）的像素常量 —— T-38 的规格值，4px 基准的间距阶梯 + 28px 的控件
 * 外壳。**单独导出**而不是散在 JSX 里，是因为「组内 4 / 组间 16 / 主操作前 12」
 * 与「可点控件一律 28px、圆角 6」是规格本身：测试要能把常量和真正渲染出来的
 * inline style / CSS 规则对起来（只会写死数字的人，改不动自己写死的数字）。
 *
 * 行内边距**保持既有 `10px 14px` 不动**：改它会牵动整块面板的节奏（泳道内边距、
 * 卡间距都按这个密度定的），属于另一件事。
 */
export const TB_TOOLBAR = {
  /** 组内相邻控件（`? ⓘ`、身份段两段之间）的间距。 */
  itemGap: 4,
  /** 组与组之间（身份 | 视图 | 筛选 | 操作）的间距。 */
  groupGap: 16,
  /** 操作组与主操作之间的间距：比组间紧一点，读作「这一组动作」。 */
  primaryGap: 12,
  /** 所有可点控件的外壳高度。 */
  controlHeight: 28,
  /** 控件外壳圆角，与既有 `.tb-iconbtn` 一致。 */
  radius: 6,
  /** 工具栏行的内边距（既有值，不动）。 */
  padding: '10px 14px',
} as const

/** Interactive-state rules for the tb-* classes used across the surfaces. */
export const TB_CSS = `
.tb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: transparent; color: inherit; padding: 5px 10px; font-size: 12px; font-family: inherit; line-height: 1.4; cursor: pointer; }
.tb-btn:hover { background: ${HOVER_BG}; }
.tb-btn:disabled { opacity: 0.55; cursor: default; }
.tb-btn:disabled:hover { background: transparent; }
/* The shell's blue primary button: link fill + on-fill text + info-hover
   (the composer send key's measured recipe) — blue and readable in BOTH themes. */
.tb-btn-primary { background: ${PRIMARY_FILL}; border-color: transparent; color: ${ON_PRIMARY}; font-weight: 500; }
.tb-btn-primary:hover { background: ${PRIMARY_FILL_HOVER}; }
.tb-btn-primary:disabled:hover { background: ${PRIMARY_FILL}; }
.tb-btn-danger { color: ${DANGER}; }
.tb-iconbtn { display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 6px; background: transparent; color: ${DIM}; padding: 4px 6px; font-size: 13px; font-family: inherit; line-height: 1; cursor: pointer; }
.tb-iconbtn:hover { background: ${HOVER_BG}; color: ${FG}; }
.tb-input, .tb-textarea { width: 100%; box-sizing: border-box; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: ${BG}; color: inherit; padding: 6px 9px; font-size: 12.5px; font-family: inherit; line-height: 1.5; }
.tb-input::placeholder, .tb-textarea::placeholder { color: ${DIM}; opacity: 0.7; }
.tb-input:focus, .tb-textarea:focus { outline: none; border-color: ${LINK}; box-shadow: 0 0 0 3px ${FOCUS_HALO}; }
.tb-textarea { resize: vertical; }
.tb-card { display: block; width: 100%; box-sizing: border-box; text-align: left; border: 1px solid ${BORDER}; border-radius: 8px; background: ${BG_RAISED}; color: inherit; padding: 6px 8px; font-family: inherit; cursor: pointer; }
.tb-card:hover { border-color: ${ACCENT}; }
.tb-card.active { border-color: ${ACCENT}; box-shadow: 0 0 0 1px ${ACCENT}; }
/* T-76「在等你决定」的凸显之一：**左侧竖条**（另两处是卡面第一行的 ⏳ 徽章、列内排
   最前，见 waitingFirst）。用 inset box-shadow 而不是 border-left：border 会把内容
   右推 2px（同一列里"等待卡的字比别人偏一点"读起来像排版坏了），inset 阴影只画不占
   布局。active 的描边是**外**阴影 —— 两条不能同时声明（同一元素上 box-shadow 只有
   一条），所以两者同时命中时显式合并（见下一条规则）。
   竖条用 **LINK 蓝** 而不是 ACCENT：ACCENT 是宿主 brand-primary —— 它是**反相单色**
   （浅色下近黑、深色下近白，见本文件顶部那条 token 教训），不是蓝。主人的要求是
   「蓝系」，而且要在两个主题下都是同一个记号 ⇒ 用与 ⏳ 徽章同一个蓝（LINK）。 */
.tb-card-wait { box-shadow: inset 3px 0 0 ${LINK}; }
.tb-card.active.tb-card-wait { box-shadow: 0 0 0 1px ${ACCENT}, inset 3px 0 0 ${LINK}; }
/* 「跳过去」的落点高亮：outline 不参与布局（高亮不会把卡片挤动一下），1.2s 自己淡掉
   —— 卡本来就在列表里，高亮只是指路，不是一种新的状态。同样是那个蓝。 */
.tb-card-flash { outline: 2px solid ${LINK}; outline-offset: 2px; animation: tb-flash 1200ms ease-out 1 both; }
@keyframes tb-flash { 0%, 55% { outline-color: ${LINK}; } 100% { outline-color: transparent; } }
.tb-chip { border: 1px solid ${BORDER}; border-radius: 999px; background: transparent; color: ${DIM}; padding: 3px 11px; font-size: 11px; font-family: inherit; cursor: pointer; }
.tb-chip:hover { color: ${FG}; border-color: ${BORDER_STRONG}; }
.tb-chip.active { background: ${HOVER_BG}; color: ${LINK}; border-color: ${LINK}; font-weight: 600; }
/* 三枚 10px 药丸都必须自己会截断：长 actor 名（或长 tag）以前会**视觉溢出虚线边框**，
   再被泳道的 overflow:hidden 从中间切掉 —— 看起来像排版坏了而不是"名字太长"。
   max-width:100% 是给 flex 容器用的（父级再窄也只会截断，不会撑破）；药丸里的文字
   节点各自再带 min-width:0 + ellipsis（见 BoardPanel/MiniBoard 的 who 样式），
   因为 inline-flex 容器上的 text-overflow 管不到子元素。 */
.tb-tag { font-size: 10px; color: ${DIM}; border: 1px solid ${BORDER}; border-radius: 999px; padding: 1px 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-badge { display: inline-flex; align-items: center; font-size: 10px; color: ${LINK}; background: ${HOVER_BG}; border-radius: 999px; padding: 1px 7px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-badge-outline { display: inline-flex; align-items: center; font-size: 10px; color: ${DIM}; border: 1px dashed ${BORDER_STRONG}; border-radius: 999px; padding: 0 7px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* T-76：**「等你决定」的徽章**。它必须一眼就和「已超时」分开，因为它俩说的不是一回事
   （一个是"该你拍板"，一个是"这件事拖太久了"）。两重区分，缺一不可：
     · 颜色：link 蓝（两个主题下都是蓝） vs WARN 琥珀；
     · 形状：**实心 + 5px 圆角矩形**（与 .tb-prop-copy 同一档圆角） vs **描边 + 999px 胶囊**。
   前身是 .tb-badge-wait（琥珀描边胶囊）——「等你」绝不能沿用那个形状，否则扫视时
   "超时"与"等你"会等价，那正是本周在治的病（两种不同的事看起来一样）。 */
.tb-badge-you { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; font-size: 10px; line-height: 16px; color: ${ON_PRIMARY}; background: ${PRIMARY_FILL}; border-radius: 5px; padding: 0 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* v0.5.4 collaboration marks: "parked on someone" (amber, shared by the card
   and the drawer) and "past its column SLA" (a quiet dot, deliberately NOT a
   red alarm — see the human strip for the one place that speaks up). */
.tb-badge-wait { display: inline-flex; align-items: center; font-size: 10px; color: ${WARN}; border: 1px solid ${WARN}; border-radius: 999px; padding: 0 7px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-stale { display: inline-block; width: 5px; height: 5px; border-radius: 3px; background: ${TERTIARY}; flex-shrink: 0; align-self: center; }
/* The human strip's card button: reads as a title, behaves like a link. */
.tb-human-card { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; border: none; border-radius: 6px; background: transparent; color: inherit; padding: 1px 4px; font-family: inherit; font-size: 12.5px; font-weight: 500; line-height: 1.5; cursor: pointer; text-align: left; }
.tb-human-card:hover { background: ${HOVER_BG}; }
/* Drop-target highlight rides the injected stylesheet (inline styles cannot
   express state classes); !important beats the lane's inline background. */
.tb-column.dragover { box-shadow: inset 0 0 0 2px ${ACCENT} !important; background: ${HOVER_BG} !important; }
/* The collapsed closed column (narrow vertical strip). */
.tb-closed-strip:hover { background: ${HOVER_BG} !important; }
/* In-column assignee picker rows. */
.tb-picker-row { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 6px; border: none; border-radius: 6px; background: transparent; color: inherit; padding: 7px 10px; font-size: 12px; font-family: inherit; cursor: pointer; text-align: left; }
.tb-picker-row:hover { background: ${HOVER_BG}; }
/* Drawer tab strip. */
.tb-tab { border: none; border-bottom: 2px solid transparent; background: transparent; color: ${DIM}; padding: 6px 2px; font-size: 12px; font-family: inherit; cursor: pointer; }
.tb-tab:hover { color: ${FG}; }
.tb-tab.active { color: ${LINK}; border-bottom-color: ${LINK}; font-weight: 600; }
/* 详情抽屉 v2（T-29）：这一组全部复用上面的 token —— 没有新配色、没有第三方 UI 库。
   粘性头部是 position:sticky + 负 margin 盖住滚动容器的内边距带（见 BoardPanel 的
   drawerHeadWrap），标签页上的「有新动态」圆点与琥珀色的「久未活动」点都只是记号。 */
.tb-tab-dot { display: inline-block; width: 6px; height: 6px; border-radius: 3px; background: ${LINK}; margin-left: 5px; vertical-align: 1px; }
.tb-quiet-dot { display: inline-block; width: 6px; height: 6px; border-radius: 3px; background: ${WARN}; flex-shrink: 0; }
/* 抽屉头部（T-75）：「#id + 标题 + 主操作 / 编辑 / ×」。
   0.8.0 的写法是「标题 flex:1 + min-width:0」—— 在 320px 视口（抽屉 236px）下，三枚
   右侧控件加起来就快把那一行占满，标题被压到 **≈1 个汉字宽 ⇒ 竖排**，头部整块高
   **935px**（T-74 实测两遍，改前改后同值 ⇒ 0.8.0 起的既有缺陷，不是 T-74 引入）。
   修法（实测选出来的，见 T-75 卡）：flex-wrap + 给标题一个 flex-basis 的**下限**
   —— 标题拿不到那个宽度就整体换行，而不是一个一个字往下掉。
   （布局写在这里而不是 inline style：inline 压过样式表，窄视口行为就没法被覆盖、
   负面对照、测试读到了。） */
.tb-drawer-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; }
.tb-drawer-ref { flex-shrink: 0; }
/* flex-basis 是**下限**，不是宽度：160px 是"标题至少要有这么宽才配和别的控件同行"
   的门槛。低于它 ⇒ 标题整条换行（拿满 208px），而不是被压成一根竖条。
   为什么不是 0%（= 0.8.0 的 flex:1）：flex-basis:0 让标题的 hypothetical size 也是 0，
   换行算法永远认为它"放得下" ⇒ flex-wrap 一个人救不了场（实测：wrap 单独用，
   320px 下头部仍是 953.95px、标题 15px 宽）。两者必须一起上。 */
.tb-drawer-title { flex: 1 1 160px; min-width: 0; }
/* T-76 汇总条里的「跳过去 ▸」：读起来是一句链接，行为是一个按钮（与 .tb-link 同一套
   语言：link 蓝、无边框、hover 才浮底）。 */
.tb-wait-jump { border: none; border-radius: 6px; background: transparent; color: ${LINK}; font: inherit; font-size: 11.5px; line-height: 16px; padding: 2px 6px; white-space: nowrap; cursor: pointer; }
.tb-wait-jump:hover { background: ${HOVER_BG}; }
/* 属性区（T-74 结构重塑）：四行语义行 —— 人 / 值 / 时 / 标签。
   行首 66px 的 muted 小字标签 + 右侧「标签 值 · 标签 值」的 flex 流；字段之间
   的分隔符用 ::before 挂在**后一个字段**上，于是折行时「·」永远跟着下一段的
   开头走，不会孤零零掉在行尾。字段不收缩（flex:0 0 auto）+ max-width:100%：
   一条超长的值（「—（没人欠这次裁决）」）自己折行，绝不会把整行撑出抽屉。 */
.tb-prop-line { display: grid; grid-template-columns: 66px minmax(0, 1fr); align-items: baseline; gap: 10px; }
.tb-prop-label { font-size: 10px; color: ${DIM}; line-height: 18px; }
.tb-prop-fields { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.tb-prop-field { display: inline-flex; align-items: baseline; gap: 5px; flex: 0 0 auto; min-width: 0; max-width: 100%; }
.tb-prop-field + .tb-prop-field::before { content: '·'; color: ${FAINT}; }
.tb-prop-field-label { flex-shrink: 0; font-size: 10px; color: ${DIM}; line-height: 18px; }
.tb-prop-field-val { min-width: 0; font-size: 11.5px; line-height: 18px; overflow-wrap: anywhere; }
.tb-prop-copy { border: none; border-radius: 5px; background: transparent; color: inherit; font: inherit; font-size: 11.5px; line-height: 18px; text-align: left; padding: 0 3px; cursor: pointer; }
.tb-prop-copy:hover { background: ${HOVER_BG}; }
/* 属性区第四行的标签药丸（沿用 .tb-tag，只是排成一条会折行的流）。 */
.tb-tagline { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
/* 动作区（T-74）：能按的动作是**一行胶囊**；结果列进 title（沿用既有 label /
   title / disabled 语义），不可执行的动作折进下一行的 disclosure。 */
.tb-action-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.tb-action-chips .tb-btn { white-space: nowrap; }
.tb-action-more { font-size: 10.5px; color: ${DIM}; padding: 3px 8px; }
.tb-action-more-mark { font-size: 10px; color: ${FAINT}; }
/* 指派（T-74）：「当前：<谁>」 + 展开式 combobox + 小号次操作，全在一行里。 */
.tb-assign-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.tb-assign-current { display: inline-flex; align-items: baseline; gap: 2px; min-width: 0; font-size: 11.5px; line-height: 18px; overflow-wrap: anywhere; }
.tb-assign-more { font-size: 10.5px; padding: 3px 8px; }
/* 折起的那一层：仍然是 0.8.0 的「左按钮右原因」，只是默认 hidden。 */
.tb-action-row { display: grid; grid-template-columns: 108px minmax(0, 1fr); align-items: center; gap: 10px; }
.tb-action-row .tb-btn { width: 100%; }
.tb-action-row[data-off="1"] .tb-btn { opacity: 0.5; }
.tb-action-reason { font-size: 10.5px; color: ${FAINT}; line-height: 1.5; }
/* 属性表里可点的标签：沿用 .tb-tag 的 10px 药丸，只是变成按钮。 */
.tb-tag-btn { background: transparent; font-family: inherit; cursor: pointer; }
.tb-tag-btn:hover { color: ${FG}; border-color: ${BORDER_STRONG}; }
.tb-tag-btn.active { color: ${LINK}; border-color: ${LINK}; background: ${HOVER_BG}; font-weight: 600; }
/* 「关于」浮层里的外链行：整行可点，hover 才浮起来（行内还有一行 10px 的目标提示）。 */
.tb-about-link:hover { background: ${HOVER_BG}; }
/* Rendered markdown (drawer detail + comments): compact, both themes. */
.tb-md { overflow-wrap: break-word; min-width: 0; }
.tb-md h1, .tb-md h2, .tb-md h3, .tb-md h4, .tb-md h5, .tb-md h6 { margin: 0.7em 0 0.35em; line-height: 1.35; font-weight: 600; }
.tb-md h1 { font-size: 16px; } .tb-md h2 { font-size: 14.5px; } .tb-md h3 { font-size: 13.5px; } .tb-md h4, .tb-md h5, .tb-md h6 { font-size: 12.5px; }
.tb-md p { margin: 0.4em 0; }
.tb-md ul, .tb-md ol { margin: 0.3em 0; padding-left: 1.35em; }
.tb-md li { margin: 0.12em 0; }
.tb-md a { color: ${LINK}; text-decoration: none; }
.tb-md a:hover { text-decoration: underline; }
/* Images never overflow the drawer (a markdown image is a real tag now), and a
   task-list checkbox sits on the text baseline instead of shoving the line. */
.tb-md img { max-width: 100%; height: auto; border-radius: 8px; }
.tb-md input[type="checkbox"] { vertical-align: -1px; margin: 0 5px 0 0; }
.tb-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; background: ${HOVER_BG}; padding: 1px 5px; border-radius: 5px; }
.tb-md pre { background: ${BG_SUNK}; border: 1px solid ${BORDER}; border-radius: 8px; padding: 9px 11px; overflow-x: auto; margin: 0.5em 0; line-height: 1.6; tab-size: 2; }
.tb-md pre code { background: transparent; padding: 0; display: block; white-space: pre; }
.tb-md blockquote { margin: 0.5em 0; padding: 2px 12px; border-left: 3px solid ${ACCENT}; color: ${DIM}; border-radius: 0 6px 6px 0; }
.tb-md hr { border: none; border-top: 1px solid ${BORDER}; margin: 0.8em 0; }
/* GFM tables scroll sideways instead of stretching the drawer. */
.tb-md .tb-table-wrap { overflow-x: auto; margin: 0.55em 0; }
.tb-md table { border-collapse: collapse; font-size: 12px; line-height: 1.5; }
.tb-md th, .tb-md td { border: 1px solid ${BORDER}; padding: 4px 9px; text-align: left; vertical-align: top; }
.tb-md th { background: ${BG_SUNK}; font-weight: 600; white-space: nowrap; }
/* Mini board (status-bar entry + right drawer): stats-row pill, section drop
   targets, compact rows. */
.tb-mini-sec.dragover { box-shadow: inset 0 0 0 1.5px ${ACCENT} !important; background: ${HOVER_BG} !important; }
.tb-mini-row { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 6px; border: none; border-radius: 6px; background: transparent; color: inherit; padding: 5px 8px; font-size: 12px; font-family: inherit; line-height: 1.4; cursor: pointer; text-align: left; }
.tb-mini-row:hover { background: ${HOVER_BG}; }
.tb-mini-row.dragging { opacity: 0.5; }
.tb-mini-closed:hover { background: ${HOVER_BG}; }
/* The entry pill: same visual weight as the shipped stats pills (quiet
   tertiary text, transparent until hovered). */
.tb-mini-entry { display: inline-flex; align-items: center; gap: 5px; border: none; border-radius: 24px; background: transparent; color: ${TERTIARY}; padding: 1px 8px; font: inherit; cursor: pointer; white-space: nowrap; }
.tb-mini-entry:hover { background: ${HOVER_BG}; color: ${DIM}; }
/* 统计页（T-28）：真网格，不是 flex-wrap。
   flex-wrap 会在右侧留一大片空白（两个块各自 50% 但换行时机由内容决定）；
   auto-fit + minmax 让「放得下两块就两块，放不下就一块」由容器宽度决定：
   1180px 的面板 = 两列，窄面板自动落回单列。gap 取 10，与看板泳道同一套密度。 */
.tb-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 10px; align-items: start; }
.tb-stats-wide { grid-column: 1 / -1; }
.tb-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 8px; }
/* 可点行（持球人 / 异常 / 里程碑展开的卡）：行内是文字，行为是链接。 */
.tb-stats-row { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 7px; border: none; border-bottom: 1px solid ${BORDER}; background: transparent; color: inherit; padding: 5px 6px; font-size: 11.5px; font-family: inherit; line-height: 1.45; cursor: pointer; text-align: left; }
.tb-stats-row:hover { background: ${HOVER_BG}; }
.tb-stats-row:last-child { border-bottom: none; }
.tb-stats-row[data-flat="1"] { cursor: default; }
.tb-stats-row[data-flat="1"]:hover { background: transparent; }
.tb-mstone-card { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 6px; border: 1px solid ${BORDER}; border-radius: 6px; background: transparent; color: inherit; padding: 3px 7px; font-size: 10.5px; font-family: inherit; line-height: 1.5; cursor: pointer; text-align: left; }
.tb-mstone-card:hover { background: ${HOVER_BG}; border-color: ${BORDER_STRONG}; }
/* ---- 导航区（T-38, v0.7.4）---------------------------------------------------
   工具栏的每一个可点控件都是同一只 ${TB_TOOLBAR.controlHeight}px 高、${TB_TOOLBAR.radius}px 圆角的外壳
   （TB_TOOLBAR），间距由行内 style 给（组内 4 / 组间 16 / 主操作前 12）。这里
   只放**状态**：hover / 按下 / 键盘 focus-visible —— 行内 style 表达不了伪类。
   为什么另起一套 .tb-toolbtn 而不改 .tb-iconbtn：后者还挂在抽屉、选择器、mini
   抽屉的关闭键上（那些是 ~22px 的文字按钮），把它改成 28px 方盒会顺手改掉三个
   这次没在动的地方。
   按下反馈只碰 background / color / transform（不动布局、不引动画库），过渡
   50ms —— 「按下 50ms 内有反馈」是个可测的时长，不是感觉。 */
.tb-toolbtn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: ${TB_TOOLBAR.controlHeight}px; height: ${TB_TOOLBAR.controlHeight}px; padding: 0; border: 1px solid transparent; border-radius: ${TB_TOOLBAR.radius}px; background: transparent; color: ${DIM}; font-family: inherit; line-height: 1; cursor: pointer; transition: background-color 50ms ease, color 50ms ease; }
.tb-toolbtn:hover { background: ${HOVER_BG}; color: ${FG}; }
.tb-toolbtn:active { background: ${FOCUS_HALO}; color: ${FG}; transform: translateY(0.5px); }
.tb-toolbtn:focus-visible { outline: 2px solid ${LINK}; outline-offset: -1px; }
.tb-toolbtn-primary { box-sizing: border-box; height: ${TB_TOOLBAR.controlHeight}px; padding: 0 12px; border-radius: ${TB_TOOLBAR.radius}px; }
.tb-toolbtn-primary:active { transform: translateY(0.5px); }
/* 视图组的两个盒子：按进度|按负责人 一盒，统计 同壳、16px 分列（盒内分割线分不清，
   所以仍分两盒 —— 但同壳，读起来还是一组）。盒子用 inset 阴影画边、不占布局高度：
   这样里面的控件与外面的 28px 图标按钮同高、同一行基线。 */
.tb-seg-group { display: inline-flex; align-items: center; height: ${TB_TOOLBAR.controlHeight}px; box-sizing: border-box; border-radius: ${TB_TOOLBAR.radius}px; box-shadow: inset 0 0 0 1px ${BORDER}; overflow: hidden; }
.tb-seg { display: inline-flex; align-items: center; height: ${TB_TOOLBAR.controlHeight}px; border: none; border-radius: ${TB_TOOLBAR.radius}px; background: transparent; color: ${DIM}; font-family: inherit; font-size: 11.5px; padding: 0 10px; cursor: pointer; white-space: nowrap; transition: background-color 50ms ease, color 50ms ease; }
.tb-seg:hover { background: ${HOVER_BG}; color: ${FG}; }
.tb-seg:active { background: ${FOCUS_HALO}; color: ${FG}; transform: translateY(0.5px); }
.tb-seg.active, .tb-seg.active:hover { background: ${HOVER_BG}; color: ${FG}; font-weight: 600; }
.tb-seg:focus-visible { outline: 2px solid ${LINK}; outline-offset: -2px; }
/* 筛选组：「含已关闭」是一只 toggle chip（不再用原生 checkbox —— 它跟着系统字体走、
   跟 28px 外壳对不齐，勾选框的大小还随平台变）。选中态用宿主 accent 底色 + 勾记号：
   accent = 外壳的 brand-primary（浅色主题近黑 / 深色主题近白），配对前景是
   label-primary-foreground，两个主题都读得出来。方框 → 勾就是状态本身，窄档只留
   它也不丢信息（文字进 tooltip）。 */
.tb-chip-toggle { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; height: ${TB_TOOLBAR.controlHeight}px; padding: 0 10px; border: 1px solid ${BORDER}; border-radius: ${TB_TOOLBAR.radius}px; background: transparent; color: ${DIM}; font-family: inherit; font-size: 11.5px; line-height: 1; white-space: nowrap; cursor: pointer; transition: background-color 50ms ease, color 50ms ease; }
.tb-chip-toggle:hover { background: ${HOVER_BG}; color: ${FG}; border-color: ${BORDER_STRONG}; }
.tb-chip-toggle:active { transform: translateY(0.5px); }
.tb-chip-toggle:not([aria-checked="true"]):active { background: ${FOCUS_HALO}; color: ${FG}; }
.tb-chip-toggle[aria-checked="true"] { background: ${ACCENT}; border-color: transparent; color: ${ON_PRIMARY}; font-weight: 500; }
.tb-chip-toggle[aria-checked="true"]:hover { background: ${ACCENT}; color: ${ON_PRIMARY}; border-color: transparent; }
.tb-chip-toggle:focus-visible { outline: 2px solid ${LINK}; outline-offset: -1px; }
/*「⋯」的下拉：与其它浮层同一套语言（raised 底、1px 描边、8px 圆角、卡片阴影），
   落在 z 27 —— 高于选择器 (25) 与抽屉 (21)，低于指南 (31) 与关于 (41)，与
   escapeTarget 的分层逐层对应。 */
.tb-menu-item { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 8px; height: ${TB_TOOLBAR.controlHeight}px; border: none; border-radius: ${TB_TOOLBAR.radius}px; background: transparent; color: ${FG}; padding: 0 8px; font-family: inherit; font-size: 12px; line-height: 1; text-align: left; white-space: nowrap; cursor: pointer; transition: background-color 50ms ease, color 50ms ease; }
.tb-menu-item:hover { background: ${HOVER_BG}; }
.tb-menu-item:active { background: ${FOCUS_HALO}; color: ${FG}; transform: translateY(0.5px); }
.tb-menu-item:focus-visible { outline: 2px solid ${LINK}; outline-offset: -2px; }
`

/**
 * This package's client-module id — the identity dsh's client module loader
 * stamps on style tags (`data-plugin`) and removes on unload. It MUST equal the
 * bundle envelope id, which `scripts/build.mjs` writes from `package.json`'s
 * name; a test pins the two together.
 */
export const CLIENT_PLUGIN_ID = 'dsh-taskboard-kit'

/** The stylesheet tag's fingerprint: loader inventory key + our dedupe key. */
export const CSS_TAG_ID = `${CLIENT_PLUGIN_ID}/theme.css`

/** Minimal DOM face {@link ensureTaskboardStyles} needs (real Document, or a
 *  test stub — the function is deliberately drivable in tests). */
export interface StylesDocument {
  head: { appendChild(node: unknown): unknown }
  createElement(tag: string): { textContent: string; setAttribute(name: string, value: string): void }
  querySelector(selector: string): unknown
}

/**
 * Inject {@link TB_CSS} into `document.head` once, TAGGED as our own.
 *
 * Two rules, both load-bearing (the status-bar pill once rendered as an
 * unstyled UA `<button>` because of them — T-15, 2026-09-30):
 *
 *  1. **Never let React own the tag.** dsh's client module loader claims every
 *     untagged `<style>` in the document for whichever plugin module
 *     materializes next:
 *
 *         for (const el of document.querySelectorAll('style:not([data-plugin])'))
 *           el.setAttribute('data-plugin', id)          // dsh-client-modules
 *
 *     and deletes `style[data-plugin=<pkg>]` when that package unloads or hot
 *     reloads. A tag rendered inside the React tree has no `data-plugin`, so it
 *     gets claimed by a *stranger* and later deleted behind React's back: the
 *     fiber still believes the node exists, never re-adds it, and the surface
 *     silently loses the whole stylesheet. The kit's own tags are therefore
 *     born with `data-plugin` + `data-plugin-css` — the same convention the
 *     shipped dsh packages use — so the loader never claims them, and our own
 *     unload removes exactly ours.
 *  2. **Idempotent + self-healing.** Keyed by `data-plugin-css`, so a second
 *     call (every surface mount, the client plugin's apply) is a no-op; if the
 *     tag ever disappears the next call puts it back.
 *
 * @param doc - document to inject into; defaults to the browser document and
 *   is a no-op when there is none (SSR / plain Node).
 */
export function ensureTaskboardStyles(doc?: StylesDocument | null): void {
  const target = doc !== undefined ? doc : typeof document === 'undefined' ? null : (document as unknown as StylesDocument)
  if (!target) return
  if (target.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`)) return
  const tag = target.createElement('style')
  tag.setAttribute('data-plugin', CLIENT_PLUGIN_ID)
  tag.setAttribute('data-plugin-css', CSS_TAG_ID)
  tag.textContent = TB_CSS
  target.head.appendChild(tag)
}
