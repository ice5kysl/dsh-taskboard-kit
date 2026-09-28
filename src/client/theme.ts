/**
 * Theme tokens and the interactive-state stylesheet of dsh-taskboard-kit's
 * browser face — shared by the board tab (BoardPanel) and the composer-side
 * mini board (MiniBoard), so both inject the same rules and read the same
 * palette.
 *
 * Colors ride the dsh shell's `--dsw-alias-*` design tokens with fallbacks
 * for older shells. Inline styles cannot express :hover / :focus / :disabled,
 * so every interactive element carries a class from `TB_CSS`, injected once
 * per surface via <style>{TB_CSS}</style> (double injection is harmless).
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
export const FAINT = 'var(--dsw-alias-label-dimmed, #9ca3af)'
export const BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
export const BG_SUNK = 'var(--dsw-alias-bg-layer-1, #f5f7fa)'
export const BG_RAISED = 'var(--dsw-alias-bg-layer-3, #ffffff)'
export const BORDER = 'var(--dsw-alias-border-l1, rgba(28,35,51,0.12))'
export const BORDER_STRONG = 'var(--dsw-alias-border-l2, rgba(28,35,51,0.20))'
export const ACCENT = 'var(--dsw-alias-brand-primary, #2d66f7)'
export const DANGER = 'var(--dsw-alias-state-error-primary, #dc2626)'
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
.tb-card { display: block; width: 100%; box-sizing: border-box; text-align: left; border: 1px solid ${BORDER}; border-radius: 8px; background: ${BG_RAISED}; color: inherit; padding: 8px 10px; font-family: inherit; cursor: pointer; }
.tb-card:hover { border-color: ${ACCENT}; }
.tb-card.active { border-color: ${ACCENT}; box-shadow: 0 0 0 1px ${ACCENT}; }
.tb-chip { border: 1px solid ${BORDER}; border-radius: 999px; background: transparent; color: ${DIM}; padding: 3px 11px; font-size: 11px; font-family: inherit; cursor: pointer; }
.tb-chip:hover { color: ${FG}; border-color: ${BORDER_STRONG}; }
.tb-chip.active { background: ${HOVER_BG}; color: ${LINK}; border-color: ${LINK}; font-weight: 600; }
.tb-tag { font-size: 10px; color: ${DIM}; border: 1px solid ${BORDER}; border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
.tb-badge { display: inline-flex; align-items: center; font-size: 10px; color: ${LINK}; background: ${HOVER_BG}; border-radius: 999px; padding: 1px 7px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-badge-outline { display: inline-flex; align-items: center; font-size: 10px; color: ${DIM}; border: 1px dashed ${BORDER_STRONG}; border-radius: 999px; padding: 0 7px; white-space: nowrap; }
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
/* Rendered markdown (drawer detail + comments): compact, both themes. */
.tb-md { overflow-wrap: break-word; min-width: 0; }
.tb-md h1, .tb-md h2, .tb-md h3, .tb-md h4, .tb-md h5, .tb-md h6 { margin: 0.7em 0 0.35em; line-height: 1.35; font-weight: 600; }
.tb-md h1 { font-size: 16px; } .tb-md h2 { font-size: 14.5px; } .tb-md h3 { font-size: 13.5px; } .tb-md h4, .tb-md h5, .tb-md h6 { font-size: 12.5px; }
.tb-md p { margin: 0.4em 0; }
.tb-md ul, .tb-md ol { margin: 0.3em 0; padding-left: 1.35em; }
.tb-md li { margin: 0.12em 0; }
.tb-md a { color: ${LINK}; text-decoration: none; }
.tb-md a:hover { text-decoration: underline; }
.tb-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; background: ${HOVER_BG}; padding: 1px 5px; border-radius: 5px; }
.tb-md pre { background: ${BG_SUNK}; border: 1px solid ${BORDER}; border-radius: 8px; padding: 9px 11px; overflow-x: auto; margin: 0.5em 0; line-height: 1.6; tab-size: 2; }
.tb-md pre code { background: transparent; padding: 0; display: block; white-space: pre; }
.tb-md blockquote { margin: 0.5em 0; padding: 2px 12px; border-left: 3px solid ${ACCENT}; color: ${DIM}; border-radius: 0 6px 6px 0; }
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
`
