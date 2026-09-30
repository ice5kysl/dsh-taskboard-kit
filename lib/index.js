// src/host/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/host/http.ts
import { existsSync, statSync } from "node:fs";
import { dirname as dirname2, isAbsolute, join as join2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/shared/bridge.ts
var BRIDGE_PREFIX = "/dsh-taskboard";
var MUTATE_HEADER = "x-taskboard";
var MUTATE_HEADER_VALUE = "mutate";

// src/host/store.ts
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// src/shared/types.ts
var TASK_VALUES = [0.5, 1, 2, 3, 5, 8];
function columnOf(task) {
  if (task.status === "open") return task.assignee ? "assigned" : "pool";
  return task.status;
}
function emptyBoard(workspace) {
  return { version: 1, workspace, next_seq: 1, tasks: {}, actors: {} };
}
var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
function compareTasks(a, b) {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

// src/shared/board.ts
var HUMAN_ACTOR = "human";
function actorKey(name2) {
  return name2.trim().toLowerCase();
}
function parseAliasConfig(raw) {
  const groups = {};
  if (!raw) return groups;
  for (const chunk of raw.split(",")) {
    const [canonical, rest] = chunk.split(":");
    const name2 = canonical?.trim();
    if (!name2) continue;
    const aliases = (rest ?? "").split("|").map((alias) => alias.trim()).filter(Boolean);
    if (aliases.length > 0) groups[actorKey(name2)] = aliases;
  }
  return groups;
}
function parseWatchNames(raw) {
  const names = (raw ?? "").split(",").map((name2) => name2.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return { canonical: names[0], aliases: names.slice(1) };
}
function resolveActor(board, name2) {
  if (!name2) return void 0;
  const key = actorKey(name2);
  if (key === "") return void 0;
  const actors = board.actors ?? {};
  for (const [entryName, entry] of Object.entries(actors)) {
    if (actorKey(entryName) === key) return entry;
  }
  for (const entry of Object.values(actors)) {
    if ((entry.aliases ?? []).some((alias) => actorKey(alias) === key)) return entry;
  }
  return void 0;
}
function actorKeyOf(board, name2) {
  const key = actorKey(name2);
  for (const [entryName, entry] of Object.entries(board.actors ?? {})) {
    if (actorKey(entryName) === key) return actorKey(entryName);
    if ((entry.aliases ?? []).some((alias) => actorKey(alias) === key)) return actorKey(entryName);
  }
  return key;
}
function sameActor(board, a, b) {
  if (!a || !b) return false;
  return actorKeyOf(board, a) === actorKeyOf(board, b);
}
function actorNames(board, name2) {
  const key = actorKey(name2);
  for (const [entryName, entry] of Object.entries(board.actors ?? {})) {
    if (actorKey(entryName) === key || (entry.aliases ?? []).some((alias) => actorKey(alias) === key)) {
      return [entryName, ...entry.aliases ?? []];
    }
  }
  return [name2];
}
function actorSeenAt(board, name2) {
  const entry = resolveActor(board, name2);
  if (!entry) return void 0;
  return entry.last_seen_at;
}
var COLUMN_EVENTS = /* @__PURE__ */ new Set([
  "created",
  "assigned",
  "claimed",
  "started",
  "stopped",
  "submitted",
  "approved",
  "rejected",
  "done",
  "reopened",
  "closed"
]);
function columnSince(task) {
  for (let index = task.log.length - 1; index >= 0; index -= 1) {
    const entry = task.log[index];
    if (COLUMN_EVENTS.has(entry.event)) return entry.at;
  }
  return task.created_at;
}
function ageInColumnMs(task, now = Date.now()) {
  const since = Date.parse(columnSince(task));
  if (Number.isNaN(since)) return 0;
  return Math.max(0, now - since);
}
var DEFAULT_COLUMN_SLA_MS = {
  pool: 72 * 36e5,
  // 待认领躺 3 天 = 没人要
  assigned: 48 * 36e5,
  // 指派了 2 天还没 start
  in_progress: 72 * 36e5,
  // 3 天没动静
  review: 24 * 36e5,
  // 审核人欠 1 天
  // done is NOT terminal (v0.6): a card approved but never settled is exactly
  // the rot the two-step close exists to catch, so it goes stale like any
  // other unfinished work.
  done: 72 * 36e5,
  // 审核过了 3 天还没人收口
  closed: null
  // the only terminal column: never stale
};
var DEFAULT_WAIT_SLA_MS = {
  human: 24 * 36e5,
  agent: 8 * 36e5,
  external: null
};
function stalenessOf(task, now = Date.now(), options) {
  const column = columnOf(task);
  const slaMs = options?.columnSla?.[column] !== void 0 ? options.columnSla[column] : DEFAULT_COLUMN_SLA_MS[column];
  const ageMs = ageInColumnMs(task, now);
  const overdueMs = slaMs !== null && ageMs > slaMs ? ageMs - slaMs : 0;
  const waiting = task.waiting_on ?? null;
  const waitMs = waiting ? Math.max(0, now - (Date.parse(waiting.since) || now)) : 0;
  const waitSla = waiting ? options?.waitSla?.[waiting.kind] !== void 0 ? options.waitSla[waiting.kind] : DEFAULT_WAIT_SLA_MS[waiting.kind] : null;
  return {
    ageMs,
    slaMs,
    stale: overdueMs > 0,
    overdueMs,
    waiting,
    waitMs,
    waitOverdue: waitSla !== null && waiting !== null && waitMs > waitSla
  };
}
function isStale(task, now = Date.now(), options) {
  return stalenessOf(task, now, options).stale;
}
var DEFAULT_QUIET_MS = 36 * 36e5;
function assigneeIsGone(board, task, now = Date.now(), quietMs = DEFAULT_QUIET_MS) {
  if (!task.assignee) return { gone: false, reason: null, ageMs: 0 };
  const seenAt = actorSeenAt(board, task.assignee);
  if (seenAt === void 0) {
    const ageMs2 = ageInColumnMs(task, now);
    return { gone: ageMs2 > quietMs, reason: "unknown-actor", ageMs: ageMs2 };
  }
  if (seenAt === null) {
    const ageMs2 = ageInColumnMs(task, now);
    return { gone: ageMs2 > quietMs, reason: "never-seen", ageMs: ageMs2 };
  }
  const seen = Date.parse(seenAt);
  if (Number.isNaN(seen)) return { gone: false, reason: null, ageMs: 0 };
  const ageMs = now - seen;
  return { gone: ageMs > quietMs, reason: "quiet", ageMs };
}
function boardHealth(board, options) {
  const now = options?.now ?? Date.now();
  const quietMs = options?.quietMs ?? DEFAULT_QUIET_MS;
  const health2 = { orphaned: [], unownedReview: [], waitingHuman: [], waitingOther: [], needsSettling: [], stale: [] };
  for (const task of Object.values(board.tasks)) {
    if (task.status === "closed") continue;
    if (task.status === "done") {
      health2.needsSettling.push({ task, kind: "needs_settling", ageMs: ageInColumnMs(task, now) });
      continue;
    }
    if (task.waiting_on) {
      const ageMs = Math.max(0, now - (Date.parse(task.waiting_on.since) || now));
      const issue = {
        task,
        kind: task.waiting_on.kind === "human" ? "waiting_human" : "stale",
        actor: task.waiting_on.who ?? void 0,
        ageMs,
        detail: task.waiting_on.question
      };
      if (task.waiting_on.kind === "human") health2.waitingHuman.push(issue);
      else health2.waitingOther.push(issue);
      continue;
    }
    if (task.status === "review" && !task.reviewer) {
      health2.unownedReview.push({ task, kind: "unowned_review", ageMs: ageInColumnMs(task, now) });
      continue;
    }
    if (task.assignee) {
      const gone = assigneeIsGone(board, task, now, quietMs);
      if (gone.gone) {
        health2.orphaned.push({
          task,
          kind: "orphaned",
          actor: task.assignee,
          ageMs: gone.ageMs,
          detail: gone.reason ?? void 0
        });
        continue;
      }
    }
    const staleness = stalenessOf(task, now, options);
    if (staleness.stale) health2.stale.push({ task, kind: "stale", ageMs: staleness.ageMs });
  }
  const byAge = (a, b) => b.ageMs - a.ageMs || a.task.id.localeCompare(b.task.id);
  health2.orphaned.sort(byAge);
  health2.unownedReview.sort(byAge);
  health2.waitingHuman.sort(byAge);
  health2.waitingOther.sort(byAge);
  health2.needsSettling.sort(byAge);
  health2.stale.sort(byAge);
  return health2;
}
var RANK = {
  review_owed: 10,
  unblock_me: 20,
  returned: 30,
  stalled_mine: 40,
  // Settling comes after live work but before picking up something new: an
  // unfinished close is cheap to finish and blocks the card from ever leaving.
  settle_mine: 42,
  orphaned_mine: 45,
  start_assigned: 50,
  human_blocked: 60,
  pool_pick: 90
};
function inboxFor(board, actor, options) {
  const now = options?.now ?? Date.now();
  const poolLimit = options?.poolLimit ?? 3;
  const includeHumanBlocked = options?.includeHumanBlocked ?? true;
  const items = [];
  const isMe = (name2) => sameActor(board, name2, actor);
  for (const task of Object.values(board.tasks)) {
    if (task.status === "closed") continue;
    if (task.status === "done" && task.assignee && isMe(task.assignee)) {
      items.push({
        kind: "settle_mine",
        task,
        ageMs: ageInColumnMs(task, now),
        rank: RANK.settle_mine,
        // done is not terminal: the closing step is a real action, and the
        // note is the only place "finished" vs "abandoned" is recorded.
        suggest: `taskboard update ${task.id} --action close --note "\u5DF2\u4EA4\u4ED8\u2026"\uFF08\u4E0D\u505A\u4E86\u4E5F\u8D70 close\uFF0C\u5199\u6E05\u539F\u56E0\uFF09`
      });
      continue;
    }
    if (task.status === "done") continue;
    if (task.status === "review" && task.reviewer && isMe(task.reviewer)) {
      items.push({
        kind: "review_owed",
        task,
        ageMs: ageInColumnMs(task, now),
        rank: RANK.review_owed,
        suggest: `taskboard get ${task.id} \u2192 taskboard update ${task.id} --action approve|reject --note "\u2026"`,
        actor: task.assignee ?? void 0
      });
      continue;
    }
    const waiting = task.waiting_on ?? null;
    if (waiting) {
      if (waiting.kind === "agent" && isMe(waiting.who)) {
        items.push({
          kind: "unblock_me",
          task,
          ageMs: Math.max(0, now - (Date.parse(waiting.since) || now)),
          rank: RANK.unblock_me,
          suggest: `taskboard comment ${task.id} --text "\u2026" \u2192 taskboard update ${task.id} --action unblock`,
          actor: task.assignee ?? void 0
        });
        continue;
      }
      if (includeHumanBlocked && waiting.kind === "human") {
        items.push({
          kind: "human_blocked",
          task,
          ageMs: Math.max(0, now - (Date.parse(waiting.since) || now)),
          rank: RANK.human_blocked,
          suggest: `\u901A\u77E5\u4EBA\u7C7B\uFF08\u7528\u4F60\u7684\u901A\u77E5\u901A\u9053\uFF0C\u5982 msg9\uFF09\uFF1A${task.id} \u5728\u7B49\u51B3\u5B9A \u2014\u2014 ${waiting.question}`,
          actor: waiting.who ?? void 0
        });
        continue;
      }
      continue;
    }
    const last = task.log[task.log.length - 1];
    if (isMe(task.assignee)) {
      if (task.status === "in_progress" && last?.event === "rejected") {
        items.push({
          kind: "returned",
          task,
          ageMs: ageInColumnMs(task, now),
          rank: RANK.returned,
          suggest: `taskboard get ${task.id} \u770B\u6253\u56DE\u539F\u56E0 \u2192 \u6539\u5B8C taskboard update ${task.id} --action submit`,
          actor: last.by
        });
        continue;
      }
      if (task.status === "open") {
        items.push({
          kind: "start_assigned",
          task,
          ageMs: ageInColumnMs(task, now),
          rank: RANK.start_assigned,
          suggest: `taskboard update ${task.id} --action start`
        });
        continue;
      }
      const staleness = stalenessOf(task, now, options);
      if (staleness.stale) {
        items.push({
          kind: "stalled_mine",
          task,
          ageMs: staleness.ageMs,
          rank: RANK.stalled_mine,
          suggest: `taskboard update ${task.id} --note "\u8FDB\u5C55\u2026"\uFF08\u6216 block / submit / close\uFF09`
        });
      }
      continue;
    }
    if (isMe(task.created_by) && task.assignee) {
      const gone = assigneeIsGone(board, task, now, options?.quietMs ?? DEFAULT_QUIET_MS);
      if (gone.gone) {
        items.push({
          kind: "orphaned_mine",
          task,
          ageMs: gone.ageMs,
          rank: RANK.orphaned_mine,
          suggest: `taskboard update ${task.id} --assignee none\uFF08\u653E\u56DE\u6C60\u5B50\uFF09\u6216 --assignee <\u6D3B\u8DC3\u7684 Agent>`,
          actor: task.assignee
        });
      }
    }
  }
  if (poolLimit > 0) {
    const pool = Object.values(board.tasks).filter((task) => task.status === "open" && !task.assignee && !task.waiting_on).sort(compareByValue).slice(0, poolLimit);
    for (const task of pool) {
      items.push({
        kind: "pool_pick",
        task,
        ageMs: ageInColumnMs(task, now),
        rank: RANK.pool_pick,
        suggest: `taskboard claim ${task.id}`
      });
    }
  }
  return items.sort((a, b) => a.rank - b.rank || b.ageMs - a.ageMs || PRIORITY_RANK_LOCAL[a.task.priority] - PRIORITY_RANK_LOCAL[b.task.priority] || a.task.id.localeCompare(b.task.id));
}
var PRIORITY_RANK_LOCAL = { high: 0, medium: 1, low: 2 };
function compareByValue(a, b) {
  const valueA = a.value ?? 0;
  const valueB = b.value ?? 0;
  if (valueA !== valueB) return valueB - valueA;
  const byPriority = PRIORITY_RANK_LOCAL[a.priority] - PRIORITY_RANK_LOCAL[b.priority];
  if (byPriority !== 0) return byPriority;
  return a.created_at.localeCompare(b.created_at);
}
function waitingOnHuman(board, now = Date.now()) {
  return boardHealth(board, { now }).waitingHuman;
}

// src/host/store.ts
var StoreError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "StoreError";
  }
};
function boardFilePath(cwd) {
  return join(cwd, ".dsh", "taskboard.json");
}
var boardsSeen = /* @__PURE__ */ new Map();
async function loadBoard(cwd) {
  const file = boardFilePath(cwd);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const seen2 = boardsSeen.get(resolve(cwd)) ?? 0;
      if (seen2 > 0) {
        throw new StoreError(
          "internal",
          `the board file disappeared while this process was running (it held ${seen2} task(s) a moment ago); refusing to treat it as an empty board \u2014 restore .dsh/taskboard.json (or restart dsh) and retry`
        );
      }
      return emptyBoard(resolve(cwd));
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await writeFile(`${file}.corrupt`, raw, { mode: 384, flag: "wx" }).catch(() => {
    });
    throw new StoreError(
      "internal",
      "taskboard file is not valid JSON (the raw bytes were kept beside it as taskboard.json.corrupt); fix or remove it"
    );
  }
  if (!parsed || parsed.version !== 1) {
    throw new StoreError("internal", "unsupported taskboard version (expected 1)");
  }
  if (!parsed.tasks || typeof parsed.tasks !== "object" || Array.isArray(parsed.tasks)) {
    throw new StoreError("internal", 'taskboard file has no "tasks" object; refusing to treat it as an empty board');
  }
  parsed.actors ??= {};
  let maxSeq = 0;
  for (const [key, task] of Object.entries(parsed.tasks)) {
    if (!task || typeof task !== "object") {
      throw new StoreError("internal", `taskboard entry ${key} is not an object`);
    }
    if (task.id !== key) task.id = key;
    if (!Array.isArray(task.comments)) task.comments = [];
    if (!Array.isArray(task.log)) task.log = [];
    if (!Array.isArray(task.tags)) task.tags = [];
    if (task.value === void 0) task.value = null;
    if (task.status === "cancelled") task.status = "closed";
    if (task.reviewer === void 0) task.reviewer = null;
    if (task.waiting_on === void 0) task.waiting_on = null;
    for (const entry of task.log) {
      if (entry.event === "cancelled") entry.event = "closed";
    }
    const seq = /^T-(\d+)$/.exec(key);
    if (seq) maxSeq = Math.max(maxSeq, Number(seq[1]));
  }
  const seen = /* @__PURE__ */ new Map();
  for (const task of Object.values(parsed.tasks ?? {})) {
    for (const entry of task.log ?? []) {
      if (typeof entry?.by !== "string" || typeof entry?.at !== "string") continue;
      const key = actorKey(entry.by);
      if (!key) continue;
      const known = seen.get(key);
      if (!known || entry.at > known) seen.set(key, entry.at);
    }
    for (const comment of task.comments ?? []) {
      if (typeof comment?.by !== "string" || typeof comment?.at !== "string") continue;
      const key = actorKey(comment.by);
      if (!key) continue;
      const known = seen.get(key);
      if (!known || comment.at > known) seen.set(key, comment.at);
    }
  }
  for (const [key, at] of seen) {
    const entry = resolveActor(parsed, key);
    if (!entry) {
      parsed.actors[key] = { kind: kindOf(key), aliases: [], first_seen_at: at, last_seen_at: at };
      continue;
    }
    if (entry.last_seen_at === null) entry.last_seen_at = at;
  }
  const next = parsed.next_seq;
  const base = typeof next === "number" && Number.isInteger(next) && next > 0 ? next : 1;
  parsed.next_seq = Math.max(base, maxSeq + 1);
  const currentWorkspace = resolve(cwd);
  if (parsed.workspace !== currentWorkspace) parsed.workspace = currentWorkspace;
  boardsSeen.set(currentWorkspace, Object.keys(parsed.tasks ?? {}).length);
  return parsed;
}
var tempCounter = 0;
async function saveBoard(cwd, board) {
  const file = boardFilePath(cwd);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${tempCounter += 1}`;
  try {
    await writeFile(temp, `${JSON.stringify(board, null, 2)}
`, { mode: 384 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {
    });
    throw error;
  }
}
async function enableBoard(cwd, options = {}) {
  const boardFile = boardFilePath(cwd);
  const protocolFile = join(cwd, ".dsh", "BOARD-PROTOCOL.md");
  const alreadyExisted = await fileExists(boardFile);
  if (!alreadyExisted) {
    await withBoardLock(cwd, async () => {
      if (await fileExists(boardFile)) return;
      await saveBoard(cwd, emptyBoard(resolve(cwd)));
    });
  }
  let protocolWritten = null;
  if (options.seedProtocol !== false && !await fileExists(protocolFile)) {
    await mkdir(dirname(protocolFile), { recursive: true });
    await writeFile(protocolFile, protocolDoc(), { mode: 384 });
    protocolWritten = protocolFile;
  }
  return {
    board_file: boardFile,
    protocol_file: protocolWritten,
    already_existed: alreadyExisted
  };
}
async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function protocolDoc() {
  return `# \u672C\u5DE5\u4F5C\u533A\u7684\u4EFB\u52A1\u770B\u677F\u7EA6\u5B9A

> \u672C\u6587\u4EF6\u7531 dsh-taskboard-kit \u5728\u300C\u5F00\u542F\u770B\u677F\u300D\u65F6\u751F\u6210\uFF0C\u4E4B\u540E**\u5F52\u672C\u5DE5\u4F5C\u533A\u6240\u6709** \u2014\u2014 \u53EF\u4EE5\u81EA\u7531\u7F16\u8F91\u3001\u6269\u5145\u3001
> \u751A\u81F3\u5220\u9664\uFF1B\u63D2\u4EF6\u4E0D\u4F1A\u8986\u76D6\u5B83\u3002\u5B8C\u6574\u89C4\u8303\u89C1\u63D2\u4EF6\u81EA\u5E26\u6587\u6863\uFF08\`dsh-taskboard-kit/docs/COLLABORATION.md\`\uFF09\uFF0C
> \u8FD9\u91CC\u53EA\u5199\u672C\u677F\u4E0D\u53EF\u4E0D\u77E5\u7684\u51E0\u6761\u3002

## \u552F\u4E00\u4E8B\u5B9E\u6E90

\u770B\u677F\u5C31\u662F\u4E00\u4E2A\u6587\u4EF6\uFF1A\`.dsh/taskboard.json\`\uFF08\u672C\u76EE\u5F55\u4E0B\uFF09\u3002**\u6C38\u8FDC\u4E0D\u8981\u624B\u6539\u5B83** \u2014\u2014
\u9501\u3001\u539F\u5B50\u8BA4\u9886\u3001\u72B6\u6001\u673A\u90FD\u5728\u5DE5\u5177\u91CC\uFF0C\u624B\u6539\u4F1A\u7ED5\u8FC7\u5168\u90E8\u4FDD\u62A4\u3002\u7528 \`taskboard_*\` \u5DE5\u5177\uFF0C
\u6216\u6CA1\u6709\u63D2\u4EF6\u65F6\u7684 \`dsh-taskboard-kit/bin/taskboard.mjs\` CLI\u3002

## \u72B6\u6001\u673A\uFF1A\u53EA\u6709 closed \u662F\u7EC8\u70B9

\`\`\`
open \u2500\u2500\u25B6 in_progress \u2500\u2500\u25B6 review \u2500\u2500\u25B6 done \u2500\u2500\u25B6 closed
\`\`\`

- \`done\` = \u5E72\u5B8C\u4E14\u5BA1\u6838\u901A\u8FC7\uFF0C**\u4F46\u8FD8\u6CA1\u7ED3\u6E05**\uFF1A\u5361\u4ECD\u5728\u770B\u677F\u4E0A\uFF0C\u4ECD\u7B97\u300C\u672A\u7ED3\u6E05\u300D\u3002
- \`closed\` = \u7ED3\u6E05\uFF0C**\u552F\u4E00\u7684\u7EC8\u6001**\uFF1A\u7ED3\u6E05\u540E\u5361\u79BB\u5F00\u6D3B\u8DC3\u89C6\u56FE\u4E0E\u6D3B\u8DC3\u8BA1\u6570\u3002
- \u300C\u8FD9\u4E8B\u4E0D\u505A\u4E86\u300D\u4E5F\u8D70 \`close\`\uFF0C\u4F46**\u5FC5\u987B\u5728 note \u91CC\u5199\u6E05\u539F\u56E0** \u2014\u2014
  \u6CA1\u6709\u5355\u72EC\u7684 abandoned \u72B6\u6001\uFF0C\u300C\u505A\u5B8C\u4E86\u300D\u548C\u300C\u653E\u5F03\u4E86\u300D\u7684\u533A\u522B\u53EA\u5B58\u5728\u4E8E\u7559\u8A00\u91CC\u3002

\u6240\u4EE5\uFF1A\u5BA1\u6838\u901A\u8FC7\u4E4B\u540E\uFF0C**\u8FD8\u6709\u4E00\u6B65\u6536\u53E3**\u3002\u6CA1\u4EBA\u6536\u53E3\u7684\u5361\u4F1A\u4E00\u76F4\u6302\u5728\u9762\u677F\u9876\u90E8\u7684
\u300C\u5F85\u6536\u53E3\u300D\u6761\u4E0A\uFF0C\u8D85\u8FC7 72h \u4F1A\u88AB\u81EA\u68C0\u70B9\u540D\u3002

## \u4E09\u6761\u6700\u5E38\u88AB\u8FDD\u53CD\u7684\u89C4\u77E9

1. **\u52A8\u624B\u524D\u5148\u5360\u4F4D**\uFF1A\u6C60\u91CC\u7684\u5361 \`claim\`\uFF0C\u6307\u6D3E\u7ED9\u4F60\u7684\u5361 \`start\`\u3002\u6CA1\u5360\u4F4D\u4E0D\u5F00\u5DE5\u3002
2. **\u505A\u5B8C\u4EA4\u5BA1\u6838\uFF0C\u4E0D\u8981\u81EA\u5DF1 done**\uFF1A\`submit --reviewer <\u540D\u5B57>\` + \u4E00\u6761 \`comment\` \u5199\u6E05
   \u300C\u505A\u4E86\u4EC0\u4E48 / \u9A8C\u8BC1\u4E86\u4EC0\u4E48 / \u8FD8\u5DEE\u4EC0\u4E48\u300D\u3002\u6CA1\u6709\u4EA4\u63A5\u7559\u8A00\u7684\u63D0\u4EA4\uFF0C\u5BA1\u6838\u4EBA\u65E0\u6CD5\u9A8C\u6536\u3002
3. **\u5361\u4F4F\u8981\u8BF4\u6E05\u5728\u7B49\u8C01**\uFF1A\u7B49\u4EBA\u7C7B \`block --on human --question "\u4E00\u53E5\u80FD\u76F4\u63A5\u8F6C\u53D1\u7684\u95EE\u53E5"\`\uFF1B
   \u7B49 Agent \`block --on agent --who <\u540D\u5B57>\`\u3002\u7B49\u8C01\u7684\u5361\u4E0D\u80FD\u88AB\u8BA4\u9886\u3002

## \u4F1A\u8BDD\u5F00\u59CB\u5148\u770B\u81EA\u5DF1\u90A3\u4E00\u4EFD

\`taskboard_inbox\` \u2014\u2014 \u73B0\u5728\u538B\u5728\u4F60\u8EAB\u4E0A\u7684\u4E8B\uFF0C\u6309\u6025\u8FEB\u5EA6\u6392\u597D\uFF0C\u6BCF\u6761\u90FD\u5E26\u8BE5\u6572\u7684\u547D\u4EE4\u3002
`;
}
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 100;
var LOCK_MAX_ATTEMPTS = 50;
var boardQueue = Promise.resolve();
function withBoardLock(cwd, task) {
  const run = boardQueue.then(async () => {
    const release = await acquireBoardLock(cwd);
    try {
      return await task();
    } finally {
      await release();
    }
  });
  boardQueue = run.catch(() => {
  });
  return run;
}
async function lockHolderPid(lockPath) {
  const raw = await readFile(lockPath, "utf8").catch(() => "");
  try {
    const pid = Number(JSON.parse(raw).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : void 0;
  } catch {
    return void 0;
  }
}
async function acquireBoardLock(cwd) {
  const lockPath = `${boardFilePath(cwd)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(lockPath, "wx", 384);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString(), token }));
      await handle.close();
      return async () => {
        const owner = await readFile(lockPath, "utf8").then((raw) => String(JSON.parse(raw).token ?? "")).catch(() => "");
        if (owner === token) await rm(lockPath, { force: true });
      };
    } catch (error) {
      await handle?.close().catch(() => {
      });
      if (handle) await rm(lockPath, { force: true }).catch(() => {
      });
      if (error.code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        const holder = await lockHolderPid(lockPath);
        throw new StoreError(
          "internal",
          holder === void 0 ? `taskboard is locked (${lockPath}); still busy after ~${LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS / 1e3}s and the holder is unknown` : `taskboard is locked by live pid ${holder} (${lockPath}); still busy after ~${LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS / 1e3}s`
        );
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, LOCK_RETRY_MS));
    }
  }
}
async function isStaleLock(lockPath) {
  let info;
  try {
    info = await stat(lockPath);
  } catch {
    return true;
  }
  const pid = await lockHolderPid(lockPath);
  if (pid !== void 0) {
    if (pid === process.pid) return Date.now() - info.mtimeMs > LOCK_STALE_MS;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }
  return Date.now() - info.mtimeMs > LOCK_STALE_MS;
}
var PRIORITIES = ["high", "medium", "low"];
var STATUSES = ["open", "in_progress", "review", "done", "closed"];
var ACTIONS = [
  "start",
  "stop",
  "submit",
  "approve",
  "reject",
  "done",
  "close",
  "reopen",
  "cancel",
  "block",
  "unblock"
];
var MAX_TITLE_LENGTH = 500;
var MAX_DETAIL_LENGTH = 2e5;
var MAX_TEXT_LENGTH = 5e4;
var MAX_TAG_LENGTH = 100;
var MAX_TAGS = 50;
var TASK_ID = /^T-\d+$/;
function requireId(id) {
  const value = typeof id === "string" ? id.trim() : "";
  if (!TASK_ID.test(value)) {
    throw new StoreError("invalid-input", `task id must look like T-1 (got ${JSON.stringify(id)})`);
  }
  return value;
}
function requireTitle(title) {
  if (typeof title !== "string" || title.trim() === "") {
    throw new StoreError("invalid-input", "title is required and must be a non-empty string");
  }
  const value = title.trim();
  if (value.length > MAX_TITLE_LENGTH) {
    throw new StoreError("invalid-input", `title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return value;
}
function parsePriority(priority) {
  if (priority === void 0) return void 0;
  if (typeof priority !== "string" || !PRIORITIES.includes(priority)) {
    throw new StoreError("invalid-input", `priority must be one of ${PRIORITIES.join(" | ")}`);
  }
  return priority;
}
function parseTags(tags) {
  if (tags === void 0) return void 0;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new StoreError("invalid-input", "tags must be an array of strings");
  }
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))];
  if (cleaned.length > MAX_TAGS) {
    throw new StoreError("invalid-input", `at most ${MAX_TAGS} tags are allowed`);
  }
  if (cleaned.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new StoreError("invalid-input", `each tag must be at most ${MAX_TAG_LENGTH} characters`);
  }
  return cleaned;
}
function parseDetail(detail) {
  if (detail === void 0) return void 0;
  if (typeof detail !== "string") throw new StoreError("invalid-input", "detail must be a string");
  if (detail.length > MAX_DETAIL_LENGTH) {
    throw new StoreError("invalid-input", `detail must be at most ${MAX_DETAIL_LENGTH} characters`);
  }
  return detail;
}
function parseAssignee(assignee) {
  if (assignee === void 0) return void 0;
  if (assignee === null) return null;
  if (typeof assignee !== "string") {
    throw new StoreError("invalid-input", "assignee must be a string or null");
  }
  const trimmed = assignee.trim();
  return trimmed === "" || trimmed.toLowerCase() === "none" ? null : trimmed;
}
function parseAction(action) {
  if (action === void 0) return void 0;
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    throw new StoreError("invalid-input", `action must be one of ${ACTIONS.join(" | ")}`);
  }
  return action;
}
function parseValue(value) {
  if (value === void 0) return void 0;
  if (value === null) return null;
  if (typeof value !== "number" || !TASK_VALUES.includes(value)) {
    throw new StoreError("invalid-input", `value must be one of ${TASK_VALUES.join(" | ")} (or null to clear)`);
  }
  return value;
}
function mustTask(board, id) {
  const task = Object.hasOwn(board.tasks, id) ? board.tasks[id] : void 0;
  if (!task || typeof task !== "object") throw new StoreError("not-found", `no such task: ${id}`);
  return task;
}
function logEntry(at, by, event) {
  return { at, by, event };
}
function actorAliasGroups() {
  const groups = {};
  const add = (canonical, aliases) => {
    const key = actorKey(canonical);
    if (!key) return;
    groups[key] = [.../* @__PURE__ */ new Set([...groups[key] ?? [], ...aliases.map((alias) => alias.trim()).filter(Boolean)])];
  };
  add("dsh", ["dsh-agent"]);
  for (const [canonical, aliases] of Object.entries(parseAliasConfig(process.env.TASKBOARD_ACTOR_ALIASES))) {
    add(canonical, aliases);
  }
  const watch2 = parseWatchNames(process.env.TASKBOARD_WATCH_NAMES);
  if (watch2) add(watch2.canonical, watch2.aliases);
  return groups;
}
function humanNames() {
  const configured = (process.env.TASKBOARD_HUMANS ?? "").split(",").map((name2) => name2.trim()).filter(Boolean);
  return [HUMAN_ACTOR, ...configured];
}
function kindOf(name2) {
  const key = actorKey(name2);
  return humanNames().some((human) => actorKey(human) === key) ? "human" : "agent";
}
function touchActor(board, name2, now) {
  const key = actorKey(name2);
  if (!key) return;
  board.actors ??= {};
  const groups = actorAliasGroups();
  const canonical = Object.keys(groups).find((group) => group === key || groups[group].some((alias) => actorKey(alias) === key));
  const aliases = groups[key] ?? (canonical ? groups[canonical] ?? [] : []);
  const existingKey = Object.keys(board.actors).find((entry2) => actorKey(entry2) === key) ?? Object.keys(board.actors).find((entry2) => (board.actors[entry2]?.aliases ?? []).some((alias) => actorKey(alias) === key));
  const target = existingKey ?? canonical ?? name2.trim();
  const entry = board.actors[target] ?? {
    kind: kindOf(name2),
    aliases: [],
    first_seen_at: now,
    last_seen_at: null
  };
  entry.aliases = [.../* @__PURE__ */ new Set([...entry.aliases, ...aliases])].filter((alias) => actorKey(alias) !== actorKey(target));
  entry.last_seen_at = now;
  board.actors[target] = entry;
}
function noteActor(board, name2, now, kind) {
  if (!name2) return;
  const key = actorKey(name2);
  if (!key) return;
  if (resolveActor(board, name2)) return;
  board.actors ??= {};
  board.actors[name2.trim()] = {
    kind: kind ?? kindOf(name2),
    aliases: [],
    first_seen_at: now,
    last_seen_at: null
  };
}
function actorNamesOf(board, name2) {
  return actorNames(board, name2);
}
function canonicalActor(board, name2) {
  const entry = resolveActor(board, name2);
  if (!entry) return name2.trim();
  const found = Object.entries(board.actors ?? {}).find(([, value]) => value === entry);
  return found?.[0] ?? name2.trim();
}
async function createTask(cwd, input, by) {
  const title = requireTitle(input?.title);
  const detail = parseDetail(input?.detail) ?? "";
  const assignee = parseAssignee(input?.assignee) ?? null;
  const priority = parsePriority(input?.priority) ?? "medium";
  const value = parseValue(input?.value) ?? null;
  const tags = parseTags(input?.tags) ?? [];
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let id = `T-${board.next_seq}`;
    while (Object.hasOwn(board.tasks, id)) {
      board.next_seq += 1;
      id = `T-${board.next_seq}`;
    }
    board.next_seq += 1;
    const log = [logEntry(now, by, "created")];
    if (assignee) log.push(logEntry(now, by, "assigned"));
    const task = {
      id,
      title,
      detail,
      status: "open",
      assignee,
      reviewer: null,
      waiting_on: null,
      priority,
      value,
      tags,
      created_by: by,
      created_at: now,
      updated_at: now,
      log,
      comments: []
    };
    board.tasks[id] = task;
    touchActor(board, by, now);
    noteActor(board, assignee, now);
    await saveBoard(cwd, board);
    return task;
  });
}
async function claimTask(cwd, id, by) {
  const taskId = requireId(id);
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd);
    const task = mustTask(board, taskId);
    if (task.waiting_on) {
      throw new StoreError(
        "conflict",
        `${taskId} is waiting on ${task.waiting_on.kind}${task.waiting_on.who ? ` (${task.waiting_on.who})` : ""}: ${task.waiting_on.question} \u2014 unblock it before claiming`
      );
    }
    if (task.status !== "open" || task.assignee) {
      const held = task.assignee ? ` (held by ${task.assignee})` : "";
      throw new StoreError("conflict", `${taskId} cannot be claimed: status is ${task.status}${held}`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    task.status = "in_progress";
    task.assignee = by;
    task.updated_at = now;
    task.log.push(logEntry(now, by, "claimed"));
    touchActor(board, by, now);
    await saveBoard(cwd, board);
    return task;
  });
}
var WAIT_KINDS = ["human", "agent", "external"];
function parseWaitKind(kind) {
  if (kind === void 0) return void 0;
  if (typeof kind !== "string" || !WAIT_KINDS.includes(kind)) {
    throw new StoreError("invalid-input", `wait kind must be one of ${WAIT_KINDS.join(" | ")}`);
  }
  return kind;
}
function allowsSelfReview() {
  return process.env.TASKBOARD_ALLOW_SELF_REVIEW === "1";
}
function resolveReviewer(board, task, by, requested) {
  const selfReview = (name2) => allowsSelfReview() || !sameActor(board, name2, by);
  if (requested && requested.trim() !== "") {
    if (!selfReview(requested)) {
      throw new StoreError("invalid-input", `you cannot review your own work: pick another reviewer (or set TASKBOARD_ALLOW_SELF_REVIEW=1)`);
    }
    return requested.trim();
  }
  if (task.reviewer && sameActor(board, task.reviewer, by) === false) return task.reviewer;
  if (task.created_by && !sameActor(board, task.created_by, by)) return task.created_by;
  const others = Object.entries(board.actors ?? {}).filter(([name2, entry]) => entry.kind === "agent" && !sameActor(board, name2, by) && entry.last_seen_at).sort((a, b) => String(b[1].last_seen_at).localeCompare(String(a[1].last_seen_at)));
  if (others.length > 0) return others[0][0];
  return HUMAN_ACTOR;
}
function canDecide(board, task, by) {
  if (kindOf(by) === "human") return true;
  if (!task.reviewer) return true;
  return sameActor(board, task.reviewer, by) || sameActor(board, task.created_by, by);
}
async function updateTask(cwd, id, patch, by) {
  const taskId = requireId(id);
  const action = parseAction(patch?.action);
  const assignee = parseAssignee(patch?.assignee);
  const reviewer = parseAssignee(patch?.reviewer);
  const waitKind = parseWaitKind(patch?.wait_kind);
  const waitWho = parseAssignee(patch?.wait_who);
  const waitQuestion = parseDetail(patch?.wait_question);
  const title = patch?.title === void 0 ? void 0 : requireTitle(patch.title);
  const detail = parseDetail(patch?.detail);
  const priority = parsePriority(patch?.priority);
  const value = parseValue(patch?.value);
  const tags = parseTags(patch?.tags);
  let note;
  if (patch?.note !== void 0) {
    if (typeof patch.note !== "string") throw new StoreError("invalid-input", "note must be a string");
    const trimmed = patch.note.trim();
    if (trimmed.length > MAX_TEXT_LENGTH) {
      throw new StoreError("invalid-input", `note must be at most ${MAX_TEXT_LENGTH} characters`);
    }
    note = trimmed === "" ? void 0 : trimmed;
  }
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd);
    const task = mustTask(board, taskId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const events = [];
    if (action) {
      if (action === "block") {
        if (task.status === "done" || task.status === "closed") {
          throw new StoreError("invalid-transition", `${taskId} is ${task.status}; a finished task cannot be blocked`);
        }
        const kind = waitKind ?? (waitWho ? kindOf(waitWho) : void 0);
        if (!kind) {
          throw new StoreError("invalid-input", "block needs wait_kind (human | agent | external) or wait_who");
        }
        const question = (waitQuestion ?? "").trim();
        if (question === "") {
          throw new StoreError("invalid-input", "block needs wait_question \u2014 say exactly what the other side must decide");
        }
        task.waiting_on = { kind, who: waitWho ?? null, question, since: now };
        noteActor(board, waitWho, now, kind === "human" ? "human" : "agent");
        events.push("blocked");
      } else if (action === "unblock") {
        if (!task.waiting_on) {
          throw new StoreError("invalid-transition", `${taskId} is not waiting on anyone`);
        }
        task.waiting_on = null;
        events.push("unblocked");
      } else {
        const transition = transitionOf(task, action);
        if (action === "submit") {
          const resolved = resolveReviewer(board, task, by, reviewer);
          task.reviewer = resolved;
          touchActor(board, resolved, now);
          task.waiting_on = null;
        } else if (action === "approve" || action === "reject") {
          if (!canDecide(board, task, by)) {
            throw new StoreError(
              "conflict",
              `${taskId} is waiting for ${task.reviewer} to review it; only the reviewer, ${task.created_by} (creator) or the human can decide`
            );
          }
          task.reviewer = null;
          task.waiting_on = null;
        } else if (action === "done" || action === "close" || action === "reopen") {
          task.reviewer = null;
          task.waiting_on = null;
        }
        task.status = transition.to;
        events.push(transition.event);
      }
    }
    if (assignee !== void 0 && assignee !== task.assignee) {
      if (task.status !== "open" && task.status !== "in_progress") {
        throw new StoreError(
          "invalid-input",
          `${taskId} is ${task.status}; the assignee can only change while open or in_progress`
        );
      }
      events.push(task.assignee === null && assignee !== null ? "assigned" : "updated");
      task.assignee = assignee;
      noteActor(board, assignee, now);
    }
    if (reviewer !== void 0 && action !== "submit" && reviewer !== null && !sameActor(board, task.reviewer, reviewer)) {
      const mayDelegate = kindOf(by) === "human" || sameActor(board, task.assignee, by) || sameActor(board, task.created_by, by) || sameActor(board, task.reviewer, by);
      if (!mayDelegate) {
        throw new StoreError("conflict", `${taskId} is not yours to hand over: only its owner, creator, current reviewer or the human can set the reviewer`);
      }
      if (sameActor(board, reviewer, by) && !allowsSelfReview()) {
        throw new StoreError("invalid-input", "you cannot review your own work: pick another reviewer (or set TASKBOARD_ALLOW_SELF_REVIEW=1)");
      }
      task.reviewer = reviewer;
      noteActor(board, reviewer, now);
      events.push("updated");
    } else if (reviewer === null && task.reviewer !== null) {
      task.reviewer = null;
      events.push("updated");
    }
    let fieldsChanged = false;
    if (title !== void 0 && title !== task.title) {
      task.title = title;
      fieldsChanged = true;
    }
    if (detail !== void 0 && detail !== task.detail) {
      task.detail = detail;
      fieldsChanged = true;
    }
    if (priority !== void 0 && priority !== task.priority) {
      task.priority = priority;
      fieldsChanged = true;
    }
    if (value !== void 0 && value !== task.value) {
      task.value = value;
      fieldsChanged = true;
    }
    if (tags !== void 0 && JSON.stringify(tags) !== JSON.stringify(task.tags)) {
      task.tags = tags;
      fieldsChanged = true;
    }
    if (fieldsChanged) events.push("updated");
    if (events.length === 0 && !note) {
      throw new StoreError("invalid-input", "nothing to update: pass an action, a field change, or a note");
    }
    if (events.length === 0) events.push("updated");
    const entries = events.map((event) => logEntry(now, by, event));
    if (note) entries[entries.length - 1].note = note;
    task.log.push(...entries);
    task.updated_at = now;
    touchActor(board, by, now);
    await saveBoard(cwd, board);
    return { task, events };
  });
}
var TRANSITIONS = {
  start: { from: ["open"], to: "in_progress", event: "started" },
  stop: { from: ["in_progress"], to: "open", event: "stopped" },
  submit: { from: ["in_progress"], to: "review", event: "submitted" },
  approve: { from: ["review"], to: "done", event: "approved" },
  reject: { from: ["review"], to: "in_progress", event: "rejected" },
  done: { from: ["open", "in_progress", "review"], to: "done", event: "done" },
  close: { from: ["open", "in_progress", "review", "done"], to: "closed", event: "closed" },
  reopen: { from: ["done", "closed"], to: "open", event: "reopened" }
};
function transitionOf(task, action) {
  const effective = action === "cancel" ? "close" : action;
  const transition = TRANSITIONS[effective];
  if (!transition) {
    throw new StoreError("invalid-input", `action "${action}" does not move the status; use it on its own`);
  }
  if (!transition.from.includes(task.status)) {
    throw new StoreError("invalid-transition", `${task.id} is ${task.status}; action "${action}" is not allowed now`);
  }
  return transition;
}
async function addComment(cwd, id, text, by) {
  const taskId = requireId(id);
  if (typeof text !== "string" || text.trim() === "") {
    throw new StoreError("invalid-input", "comment text is required and must be a non-empty string");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new StoreError("invalid-input", `comment text must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  const body = text.trim();
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd);
    const task = mustTask(board, taskId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    task.comments.push({ at: now, by, text: body });
    task.updated_at = now;
    touchActor(board, by, now);
    await saveBoard(cwd, board);
    return task;
  });
}
async function getTask(cwd, id) {
  const taskId = requireId(id);
  const board = await loadBoard(cwd);
  return mustTask(board, taskId);
}
async function listTasks(cwd, filter) {
  if (filter?.status !== void 0 && !STATUSES.includes(filter.status)) {
    throw new StoreError("invalid-input", `status must be one of ${STATUSES.join(" | ")}`);
  }
  if (filter?.waiting !== void 0 && filter.waiting !== "any" && !WAIT_KINDS.includes(filter.waiting)) {
    throw new StoreError("invalid-input", `waiting must be one of ${WAIT_KINDS.join(" | ")} or any`);
  }
  const board = await loadBoard(cwd);
  return Object.values(board.tasks).filter((task) => {
    if (filter?.status && task.status !== filter.status) return false;
    if (filter?.assignee === "none" && task.assignee !== null) return false;
    if (filter?.assignee !== void 0 && filter.assignee !== "none" && task.assignee !== filter.assignee) return false;
    if (filter?.waiting === "any" && !task.waiting_on) return false;
    if (filter?.waiting !== void 0 && filter.waiting !== "any" && task.waiting_on?.kind !== filter.waiting) return false;
    return true;
  }).sort(compareTasks);
}
async function inbox(cwd, actor, options) {
  const board = await loadBoard(cwd);
  return inboxFor(board, actor, options);
}
async function health(cwd, options) {
  return boardHealth(await loadBoard(cwd), options);
}
async function roster(cwd) {
  const board = await loadBoard(cwd);
  const now = Date.now();
  return Object.entries(board.actors ?? {}).map(([name2, entry]) => ({
    name: name2,
    entry,
    quietMs: entry.last_seen_at ? Math.max(0, now - (Date.parse(entry.last_seen_at) || now)) : null
  })).sort((a, b) => (a.quietMs ?? Number.MAX_SAFE_INTEGER) - (b.quietMs ?? Number.MAX_SAFE_INTEGER));
}
function columnAgeMs(task, now = Date.now()) {
  return ageInColumnMs(task, now);
}
function taskStaleness(task, now) {
  return stalenessOf(task, now);
}

// src/host/http.ts
var HUMAN_ACTOR2 = "human";
function cliPath() {
  try {
    return join2(dirname2(fileURLToPath(import.meta.url)), "..", "bin", "taskboard.mjs");
  } catch {
    return null;
  }
}
function defaultBridgeDeps(ctx) {
  let injectedAgents;
  let injectedSessions;
  try {
    const inject2 = ctx.inject;
    if (typeof inject2 === "function") {
      inject2.call(ctx, ["agents"], (child) => {
        const services = child;
        injectedAgents = services.agents ?? injectedAgents;
        injectedSessions = services.sessions ?? injectedSessions;
      });
    }
  } catch {
  }
  return {
    loadBoard,
    enableBoard,
    createTask,
    claimTask,
    updateTask,
    addComment,
    // The workspace roots this host actually serves: the cwd of a live
    // session. Read lazily and defensively.
    //
    // ⚠️ 两种"空"必须分开（kimi 2026-09-30 真机复测发现的洞）：
    //   a) 服务**拿不到**（测试环境、headless、启动窗口、抛异常）⇒ `undefined` = 未知，
    //      退化成 requireCwd 的形状检查，**不拒绝每个请求**；
    //   b) 服务拿得到、但 `list()` **确实为空** ⇒ 这是**确定的事实而非未知**：
    //      此刻没有任何 live 会话 ⇒ 白名单是空集 ⇒ `false`。
    //   旧实现把两者都当 undefined，于是**零 live 会话时白名单整体退场** ——
    //   而"没人在用 dsh"恰恰是守护最该在场的场景（本机任意进程可往任意可写目录建板）。
    isAllowedCwd: (cwd) => {
      try {
        const agents = injectedAgents ?? ctx.agents;
        const sessions = injectedSessions ?? ctx.sessions;
        if (!agents || !sessions || typeof agents.list !== "function") return void 0;
        const live = agents.list();
        if (!Array.isArray(live)) return void 0;
        const roots = live.map((agent) => sessions.get(agent.id)?.header?.cwd).filter((root) => typeof root === "string" && root !== "");
        if (roots.length === 0) return false;
        const target = resolve2(cwd);
        return roots.some((root) => resolve2(root) === target);
      } catch {
        return void 0;
      }
    },
    log: (message) => {
      try {
        ctx.logger("taskboard-kit:http").info(message);
      } catch {
      }
    }
  };
}
var BridgeError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "BridgeError";
  }
};
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}
function sendTask(res, task) {
  sendJson(res, 200, { ok: true, task });
}
function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: message, code });
}
function hostnameOf(host) {
  if (!host) return null;
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  if (bracketed) return bracketed[1].toLowerCase();
  const colon = host.lastIndexOf(":");
  const bare = colon > 0 ? host.slice(0, colon) : host;
  return bare.toLowerCase() || null;
}
function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(hostname);
}
function isLoopbackAddress(address) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(normalized);
}
function isTrustedRequest(req) {
  const hostHeader = req.headers.host ?? "";
  const host = hostnameOf(hostHeader);
  if (!host || !isLoopbackHostname(host)) return false;
  const remote = req.socket?.remoteAddress;
  if (remote && !isLoopbackAddress(remote)) return false;
  const origin = req.headers.origin;
  if (origin) return isSameOrigin(origin, hostHeader);
  return true;
}
function portOf(hostHeader) {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end < 0) return void 0;
    const rest = hostHeader.slice(end + 1);
    return rest.startsWith(":") ? rest.slice(1) : void 0;
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon > 0 ? hostHeader.slice(colon + 1) : void 0;
}
function isSameOrigin(origin, hostHeader) {
  try {
    const parsed = new URL(origin);
    const originHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (originHost !== hostnameOf(hostHeader)) return false;
    const expected = portOf(hostHeader) ?? (parsed.protocol === "https:" ? "443" : "80");
    const actual = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return actual === expected;
  } catch {
    return false;
  }
}
var MAX_BODY_BYTES = 256 * 1024;
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, "invalid-input", "request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BridgeError(400, "invalid-input", "request body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(400, "invalid-input", "request body is not valid JSON");
  }
}
function str(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function requireMutateHeader(req) {
  if (req.headers[MUTATE_HEADER] !== MUTATE_HEADER_VALUE) {
    throw new BridgeError(403, "forbidden", `missing "${MUTATE_HEADER}: ${MUTATE_HEADER_VALUE}" header`);
  }
}
function requireCwd(deps, raw) {
  const value = str(raw);
  if (!value) throw new BridgeError(400, "invalid-input", 'field "cwd" is required');
  if (!isAbsolute(value)) {
    throw new BridgeError(400, "invalid-input", '"cwd" must be an absolute path');
  }
  if (value.split(/[\\/]/).includes("..")) {
    throw new BridgeError(400, "invalid-input", '"cwd" must not contain ".."');
  }
  const cwd = resolve2(value);
  if (deps.isAllowedCwd?.(cwd) === false && !existsSync(boardFilePath(cwd))) {
    throw new BridgeError(
      403,
      "forbidden",
      "cwd is not a workspace served by this dsh instance and has no board file"
    );
  }
  return cwd;
}
async function runDomain(res, op) {
  try {
    return sendTask(res, await op());
  } catch (error) {
    if (error instanceof StoreError) {
      return fail(res, error.code === "internal" ? 500 : 200, error.code, error.message);
    }
    throw error;
  }
}
async function runPlain(res, op) {
  try {
    return sendJson(res, 200, await op());
  } catch (error) {
    if (error instanceof StoreError) {
      return fail(res, error.code === "internal" ? 500 : 200, error.code, error.message);
    }
    throw error;
  }
}
function createTaskboardBridge(deps) {
  async function route(req, res, url) {
    const path = url.pathname.replace(/\/+$/, "") || BRIDGE_PREFIX;
    const method = req.method ?? "GET";
    if (method === "GET" && path === `${BRIDGE_PREFIX}/board`) {
      const cwd = requireCwd(deps, url.searchParams.get("cwd"));
      try {
        const cli = cliPath();
        const boardFile = boardFilePath(cwd);
        return sendJson(res, 200, {
          ok: true,
          board: await deps.loadBoard(cwd),
          cli: cli && existsSync(cli) ? cli : null,
          board_file: boardFile,
          // Reported alongside the board so the panel can tell "no board yet"
          // (offer to enable) apart from "empty board" (offer to create).
          board_exists: existsSync(boardFile),
          // Content freshness marker: the panel drops a snapshot whose mtime
          // is strictly older than the one it already applied (m19).
          board_mtime: existsSync(boardFile) ? statSync(boardFile).mtimeMs : 0
        });
      } catch (error) {
        if (error instanceof StoreError) {
          return fail(res, error.code === "internal" ? 500 : 200, error.code, error.message);
        }
        throw error;
      }
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/enable`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(deps, body.cwd);
      return runPlain(res, async () => {
        const result = await deps.enableBoard(cwd, { seedProtocol: body.seed_protocol !== false });
        return { ok: true, ...result };
      });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/create`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(deps, body.cwd);
      const request = body;
      return runDomain(res, () => deps.createTask(cwd, {
        title: request.title,
        ...request.detail !== void 0 ? { detail: request.detail } : {},
        ...request.assignee !== void 0 ? { assignee: request.assignee } : {},
        ...request.priority !== void 0 ? { priority: request.priority } : {},
        ...request.value !== void 0 ? { value: request.value } : {},
        ...request.tags !== void 0 ? { tags: request.tags } : {}
      }, HUMAN_ACTOR2));
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/claim`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(deps, body.cwd);
      const request = body;
      return runDomain(res, () => deps.claimTask(cwd, request.id, HUMAN_ACTOR2));
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/update`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(deps, body.cwd);
      const request = body;
      return runDomain(res, async () => (await deps.updateTask(cwd, request.id, {
        ...request.action !== void 0 ? { action: request.action } : {},
        ...request.assignee !== void 0 ? { assignee: request.assignee } : {},
        ...request.reviewer !== void 0 ? { reviewer: request.reviewer } : {},
        ...request.wait_kind !== void 0 ? { wait_kind: request.wait_kind } : {},
        ...request.wait_who !== void 0 ? { wait_who: request.wait_who } : {},
        ...request.wait_question !== void 0 ? { wait_question: request.wait_question } : {},
        ...request.title !== void 0 ? { title: request.title } : {},
        ...request.detail !== void 0 ? { detail: request.detail } : {},
        ...request.priority !== void 0 ? { priority: request.priority } : {},
        ...request.value !== void 0 ? { value: request.value } : {},
        ...request.tags !== void 0 ? { tags: request.tags } : {},
        ...request.note !== void 0 ? { note: request.note } : {}
      }, HUMAN_ACTOR2)).task);
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/comment`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(deps, body.cwd);
      const request = body;
      return runDomain(res, () => deps.addComment(cwd, request.id, request.text, HUMAN_ACTOR2));
    }
    return fail(res, 404, "not-found", `no route for ${method} ${path}`);
  }
  return {
    async handle(req, res) {
      try {
        if (!isTrustedRequest(req)) {
          return fail(res, 403, "forbidden", "untrusted host or origin");
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        await route(req, res, url);
      } catch (error) {
        if (error instanceof BridgeError) {
          return fail(res, error.status, error.code, error.message);
        }
        if (error instanceof StoreError) {
          return fail(res, error.code === "internal" ? 500 : 200, error.code, error.message);
        }
        const message = error?.message ?? String(error);
        deps.log(`bridge error: ${message}`);
        return fail(res, 500, "internal", "internal error");
      }
    }
  };
}

// src/host/locale.ts
function detectLocale() {
  return (process.env.TASKBOARDKIT_LOCALE ?? "").toLowerCase() === "en" ? "en" : "zh";
}
function L(zh, en, vars) {
  const template = detectLocale() === "zh" ? zh : en;
  if (!vars) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (raw, name2) => vars[name2] !== void 0 ? String(vars[name2]) : raw
  );
}

