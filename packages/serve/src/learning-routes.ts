// The learning routes, this server's own under /v2: a run's learning state, its memo and its diff, approve and refuse; an
// agent's learning at main, one file of it, its log of merges, and retire. Reads come from the bare repository with git's
// plumbing, which takes no lock, so any number run at once; approve, refuse and retire go through the agent's queue. Every
// text that leaves passes through the host's secrets at read time, so a value made secret after a proposal never comes back
// out of it, and a file the checker finds a secret in shows its path and the rule only. A run's text is untrusted on this
// origin: it answers with an explicit type, nosniff, and a sandbox on anything but JSON.
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Agents } from "./agents.js";
import { ApiError, invalid } from "./errors.js";
import { learningOf, openAgentRepo, readRunState, repoOf, type RunState, withAgentRepo } from "./learning.js";
import type { Review } from "./review.js";
import type { Json } from "./validate.js";

export type LearningRoute = { method: string; pattern: RegExp; name: string };

export const LEARNING_ROUTES: LearningRoute[] = [
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning$/, name: "getRunLearning" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning\/memo$/, name: "getRunLearningMemo" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning\/diff$/, name: "getRunLearningDiff" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/learning\/approve$/, name: "approveRunLearning" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/learning\/refuse$/, name: "refuseRunLearning" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning$/, name: "getAgentLearning" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/files\/(.+)$/, name: "readAgentLearningFile" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/log$/, name: "listAgentLearningLog" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/retire$/, name: "retireAgentLearning" },
];

const param = (name: string, description: string) => ({ name, in: "path", required: true, description, schema: { type: "string" } });
const RUN = param("run_id", "The run.");
const AGENT = param("agent_id", "The agent.");
const answer = (description: string, type = "application/json") => ({ description, content: { [type]: { schema: type === "application/json" ? { type: "object" } : { type: "string" } } } });
const op = (operationId: string, summary: string, parameters: unknown[], ok: unknown, extra: Record<string, unknown> = {}) => ({
  operationId, tags: ["learning"], summary, parameters, "x-agentrun-serve": true, ...extra,
  responses: { "200": ok, "401": { $ref: "#/components/responses/Unauthenticated" }, "404": { $ref: "#/components/responses/NotFound" }, "500": { $ref: "#/components/responses/Internal" } },
});
const reasonBody = { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", maxLength: 200 } } } } } };

/** The learning routes' operations for /v2/openapi.json, each this server's own. */
export const LEARNING_OPENAPI: Record<string, Record<string, Record<string, unknown>>> = {
  "/runs/{run_id}/learning": { get: op("getRunLearning", "What the run learned: its proposal and its review", [RUN], answer("The run's learning state.")) },
  "/runs/{run_id}/learning/memo": { get: op("getRunLearningMemo", "The run's memo, from main once merged, else from its branch", [RUN], answer("The memo.", "text/markdown")) },
  "/runs/{run_id}/learning/diff": { get: op("getRunLearningDiff", "What the run proposed, or what landed once merged, file by file", [RUN], answer("The diff, bounded.")) },
  "/runs/{run_id}/learning/approve": { post: op("approveRunLearning", "Approve the run's held plan", [RUN], answer("How it landed.")) },
  "/runs/{run_id}/learning/refuse": { post: op("refuseRunLearning", "Refuse the run's held plan, with a one-line reason", [RUN], answer("How it landed."), { requestBody: reasonBody }) },
  "/agents/{agent_id}/learning": { get: op("getAgentLearning", "What the agent has learned, at main", [AGENT], answer("Its notes, skills and workflows.")) },
  "/agents/{agent_id}/learning/files/{path}": { get: op("readAgentLearningFile", "One file of the agent's learning at main", [AGENT, param("path", "A plain repository path.")], answer("The file's text.", "text/plain")) },
  "/agents/{agent_id}/learning/log": { get: op("listAgentLearningLog", "The merges on main, newest first", [AGENT], answer("A page of merges.")) },
  "/agents/{agent_id}/learning/retire": { post: op("retireAgentLearning", "Retire a note on main", [AGENT], answer("Whether it was retired."), { requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["id", "reason"], properties: { id: { type: "string" }, reason: { type: "string", maxLength: 200 } } } } } } }) },
};

export type LearningContext = {
  data: string;
  agents: Pick<Agents, "get">;
  review: Pick<Review, "approve" | "refuse">;
  /** The host's secrets now (runs.ts `hostSecrets`): read again at each answer. */
  secrets: () => string[];
  runOf(id: string): Promise<{ id: string; agentId: string }>;
  bodyOf(req: IncomingMessage): Promise<Json>;
  /** Who the request is, from its credential only. Only `id`, a stable opaque account id ("token" for the server's
   *  token), is ever written into the learning repository; anything person-identifying stays in the log. */
  principal(req: IncomingMessage): LearningPrincipal;
  log?: (event: string, fields: Record<string, string | number>) => void;
};

