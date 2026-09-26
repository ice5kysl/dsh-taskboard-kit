// src/host/index.ts
import { randomUUID } from "node:crypto";

// src/host/http.ts
import { existsSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/shared/bridge.ts
var BRIDGE_PREFIX = "/dsh-taskboard";
var MUTATE_HEADER = "x-taskboard";
var MUTATE_HEADER_VALUE = "mutate";

// src/host/store.ts
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// src/shared/types.ts
var TASK_VALUES = [0.5, 1, 2, 3, 5, 8];
function columnOf(task) {
  if (task.status === "open") return task.assignee ? "assigned" : "pool";
  return task.status;
}
function emptyBoard(workspace) {
  return { version: 1, workspace, next_seq: 1, tasks: {} };
}
var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
function compareTasks(a, b) {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
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
async function loadBoard(cwd) {
  const file = boardFilePath(cwd);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyBoard(resolve(cwd));
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}`;
    await writeFile(backup, raw, { mode: 384 }).catch(() => {
    });
    throw new StoreError(
      "internal",
      `taskboard file is not valid JSON (a copy was kept at ${backup}): ${error.message}`
    );
  }
  if (!parsed || parsed.version !== 1) {
    throw new StoreError("internal", `unsupported taskboard version in ${file} (expected 1)`);
  }
  for (const task of Object.values(parsed.tasks ?? {})) {
    if (!Array.isArray(task.comments)) task.comments = [];
    if (task.value === void 0) task.value = null;
    if (task.status === "cancelled") task.status = "closed";
    for (const entry of task.log ?? []) {
      if (entry.event === "cancelled") entry.event = "closed";
    }
  }
  return parsed;
}
var tempCounter = 0;
async function saveBoard(cwd, board) {
  const file = boardFilePath(cwd);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${tempCounter += 1}`;
  await writeFile(temp, `${JSON.stringify(board, null, 2)}
`, { mode: 384 });
  await rename(temp, file);
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
async function acquireBoardLock(cwd) {
  const lockPath = `${boardFilePath(cwd)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 384);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      await handle?.close().catch(() => {
      });
      if (error.code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        throw new StoreError(
          "internal",
          `taskboard is locked by another process (${lockPath}); still busy after ~${LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS / 1e3}s`
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
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
  const raw = await readFile(lockPath, "utf8").catch(() => "");
  let pid = NaN;
  try {
    pid = Number(JSON.parse(raw).pid);
  } catch {
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}
var PRIORITIES = ["high", "medium", "low"];
var STATUSES = ["open", "in_progress", "review", "done", "closed"];
var ACTIONS = ["start", "stop", "submit", "approve", "reject", "done", "close", "reopen", "cancel"];
function requireId(id) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new StoreError("invalid-input", "task id is required");
  }
  return id.trim();
}
function requireTitle(title) {
  if (typeof title !== "string" || title.trim() === "") {
    throw new StoreError("invalid-input", "title is required and must be a non-empty string");
  }
  return title.trim();
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
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))];
}
function parseDetail(detail) {
  if (detail === void 0) return void 0;
  if (typeof detail !== "string") throw new StoreError("invalid-input", "detail must be a string");
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
  const task = board.tasks[id];
  if (!task) throw new StoreError("not-found", `no such task: ${id}`);
  return task;
}
function logEntry(at, by, event) {
  return { at, by, event };
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
    const id = `T-${board.next_seq}`;
    board.next_seq += 1;
    const log = [logEntry(now, by, "created")];
    if (assignee) log.push(logEntry(now, by, "assigned"));
    const task = {
      id,
      title,
      detail,
      status: "open",
      assignee,
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
    await saveBoard(cwd, board);
    return task;
  });
}
async function claimTask(cwd, id, by) {
  const taskId = requireId(id);
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd);
    const task = mustTask(board, taskId);
    if (task.status !== "open" || task.assignee) {
      const held = task.assignee ? ` (held by ${task.assignee})` : "";
      throw new StoreError("conflict", `${taskId} cannot be claimed: status is ${task.status}${held}`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    task.status = "in_progress";
    task.assignee = by;
    task.updated_at = now;
    task.log.push(logEntry(now, by, "claimed"));
    await saveBoard(cwd, board);
    return task;
  });
}
async function updateTask(cwd, id, patch, by) {
  const taskId = requireId(id);
  const action = parseAction(patch?.action);
  const assignee = parseAssignee(patch?.assignee);
  const title = patch?.title === void 0 ? void 0 : requireTitle(patch.title);
  const detail = parseDetail(patch?.detail);
  const priority = parsePriority(patch?.priority);
  const value = parseValue(patch?.value);
  const tags = parseTags(patch?.tags);
  const note = typeof patch?.note === "string" && patch.note.trim() !== "" ? patch.note.trim() : void 0;
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd);
    const task = mustTask(board, taskId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const events = [];
    if (action) {
      const transition = transitionOf(task, action);
      task.status = transition.to;
      events.push(transition.event);
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
  const body = text.trim();
  return withBoardLock(cwd, async () => {
    const board = await loadBoard(cwd);
    const task = mustTask(board, taskId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    task.comments.push({ at: now, by, text: body });
    task.updated_at = now;
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
  const board = await loadBoard(cwd);
  return Object.values(board.tasks).filter((task) => {
    if (filter?.status && task.status !== filter.status) return false;
    if (filter?.assignee === "none" && task.assignee !== null) return false;
    if (filter?.assignee !== void 0 && filter.assignee !== "none" && task.assignee !== filter.assignee) return false;
    return true;
  }).sort(compareTasks);
}

// src/host/http.ts
var HUMAN_ACTOR = "human";
function cliPath() {
  try {
    return join2(dirname2(fileURLToPath(import.meta.url)), "..", "bin", "taskboard.mjs");
  } catch {
    return null;
  }
}
function defaultBridgeDeps(ctx) {
  return {
    loadBoard,
    createTask,
    claimTask,
    updateTask,
    addComment,
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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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
  const host = hostnameOf(req.headers.host);
  if (!host) return false;
  const origin = req.headers.origin;
  if (origin) return isSameOrigin(origin, req.headers.host ?? "");
  const remote = req.socket?.remoteAddress;
  if (remote && !isLoopbackAddress(remote)) return false;
  return isLoopbackHostname(host);
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
function requireCwd(body) {
  const cwd = str(body.cwd);
  if (!cwd) throw new BridgeError(400, "invalid-input", 'field "cwd" is required');
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
function createTaskboardBridge(deps) {
  async function route(req, res, url) {
    const path = url.pathname.replace(/\/+$/, "") || BRIDGE_PREFIX;
    const method = req.method ?? "GET";
    if (method === "GET" && path === `${BRIDGE_PREFIX}/board`) {
      const cwd = str(url.searchParams.get("cwd"));
      if (!cwd) throw new BridgeError(400, "invalid-input", 'query parameter "cwd" is required');
      try {
        const cli = cliPath();
        return sendJson(res, 200, {
          ok: true,
          board: await deps.loadBoard(cwd),
          cli: cli && existsSync(cli) ? cli : null,
          board_file: boardFilePath(cwd)
        });
      } catch (error) {
        if (error instanceof StoreError) {
          return fail(res, error.code === "internal" ? 500 : 200, error.code, error.message);
        }
        throw error;
      }
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/create`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(body);
      const request = body;
      return runDomain(res, () => deps.createTask(cwd, {
        title: request.title,
        ...request.detail !== void 0 ? { detail: request.detail } : {},
        ...request.assignee !== void 0 ? { assignee: request.assignee } : {},
        ...request.priority !== void 0 ? { priority: request.priority } : {},
        ...request.value !== void 0 ? { value: request.value } : {},
        ...request.tags !== void 0 ? { tags: request.tags } : {}
      }, HUMAN_ACTOR));
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/claim`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(body);
      const request = body;
      return runDomain(res, () => deps.claimTask(cwd, request.id, HUMAN_ACTOR));
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/update`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(body);
      const request = body;
      return runDomain(res, async () => (await deps.updateTask(cwd, request.id, {
        ...request.action !== void 0 ? { action: request.action } : {},
        ...request.assignee !== void 0 ? { assignee: request.assignee } : {},
        ...request.title !== void 0 ? { title: request.title } : {},
        ...request.detail !== void 0 ? { detail: request.detail } : {},
        ...request.priority !== void 0 ? { priority: request.priority } : {},
        ...request.value !== void 0 ? { value: request.value } : {},
        ...request.tags !== void 0 ? { tags: request.tags } : {},
        ...request.note !== void 0 ? { note: request.note } : {}
      }, HUMAN_ACTOR)).task);
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/comment`) {
      requireMutateHeader(req);
      const body = await readJsonBody(req);
      const cwd = requireCwd(body);
      const request = body;
      return runDomain(res, () => deps.addComment(cwd, request.id, request.text, HUMAN_ACTOR));
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
        return fail(res, 500, "internal", message);
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
function summaryLine(task) {
  return `${task.id} \xB7 ${task.status} \xB7 ${whoLabel(task.assignee)} \xB7 ${task.priority}${valueLabel(task)} \xB7 ${task.title}`;
}
function formatGet(task) {
  const lines = [
    `${task.id} \xB7 ${task.status} \xB7 ${task.priority}${valueLabel(task)}`,
    task.title,
    L("\u8D1F\u8D23\u4EBA\uFF1A{who} \xB7 \u521B\u5EFA\uFF1A{creator} {created} \xB7 \u66F4\u65B0\uFF1A{updated}", "assignee: {who} \xB7 created by {creator} {created} \xB7 updated {updated}", {
      who: whoLabel(task.assignee),
      creator: task.created_by,
      created: task.created_at,
      updated: task.updated_at
    })
  ];
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
function registerTaskboardTools(ctx) {
  ctx.tools.register(defineTool({
    name: "taskboard_list",
    description: "List tasks on this workspace's shared task board (the same board the human sees in the kanban tab). Call it at session start to see what is claimable, delegated to you, in progress, or awaiting review. One summary line per task; use taskboard_get for a task's full detail and timeline.",
    parameters: {
      status: { type: "string", enum: ["open", "in_progress", "review", "done", "closed"], description: "Keep only this status." },
      column: { type: "string", enum: ["pool", "assigned", "in_progress", "review", "done", "closed"], description: "Keep only this kanban column (pool = open and unassigned, i.e. claimable; review = submitted, awaiting approval)." },
      assignee: { type: "string", description: 'Keep only tasks owned by this actor; pass "none" for unassigned (claimable) tasks.' }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        const all = await listTasks(cwd);
        const listed = all.filter((task) => {
          if (args.status && task.status !== args.status) return false;
          if (args.column && columnOf(task) !== args.column) return false;
          if (args.assignee === "none") return task.assignee === null;
          if (args.assignee !== void 0 && task.assignee !== args.assignee) return false;
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
        if (listed.length === 0) {
          const empty = all.length === 0 ? L("\u770B\u677F\u662F\u7A7A\u7684\u2014\u2014\u7528 taskboard_create \u5EFA\u7B2C\u4E00\u4E2A\u4EFB\u52A1\u3002", "The board is empty \u2014 use taskboard_create to add the first task.") : L("\u6CA1\u6709\u5339\u914D\u7684\u4EFB\u52A1\uFF08\u653E\u5BBD\u8FC7\u6EE4\u6761\u4EF6\u8BD5\u8BD5\uFF09\u3002", "No tasks match these filters (try loosening them).");
          return `${empty}
${totals}`;
        }
        const head = L("{count} \u6761\u4EFB\u52A1\uFF1A", "{count} task(s):", { count: listed.length });
        return `${head}
${listed.map(summaryLine).join("\n")}
${totals}`;
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_create",
    description: "Create a task on this workspace's shared task board. Omit assignee to put it in the claimable pool (anyone \u2014 you, a sibling agent, or the human \u2014 can then taskboard_claim it); set assignee to delegate it. Returns the allocated id (T-<n>).",
    parameters: {
      title: { type: "string", required: true, description: "One-line task title." },
      detail: { type: "string", description: "Markdown body with the full context (rendered as plain text in the panel)." },
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
    description: "Atomically claim a pool task for yourself: succeeds only while it is open AND unassigned, then it is yours and in_progress. ALWAYS claim before starting work on a pool task \u2014 if the claim conflicts, someone else got there first; pick another task instead of working in parallel by accident.",
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
          "\u5DF2\u8BA4\u9886 {id}\uFF08in_progress \xB7 {by}\uFF09\uFF1A{title}\n\u5B8C\u6210\u540E\u7528 taskboard_update\uFF08action=done\uFF09\u6536\u5C3E\u3002",
          "Claimed {id} (in_progress \xB7 {by}): {title}\nClose it with taskboard_update (action=done) when finished.",
          { id: task.id, by: actor, title: task.title }
        );
      } catch (error) {
        if (error instanceof StoreError && error.code === "conflict") {
          const task = await getTask(cwd, args.id).catch(() => void 0);
          if (task) {
            return L(
              "{id} \u8BA4\u9886\u5931\u8D25\uFF1A\u73B0\u5728\u7531 {who} \u6301\u6709\uFF0C\u72B6\u6001 {status}\u3002\u7528 taskboard_list \u6311\u522B\u7684\u5F85\u8BA4\u9886\u4EFB\u52A1\uFF0C\u6216\u5411\u4EBA\u7C7B\u8BF7\u793A\u3002",
              "Cannot claim {id}: now held by {who}, status {status}. Pick another pool task via taskboard_list, or ask the human.",
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
    description: "Update a task you own: move it through its lifecycle (action start/stop/submit/approve/reject/done/close/reopen), reassign it, edit title/detail/priority/value/tags, and attach a note to the log entry. Report progress as you go \u2014 the human watches the same board in the kanban tab. To leave information without changing state, use taskboard_comment instead.",
    parameters: {
      id: { type: "string", required: true, description: "Task id, e.g. T-1." },
      action: { type: "string", enum: ["start", "stop", "submit", "approve", "reject", "done", "close", "reopen", "cancel"], description: "start: open\u2192in_progress; stop: in_progress\u2192open; submit: in_progress\u2192review (hand to a reviewer); approve: review\u2192done; reject: review\u2192in_progress (send back); done: open|in_progress|review\u2192done; close: open|in_progress|review|done\u2192closed (cancel is its legacy alias); reopen: done|closed\u2192open." },
      assignee: { oneOf: [{ type: "string" }, { type: "null" }], description: "New owner while open/in_progress; null unassigns back to the pool." },
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
        const { task, events } = await updateTask(cwd, args.id, {
          ...args.action !== void 0 ? { action: args.action } : {},
          ...args.assignee !== void 0 ? { assignee: args.assignee } : {},
          ...args.title !== void 0 ? { title: args.title } : {},
          ...args.detail !== void 0 ? { detail: args.detail } : {},
          ...args.priority !== void 0 ? { priority: args.priority } : {},
          ...args.value !== void 0 ? { value: args.value } : {},
          ...args.tags !== void 0 ? { tags: args.tags } : {},
          ...args.note !== void 0 ? { note: args.note } : {}
        }, actorOf(args.by));
        return L(
          "\u5DF2\u66F4\u65B0 {id}\uFF1A{events}\u3002\u5F53\u524D {status} \xB7 {who}",
          "Updated {id}: {events}. Now {status} \xB7 {who}",
          { id: task.id, events: events.join(" \xB7 "), status: task.status, who: whoLabel(task.assignee) }
        );
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "taskboard_comment",
    description: "Add an information comment to a task WITHOUT changing its state: implementation findings, handoff notes for the next agent, or test feedback. The next agent reads them in taskboard_get.",
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
    description: "Read ONE task in full: title, detail body, owner, priority, tags, the complete log timeline (who did what, when, with notes), and the information comments other agents left (findings / handoffs / test feedback). taskboard_list only shows summary lines.",
    parameters: {
      id: { type: "string", required: true, description: "Task id, e.g. T-1 (from taskboard_list)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const cwd = resolveCwd(ctx, exec);
        return formatGet(await getTask(cwd, args.id));
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
function diffBoards(prev, next, names) {
  if (!prev) return [];
  const mine = new Set(names);
  const isMine = (task) => task.assignee !== null && mine.has(task.assignee) || mine.has(task.created_by);
  const lines = [];
  for (const [id, after] of Object.entries(next.tasks)) {
    const before = prev.tasks[id];
    if (!before) {
      if (mine.has(after.created_by)) continue;
      if (after.assignee && mine.has(after.assignee)) {
        lines.push(`${id} \xB7 assigned to you (by ${after.created_by}) \xB7 ${quoted(after)}`);
      } else if (!after.assignee) {
        lines.push(`${id} \xB7 new in pool (by ${after.created_by}) \xB7 ${quoted(after)}`);
      }
      continue;
    }
    if (after.assignee !== before.assignee && after.assignee && mine.has(after.assignee)) {
      const actor = after.log.at(-1)?.by;
      if (!actor || !mine.has(actor)) {
        lines.push(`${id} \xB7 assigned to you${actor ? ` (by ${actor})` : ""} \xB7 ${quoted(after)}`);
      }
    }
    for (const entry of after.log.slice(before.log.length)) {
      if (mine.has(entry.by)) continue;
      if (entry.event !== "approved" && entry.event !== "rejected" && entry.event !== "done") continue;
      if (!isMine(after)) continue;
      const note = entry.note ? ` \u2014 ${excerpt(entry.note)}` : "";
      lines.push(`${id} \xB7 ${entry.event} by ${entry.by}${note} \xB7 ${quoted(after)}`);
    }
    const newComments = after.comments.slice(before.comments.length).filter((comment) => !mine.has(comment.by));
    if (newComments.length > 0 && isMine(after)) {
      const last = newComments[newComments.length - 1];
      lines.push(newComments.length === 1 ? `${id} \xB7 new comment by ${last.by}: ${excerpt(last.text)} \xB7 ${quoted(after)}` : `${id} \xB7 ${newComments.length} new comments (latest by ${last.by}) \xB7 ${quoted(after)}`);
    }
  }
  return lines;
}
function createBoardWatcher(deps) {
  const names = [...deps.names ?? envNames() ?? ["dsh", "dsh-agent"]];
  const debounceMs = deps.debounceMs ?? 300;
  const throttleMs = deps.throttleMs ?? 5e3;
  const reconcileMs = deps.reconcileMs ?? 3e4;
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
    const lines = diffBoards(prev, next, names);
    if (lines.length > 0) enqueue(cwd, entry, lines);
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
        const entry = { unwatch, pending: [], lastFlushAt: 0 };
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
    return () => {
      stopped = true;
      clearInterval(interval);
      for (const entry of watched.values()) {
        entry.unwatch();
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
      }
      watched.clear();
    };
  }
  return { start, reconcile, poke };
}

// src/host/index.ts
var name = "taskboard-kit";
var inject = ["tools", "sessions"];
function pluginNotice(uuid, text, summary) {
  return {
    role: "user",
    id: uuid,
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "taskboard-kit", form: "notice", summary: summary.slice(0, 120) }
  };
}
function apply(ctx) {
  const log = ctx.logger("taskboard-kit");
  log.info("taskboard-kit loaded");
  registerTaskboardTools(ctx);
  log.info("taskboard tools registered (list, create, claim, update, comment, get)");
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
    systemPrompt.section({
      name: "taskboard:rules",
      order: 5e3,
      text: L(
        "## \u4EFB\u52A1\u770B\u677F\n\u672C workspace \u6709\u4E00\u5757\u5171\u4EAB\u4EFB\u52A1\u770B\u677F\uFF08taskboard_* \u5DE5\u5177\uFF09\uFF0C\u4EBA\u7C7B\u5728\u754C\u9762\u7684\u770B\u677F\u6807\u7B7E\u9875\u91CC\u770B\u5230\u7684\u662F\u540C\u4E00\u5757\u677F\u3002\u89C4\u5219\uFF1A\n- \u4F1A\u8BDD\u5F00\u59CB\u5148\u8C03\u7528 taskboard_list\uFF1A\u770B\u5F85\u8BA4\u9886\u6C60\uFF08column=pool\uFF09\u3001\u6307\u6D3E\u7ED9\u4F60\u7684\u3001\u8FDB\u884C\u4E2D\u7684\u3001\u4EE5\u53CA\u5F85\u5BA1\u6838\uFF08column=review\uFF09\u7684\u4EFB\u52A1\uFF1B\n- \u52A8\u624B\u505A\u4E00\u4EF6\u4E8B\u4E4B\u524D\u5148\u5360\u4F4D\uFF1A\u6C60\u91CC\u7684\u4EFB\u52A1\u7528 taskboard_claim \u8BA4\u9886\uFF1B\u6307\u6D3E\u7ED9\u4F60\u7684\u4EFB\u52A1\u7528 taskboard_update\uFF08action=start\uFF09\u5F00\u5DE5\u3002\n  \u8BA4\u9886/\u5F00\u5DE5\u4E4B\u524D\u4E0D\u8981\u76F4\u63A5\u5E72\u6D3B\u2014\u2014\u677F\u5B50\u5B58\u5728\u7684\u610F\u4E49\u5C31\u662F\u907F\u514D\u649E\u8F66\uFF1B\n- \u505A\u5B8C\u7528 taskboard_update\uFF08action=submit\uFF09\u63D0\u4EA4\u5BA1\u6838\uFF0C\u4E0D\u8981\u76F4\u63A5 done\uFF1B\u5BA1\u6838\u8005 approve \u901A\u8FC7\u3001reject \u6253\u56DE\uFF08\u6253\u56DE\u65F6\u7528 taskboard_comment \u5199\u660E\u539F\u56E0\uFF09\uFF1B\u88AB\u6253\u56DE\uFF08\u56DE\u5230 in_progress\uFF09\u6539\u5B8C\u518D submit\uFF1B\n- \u8FDB\u5C55/\u5B8C\u6210\u5373\u65F6 taskboard_update\uFF08note \u8BB0\u8FDB\u5C55\uFF09\uFF1B\u5B9E\u73B0\u53D1\u73B0\u3001\u4EA4\u63A5\u8BF4\u660E\u3001\u6D4B\u8BD5\u53CD\u9988\u7528 taskboard_comment\uFF08\u4E0D\u6539\u72B6\u6001\uFF09\uFF0C\u63A5\u624B\u4EFB\u52A1\u524D\u5148 taskboard_get \u770B\u7559\u8A00\u548C\u65F6\u95F4\u7EBF\uFF1B\n- \u4E0D\u8981\u7684\u4EFB\u52A1\u7528 action=close\uFF08\u65E7\u540D cancel \u662F\u5B83\u7684\u522B\u540D\uFF09\uFF1Bclaim \u51B2\u7A81 = \u522B\u4EBA\u5DF2\u7ECF\u5360\u4E86\uFF1A\u6362\u522B\u7684\u5F85\u8BA4\u9886\u4EFB\u52A1\uFF0C\u6216\u5411\u4EBA\u7C7B\u8BF7\u793A\uFF0C\u4E0D\u8981\u786C\u505A\u540C\u4E00\u4E2A\u3002\n- \u770B\u677F\u53D8\u5316\uFF08\u65B0\u6307\u6D3E\u7ED9\u4F60\u7684\u4EFB\u52A1\u3001\u5BA1\u6838\u7ED3\u679C\u3001\u65B0\u7559\u8A00\uFF09\u4F1A\u81EA\u52A8\u901A\u77E5\u4F60\uFF0C\u65E0\u9700\u8F6E\u8BE2\u3002",
        "## Task board\nThis workspace has a shared task board (taskboard_* tools); the human watches the SAME board in the kanban tab. Rules:\n- At session start, call taskboard_list: check the claimable pool (column=pool), tasks delegated to you, work in progress, and the review queue (column=review);\n- Before working on anything, take ownership first: taskboard_claim a pool task, or taskboard_update (action=start) a task delegated to you. Never just start working \u2014 the board exists to prevent collisions;\n- When finished, taskboard_update (action=submit) to hand the task to review instead of marking it done yourself; the reviewer approves (\u2192 done) or rejects (\u2192 in_progress, with a taskboard_comment explaining why); after a rejection, fix and submit again;\n- Report progress as it happens with taskboard_update (note to log progress); leave findings, handoff notes or test feedback with taskboard_comment (state untouched); before picking up a task, taskboard_get first to read its comments and timeline;\n- Close unwanted tasks with action=close (cancel is its legacy alias); a claim conflict means someone else got there first: pick another pool task or ask the human \u2014 never work the same task anyway.\n- Board changes (tasks assigned to you, review verdicts, new comments) are pushed to you automatically \u2014 no polling needed."
      )
    });
    log.info("taskboard rules added to the system prompt");
  });
  ctx.on("agent/session-start", (payload) => {
    const { agent } = payload;
    void (async () => {
      const cwd = resolveCwd(ctx, { agent: agent.id });
      const tasks = await listTasks(cwd);
      const pool = tasks.filter((task) => task.status === "open" && !task.assignee).length;
      const assigned = tasks.filter((task) => task.status === "open" && task.assignee).length;
      const inProgress = tasks.filter((task) => task.status === "in_progress").length;
      if (pool + assigned + inProgress === 0) return;
      const delegated = assigned > 0 ? L("\u3001\u5DF2\u6307\u6D3E {assigned} \u6761", ", {assigned} delegated", { assigned }) : "";
      agent.inject(pluginNotice(
        randomUUID(),
        L(
          "\u672C workspace \u7684\u4EFB\u52A1\u770B\u677F\u6709\u5F85\u8BA4\u9886 {pool} \u6761{delegated}\u3001\u8FDB\u884C\u4E2D {ip} \u6761\u4EFB\u52A1\u3002\u7528 taskboard_list \u67E5\u770B\uFF1B\u52A8\u624B\u524D\u8BB0\u5F97\u5148 claim / start\u3002",
          "This workspace's task board has {pool} claimable{delegated} and {ip} in-progress task(s). See taskboard_list; claim / start before working.",
          { pool, delegated, ip: inProgress }
        ),
        `taskboard: ${pool} claimable, ${inProgress} in progress`
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
        agent?.inject(pluginNotice(randomUUID(), text, text.split("\n")[1] ?? "board change"));
      },
      log: (message) => log.info(message)
    });
    child.effect(() => watcher.start(), "taskboard-kit: board watcher");
    log.info("taskboard board watcher started (fs.watch on live sessions' boards)");
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
  L,
  StoreError,
  TASK_VALUES,
  addComment,
  apply,
  boardFilePath,
  claimTask,
  createBoardWatcher,
  createTask,
  createTaskboardBridge,
  defaultBridgeDeps,
  diffBoards,
  getTask,
  inject,
  isTrustedRequest,
  listTasks,
  loadBoard,
  name,
  resolveCwd,
  saveBoard,
  updateTask,
  withBoardLock
};