// src/host/notify.ts
import { spawn } from "node:child_process";
function noticePayload(notice) {
  return {
    kind: "taskboard.human",
    reason: notice.reason,
    workspace: notice.cwd,
    task: {
      id: notice.task.id,
      title: notice.task.title,
      status: notice.task.status,
      priority: notice.task.priority,
      value: notice.task.value,
      assignee: notice.task.assignee,
      created_by: notice.task.created_by,
      detail: notice.task.detail
    },
    question: notice.question,
    waiting_by: notice.waitingBy,
    waited_ms: notice.waitedMs,
    board_file: `${notice.cwd}/.dsh/taskboard.json`
  };
}
var HOOK_TIMEOUT_MS = 5e3;
function defaultRunHook(command, payload, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, { shell: true, env: { ...process.env, ...env } });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`notify hook timed out after ${HOOK_TIMEOUT_MS}ms`));
    }, HOOK_TIMEOUT_MS);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`notify hook exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`));
    });
    child.stdin?.end(payload);
  });
}
async function notifyHuman(notice, deps) {
  const command = process.env.TASKBOARD_NOTIFY_CMD?.trim();
  if (!command) return { delivered: false, how: "none" };
  const payload = JSON.stringify(noticePayload(notice), null, 2);
  const env = {
    TASKBOARD_NOTIFY_REASON: notice.reason,
    TASKBOARD_TASK_ID: notice.task.id,
    TASKBOARD_TASK_TITLE: notice.task.title,
    TASKBOARD_TASK_PRIORITY: notice.task.priority,
    TASKBOARD_QUESTION: notice.question,
    TASKBOARD_WORKSPACE: notice.cwd,
    TASKBOARD_WAITED_MS: String(notice.waitedMs)
  };
  try {
    await (deps.runHook ?? defaultRunHook)(command, payload, env);
    return { delivered: true, how: "hook" };
  } catch (error) {
    const message = error?.message ?? String(error);
    deps.log(`human notify hook failed for ${notice.task.id}: ${message}`);
    return { delivered: false, how: "hook", error: message };
  }
}
function notifyHookExample(inbox2) {
  return `TASKBOARD_NOTIFY_CMD='printf "%s\\n" "[\u770B\u677F] $TASKBOARD_TASK_ID \u9700\u8981\u4F60\u51B3\u5B9A\uFF08$TASKBOARD_NOTIFY_REASON\uFF09" "$TASKBOARD_QUESTION" | msg9 send --to ${inbox2} --subject "\u770B\u677F ${"$"}TASKBOARD_TASK_ID \u7B49\u4F60\u51B3\u5B9A"'`;
}
var msg9HookExample = notifyHookExample;