export type LearningPrincipal = { readonly id: string; readonly email?: string };

const FILE_CAP = 64 * 1024;
const DIFF_TOTAL_CAP = 1024 * 1024;
const DIFF_FILES_CAP = 200;
const LOG_LIMIT = 100;
const NOTES_CAP = 500;
const PLAIN_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SAFE = ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"];
const ENV = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
const SECRET_RULES = new Set(["secret_shape", "secret_value"]);

/** git's plumbing on the bare repository, read-only. */
async function git(bare: string, args: readonly string[], allowFail = false): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", ["--git-dir", bare, ...SAFE, ...args], { env: ENV, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
    return stdout;
  } catch (error) {
    if (allowFail) return undefined;
    throw error;
  }
}
const commitOf = async (bare: string, ref: string) => (await git(bare, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], true))?.trim() || undefined;
const blobAt = (bare: string, commit: string, path: string) => git(bare, ["cat-file", "blob", `${commit}:${path}`], true);

/** `text` with every one of the host's secrets now replaced by "[redacted]". */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown, secrets: readonly string[]): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(redact(JSON.stringify(body), secrets.map((s) => JSON.stringify(s).slice(1, -1))));
}
function sendText(res: ServerResponse, type: string, text: string, secrets: readonly string[]): void {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
  res.end(redact(text, secrets));
}

/** The run's learning state as the routes show it: none of the server's own bookkeeping. */
function stateView(runId: string, state: RunState | undefined): Record<string, unknown> {
  if (!state) return { run_id: runId, state: "none" };
  const { sha: _sha, pruned: _pruned, ...shown } = state;
  return { run_id: runId, ...shown };
}

/** One line of 1 to 200 characters, or a 422 on `field`. */
function oneLine(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || Array.from(value).length > 200 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw invalid([{ field, reason: value === undefined ? "missing" : "not_an_option", message: `${field} is one line of 1 to 200 characters` }]);
  }
  return value.trim();
}

export async function answerLearning(name: string, req: IncomingMessage, res: ServerResponse, url: URL, first: string, second: string | undefined, ctx: LearningContext): Promise<void> {
  const secrets = ctx.secrets();
  if (name.startsWith("getRun") || name.endsWith("RunLearning")) return answerRun(name, req, res, first, ctx, secrets);
  return answerAgent(name, req, res, url, first, second, ctx, secrets);
}

async function answerRun(name: string, req: IncomingMessage, res: ServerResponse, runId: string, ctx: LearningContext, secrets: readonly string[]): Promise<void> {
  const run = await ctx.runOf(runId);
  const agentId = run.agentId;
  const state = await readRunState(ctx.data, agentId, run.id);
  // A request's read of the agent store: a store busy past its wait is home_busy (server.ts), never a wrong answer.
  const learns = state !== undefined || learningOf((await ctx.agents.get(agentId))?.revision) !== "off";
  const bare = repoOf(ctx.data, agentId);
  switch (name) {
    case "getRunLearning":
      return sendJson(res, 200, learns ? stateView(run.id, state) : { run_id: run.id, state: "off" }, secrets);
    case "getRunLearningMemo": {
      const path = `memos/${run.id}.md`;
      const on = (await commitOf(bare, "main")) ?? "";
      const text = (on && (await blobAt(bare, on, path))) || (await branchBlob(bare, run.id, path));
      if (text === undefined) throw new ApiError("not_found", "this run has no memo");
      return sendText(res, "text/markdown; charset=utf-8", text, secrets);
    }
    case "getRunLearningDiff":
      return sendJson(res, 200, await diffOf(bare, run.id, state, secrets), secrets);
    case "approveRunLearning":
    case "refuseRunLearning": {
      const body = await ctx.bodyOf(req);
      const reason = name === "refuseRunLearning" ? oneLine(body.reason, "reason") : undefined;
      if (state?.state !== "awaiting_approval") throw new ApiError("not_awaiting_approval", "this run's learning is not waiting for approval");
      const { id: principal } = ctx.principal(req);
      const result = reason === undefined ? await ctx.review.approve(agentId, run.id, principal) : await ctx.review.refuse(agentId, run.id, principal, reason);
      return sendJson(res, 200, result, secrets);
    }
  }
  throw new ApiError("not_found", `no route ${name}`);
}

const branchBlob = async (bare: string, runId: string, path: string) => {
  const tip = await commitOf(bare, `refs/heads/runs/${runId}`);
  return tip ? blobAt(bare, tip, path) : undefined;
};

type DiffFile = { path: string; status: string; diff?: string; truncated?: boolean; binary?: boolean; withheld?: string };

/** `proposed`, the run's branch against its base while it is there, or `landed`, the merge's second parent against its
 *  parent once merged; bounded per file and in all. A file the checker finds a secret in shows its path and the rule. */
async function diffOf(bare: string, runId: string, state: RunState | undefined, secrets: readonly string[]): Promise<Record<string, unknown>> {
  let of: "proposed" | "landed";
  let base: string | undefined;
  let head: string | undefined;
  const tip = await commitOf(bare, `refs/heads/runs/${runId}`);
  if (tip) {
    of = "proposed";
    head = tip;
    base = state?.base ? await commitOf(bare, state.base) : undefined;
    base ??= (await git(bare, ["merge-base", "main", tip], true))?.trim() || undefined;
  } else if (state?.merge) {
    of = "landed";
    head = await commitOf(bare, `${state.merge}^2`);
    base = head ? await commitOf(bare, `${head}^`) : undefined;
  } else {
    throw new ApiError("not_found", "this run has no branch and nothing landed");
  }
  if (!head || !base) throw new ApiError("not_found", "this run's commits are not in the repository");
  const withheld = new Map<string, string>();
  if (of === "proposed") {
    const { checkBranch } = await import("@parcha/agentrun-learn");
    const report = await checkBranch({ cwd: bare, base: "main", head: tip!, branch: `runs/${runId}`, refuseValues: [...secrets], tools: [] }).catch(() => undefined);
    for (const p of report?.problems ?? []) if (p.path && SECRET_RULES.has(p.rule)) withheld.set(p.path, p.rule);
  }
  const listing = (await git(bare, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", base, head])) ?? "";
  const parts = listing.split("\0").filter(Boolean);
  const files: DiffFile[] = [];
  let total = 0;
  let truncated = false;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = { A: "added", M: "modified", D: "deleted", T: "modified" }[parts[i]![0] as "A" | "M" | "D" | "T"] ?? "modified";
    const path = parts[i + 1]!;
    if (files.length >= DIFF_FILES_CAP) {
      truncated = true;
      break;
    }
    // A value the host holds as secret now, in the file as proposed: its path and the rule, however the checker read it.
    const proposedText = of === "proposed" && status !== "deleted" ? await blobAt(bare, head, path) : undefined;
    const rule = withheld.get(path) ?? (proposedText !== undefined && secrets.some((secret) => secret.length > 0 && proposedText.includes(secret)) ? "secret_value" : undefined);
    if (rule) {
      files.push({ path, status, withheld: rule });
      continue;
    }
    const numstat = (await git(bare, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", base, head, "--", path])) ?? "";
    if (numstat.startsWith("-\t-\t")) {
      files.push({ path, status, binary: true });
      continue;
    }
    let text = redact((await git(bare, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", base, head, "--", path])) ?? "", secrets);
    let cut = false;
    if (Buffer.byteLength(text) > FILE_CAP) {
      text = Buffer.from(text).subarray(0, FILE_CAP).toString("utf8").replace(/�$/, "");
      cut = true;
    }
    if (total + Buffer.byteLength(text) > DIFF_TOTAL_CAP) {
      truncated = true;
      break;
    }
    total += Buffer.byteLength(text);
    files.push({ path, status, diff: text, ...(cut ? { truncated: true } : {}) });
  }
  return { run_id: runId, of, base, head, files, truncated };
}

async function answerAgent(name: string, req: IncomingMessage, res: ServerResponse, url: URL, agentId: string, second: string | undefined, ctx: LearningContext, secrets: readonly string[]): Promise<void> {
  const entry = await ctx.agents.get(agentId);
  if (!entry) throw new ApiError("not_found", `no agent ${agentId}`);
  const bare = repoOf(ctx.data, agentId);
  const main = await commitOf(bare, "main");
  switch (name) {
    case "getAgentLearning": {
      const mode = learningOf(entry.revision);
      if (!main) return sendJson(res, 200, { agent_id: agentId, mode, main: null, notes: [], skills: [], workflows: [] }, secrets);
      const paths = ((await git(bare, ["ls-tree", "-r", "-z", "--name-only", main, "--", "learnings", ".agents/skills", "workflows"])) ?? "").split("\0").filter(Boolean);
      const notePaths = paths.filter((p) => /^learnings\/L-[0-9a-f]{12}\.md$/.test(p));
      const { parseLearning } = await import("@parcha/pi-agent-learn");
      const notes: Record<string, unknown>[] = [];
      for (const path of notePaths.slice(0, NOTES_CAP)) {
        try {
          const note = parseLearning((await blobAt(bare, main, path)) ?? "");
          notes.push({ id: note.id, type: note.type, status: note.status, uses: note.uses, text: note.text });
        } catch {
          notes.push({ id: path.slice("learnings/".length, -3), status: "unreadable" });
        }
      }
      const skills = [...new Set(paths.map((p) => /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1]).filter((n): n is string => n !== undefined))].sort();
      const workflows = [...new Set(paths.map((p) => /^workflows\/([^/]+)\//.exec(p)?.[1]).filter((n): n is string => n !== undefined))].sort().map((n) => ({ name: n }));
      return sendJson(res, 200, { agent_id: agentId, mode, main, notes, skills, workflows, ...(notePaths.length > NOTES_CAP ? { truncated: true } : {}) }, secrets);
    }
    case "readAgentLearningFile": {
      let path: string;
      try {
        path = decodeURIComponent(second ?? "");
      } catch {
        throw invalid([{ field: "path", reason: "not_an_option", message: "the path is not percent-encoded right" }]);
      }
      if (!PLAIN_PATH.test(path) || path.split("/").some((part) => part === "." || part === ".." || part.startsWith(".git"))) {
        throw invalid([{ field: "path", reason: "not_an_option", message: "the path is a plain repository path: no empty, . or .. segment, no NUL, no leading /" }]);
      }
      if (!main) throw new ApiError("not_found", "this agent's learning has no main yet");
      const size = Number((await git(bare, ["cat-file", "-s", `${main}:${path}`], true))?.trim() ?? NaN);
      if (!Number.isFinite(size)) throw new ApiError("not_found", "no such file at main");
      if (size > FILE_CAP) throw invalid([{ field: "path", reason: "too_large", message: `the file is over ${FILE_CAP} bytes` }]);
      const text = (await blobAt(bare, main, path)) ?? "";
      const type = path.endsWith(".md") ? "text/markdown; charset=utf-8" : path.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
      if (type.startsWith("application/json")) {
        res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end(redact(text, secrets));
      }
      return sendText(res, type, text, secrets);
    }
    case "listAgentLearningLog": {
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 20 : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > LOG_LIMIT) throw invalid([{ field: "limit", reason: "not_an_option", message: `limit is a whole number from 1 to ${LOG_LIMIT}` }]);
      const cursor = url.searchParams.get("cursor");
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0) throw invalid([{ field: "cursor", reason: "not_an_option", message: "cursor is a next_cursor this route gave" }]);
      if (!main) return sendJson(res, 200, { agent_id: agentId, merges: [], next_cursor: null }, secrets);
      const text = (await git(bare, ["log", "--first-parent", "-z", "--format=%H%x1f%cI%x1f%s%x1f%(trailers:key=Curated-Run,valueonly,separator=%x2C)", main])) ?? "";
      // The run comes from the Curated-Run trailer; what was accepted and refused is the run's verdict, never read out of
      // a commit's words.
      const merges = text.split("\0").filter(Boolean).map((line) => line.replace(/^\n/, "").split("\x1f")).filter(([, , , run]) => (run ?? "").trim() !== "")
        .map(([sha, at, subject, run]) => ({ sha, at, run: (run ?? "").trim(), subject }));
      const page = merges.slice(offset, offset + limit);
      return sendJson(res, 200, { agent_id: agentId, merges: page, next_cursor: offset + limit < merges.length ? String(offset + limit) : null }, secrets);
    }
    case "retireAgentLearning": {
      const body = await ctx.bodyOf(req);
      const id = body.id;
      if (typeof id !== "string" || !/^L-[0-9a-f]{12}$/.test(id)) throw invalid([{ field: "id", reason: id === undefined ? "missing" : "not_an_option", message: "id is a note's id, L- and 12 hex digits" }]);
      const reason = oneLine(body.reason, "reason");
      const { retireLearning } = await import("@parcha/pi-agent-learn");
      // On main, the reason and the stable account id only: never a person's email or name.
      const { id: principal } = ctx.principal(req);
      const result = await withAgentRepo(ctx.data, agentId, async () => {
        const repo = await openAgentRepo(ctx.data, agentId, join(ctx.data, "agents", agentId, "curator"));
        return retireLearning({ repo, id, reason: `${reason} (by ${principal})`, secrets: [...secrets] });
      });
      ctx.log?.("learning_retired", { agent: agentId, note: id, by: principal, result: result.status });
      return sendJson(res, 200, result, secrets);
    }
  }
  throw new ApiError("not_found", `no route ${name}`);
}