// src/host/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/host/workspace.ts
function sessionIdOf(agent) {
  if (typeof agent === "string" && agent !== "") return agent;
  if (agent && typeof agent === "object") {
    const id = agent.id;
    if (typeof id === "string" && id !== "") return id;
  }
  return void 0;
}
function resolveCwd(ctx, exec) {
  const sessionId = sessionIdOf(exec?.agent);
  if (sessionId) {
    try {
      const sessions = ctx.sessions;
      const cwd = sessions?.get(sessionId)?.header?.cwd;
      if (typeof cwd === "string" && cwd !== "") return cwd;
    } catch {
    }
  }
  return process.cwd();
}

// src/host/tools.ts
var TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }]
};
function actorOf(by) {
  if (typeof by === "string" && by.trim() !== "") return by.trim();
  return process.env.TASKBOARD_ACTOR?.trim() || "dsh-agent";
}
function whoLabel(assignee) {
  return assignee ?? L("\u5F85\u8BA4\u9886", "unassigned");
}
function errorText(error) {
  if (error instanceof StoreError) {
    switch (error.code) {
      case "not-found":
        return L("\u6CA1\u6709\u627E\u5230\u4EFB\u52A1\uFF1A{message}\uFF08\u7528 taskboard_list \u770B\u73B0\u6709\u4EFB\u52A1\uFF09", "Task not found: {message} (see taskboard_list for existing tasks)", { message: error.message });
      case "invalid-input":
        return L("\u53C2\u6570\u4E0D\u5BF9\uFF1A{message}", "Invalid input: {message}", { message: error.message });
      case "invalid-transition":
        return L("\u73B0\u5728\u4E0D\u5141\u8BB8\u8FD9\u6837\u6D41\u8F6C\uFF1A{message}", "That transition is not allowed right now: {message}", { message: error.message });
      case "conflict":
        return L("\u51B2\u7A81\uFF1A{message}", "Conflict: {message}", { message: error.message });
      default:
        return L("\u770B\u677F\u5B58\u50A8\u9519\u8BEF\uFF1A{message}", "Taskboard storage error: {message}", { message: error.message });
    }
  }
  return L("taskboard \u5DE5\u5177\u5931\u8D25\uFF1A{message}", "taskboard tool failed: {message}", { message: error.message });
}
function valueLabel(task) {
  return task.value !== null ? ` \xB7 v${task.value}` : "";
}
function ageLabel(ms) {
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d${restHours}h` : `${days}d`;
}
function marksOf(task, now) {
  const parts = [];
  const staleness = stalenessOf(task, now);
  if (task.reviewer) parts.push(`reviewer:${task.reviewer}`);
  if (task.waiting_on) {
    const who = task.waiting_on.who ? `(${task.waiting_on.who})` : "";
    parts.push(`wait:${task.waiting_on.kind}${who}`);
  }
  const halfway = staleness.slaMs !== null && staleness.ageMs >= staleness.slaMs / 2;
  if (staleness.stale) parts.push(`stale:${ageLabel(staleness.ageMs)}`);
  else if (halfway && task.status !== "done" && task.status !== "closed") parts.push(`col:${ageLabel(staleness.ageMs)}`);
  return parts.length > 0 ? ` \xB7 ${parts.join(" \xB7 ")}` : "";
}
function summaryLine(task, now) {
  return `${task.id} \xB7 ${task.status} \xB7 ${whoLabel(task.assignee)} \xB7 ${task.priority}${valueLabel(task)}${marksOf(task, now)} \xB7 ${task.title}`;
}
function seenLabel(board, name2, now) {
  const seenAt = actorSeenAt(board, name2);
  if (seenAt === void 0) return L("\uFF08\u540D\u518C\u91CC\u6CA1\u6709\uFF1A\u4ECE\u672A\u52A8\u624B\uFF09", "(not on the roster: never acted)");
  if (seenAt === null) return L("\uFF08\u4ECE\u672A\u52A8\u624B\uFF09", "(never acted)");
  const parsed = Date.parse(seenAt);
  if (Number.isNaN(parsed)) return "";
  return L("\uFF08\u6700\u8FD1\u6D3B\u52A8 {age} \u524D\uFF09", "(last active {age} ago)", { age: ageLabel(Math.max(0, now - parsed)) });
}
function formatGet(task, board, now) {
  const staleness = stalenessOf(task, now);
  const lines = [
    `${task.id} \xB7 ${task.status} \xB7 ${task.priority}${valueLabel(task)}`,
    task.title,
    L("\u8D1F\u8D23\u4EBA\uFF1A{who}{seen} \xB7 \u521B\u5EFA\uFF1A{creator} {created} \xB7 \u66F4\u65B0\uFF1A{updated}", "assignee: {who}{seen} \xB7 created by {creator} {created} \xB7 updated {updated}", {
      who: whoLabel(task.assignee),
      seen: task.assignee ? ` ${seenLabel(board, task.assignee, now)}` : "",
      creator: task.created_by,
      created: task.created_at,
      updated: task.updated_at
    }),
    L("\u5F53\u524D\u5217\uFF1A{column} \xB7 \u5DF2\u505C\u7559 {age}", "column: {column} \xB7 age {age}", {
      column: columnOf(task),
      age: ageLabel(staleness.ageMs)
    })
  ];
  if (staleness.stale) {
    lines.push(L("\u26A0 \u9648\u65E7\uFF1A\u8D85\u8FC7\u8BE5\u5217 {sla} \u7684\u9608\u503C", "\u26A0 stale: past this column's {sla} SLA", { sla: ageLabel(staleness.slaMs ?? 0) }));
  }
  if (task.reviewer) {
    lines.push(L("\u5BA1\u6838\u4EBA\uFF1A{who}{seen}", "reviewer: {who}{seen}", { who: task.reviewer, seen: ` ${seenLabel(board, task.reviewer, now)}` }));
  }
  if (task.waiting_on) {
    const waited = Math.max(0, now - (Date.parse(task.waiting_on.since) || now));
    lines.push(L(
      "\u23F3 \u5728\u7B49 {kind}{who}\uFF0C\u5DF2 {waited}\uFF1A{question}",
      "\u23F3 waiting on {kind}{who} for {waited}: {question}",
      {
        kind: task.waiting_on.kind,
        who: task.waiting_on.who ? `(${task.waiting_on.who})` : "",
        waited: ageLabel(waited),
        question: task.waiting_on.question
      }
    ));
  }
  if (task.tags.length > 0) lines.push(`tags: ${task.tags.join(", ")}`);
  if (task.detail) lines.push("", task.detail);
  lines.push("", L("\u65F6\u95F4\u7EBF\uFF1A", "timeline:"));
  for (const entry of task.log) {
    lines.push(`${entry.at} \xB7 ${entry.by} \xB7 ${entry.event}${entry.note ? ` \u2014 ${entry.note}` : ""}`);
  }
  if (task.comments.length > 0) {
    lines.push("", L("\u7559\u8A00\uFF1A", "comments:"));
    for (const comment of task.comments) {
      lines.push(`${comment.at} \xB7 ${comment.by} \xB7 ${comment.text}`);
    }
  }
  return lines.join("\n");
}
function inboxKindLabel(item) {
  switch (item.kind) {
    case "review_owed":
      return L("\u7B49\u4F60\u5BA1\u6838", "review owed by you");
    case "unblock_me":
      return L("\u6709\u4EBA\u5728\u7B49\u4F60", "someone is blocked on you");
    case "returned":
      return L("\u4F60\u7684\u5361\u88AB\u6253\u56DE", "your task was rejected");
    case "stalled_mine":
      return L("\u4F60\u7684\u5361\u9648\u65E7\u4E86", "your task went stale");
    case "orphaned_mine":
      return L("\u4F60\u6D3E\u7684\u5361\uFF0C\u63A5\u7684\u4EBA\u4E0D\u89C1\u4E86", "your delegate went quiet");
    case "start_assigned":
      return L("\u6307\u6D3E\u7ED9\u4F60\u4F46\u6CA1\u5F00\u5DE5", "assigned to you, not started");
    case "human_blocked":
      return L("\u5728\u7B49\u4EBA\u7C7B\uFF08\u53BB\u53EB\u4EBA\uFF09", "waiting on the human (go ping them)");
    case "settle_mine":
      return L("\u4F60\u7684\u5361\u5DF2 done \u4F46\u6CA1\u6536\u53E3", "your task is done but unsettled");
    case "pool_pick":
      return L("\u6C60\u5B50\u91CC\u503C\u5F97\u62FF", "worth claiming from the pool");
    default:
      return item.kind;
  }
}
function formatInbox(items, actor, now) {
  if (items.length === 0) {
    return L("{actor}\uFF1A\u73B0\u5728\u6CA1\u6709\u8BE5\u4F60\u5904\u7406\u7684\u4E8B\uFF08\u770B\u677F\u5E72\u51C0\uFF09\u3002", "{actor}: nothing is on you right now (board is clean).", { actor });
  }
  const lines = [L(
    "{actor} \u73B0\u5728\u8BE5\u5904\u7406\u7684 {count} \u4EF6\u4E8B\uFF08\u5DF2\u6309\u6025\u8FEB\u5EA6\u6392\u5E8F\uFF09\uFF1A",
    "{count} thing(s) on {actor}, most urgent first:",
    { actor, count: items.length }
  )];
  items.forEach((item, index) => {
    const flags = item.actor ? ` \xB7 ${item.actor}` : "";
    lines.push(
      `${index + 1}. [${inboxKindLabel(item)}] ${item.task.id} \xB7 ${item.task.priority}${valueLabel(item.task)} \xB7 \u5DF2 ${ageLabel(item.ageMs)}${flags}`,
      `   ${item.task.title}`,
      `   \u2192 ${item.suggest}`
    );
  });
  return lines.join("\n");
}
function registerTaskboardTools(ctx) {
  ctx.tools.register(defineTool({
    name: "taskboard_list",
    description: `List tasks on this workspace's shared task board (the same board the human sees in the kanban tab). One summary line per task with its reviewer / waiting-on / staleness marks. For "what should I do right now", prefer taskboard_inbox.`,
    parameters: {
      status: { type: "string", enum: ["open", "in_progress", "review", "done", "closed"], description: "Keep only this status." },
      column: { type: "string", enum: ["pool", "assigned", "in_progress", "review", "done", "closed"], description: "Keep only this kanban column (pool = open and unassigned, i.e. claimable; review = submitted, awaiting approval)." },
      assignee: { type: "string", description: 'Keep only tasks owned by this actor; pass "none" for unassigned (claimable) tasks.' },
      waiting: { type: "string", enum: ["human", "agent", "external", "any"], description: 'Keep only tasks parked on someone: human / agent / external, or "any" for all waiting tasks.' }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const all = await listTasks(cwd);
        const now = Date.now();
        const listed = all.filter((task) => {
          if (args.status && task.status !== args.status) return false;
          if (args.column && columnOf(task) !== args.column) return false;
          if (args.assignee === "none") return task.assignee === null;
          if (args.assignee !== void 0 && task.assignee !== args.assignee) return false;
          if (args.waiting === "any") return task.waiting_on !== null;
          if (args.waiting !== void 0) return task.waiting_on?.kind === args.waiting;
          return true;
        });
        const totals = L(
          "\u770B\u677F\u5408\u8BA1\uFF1Aopen {open} \xB7 in_progress {ip} \xB7 review {rv} \xB7 done {done} \xB7 closed {cx}",
          "board totals: open {open} \xB7 in_progress {ip} \xB7 review {rv} \xB7 done {done} \xB7 closed {cx}",
          {
            open: all.filter((task) => task.status === "open").length,
            ip: all.filter((task) => task.status === "in_progress").length,
            rv: all.filter((task) => task.status === "review").length,
            done: all.filter((task) => task.status === "done").length,
            cx: all.filter((task) => task.status === "closed").length
          }
        );
        const board = await loadBoard(cwd);
        const health2 = boardHealth(board, { now });
        const healthLine = health2.orphaned.length + health2.unownedReview.length > 0 ? L(
          "\n\u26A0 \u534F\u4F5C\u5065\u5EB7\uFF1A{orphaned} \u5F20\u6D3E\u7ED9\u4E86\u4E45\u672A/\u4ECE\u672A\u51FA\u73B0\u7684 Agent\uFF0C{unowned} \u5F20\u5728 review \u4F46\u6CA1\u6709\u5BA1\u6838\u4EBA\uFF08\u7528 taskboard_update \u6539\u6D3E\uFF0C\u6216 comment \u8BF4\u660E\uFF09",
          "\n\u26A0 collaboration health: {orphaned} delegated to an actor that has gone quiet/never acted, {unowned} in review with nobody named (reassign with taskboard_update, or comment)",
          { orphaned: health2.orphaned.length, unowned: health2.unownedReview.length }
        ) : "";
        const waitingLine = health2.waitingHuman.length > 0 ? L(
          "\n\u23F3 \u5728\u7B49\u4EBA\u7C7B\u51B3\u5B9A\uFF1A{list}\uFF08\u7528 taskboard_inbox \u770B\u8BE6\u60C5\uFF0C\u518D\u7528\u4F60\u7684\u901A\u77E5\u901A\u9053\u53EB\u4EBA\uFF09",
          "\n\u23F3 waiting on the human: {list} (taskboard_inbox has the detail, then ping them via your notify channel)",
          { list: health2.waitingHuman.map((issue) => issue.task.id).join(", ") }
        ) : "";
        if (listed.length === 0) {
          const empty = all.length === 0 ? L("\u770B\u677F\u662F\u7A7A\u7684\u2014\u2014\u7528 taskboard_create \u5EFA\u7B2C\u4E00\u4E2A\u4EFB\u52A1\u3002", "The board is empty \u2014 use taskboard_create to add the first task.") : L("\u6CA1\u6709\u5339\u914D\u7684\u4EFB\u52A1\uFF08\u653E\u5BBD\u8FC7\u6EE4\u6761\u4EF6\u8BD5\u8BD5\uFF09\u3002", "No tasks match these filters (try loosening them).");
          return `${empty}
${totals}${healthLine}${waitingLine}`;
        }
        const head = L("{count} \u6761\u4EFB\u52A1\uFF1A", "{count} task(s):", { count: listed.length });
        return `${head}
${listed.map((task) => summaryLine(task, now)).join("\n")}
${totals}${healthLine}${waitingLine}`;
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_inbox",
    description: "THE call to make at session start: what is on YOU right now, most urgent first \u2014 reviews you owe, people blocked on you, tasks returned to you after a rejection, your own cards that went stale, cards you delegated to an actor that has gone quiet, work assigned to you but not started, and the best pool tasks to claim. Every item comes with the command that moves it. Cards waiting on the human are listed too: pinging the human is your job, not the board's.",
    parameters: {
      by: { type: "string", description: "Acting identity (default: TASKBOARD_ACTOR or dsh-agent). Aliases like dsh/dsh-agent resolve to one owner." },
      limit: { type: "number", description: "Max items to return (default 12; 0 = no cap)." },
      pool_limit: { type: "number", description: "How many claimable pool tasks to suggest (default 3; 0 = none)." },
      include_human: { type: "boolean", description: "Include cards waiting on the human (default true) \u2014 so you can go ping them." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const actor = actorOf(args.by);
        const items = await inbox(cwd, actor, {
          ...args.pool_limit !== void 0 ? { poolLimit: args.pool_limit } : {},
          ...args.include_human !== void 0 ? { includeHumanBlocked: args.include_human } : {}
        });
        const limited = args.limit !== void 0 && args.limit > 0 ? items.slice(0, args.limit) : items;
        const rendered = formatInbox(limited, actor, Date.now());
        const more = limited.length < items.length ? L("\n\uFF08\u8FD8\u6709 {rest} \u6761\uFF0C\u8C03\u5927 limit \u770B\u5168\uFF09", "\n({rest} more \u2014 raise limit to see them)", { rest: items.length - limited.length }) : "";
        return `${rendered}${more}`;
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_create",
    description: "Create a task on this workspace's shared task board. Omit assignee to put it in the claimable pool (anyone \u2014 you, a sibling agent, or the human \u2014 can then taskboard_claim it); set assignee to delegate it. If the work cannot start without a human decision, create it and then park it (taskboard_update action=block) instead of leaving it looking claimable. Returns the allocated id (T-<n>).",
    parameters: {
      title: { type: "string", required: true, description: "One-line task title." },
      detail: { type: "string", description: "Markdown body with the full context \u2014 the panel renders it (GFM: headings, lists, code blocks, quotes, tables, --- rules)." },
      assignee: { type: "string", description: "Delegate to this actor; omit for the claimable pool." },
      priority: { type: "string", enum: ["high", "medium", "low"], description: "Default: medium." },
      value: { type: "number", enum: [0.5, 1, 2, 3, 5, 8], description: "Value points \u2014 one of 0.5 1 2 3 5 8; omit if unestimated." },
      tags: { type: "array", items: { type: "string" }, description: "Free-form grouping labels." },
      by: { type: "string", description: "Acting identity recorded in the task log (default: TASKBOARD_ACTOR or dsh-agent)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const task = await createTask(cwd, {
          title: args.title,
          ...args.detail !== void 0 ? { detail: args.detail } : {},
          ...args.assignee !== void 0 ? { assignee: args.assignee } : {},
          ...args.priority !== void 0 ? { priority: args.priority } : {},
          ...args.value !== void 0 ? { value: args.value } : {},
          ...args.tags !== void 0 ? { tags: args.tags } : {}
        }, actorOf(args.by));
        const placement = task.assignee ? L("\u5DF2\u6307\u6D3E\u7ED9 {who}", "assigned to {who}", { who: task.assignee }) : L("\u5728\u5F85\u8BA4\u9886\u6C60\u91CC\uFF0C\u53EF\u7528 taskboard_claim \u8BA4\u9886", "in the claimable pool \u2014 claim it with taskboard_claim");
        return L("\u5DF2\u521B\u5EFA {id}\uFF1A{title}\uFF08open \xB7 {priority} \xB7 {placement}\uFF09", "Created {id}: {title} (open \xB7 {priority} \xB7 {placement})", {
          id: task.id,
          title: task.title,
          priority: task.priority,
          placement
        });
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_claim",
    description: "Atomically claim a pool task for yourself: succeeds only while it is open, unassigned AND not waiting on someone, then it is yours and in_progress. ALWAYS claim before starting work on a pool task \u2014 if the claim conflicts, someone else got there first; pick another task instead of working in parallel by accident.",
    parameters: {
      id: { type: "string", required: true, description: "Task id, e.g. T-1 (from taskboard_list)." },
      by: { type: "string", description: "Acting identity recorded in the task log (default: TASKBOARD_ACTOR or dsh-agent)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = resolveCwd(ctx, exec);
      const actor = actorOf(args.by);
      try {
        const task = await claimTask(cwd, args.id, actor);
        return L(
          "\u5DF2\u8BA4\u9886 {id}\uFF08in_progress \xB7 {by}\uFF09\uFF1A{title}\n\u5E72\u5B8C\u7528 taskboard_update\uFF08action=submit --reviewer <\u5BA1\u6838\u4EBA>\uFF09\u4EA4\u5BA1\u6838\uFF1B\u4E2D\u9014\u5361\u4F4F\u4E86\u7528 action=block \u8BF4\u660E\u5728\u7B49\u8C01\u3002",
          "Claimed {id} (in_progress \xB7 {by}): {title}\nWhen done, hand it off with taskboard_update (action=submit --reviewer <name>); if you get stuck, action=block and say who you are waiting on.",
          { id: task.id, by: actor, title: task.title }
        );
      } catch (error) {
        if (error instanceof StoreError && error.code === "conflict") {
          const task = await getTask(cwd, args.id).catch(() => void 0);
          if (task) {
            if (task.waiting_on) {
              return L(
                "{id} \u8BA4\u9886\u5931\u8D25\uFF1A\u5B83\u5728\u7B49 {kind}{who} \u2014\u2014 {question}\u3002\u7B49\u5BF9\u65B9\u56DE\u590D\u540E\u5148 unblock\uFF0C\u518D\u8BA4\u9886\u3002",
                "Cannot claim {id}: it is waiting on {kind}{who} \u2014 {question}. Unblock it once the answer lands, then claim.",
                {
                  id: args.id,
                  kind: task.waiting_on.kind,
                  who: task.waiting_on.who ? ` ${task.waiting_on.who}` : "",
                  question: task.waiting_on.question
                }
              );
            }
            return L(
              "{id} \u8BA4\u9886\u5931\u8D25\uFF1A\u73B0\u5728\u7531 {who} \u6301\u6709\uFF0C\u72B6\u6001 {status}\u3002\u7528 taskboard_inbox \u770B\u4F60\u8FD8\u80FD\u62FF\u4EC0\u4E48\uFF0C\u6216\u5411\u4EBA\u7C7B\u8BF7\u793A\u3002",
              "Cannot claim {id}: now held by {who}, status {status}. See taskboard_inbox for what else is yours, or ask the human.",
              { id: args.id, who: whoLabel(task.assignee), status: task.status }
            );
          }
        }
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_update",
    description: "Update a task: move it through its lifecycle (action start/stop/submit/approve/reject/done/close/reopen), park it on someone with action=block / action=unblock, reassign it, name the reviewer with reviewer=, edit title/detail/priority/value/tags, and attach a note to the log entry. Report progress as you go \u2014 the human watches the same board in the kanban tab. Rules the board enforces: submit hands the card to a named reviewer (never yourself); approve/reject are reserved for that reviewer, the task's creator or the human; a card waiting on someone cannot be claimed. Everything else is advisory \u2014 `by` is only recorded, so the human or a lead agent can always override; still, prefer acting on the task you hold. To leave information without changing state, use taskboard_comment instead.",
    parameters: {
      id: { type: "string", required: true, description: "Task id, e.g. T-1." },
      action: { type: "string", enum: ["start", "stop", "submit", "approve", "reject", "done", "close", "reopen", "cancel", "block", "unblock"], description: "start: open\u2192in_progress; stop: in_progress\u2192open; submit: in_progress\u2192review (names a reviewer); approve: review\u2192done; reject: review\u2192in_progress (say why in note); done: open|in_progress|review\u2192done \u2014 NOT terminal, the card still owes a close; close: open|in_progress|review|done\u2192closed \u2014 THE terminal status (settled); to abandon work also use close, and say why in the note (cancel is its legacy alias); reopen: done|closed\u2192open; block: record that the card is waiting on someone (status unchanged); unblock: the wait is over." },
      assignee: { oneOf: [{ type: "string" }, { type: "null" }], description: "New owner while open/in_progress; null unassigns back to the pool." },
      reviewer: { oneOf: [{ type: "string" }, { type: "null" }], description: "Who owes the review. Set it on submit; the board also accepts it while open/in_progress to pre-delegate. You cannot review your own work." },
      wait_kind: { type: "string", enum: ["human", "agent", "external"], description: "For action=block: who the card is waiting on. Inferred from wait_who when omitted." },
      wait_who: { type: "string", description: "For action=block: the specific human or agent whose answer is needed." },
      wait_question: { type: "string", description: "For action=block: exactly what must be decided \u2014 a one-liner that can be forwarded to that person as-is." },
      title: { type: "string", description: "New title." },
      detail: { type: "string", description: "New markdown body." },
      priority: { type: "string", enum: ["high", "medium", "low"], description: "New priority." },
      value: { oneOf: [{ type: "number", enum: [0.5, 1, 2, 3, 5, 8] }, { type: "null" }], description: "Value points \u2014 one of 0.5 1 2 3 5 8; null clears back to unestimated." },
      tags: { type: "array", items: { type: "string" }, description: "Replace the tag list." },
      note: { type: "string", description: "Progress note appended to the log entry this update produces." },
      by: { type: "string", description: "Acting identity recorded in the task log (default: TASKBOARD_ACTOR or dsh-agent)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const actor = actorOf(args.by);
        const { task, events } = await updateTask(cwd, args.id, {
          ...args.action !== void 0 ? { action: args.action } : {},
          ...args.assignee !== void 0 ? { assignee: args.assignee } : {},
          ...args.reviewer !== void 0 ? { reviewer: args.reviewer } : {},
          ...args.wait_kind !== void 0 ? { wait_kind: args.wait_kind } : {},
          ...args.wait_who !== void 0 ? { wait_who: args.wait_who } : {},
          ...args.wait_question !== void 0 ? { wait_question: args.wait_question } : {},
          ...args.title !== void 0 ? { title: args.title } : {},
          ...args.detail !== void 0 ? { detail: args.detail } : {},
          ...args.priority !== void 0 ? { priority: args.priority } : {},
          ...args.value !== void 0 ? { value: args.value } : {},
          ...args.tags !== void 0 ? { tags: args.tags } : {},
          ...args.note !== void 0 ? { note: args.note } : {}
        }, actor);
        const extra = [];
        if (args.action === "submit" && task.reviewer) {
          extra.push(L(
            "\u5DF2\u4EA4\u7ED9 {who} \u5BA1\u6838\uFF08\u4F1A\u51FA\u73B0\u5728\u4ED6\u7684 taskboard_inbox \u91CC\uFF09",
            "handed to {who} for review (it now shows up in their taskboard_inbox)",
            { who: task.reviewer }
          ));
        }
        if (args.action === "block" && task.waiting_on?.kind === "human") {
          const result = await notifyHuman({
            cwd,
            task,
            question: task.waiting_on.question,
            reason: "blocked",
            waitingBy: actor,
            waitedMs: 0
          }, {
            log: (message) => {
              try {
                ctx.logger("taskboard-kit").info(message);
              } catch {
              }
            }
          });
          extra.push(result.delivered ? L("\u5DF2\u901A\u8FC7 TASKBOARD_NOTIFY_CMD \u5916\u53D1\u901A\u77E5\u4EBA\u7C7B", "the human was notified out-of-band via TASKBOARD_NOTIFY_CMD") : L("\u5DF2\u8FDB\u5165\u300C\u7B49\u4EBA\u7C7B\u300D\u6E05\u5355\uFF08\u9762\u677F\u53EF\u89C1\uFF09\uFF1B\u82E5\u4EBA\u7C7B\u4E0D\u770B\u9762\u677F\uFF0C\u7528\u4F60\u7684\u901A\u77E5\u901A\u9053\u4E3B\u52A8\u544A\u4E00\u58F0", "parked on the human (visible in the panel); if they may not look, ping them via your notify channel"));
        }
        const tail = extra.length > 0 ? `
${extra.join("\n")}` : "";
        return L(
          "\u5DF2\u66F4\u65B0 {id}\uFF1A{events}\u3002\u5F53\u524D {status} \xB7 {who}{marks}",
          "Updated {id}: {events}. Now {status} \xB7 {who}{marks}",
          { id: task.id, events: events.join(" \xB7 "), status: task.status, who: whoLabel(task.assignee), marks: marksOf(task, Date.now()) }
        ) + tail;
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_comment",
    description: "Add an information comment to a task WITHOUT changing its state: implementation findings, handoff notes for the next agent, or test feedback. The next agent reads them in taskboard_get. A submission with no handoff comment is a submission the reviewer cannot verify \u2014 say what you did, what you verified, and what is still open.",
    parameters: {
      id: { type: "string", required: true, description: "Task id, e.g. T-1." },
      text: { type: "string", required: true, description: "The comment body (findings, handoff notes, test feedback)." },
      by: { type: "string", description: "Acting identity recorded on the comment (default: TASKBOARD_ACTOR or dsh-agent)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const task = await addComment(cwd, args.id, args.text, actorOf(args.by));
        return L(
          "\u5DF2\u5728 {id} \u7559\u8A00\uFF08\u5171 {count} \u6761\uFF09\uFF1A{title}",
          "Commented on {id} ({count} comment(s) so far): {title}",
          { id: task.id, count: task.comments.length, title: task.title }
        );
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_get",
    description: "Read ONE task in full: title, detail body, owner, reviewer, who it is waiting on, how long it has been in its column (and whether that is over the SLA), the complete log timeline (who did what, when, with notes), and the information comments other agents left (findings / handoffs / test feedback). taskboard_list only shows summary lines.",
    parameters: {
      id: { type: "string", required: true, description: "Task id, e.g. T-1 (from taskboard_list)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const task = await getTask(cwd, args.id);
        const board = await loadBoard(cwd);
        return formatGet(task, board, Date.now());
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_roster",
    description: "Who is actually here: every actor that has ever acted on this board, when it was last seen, and its aliases (dsh \u2261 dsh-agent). Use it before delegating \u2014 handing work to an actor that has gone quiet (or never acted) is how a card gets orphaned. Also reports the board file path.",
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const board = await loadBoard(cwd);
        const now = Date.now();
        const entries = Object.entries(board.actors ?? {});
        const lines = [L("\u770B\u677F\u6587\u4EF6\uFF1A{file}", "board file: {file}", { file: boardFilePath(cwd) })];
        if (entries.length === 0) {
          lines.push(L("\u540D\u518C\u662F\u7A7A\u7684\u2014\u2014\u8FD8\u6CA1\u6709\u4EBA\u5728\u8FD9\u5757\u677F\u4E0A\u52A8\u8FC7\u624B\u3002", "The roster is empty \u2014 nobody has acted on this board yet."));
          return lines.join("\n");
        }
        lines.push(L("\u540D\u518C\uFF08{count} \u4E2A Actor\uFF09\uFF1A", "roster ({count} actor(s)):", { count: entries.length }));
        for (const [name2, entry] of entries) {
          const aliases = entry.aliases.length > 0 ? ` \u2261 ${entry.aliases.join(" / ")}` : "";
          const seen = entry.last_seen_at ? L("\u6700\u8FD1\u6D3B\u52A8 {age} \u524D", "last active {age} ago", { age: ageLabel(Math.max(0, now - (Date.parse(entry.last_seen_at) || now))) }) : L("\u4ECE\u672A\u52A8\u624B", "never acted");
          lines.push(`\xB7 ${name2}${aliases} \xB7 ${entry.kind} \xB7 ${seen}`);
        }
        return lines.join("\n");
      } catch (error) {
        return errorText(error);
      }
    }
  }));
}

// src/host/watch.ts
import { mkdirSync, watch } from "node:fs";
import { join as join3 } from "node:path";
function envNames() {
  const raw = process.env.TASKBOARD_WATCH_NAMES;
  if (!raw) return void 0;
  const names = raw.split(",").map((name2) => name2.trim()).filter(Boolean);
  return names.length > 0 ? names : void 0;
}
function envSiblings() {
  const raw = process.env.TASKBOARD_SIBLING_NAMES;
  if (!raw) return void 0;
  const names = raw.split(",").map((name2) => name2.trim()).filter(Boolean);
  return names.length > 0 ? names : void 0;
}
function defaultWatchDir(cwd, onChange) {
  const dir = join3(cwd, ".dsh");
  mkdirSync(dir, { recursive: true });
  const watcher = watch(dir, (_event, filename) => {
    if (filename === "taskboard.json") onChange();
  });
  watcher.on("error", () => {
  });
  return () => watcher.close();
}
function quoted(task) {
  const title = task.title.length > 40 ? `${task.title.slice(0, 40)}\u2026` : task.title;
  return `"${title}"`;
}
function excerpt(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}\u2026` : flat;
}
function diffBoards(prev, next, names, siblingNames = []) {
  if (!prev) return [];
  const self = new Set(names);
  const owned = /* @__PURE__ */ new Set([...names, ...siblingNames]);
  const isMine = (task) => task.assignee !== null && owned.has(task.assignee) || owned.has(task.created_by);
  const lines = [];
  for (const [id, after] of Object.entries(next.tasks)) {
    const before = prev.tasks[id];
    if (!before) {
      if (self.has(after.created_by)) continue;
      if (after.assignee && owned.has(after.assignee)) {
        lines.push(`${id} \xB7 assigned to you (by ${after.created_by}) \xB7 ${quoted(after)}`);
      } else if (after.waiting_on) {
        lines.push(waitLine(id, after));
      } else if (!after.assignee) {
        lines.push(`${id} \xB7 new in pool (by ${after.created_by}) \xB7 ${quoted(after)}`);
      }
      continue;
    }
    if (after.assignee !== before.assignee && after.assignee && owned.has(after.assignee)) {
      const actor = after.log.at(-1)?.by;
      if (!actor || !self.has(actor)) {
        lines.push(`${id} \xB7 assigned to you${actor ? ` (by ${actor})` : ""} \xB7 ${quoted(after)}`);
      }
    }
    if (after.reviewer && after.reviewer !== before.reviewer && owned.has(after.reviewer)) {
      const actor = after.log.at(-1)?.by;
      if (!actor || !self.has(actor)) {
        lines.push(`${id} \xB7 review requested from you${actor ? ` (by ${actor})` : ""} \xB7 ${quoted(after)}`);
      }
    }
    const waitBefore = before.waiting_on?.who ?? before.waiting_on?.kind ?? null;
    const waitAfter = after.waiting_on?.who ?? after.waiting_on?.kind ?? null;
    if (waitAfter !== waitBefore && after.waiting_on) {
      const actor = after.log.at(-1)?.by;
      if (!actor || !self.has(actor)) lines.push(waitLine(id, after));
    }
    if (before.waiting_on && !after.waiting_on) {
      const actor = after.log.at(-1)?.by;
      if (actor && !self.has(actor)) lines.push(`${id} \xB7 no longer waiting on anyone (by ${actor}) \xB7 ${quoted(after)}`);
    }
    for (const entry of after.log.slice(before.log.length)) {
      if (self.has(entry.by)) continue;
      if (entry.event !== "approved" && entry.event !== "rejected" && entry.event !== "done") continue;
      if (!isMine(after)) continue;
      const note = entry.note ? ` \u2014 ${excerpt(entry.note)}` : "";
      lines.push(`${id} \xB7 ${entry.event} by ${entry.by}${note} \xB7 ${quoted(after)}`);
    }
    const newComments = after.comments.slice(before.comments.length).filter((comment) => !self.has(comment.by));
    if (newComments.length > 0 && isMine(after)) {
      const last = newComments[newComments.length - 1];
      lines.push(newComments.length === 1 ? `${id} \xB7 new comment by ${last.by}: ${excerpt(last.text)} \xB7 ${quoted(after)}` : `${id} \xB7 ${newComments.length} new comments (latest by ${last.by}) \xB7 ${quoted(after)}`);
    }
  }
  return lines;
}
function waitLine(id, task) {
  const wait = task.waiting_on;
  const who = wait.who ? `(${wait.who})` : "";
  const question = excerpt(wait.question);
  if (wait.kind === "human") {
    return `${id} \xB7 waiting on the HUMAN${who}: ${question} \xB7 ${quoted(task)} \u2014 ping them (your notify channel) if they may not be looking`;
  }
  return `${id} \xB7 waiting on ${wait.kind}${who}: ${question} \xB7 ${quoted(task)}`;
}
var PRESSING_KINDS = /* @__PURE__ */ new Set(["review_owed", "unblock_me", "returned", "stalled_mine", "orphaned_mine"]);
function isPressing(item, board) {
  if (PRESSING_KINDS.has(item.kind)) return true;
  if (item.kind === "human_blocked") return stalenessOf(item.task).waitOverdue;
  return false;
}
function createBoardWatcher(deps) {
  const names = [...deps.names ?? envNames() ?? ["dsh", "dsh-agent"]];
  const siblings = [...deps.siblingNames ?? envSiblings() ?? []];
  const debounceMs = deps.debounceMs ?? 300;
  const throttleMs = deps.throttleMs ?? 5e3;
  const reconcileMs = deps.reconcileMs ?? 3e4;
  const auditMs = deps.auditMs ?? 5 * 6e4;
  const auditThrottleMs = deps.auditThrottleMs ?? 30 * 6e4;
  const watchDir = deps.watchDir ?? defaultWatchDir;
  const watched = /* @__PURE__ */ new Map();
  let stopped = false;
  function renderNotice(lines) {
    return L(
      "[\u770B\u677F\u53D8\u5316] \u672C workspace \u7684\u4EFB\u52A1\u770B\u677F\u6709\u66F4\u65B0\uFF1A\n{lines}\n\u7528 taskboard_get \u770B\u8BE6\u60C5\uFF1B\u5F85\u8BA4\u9886\u4EFB\u52A1\u7528 taskboard_claim \u8BA4\u9886\uFF0C\u88AB\u6307\u6D3E\u7684\u7528 taskboard_update\uFF08action=start\uFF09\u5F00\u5DE5\u3002",
      "[board change] this workspace's task board changed:\n{lines}\ntaskboard_get for details; taskboard_claim to take a pool task, taskboard_update (action=start) for one assigned to you.",
      { lines: lines.map((line) => `\xB7 ${line}`).join("\n") }
    );
  }
  function renderAuditNotice(name2, items) {
    const lines = items.map((item) => {
      const wait = item.task.waiting_on;
      const why = wait ? `waiting on ${wait.kind}${wait.who ? ` (${wait.who})` : ""}: ${wait.question}` : `${item.task.status}`;
      return `\xB7 ${item.task.id} [${item.kind}] ${item.task.title} \u2014 ${why} \xB7 \u5DF2 ${Math.round(item.ageMs / 36e5)}h
  \u2192 ${item.suggest}`;
    });
    return L(
      "[\u770B\u677F\u81EA\u68C0] {name}\uFF1A\u6709 {count} \u4EF6\u4E8B\u538B\u7740\u6CA1\u52A8\uFF08\u770B\u677F\u6CA1\u6709\u6587\u4EF6\u53D8\u5316\uFF0C\u6240\u4EE5\u6CA1\u4EBA\u88AB\u901A\u77E5\u8FC7\uFF09\uFF1A\n{lines}\n\u6CA1\u6709\u4EBA\u7C7B\u7684\u53C2\u4E0E\u4E5F\u8BE5\u7531\u4F60\u81EA\u5DF1\u63A8\u8FDB\uFF1A\u50AC\u4EBA\u3001\u6539\u6D3E\u3001\u6216\u5148\u628A\u80FD\u505A\u7684\u505A\u5B8C\u3002",
      "[board self-audit] {name}: {count} item(s) are sitting on you (no file change, so nothing was ever pushed):\n{lines}\nAdvance these without waiting for a human: ping, reassign, or finish what you can.",
      { name: name2, count: items.length, lines: lines.join("\n") }
    );
  }
  function flush(cwd, entry) {
    if (entry.pending.length === 0) return;
    const lines = [...new Set(entry.pending)];
    entry.pending = [];
    entry.lastFlushAt = Date.now();
    const agents = deps.resolveAgents().filter((agent) => agent.cwd === cwd);
    if (agents.length === 0) return;
    const text = renderNotice(lines);
    for (const agent of agents) {
      try {
        deps.injectNotice(agent.id, text);
      } catch (error) {
        deps.log(`notice injection failed for ${agent.id}: ${error?.message ?? String(error)}`);
      }
    }
  }
  function enqueue(cwd, entry, lines) {
    entry.pending.push(...lines);
    const elapsed = Date.now() - entry.lastFlushAt;
    if (elapsed >= throttleMs) {
      flush(cwd, entry);
      return;
    }
    entry.flushTimer ??= setTimeout(() => {
      entry.flushTimer = void 0;
      if (!stopped) flush(cwd, entry);
    }, throttleMs - elapsed);
  }
  async function poke(cwd) {
    const entry = watched.get(cwd);
    if (!entry || stopped) return;
    let next;
    try {
      next = await deps.loadBoard(cwd);
    } catch (error) {
      deps.log(`board reload failed for ${cwd}: ${error?.message ?? String(error)}`);
      return;
    }
    const prev = entry.lastBoard;
    entry.lastBoard = next;
    if (!prev) return;
    const lines = diffBoards(prev, next, names, siblings);
    if (lines.length > 0) enqueue(cwd, entry, lines);
  }
  async function audit(cwd) {
    const entry = watched.get(cwd);
    if (!entry || stopped) return;
    let board;
    try {
      board = await deps.loadBoard(cwd);
    } catch (error) {
      deps.log(`board audit failed for ${cwd}: ${error?.message ?? String(error)}`);
      return;
    }
    entry.lastBoard = board;
    const now = Date.now();
    for (const task of Object.values(board.tasks)) {
      const wait = task.waiting_on;
      if (!wait || wait.kind !== "human") continue;
      const staleness = stalenessOf(task, now);
      if (!staleness.waitOverdue) continue;
      const lastEscalation = entry.humanEscalatedAt.get(task.id) ?? 0;
      if (now - lastEscalation < auditThrottleMs) continue;
      entry.humanEscalatedAt.set(task.id, now);
      try {
        deps.onHumanWaitOverdue?.({ cwd, task, question: wait.question, waitedMs: staleness.waitMs, reason: "overdue" });
      } catch (error) {
        deps.log(`human escalation failed for ${task.id}: ${error?.message ?? String(error)}`);
      }
    }
    const pressing = [];
    for (const name2 of names) {
      for (const item of inboxFor(board, name2, { poolLimit: 0, includeHumanBlocked: true, now })) {
        if (isPressing(item, board)) pressing.push(item);
      }
    }
    if (pressing.length === 0) {
      entry.lastAuditSignature = void 0;
      return;
    }
    const signature = pressing.map((item) => `${item.kind}:${item.task.id}`).sort().join(",");
    const changed = signature !== entry.lastAuditSignature;
    if (!changed && now - entry.lastAuditAt < auditThrottleMs) return;
    entry.lastAuditSignature = signature;
    entry.lastAuditAt = now;
    const agents = deps.resolveAgents().filter((agent) => agent.cwd === cwd);
    if (agents.length === 0) return;
    const text = renderAuditNotice(names[0] ?? "dsh", pressing);
    for (const agent of agents) {
      try {
        deps.injectNotice(agent.id, text);
      } catch (error) {
        deps.log(`audit notice injection failed for ${agent.id}: ${error?.message ?? String(error)}`);
      }
    }
  }
  function onChange(cwd) {
    const entry = watched.get(cwd);
    if (!entry || stopped) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = void 0;
      void poke(cwd);
    }, debounceMs);
  }
  function reconcile() {
    const wanted = /* @__PURE__ */ new Set();
    for (const agent of deps.resolveAgents()) {
      if (agent.cwd) wanted.add(agent.cwd);
    }
    for (const [cwd, entry] of [...watched]) {
      if (wanted.has(cwd)) continue;
      entry.unwatch();
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      watched.delete(cwd);
    }
    for (const cwd of wanted) {
      if (watched.has(cwd)) continue;
      try {
        const unwatch = watchDir(cwd, () => onChange(cwd));
        const entry = {
          unwatch,
          pending: [],
          lastFlushAt: 0,
          lastAuditAt: 0,
          humanEscalatedAt: /* @__PURE__ */ new Map()
        };
        watched.set(cwd, entry);
        void deps.loadBoard(cwd).then((board) => {
          if (watched.get(cwd) === entry && !entry.lastBoard) entry.lastBoard = board;
        }, () => {
        });
      } catch (error) {
        deps.log(`cannot watch ${cwd}: ${error?.message ?? String(error)}`);
      }
    }
  }
  function start() {
    stopped = false;
    reconcile();
    const interval = setInterval(() => {
      if (!stopped) reconcile();
    }, reconcileMs);
    const auditInterval = setInterval(() => {
      if (stopped) return;
      for (const cwd of watched.keys()) void audit(cwd);
    }, auditMs);
    return () => {
      stopped = true;
      clearInterval(interval);
      clearInterval(auditInterval);
      for (const entry of watched.values()) {
        entry.unwatch();
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
      }
      watched.clear();
    };
  }
  return { start, reconcile, poke, audit };
}

// src/host/index.ts
var name = "taskboard-kit";
var inject = ["tools", "sessions"];
function pluginNotice(uuid, text, summary) {
  return {
    role: "user",
    id: uuid,
    content: [{ type: "text", text }],
    source: { kind: "plugin:taskboard-kit", form: "notice", summary: summary.slice(0, 120) }
  };
}
function selfActor() {
  return process.env.TASKBOARD_ACTOR?.trim() || process.env.TASKBOARD_WATCH_NAMES?.split(",")[0]?.trim() || "dsh-agent";
}
function protocolText() {
  return L(
    [
      "## \u4EFB\u52A1\u770B\u677F\uFF08\u591A Agent \u534F\u4F5C\uFF0C\u5FC5\u8BFB\uFF09",
      "\u672C workspace \u6709\u4E00\u5757\u5171\u4EAB\u4EFB\u52A1\u770B\u677F\uFF1B\u4EBA\u7C7B\u5728\u300C\u770B\u677F\u300D\u9875\u7B7E\u770B\u7684\u662F\u540C\u4E00\u5757\u677F\uFF0C\u552F\u4E00\u771F\u5B9E\u6765\u6E90\u662F `.dsh/taskboard.json`\u3002",
      "\u4E00\u5207\u64CD\u4F5C\u8D70 taskboard_* \u5DE5\u5177\uFF08\u6CA1\u6709\u63D2\u4EF6\u7684 Agent \u8D70 `bin/taskboard.mjs` CLI\uFF09\uFF0C**\u6C38\u8FDC\u4E0D\u8981\u624B\u6539 JSON**\u3002",
      "\uFF08\u5B8C\u6574\u89C4\u8303\uFF1A\u672C\u63D2\u4EF6 `docs/COLLABORATION.md`\uFF1B\u4E0B\u9762\u662F\u5FC5\u987B\u9075\u5B88\u7684\u90A3\u90E8\u5206\u3002\uFF09",
      "",
      "### \u4F1A\u8BDD\u5F00\u59CB\u5148\u770B\u81EA\u5DF1\u90A3\u4E00\u4EFD",
      "- `taskboard_inbox` \u2014\u2014 \u73B0\u5728\u538B\u5728\u4F60\u8EAB\u4E0A\u7684\u4E8B\uFF0C\u6309\u6025\u8FEB\u5EA6\u6392\u597D\uFF0C\u6BCF\u6761\u90FD\u5E26\u8BE5\u6572\u7684\u547D\u4EE4\u3002**\u8FD9\u662F\u7B2C\u4E00\u6B65**\u3002",
      "- \u9700\u8981\u7EC6\u8282\u7528 `taskboard_get <id>`\uFF08\u65F6\u95F4\u7EBF + \u7559\u8A00\uFF09\uFF1B\u4E0D\u719F\u8FD9\u5757\u677F\u5148 `taskboard_roster`\uFF08\u8C01\u8FD8\u5728\u573A\uFF09\u3002",
      "",
      "### \u72B6\u6001\u600E\u4E48\u8D70\uFF1A**\u53EA\u6709 closed \u662F\u7EC8\u70B9**",
      "- \u6B63\u5E38\u8DEF\u5F84\uFF1A`open \u2192 in_progress \u2192 review \u2192 done`\uFF0C\u518D\u7531\u5361\u4E3B / PO \u6536\u53E3 `close`\u3002",
      "- `done` = \u5E72\u5B8C\u4E14\u5BA1\u6838\u901A\u8FC7\uFF0C**\u4F46\u8FD8\u6CA1\u7ED3\u6E05**\uFF1A\u5361\u4ECD\u5728\u770B\u677F\u4E0A\uFF0C\u4ECD\u8BA1\u5165\u300C\u672A\u7ED3\u6E05\u300D\u3002",
      "  \u5BA1\u6838\u901A\u8FC7 \u2260 \u8FD9\u4EF6\u4E8B\u4E86\u4E86\uFF08\u53EF\u80FD\u8FD8\u8981\u90E8\u7F72\u3001\u7B49\u4E0A\u6E38\u3001\u8865\u6587\u6863\uFF09\uFF0C\u6240\u4EE5 done \u4E4B\u540E\u5FC5\u987B\u6709\u4EBA\u6536\u53E3\u3002",
      "- `close` = \u7ED3\u6E05\u3002**\u8FD9\u662F\u552F\u4E00\u7684\u7EC8\u6001**\uFF0C\u7ED3\u6E05\u540E\u5361\u4E0D\u518D\u51FA\u73B0\u5728\u6D3B\u8DC3\u8BA1\u6570\u91CC\u3002",
      '- \u771F\u8981"\u8FD9\u4E8B\u4E0D\u505A\u4E86"\u4E5F\u7528 close\uFF0C\u4F46**\u5FC5\u987B\u5728 note / comment \u91CC\u5199\u6E05\u4E3A\u4EC0\u4E48\u4E0D\u505A** \u2014\u2014',
      '  \u5426\u5219\u6CA1\u4EBA\u5206\u5F97\u6E05"\u505A\u5B8C\u4E86\u6536\u53E3"\u548C"\u653E\u5F03\u4E86"\u3002',
      "- `reopen` \u53EF\u4EE5\u4ECE done \u6216 closed \u56DE\u5230 open\uFF08\u7ED3\u6E05\u9519\u4E86\u5C31\u9000\u56DE\u6765\uFF09\u3002",
      "",
      "### \u52A8\u624B\u4E4B\u524D\u5148\u5360\u4F4D\uFF08\u5426\u5219\u4E24\u4E2A Agent \u4F1A\u649E\u8F66\uFF09",
      "- \u6C60\u91CC\u7684\u5361\u7528 `taskboard_claim`\uFF08\u539F\u5B50\uFF1B\u51B2\u7A81 = \u522B\u4EBA\u62A2\u5230\u4E86\uFF0C\u6362\u4E00\u5F20\uFF0C\u522B\u786C\u505A\uFF09\u3002",
      "- \u6307\u6D3E\u7ED9\u4F60\u7684\u5361\u7528 `taskboard_update`\uFF08action=start\uFF09\u3002\u6CA1\u5360\u4F4D\u5C31\u4E0D\u5F00\u5DE5\u3002",
      "",
      "### \u505A\u5B8C\u4EA4\u5BA1\u6838\uFF0C\u4E0D\u8981\u81EA\u5DF1 done",
      "- `taskboard_update`\uFF08action=submit, reviewer=<\u540D\u5B57>\uFF09\uFF0C\u5E76\u7528 `taskboard_comment` \u5199\u6E05\uFF1A\u505A\u4E86\u4EC0\u4E48\u3001\u9A8C\u8BC1\u4E86\u4EC0\u4E48\u3001\u8FD8\u5DEE\u4EC0\u4E48\u3002",
      "  \u6CA1\u6709\u4EA4\u63A5\u7559\u8A00\u7684\u63D0\u4EA4\uFF0C\u5BA1\u6838\u4EBA\u65E0\u6CD5\u9A8C\u6536\u3002",
      "- \u53EA\u6709 reviewer \u672C\u4EBA\u3001\u5361\u4E3B\u3001\u4EBA\u7C7B\u53EF\u4EE5\u88C1\u51B3\uFF1B**\u4E0D\u80FD\u5BA1\u81EA\u5DF1\u7684\u6D3B**\uFF08\u677F\u5B50\u4F1A\u62D2\uFF09\u3002",
      '- \u901A\u8FC7\u7528 `--action approve`\uFF1B\u6253\u56DE\u7528 `--action reject --note "\u539F\u56E0"`\uFF08\u5FC5\u987B\u5199\u539F\u56E0\uFF09\uFF0C\u5361\u56DE\u5230\u4F5C\u8005\u624B\u4E0A\uFF0C\u6539\u5B8C\u518D submit\u3002',
      "",
      "### \u5361\u4F4F\u4E86\uFF1A\u8BF4\u6E05\u5728\u7B49\u8C01\uFF08action=block / unblock\uFF09",
      '- \u7B49\u4EBA\u7C7B\u51B3\u5B9A\uFF1A`--action block --on human --question "\u4E00\u53E5\u80FD\u76F4\u63A5\u8F6C\u53D1\u7ED9\u6211\u4E3B\u4EBA\u7684\u95EE\u53E5"`\u3002',
      "  \u5B83\u4F1A\u8FDB\u300C\u7B49\u4EBA\u7C7B\u300D\u6E05\u5355\uFF0C\u4EBA\u7C7B\u5728\u9762\u677F\u9876\u90E8\u5C31\u80FD\u770B\u5230\u5E76\u5F53\u573A\u56DE\u590D\uFF1B**\u540C\u65F6\u4F60\u6709\u8D23\u4EFB\u4E3B\u52A8\u53EB\u4EBA**",
      "  \uFF08\u7528\u4F60\u81EA\u5DF1\u7684\u901A\u77E5\u901A\u9053\uFF1Amsg9 / \u684C\u9762\u901A\u77E5 / webhook / \u90AE\u4EF6\uFF0C\u6216\u8BA9\u8FD0\u7EF4\u914D `TASKBOARD_NOTIFY_CMD`\uFF09\u3002",
      '- \u7B49\u53E6\u4E00\u4E2A Agent\uFF1A`--action block --on agent --who <\u540D\u5B57> --question "..."`\u3002',
      "- \u5BF9\u65B9\u7B54\u590D\u540E\u7528 `--action unblock`\uFF08\u7B54\u590D\u5199\u8FDB comment\uFF09\uFF0C\u7136\u540E\u63A5\u7740\u5E72\u3002",
      "- \u7B49\u8C01\u7684\u5361**\u4E0D\u80FD\u88AB\u8BA4\u9886**\uFF1A\u5728\u7B49\u51B3\u5B9A \u2260 \u6CA1\u4EBA\u8981\u3002",
      "",
      "### \u8DDF\u8FDB\u8981\u53CA\u65F6\uFF08\u8FD9\u5757\u677F\u6700\u5BB9\u6613\u70C2\u7684\u5730\u65B9\uFF09",
      "- \u72B6\u6001\u4E00\u53D8\u5C31\u66F4\u65B0\uFF1A\u5F00\u5DE5 start\u3001\u5361\u4F4F block\u3001\u5E72\u5B8C submit\u3001\u5BA1\u6838\u8FC7\u540E\u6536\u53E3 close\u3002\u522B\u8BA9\u5361\u505C\u5728\u65E7\u72B6\u6001\u91CC\u3002",
      "- \u8FDB\u5C55\u5373\u65F6\u7528 `--note`\uFF1B\u53D1\u73B0 / \u4EA4\u63A5 / \u6D4B\u8BD5\u53CD\u9988\u7528 `taskboard_comment`\uFF08\u4E0D\u6539\u72B6\u6001\uFF09\u3002",
      "- \u770B\u677F\u4F1A**\u81EA\u68C0\u5E76\u4E3B\u52A8\u63A8\u7ED9\u4F60**\uFF1A\u4F60\u7684\u5361\u9648\u65E7\u4E86\uFF08review \u8D85 24h / in_progress \u8D85 72h / \u6307\u6D3E\u672A\u5F00\u5DE5\u8D85 48h\uFF09\u3001",
      "  \u88AB\u6253\u56DE\u540E\u518D\u65E0\u52A8\u9759\u3001\u4F60\u6D3E\u51FA\u53BB\u7684\u6D3B\u63A5\u7684\u4EBA\u4E45\u672A\u51FA\u73B0 \u2014\u2014 \u81EA\u68C0\u4F1A\u70B9\u540D\uFF0C\u5E76\u7ED9\u51FA\u8BE5\u6572\u7684\u547D\u4EE4\u3002",
      "",
      "### \u80FD\u81EA\u5DF1\u63A8\u8FDB\u7684\uFF0C\u4E0D\u8981\u7B49\u4EBA",
      "- \u6C60\u5B50\u91CC\u7684\u6D3B\u81EA\u5DF1\u8BA4\u9886\uFF1B\u80FD\u81EA\u6D4B\u7684\u81EA\u5DF1\u6D4B\uFF1B\u53D1\u73B0\u5361\u6D3E\u7ED9\u4E86\u4E0D\u5728\u573A\u7684 Agent\uFF0C**\u6539\u6D3E\u662F\u4F60\u7684\u8D23\u4EFB**\u3002",
      "- \u53EA\u6709\u771F\u9700\u8981\u4EBA\u7C7B\u62CD\u677F\uFF08\u5BF9\u5916\u52A8\u4F5C\u3001\u8D44\u6E90\u3001\u65B9\u5411\u53D6\u820D\uFF09\u624D block --on human\uFF0C\u95EE\u53E5\u8981\u5177\u4F53\u5230\u80FD\u4E00\u53E5\u8BDD\u56DE\u7B54\u3002",
      "- \u7B49\u4EBA\u7C7B\u8D85\u8FC7 24h \u4F1A\u88AB\u5347\u7EA7\u50AC\u529E\uFF08\u9762\u677F + \u53EF\u9009\u5916\u53D1\u901A\u77E5\uFF09\uFF0C\u522B\u8BA9\u5361\u70C2\u5728\u81EA\u5DF1\u624B\u91CC\u3002",
      "",
      "### \u53D8\u5316\u4F1A\u81EA\u52A8\u63A8\u7ED9\u4F60\uFF0C\u65E0\u9700\u8F6E\u8BE2",
      "- \u6307\u6D3E\u7ED9\u4F60\u3001\u5BA1\u6838\u7ED3\u8BBA\u3001\u65B0\u7559\u8A00\u3001\u6709\u4EBA\u628A\u5BA1\u6838 hand off \u7ED9\u4F60\u3001\u6709\u4EBA\u5F00\u59CB\u7B49\u4F60 \u2014\u2014 \u90FD\u4F1A\u6CE8\u5165 context\u3002\u6536\u5230\u5C31\u5904\u7406\u3002"
    ].join("\n"),
    [
      "## Task board (multi-agent collaboration, required reading)",
      "This workspace has a shared task board; the human watches the SAME board in the kanban tab. Its only source of",
      "truth is `.dsh/taskboard.json`. Drive it with the taskboard_* tools (agents without the plugin use the",
      "`bin/taskboard.mjs` CLI) \u2014 **never edit the JSON by hand**.",
      "(Full spec: the plugin's `docs/COLLABORATION.md`; the rules below are the part you must follow.)",
      "",
      "### Start every session with your own slice",
      "- `taskboard_inbox` \u2014 what is on YOU right now, most urgent first, each item with the command that moves it. **Do this first.**",
      "- `taskboard_get <id>` for detail (timeline + comments); `taskboard_roster` to see who is actually around.",
      "",
      "### The status model: **only `closed` is terminal**",
      "- Normal path: `open \u2192 in_progress \u2192 review \u2192 done`, then an owner/PO settles it with `close`.",
      "- `done` = work finished and approved, **but NOT settled**: the card stays on the board and still counts as",
      "  open work. Approval is not the same as the matter being closed out (deploys, upstream sign-off, docs may",
      "  still follow), so a `done` card still needs someone to close it.",
      "- `close` = settled. **This is the ONE terminal status**; a settled card leaves the active counts.",
      '- "We are not doing this after all" is also a `close`, but you **must say why** in the note/comment \u2014 otherwise',
      '  nobody can tell "finished and settled" from "abandoned".',
      "- `reopen` takes a card from `done` or `closed` back to `open` (settled by mistake? undo it).",
      "",
      "### Take ownership before working (otherwise two agents collide)",
      "- Pool task \u2192 `taskboard_claim` (atomic; a conflict means someone got there first \u2014 pick another).",
      "- Task assigned to you \u2192 `taskboard_update` (action=start). Never start work without claiming it.",
      "",
      "### Hand off for review instead of marking it done yourself",
      "- `taskboard_update` (action=submit, reviewer=<name>) plus a `taskboard_comment` saying what you did, what you",
      "  verified, and what is still open. A submission without a handoff note cannot be reviewed.",
      "- Only the named reviewer, the task creator or the human can decide; **you cannot review your own work** (the board refuses).",
      '- `--action approve` to pass; `--action reject --note "why"` to send it back (a reason is mandatory).',
      "",
      "### Stuck? Say who you are waiting on (action=block / unblock)",
      '- Waiting on a human: `--action block --on human --question "a one-liner that can be forwarded as-is"`.',
      "  It lands in the\u300Cwaiting on you\u300Dlist the human sees at the top of the panel \u2014 and **it is your job to ping them**",
      "  (via whatever channel you have: msg9 / a desktop notification / a webhook / mail, or `TASKBOARD_NOTIFY_CMD`).",
      '- Waiting on another agent: `--action block --on agent --who <name> --question "..."`.',
      "- When the answer lands: `--action unblock` (put the answer in a comment), then carry on.",
      "- A card waiting on someone **cannot be claimed**: parked \u2260 unowned.",
      "",
      "### Keep the board current (this is where boards rot)",
      "- Update on every state change: start, block, submit, and close once approved. Never leave a card stale.",
      "- Progress notes with `--note`; findings / handoffs / test feedback with `taskboard_comment` (state untouched).",
      "- The board **self-audits and pushes to you**: your cards going stale (review > 24h, in_progress > 72h,",
      "  assigned-but-unstarted > 48h), a rejection you never answered, work you delegated to an actor that went",
      "  quiet \u2014 all named in the audit, with the command to run.",
      "",
      "### Advance what you can without a human",
      "- Claim from the pool; verify your own work; if a card sits with an actor that is not around, **reassigning it is your job**.",
      "- Only park on a human for real decisions (external actions, resources, direction) \u2014 and ask a one-line question.",
      "- A human wait over 24h escalates (panel + optional out-of-band notify); do not let a card rot in your hands.",
      "",
      "### Changes are pushed to you \u2014 no polling",
      "- Assignments, verdicts, new comments, a review handed to you, someone starting to wait on you \u2014 all injected as context."
    ].join("\n")
  );
}
function apply(ctx) {
  const log = ctx.logger("taskboard-kit");
  log.info("taskboard-kit loaded");
  registerTaskboardTools(ctx);
  log.info("taskboard tools registered (inbox, list, create, claim, update, comment, get, roster)");
  const bridge = createTaskboardBridge(defaultBridgeDeps(ctx));
  ctx.inject(["webServer"], (child) => {
    const server = child.webServer;
    if (!server) return;
    child.effect(() => server.register({
      kind: "prefix",
      path: BRIDGE_PREFIX,
      handler: (req, res) => void bridge.handle(
        req,
        res
      )
    }), "taskboard-kit: browser bridge");
    log.info(`taskboard browser bridge mounted at ${BRIDGE_PREFIX}`);
  });
  ctx.inject(["systemPrompt"], (child) => {
    const systemPrompt = child.systemPrompt;
    if (!systemPrompt) return;
    systemPrompt.section({ name: "taskboard:rules", order: 5e3, text: protocolText() });
    log.info("taskboard collaboration protocol added to the system prompt");
  });
  ctx.on("agent/session-start", (payload) => {
    const { agent } = payload;
    void (async () => {
      const cwd = resolveCwd(ctx, { agent: agent.id });
      const actor = selfActor();
      const items = await inbox(cwd, actor, { poolLimit: 3 });
      if (items.length === 0) return;
      const head = L(
        "\u672C workspace \u7684\u4EFB\u52A1\u770B\u677F\u4E0A\u6709 {count} \u4EF6\u4E8B\u538B\u7740\u4F60\uFF08{actor}\uFF09\u2014\u2014\u7528 taskboard_inbox \u770B\u5168\uFF08\u6BCF\u6761\u90FD\u5E26\u8BE5\u6572\u7684\u547D\u4EE4\uFF09\uFF1A",
        "This workspace's task board has {count} item(s) on you ({actor}) \u2014 taskboard_inbox has them all, each with the command to run:",
        { count: items.length, actor }
      );
      const lines = items.slice(0, 5).map((item) => `\xB7 ${item.task.id} ${item.task.title} \u2014 ${item.suggest}`);
      const more = items.length > 5 ? L("\n\u2026\u8FD8\u6709 {rest} \u6761", "\n\u2026and {rest} more", { rest: items.length - 5 }) : "";
      agent.inject(pluginNotice(
        randomUUID2(),
        `${head}
${lines.join("\n")}${more}`,
        `taskboard: ${items.length} item(s) on you`
      ));
    })().catch((error) => log.info(`session-start board notice failed: ${error?.message ?? String(error)}`));
  });
  ctx.inject(["agents"], (child) => {
    const agents = child.agents;
    if (!agents) return;
    if (process.env.TASKBOARD_WATCH === "0") return;
    const watcher = createBoardWatcher({
      loadBoard,
      resolveAgents: () => agents.list().map((agent) => ({ id: agent.id, cwd: cwdOfAgentSession(child, agent.id) })),
      injectNotice: (agentId, text) => {
        const agent = agents.get(agentId);
        agent?.inject(pluginNotice(randomUUID2(), text, text.split("\n")[1] ?? "board change"));
      },
      // A card parked on the human past its wait SLA: push it out-of-band (via
      // the hook the operator wired) and tell the agents to chase it.
      onHumanWaitOverdue: (escalation) => {
        const { task, question, waitedMs } = escalation;
        void notifyHuman(
          { cwd: escalation.cwd, task, question, reason: "overdue", waitingBy: task.assignee ?? "", waitedMs },
          { log: (message) => log.info(message) }
        ).then((result) => {
          if (!result.delivered) log.info(`human wait overdue on ${task.id} (no TASKBOARD_NOTIFY_CMD wired; panel only)`);
        });
        const text = L(
          "[\u770B\u677F\u50AC\u529E] {id} \u5DF2\u7ECF\u7B49\u5728\u4EBA\u7C7B\u8EAB\u4E0A {age} \u4E86\uFF1A\u300C{question}\u300D\n\u518D\u53EB\u4E00\u6B21\u4EBA\uFF08\u4F60\u7684\u901A\u77E5\u901A\u9053\uFF1Amsg9 / \u684C\u9762\u901A\u77E5 / webhook\uFF09\uFF1B\u6216\u8005\u628A\u4E0D\u4F9D\u8D56\u4ED6\u7684\u90E8\u5206\u62C6\u51FA\u6765\u5148\u505A\u6389\uFF08\u4E0D\u8981\u7A7A\u7B49\uFF09\u3002",
          '[board escalation] {id} has been waiting on the human for {age}: "{question}"\nPing them again via your notify channel (msg9 / desktop notification / webhook), or split off the part you can advance (do not idle on it).',
          { id: task.id, age: ageLabel(waitedMs), question }
        );
        for (const agent of agents.list()) {
          if (cwdOfAgentSession(child, agent.id) !== escalation.cwd) continue;
          try {
            agent.inject(pluginNotice(randomUUID2(), text, `taskboard: ${task.id} waiting on the human`));
          } catch (error) {
            log.info(`escalation injection failed for ${agent.id}: ${error?.message ?? String(error)}`);
          }
        }
      },
      log: (message) => log.info(message)
    });
    child.effect(() => watcher.start(), "taskboard-kit: board watcher");
    log.info("taskboard board watcher started (fs.watch + periodic self-audit)");
  });
}
function cwdOfAgentSession(ctx, agentId) {
  try {
    const sessions = ctx.sessions;
    return sessions?.get(agentId)?.header?.cwd;
  } catch {
    return void 0;
  }
}
export {
  BRIDGE_PREFIX,
  DEFAULT_COLUMN_SLA_MS,
  DEFAULT_QUIET_MS,
  DEFAULT_WAIT_SLA_MS,
  HUMAN_ACTOR,
  L,
  StoreError,
  TASK_VALUES,
  actorAliasGroups,
  actorKey,
  actorKeyOf,
  actorNames,
  actorNamesOf,
  actorSeenAt,
  addComment,
  ageInColumnMs,
  ageLabel,
  apply,
  assigneeIsGone,
  boardFilePath,
  boardHealth,
  canonicalActor,
  claimTask,
  columnAgeMs,
  columnSince,
  compareByValue,
  createBoardWatcher,
  createTask,
  createTaskboardBridge,
  defaultBridgeDeps,
  diffBoards,
  enableBoard,
  formatGet,
  formatInbox,
  getTask,
  health,
  humanNames,
  inbox,
  inboxFor,
  inject,
  isStale,
  isTrustedRequest,
  listTasks,
  loadBoard,
  marksOf,
  msg9HookExample,
  name,
  noticePayload,
  notifyHookExample,
  notifyHuman,
  parseAliasConfig,
  parseWatchNames,
  resolveActor,
  resolveCwd,
  roster,
  sameActor,
  saveBoard,
  stalenessOf,
  taskStaleness,
  updateTask,
  waitingOnHuman,
  withBoardLock
};
