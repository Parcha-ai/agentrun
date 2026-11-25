// A local setup uses the source snapshot protocol: the same project, skills and tool policy that Move runs in the
// console. The private journal pins destination, source and retries. Package deploy remains a separate export format.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { refusalExit } from "./login.mjs";
import { toUrl } from "./target.mjs";

const CAPABILITIES = Object.freeze({ native_execution: false, history_import: false, config_sync: true });
const RUNTIMES = ["claude-code", "codex", "pi"];
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BODY = 128 * 1024 * 1024;
const within = (path, root) => path === root || path.startsWith(root + sep);
const identity = (target) => Object.fromEntries(["runtime", "machine_id", "project", "selector"].map(key => [key, target[key]]));
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const say = (io, text) => io.stderr.write(`${text}\n`);
const print = (io, value) => io.stdout.write(`${JSON.stringify(value)}\n`);
const enc = encodeURIComponent;

function secrets() {
  const values = new Set();
  return {
    add(value) { if (typeof value === "string" && value) for (const form of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) values.add(form); },
    cut(text) { return [...values].sort((a,b) => b.length-a.length).reduce((s, secret) => s.split(secret).join("[hidden]"), String(text)); },
  };
}

/** Redirects never carry enrollment or connector credentials to another destination. Response bodies are bounded;
 * refusals show only their error message, with every credential held by this operation removed. */
function transport(ctx, target, fetcher = fetch) {
  const scrub = secrets(); scrub.add(target.token);
  const tokenOK = value => typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f-\uffff]/.test(value);
  const call = async (method, path, body, token = target.token) => {
    if (!tokenOK(token)) throw ctx.cli.fail(4, "The destination returned an unusable connection credential.");
    scrub.add(token);
    let response, raw = "";
    try {
      response = await fetcher(`${target.base}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (Number(response.headers.get("content-length")) > MAX_BODY) throw new Error("response_too_large");
      if (response.body) {
        const reader = response.body.getReader(); let size = 0; const chunks = [];
        try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_BODY) throw new Error("response_too_large"); chunks.push(next.value); } }
        finally { await reader.cancel().catch(() => {}); }
        raw = Buffer.concat(chunks).toString("utf8");
      }
    } catch (error) {
      throw ctx.cli.fail(1, `The destination did not confirm ${method} ${path} (${error?.cause?.code ?? error?.name ?? "network_error"}). Retry the same command; its pending request is retained.`);
    }
    let value;
    try { value = raw ? JSON.parse(raw) : undefined; } catch { /* reported below, never echo a response */ }
    if (!response.ok) {
      const code = typeof value?.error?.code === "string" && /^[a-z_]+$/.test(value.error.code) ? value.error.code : "request_refused";
      const message = typeof value?.error?.message === "string" ? scrub.cut(value.error.message).slice(0, 4000) : "The destination refused this operation.";
      const auth = response.status === 401 || response.status === 403 ? token === target.token
        ? " Sign in to the selected destination workspace with permission to manage this connection before retrying."
        : " The saved connection was rejected. Review whether it was revoked or replaced in AgentRun Console before reauthorizing it; retrying does not replace this connection. Its journal and pending snapshot were preserved."
        : "";
      throw ctx.cli.fail(response.status === 409 && code === "agent_not_runnable" ? 3 : refusalExit(response.status), `${code}: ${message}${auth}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw ctx.cli.fail(1, `The destination did not return a JSON object for ${method} ${path}.`);
    return value;
  };
  return { call, scrub, tokenOK };
}

/** A capability check precedes filesystem discovery/export. Older destinations fail here without a new connection. */
async function supported(ctx, target, runtime, fetcher) {
  const result = await transport(ctx, target, fetcher).call("GET", "/capabilities");
  const feature = result.source_deployment;
  if (!feature || !Number.isSafeInteger(feature.version) || feature.version < 1 || !Array.isArray(feature.runtimes)
      || (runtime && !feature.runtimes.includes(runtime))) {
    throw ctx.cli.fail(5, "This destination does not offer deployment of this local setup. Update or enable source deployment there; no local setup was exported.");
  }
  const workspace = feature.workspace_id ?? null;
  if (workspace !== null && (typeof workspace !== "string" || !/^(user|team):[^\s\x00-\x1f]{1,256}$/.test(workspace)))
    throw ctx.cli.fail(5, "The destination did not identify its authenticated workspace.");
  if (ctx.values.workspace !== undefined && ctx.values.workspace !== workspace)
    throw ctx.cli.fail(4, "The signed-in destination workspace does not match --workspace. Sign in to the selected workspace before retrying; nothing was exported.");
  return { ...target, workspace };
}

function selected(ctx) {
  const { values, args, cli } = ctx;
  if (!RUNTIMES.includes(values.from)) throw cli.fail(2, "--from must be claude-code, codex or pi.");
  if (values["source-agent"] && (values.from !== "claude-code" || values.profile)) throw cli.fail(2, "--source-agent selects a Claude Code agent; choose it without --profile.");
  if (values.profile && values.from !== "codex") throw cli.fail(2, "--profile selects a Codex profile.");
  for (const option of ["force", "params", "pause-source", "agent", "connected"]) if (values[option] !== undefined) throw cli.fail(2, `--${option} does not apply with --from.`);
  const selector = values["source-agent"] ? { kind: "agent", name: values["source-agent"] } : values.profile ? { kind: "profile", name: values.profile } : { kind: "project" };
  if (selector.name && !/^[\w.@+-]{1,160}$/.test(selector.name)) throw cli.fail(2, "Select an agent/profile using its discovered name.");
  return { project: resolve(args[0] ?? "."), runtime: values.from, selector };
}
function targetOf(ctx) {
  const { values, env, cli } = ctx;
  const target = cli.targetOf(values.to === undefined ? values : { ...values, "base-url": cli.baseOf(toUrl(values.to, env), "--to") }, env);
  const url = new URL(target.base);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw cli.fail(2, "A remote deployment destination must use HTTPS.");
  return target;
}
async function confirmation(ctx, message) {
  if (ctx.values.yes) return true;
  if (!ctx.io.stdin.isTTY) { say(ctx.io, "Review this setup, then repeat with --yes to send it to the selected destination."); return false; }
  const prompt = createInterface({ input: ctx.io.stdin, output: ctx.io.stderr });
  try { return /^y(es)?$/i.test((await prompt.question(`${message} [y/N] `)).trim()); }
  finally { prompt.close(); }
}

function privateDirectory(path, cli) {
  // The parent may be a conventional 0755 config folder. Links in any component are refused before mkdir can follow
  // one. The directory that holds credentials is owned by this user and accessible to nobody else.
  let at = resolve(path); const missing = [];
  while (!existsSync(at)) { missing.unshift(at); if (dirname(at) === at) break; at = dirname(at); }
  for (let part = at; ; part = dirname(part)) {
    const entry = lstatSync(part);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw cli.fail(2, "The deployment journal path contains a link or a non-directory.");
    if (dirname(part) === part) break;
  }
  for (const dir of missing) mkdirSync(dir, { mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw cli.fail(2, "The deployment journal directory must be private and owned by this user.");
}
function atomic(file, value) {
  const temp = join(dirname(file), `.write-${randomUUID()}`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    const dir = openSync(dirname(file), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
}
const journalRoot = ctx => join(ctx.env.XDG_CONFIG_HOME || join(ctx.env.HOME || homedir(), ".config"), "agentrun", "deployments");
function realLocation(path) {
  const rest = []; let existing = resolve(path);
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  return join(realpathSync(existing), ...rest);
}
function outsideProject(ctx, project) {
  if (within(realLocation(journalRoot(ctx)), realLocation(project))) throw ctx.cli.fail(2, "The private deployment journal would be inside the exported project. Select a project below your home or use XDG_CONFIG_HOME outside it.");
}
function journal(ctx, source, base, workspace = null) {
  const root = journalRoot(ctx);
  const dir = join(root, hash({ base, workspace, source }));
  outsideProject(ctx, source.project);
  privateDirectory(dir, ctx.cli);
  const file = join(dir, "state.json"), pending = join(dir, "pending.json"), lock = join(dir, "held");
  const read = (path, limit = MAX_BODY) => {
    if (!existsSync(path)) return undefined;
    if (lstatSync(path).size > limit) throw ctx.cli.fail(2, "The private deployment journal exceeds its size limit.");
    const raw = ctx.cli.privateFile(path);
    try { return JSON.parse(raw); } catch { throw ctx.cli.fail(2, "The private deployment journal is invalid; it was preserved."); }
  };
  const ownerFile = `${hostname()}-${process.pid}-${randomUUID()}.json`;
  const candidate = join(dir, `.hold-${randomUUID()}`);
  mkdirSync(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    writeFileSync(join(candidate, ownerFile), JSON.stringify({ pid: process.pid, host: hostname() }), { flag: "wx", mode: 0o600 });
    for (let retry = 0; retry < 3; retry++) {
      // Publish ownership together with the directory. A competing nonempty holder cannot be replaced, even if
      // this process paused before publication and a legacy empty lock was recovered in the meantime.
      try { renameSync(candidate, lock); acquired = true; break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        let info;
        try { info = lstatSync(lock); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw ctx.cli.fail(2, "The deployment lock is not a private directory.");
        const entries = readdirSync(lock);
        if (!entries.length && Date.now() - info.mtimeMs > 60_000) {
          // An interrupted mkdir may leave no owner marker. Only remove an old, still-empty directory;
          // a writer that has since installed its marker wins because rmdir refuses a nonempty directory.
          try { rmdirSync(lock); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
          continue;
        }
        const held = entries.length === 1 ? read(join(lock, entries[0]), 4096) : undefined;
        if (held?.host !== hostname() || !Number.isSafeInteger(held.pid) || held.pid <= 0 || ctx.cli.alive(held.pid)) throw ctx.cli.fail(2, "Another deployment holds this setup's journal. Retry after it finishes; the journal was preserved.");
        try {
          // A stale holder's unique filename can never name a new process's holder. Only the process that removed
          // that exact file removes the empty directory; a competing recovery sees ENOENT and retries.
          rmSync(join(lock, entries[0])); rmdirSync(lock);
        } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
      }
    }
  } finally {
    if (!acquired) rmSync(candidate, { recursive: true, force: true });
  }
  if (!acquired) throw ctx.cli.fail(2, "This setup's deployment journal is busy; retry after the other command finishes.");
  let state;
  const close = () => {
    rmSync(join(lock, ownerFile));
    // A successor may publish its populated directory after this owner's marker was removed.
    try { rmdirSync(lock); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
  };
  try {
    state = read(file, 1024 * 1024);
    if (state && (state.version !== 1 || state.base !== base || state.workspace !== workspace || canonical(state.source) !== canonical(source)
      || !ID.test(state.installation_id) || !ID.test(state.operation_id) || !ID.test(state.target_id))) throw ctx.cli.fail(2, "The deployment journal does not match this source and destination; it was preserved.");
    if (!state) { state = { version: 1, base, workspace, source, installation_id: randomUUID(), operation_id: randomUUID(), target_id: randomUUID() }; atomic(file, state); }
    return { state, close, save: () => atomic(file, state), pending: () => read(pending), queue: value => {
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY) throw ctx.cli.fail(2, "The complete setup exceeds the upload limit; nothing was truncated.");
      atomic(pending, value);
    }, clear: () => rmSync(pending, { force: true }) };
  } catch (error) { close(); throw error; }
}

const counts = (snapshot) => ({ files: snapshot.entries.filter(item => item.type === "file").length,
  bytes: snapshot.entries.reduce((n, item) => n + item.bytes, 0), skills: snapshot.skills.length, tools: snapshot.configuration.tools.length });
function blocked(ctx, target, status, agentId, scrub) {
  const blockers = (status.blockers ?? []).map(item => ({ code: item.code, message: scrub.cut(item.message) }));
  for (const blocker of blockers) say(ctx.io, `${blocker.code}: ${blocker.message}`);
  print(ctx.io, { status: "needs_attention", target: target.base, ...(agentId ? { agent_id: agentId } : {}), state: status.state, blockers });
  return 3;
}

/** The protocol boundary takes an already exported and approved source. Network requests are replaceable for the
 * transport conformance tests; production uses fetch. Credentials and source bytes remain in private files only. */
export async function deployCapturedSetup(ctx, captured, target, { fetch: fetcher, connectOnly = false, now = Date.now } = {}) {
  const wire = transport(ctx, target, fetcher), source = identity(captured.target), snapshot = captured.snapshot;
  if (!snapshot || !DIGEST.test(snapshot.digest) || canonical(snapshot.source) !== canonical(source)) throw ctx.cli.fail(2, "The exporter did not return a snapshot of the selected source.");
  if (!snapshot.complete || snapshot.blockers.length) return blocked(ctx, target, snapshot, undefined, wire.scrub);
  const summary = { target: target.base, workspace_id: target.workspace ?? null, runtime: source.runtime, selector: source.selector, snapshot: snapshot.digest, ...counts(snapshot) };
  say(ctx.io, `Selected ${source.runtime}${source.selector.name ? ` ${source.selector.name}` : " project"}: ${summary.files} files, ${summary.skills} skills, ${summary.tools} tool connections. Destination: ${target.base}.`);
  say(ctx.io, "The setup includes project files, skill assets and supported settings. Source credentials stay local; model and tool access must be configured at the destination.");
  if (ctx.values["dry-run"]) { print(ctx.io, { status: "preview", ...summary }); return 0; }
  if (!await confirmation(ctx, `${connectOnly ? "Connect and copy" : "Deploy"} this setup into AgentRun Console?`)) return 2;
  const held = journal(ctx, source, target.base, target.workspace), state = held.state;
  try {
    for (const key of ["enrollment_token", "credential"]) if (state[key]) wire.scrub.add(state[key]);
    const expiry = (value, kind) => {
      if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
        throw ctx.cli.fail(2, `The ${kind} credential has no valid expiration. Update the destination and review this connection in AgentRun Console; its journal was preserved.`);
      return Date.parse(value);
    };
    if (state.connector_id && (!ID.test(state.connector_id) || !wire.tokenOK(state.credential))) throw ctx.cli.fail(2, "The saved source connection is invalid; it was preserved.");
    const expired = state.connector_id && expiry(state.credential_expires_at, "saved connection") <= now();
    if (!state.connector_id || expired || state.enrollment_token) {
      if (!state.enrollment_token || expiry(state.enrollment_expires_at, "saved enrollment") <= now()) {
        const enrolled = await wire.call("POST", "/connectors/enrollment", { label: "AgentRun CLI deployment", capabilities: CAPABILITIES,
          ...(state.connector_id ? { connector_id: state.connector_id } : {}) });
        if (!wire.tokenOK(enrolled.enrollment_token)) throw ctx.cli.fail(1, "The destination did not return a usable enrollment credential.");
        if (expiry(enrolled.expires_at, "returned enrollment") <= now()) throw ctx.cli.fail(4, "The destination returned an expired enrollment. Check the destination clock before retrying; its journal was preserved.");
        state.enrollment_token = enrolled.enrollment_token; state.enrollment_expires_at = enrolled.expires_at;
        state.operation_id = randomUUID(); wire.scrub.add(state.enrollment_token); held.save();
      }
      const result = await wire.call("POST", "/connectors", { installation_id: state.installation_id, operation_id: state.operation_id,
        label: "AgentRun CLI deployment", capabilities: CAPABILITIES }, state.enrollment_token);
      if (!ID.test(result.connector?.id) || !wire.tokenOK(result.credential) || Object.entries(CAPABILITIES).some(([key, value]) => result.connector.capabilities?.[key] !== value)) throw ctx.cli.fail(1, "The destination did not confirm a setup-only connection.");
      if (state.connector_id && state.connector_id !== result.connector.id) throw ctx.cli.fail(2, "The destination returned a different connection during renewal. The original connection and pending snapshot were preserved.");
      if (expiry(result.credential_expires_at, "returned connection") <= now()) throw ctx.cli.fail(4, "The destination returned an expired connection. Check the destination clock before retrying; its journal was preserved.");
      state.connector_id = result.connector.id; state.credential = result.credential; wire.scrub.add(state.credential);
      state.credential_expires_at = result.credential_expires_at;
      delete state.enrollment_token; delete state.enrollment_expires_at; held.save();
    }
    if (!ID.test(state.connector_id) || !wire.tokenOK(state.credential)) throw ctx.cli.fail(2, "The saved source connection is invalid; it was preserved.");
    const route = `/connectors/${enc(state.connector_id)}`;
    if (!state.agent_id) {
      const imported = await wire.call("POST", `${route}/import`, { deployment: true, target_id: state.target_id,
        target: { ...captured.target, sync_only: true, capabilities: { ...captured.target.capabilities, launch: false } }, name: ctx.values.name || source.selector.name || basename(source.project) }, state.credential);
      if (!ID.test(imported.agent_id)) throw ctx.cli.fail(1, "The destination did not confirm the connected agent's identity.");
      state.agent_id = imported.agent_id; held.save();
    }
    if (!ID.test(state.agent_id)) throw ctx.cli.fail(2, "The saved agent identity is invalid; its journal was preserved.");
    const syncPath = `${route}/targets/${enc(state.target_id)}/sync`;
    let grant = await wire.call("POST", `${syncPath}/grant`, {}, state.credential);
    const grantOK = (one) => one.agent_id === state.agent_id && canonical(one.source) === canonical(source) && typeof one.enabled === "boolean"
      && typeof one.generation === "string" && one.generation.length > 0 && Number.isSafeInteger(one.sequence) && one.sequence >= -1;
    if (!grantOK(grant)) throw ctx.cli.fail(1, "The destination did not confirm this exact source's setup grant.");
    if (!grant.enabled) return blocked(ctx, target, { state: "paused", blockers: [{ code: "sync_paused", message: "Source sync is paused in the console. Resume it there before deploying." }] }, state.agent_id, wire.scrub);
    let pending = held.pending();
    if (pending && (pending.generation !== grant.generation || canonical(pending.snapshot?.source) !== canonical(source)
      || !Number.isSafeInteger(pending.sequence) || pending.sequence < 0 || !DIGEST.test(pending.snapshot?.digest))) throw ctx.cli.fail(2, "The pending snapshot belongs to a different source grant or is invalid. It was retained for review.");
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!pending && grant.snapshot === snapshot.digest && grant.attempt?.digest === snapshot.digest) break;
      if (!pending) {
        if (grant.sequence >= Number.MAX_SAFE_INTEGER - 1) throw ctx.cli.fail(2, "The source sequence is exhausted; its journal was preserved.");
        pending = { generation: grant.generation, sequence: grant.sequence + 1, snapshot }; held.queue(pending);
      }
      const accepted = await wire.call("POST", syncPath, pending, state.credential);
      if (!grantOK(accepted) || accepted.generation !== pending.generation || accepted.sequence !== pending.sequence
          || accepted.snapshot !== pending.snapshot.digest || accepted.attempt?.digest !== pending.snapshot.digest) throw ctx.cli.fail(1, "The destination did not acknowledge the exact complete snapshot. Its pending bytes were retained.");
      grant = accepted; state.snapshot = accepted.snapshot; held.save(); held.clear(); pending = undefined;
    }
    if (grant.snapshot !== snapshot.digest) throw ctx.cli.fail(1, "The destination has not accepted the selected snapshot; retry the same command.");
    return finish(ctx, state.agent_id, target, wire, { connectOnly, digest: snapshot.digest, summary });
  } finally { held.close(); }
}

async function finish(ctx, agentId, target, wire, { connectOnly = false, digest, summary = {} } = {}) {
  let status = await wire.call("GET", `/agents/${enc(agentId)}/source`);
  if (digest && status.snapshot !== digest) throw ctx.cli.fail(2, "The destination's source snapshot changed; inspect the agent before deploying it.");
  const selectedDigest = digest ?? status.snapshot;
  if (!["ready", "moved"].includes(status.state) || status.blockers?.length || !DIGEST.test(selectedDigest)) return blocked(ctx, target, status, agentId, wire.scrub);
  if (!connectOnly && !status.moved) {
    await wire.call("POST", `/agents/${enc(agentId)}/source/move`, { snapshot: selectedDigest });
    status = await wire.call("GET", `/agents/${enc(agentId)}/source`);
  }
  if (!connectOnly && (status.moved !== true || status.current_snapshot !== selectedDigest || status.state !== "moved" || status.blockers?.length)) throw ctx.cli.fail(1, "The destination has not confirmed managed execution of this snapshot. Read this agent's source status before retrying.");
  const agent = await wire.call("GET", `/agents/${enc(agentId)}`);
  const result = { ...summary, status: connectOnly ? "connected" : "deployed", target: target.base, agent_id: agentId,
    snapshot: selectedDigest, ...(typeof agent.revision === "string" ? { revision_id: agent.revision } : {}),
    ...(typeof agent.console_url === "string" ? { console_url: wire.scrub.cut(agent.console_url) } : {}) };
  say(ctx.io, connectOnly ? "The setup is connected and copied into AgentRun Console. Deploy it to switch execution to AgentRun."
    : "The agent is deployed in AgentRun Console. New runs execute on AgentRun with the copied setup.");
  print(ctx.io, result);
  return 0;
}

export async function deployConnected(ctx, agentId, target, { fetch: fetcher } = {}) {
  if (!ID.test(agentId)) throw ctx.cli.fail(2, "--connected requires an existing agent ID.");
  const wire = transport(ctx, target, fetcher);
  const status = await wire.call("GET", `/agents/${enc(agentId)}/source`);
  if (!["ready", "moved"].includes(status.state) || status.blockers?.length) return blocked(ctx, target, status, agentId, wire.scrub);
  if (ctx.values["dry-run"]) { print(ctx.io, { status: "preview", target: target.base, workspace_id: target.workspace ?? null, agent_id: agentId, state: status.state, snapshot: status.snapshot }); return 0; }
  if (!await confirmation(ctx, `Deploy connected agent ${agentId} into AgentRun Console?`)) return 2;
  return finish(ctx, agentId, target, wire, { digest: status.snapshot });
}

/** The user-facing command checks the destination before discovery and uses the installed source reader. */
export async function localSetup(ctx, { connectOnly = false, fetch: fetcher, capture, now } = {}) {
  let target = targetOf(ctx);
  if (ctx.values.connected !== undefined) {
    if (connectOnly || ctx.args.length || ["from", "source-agent", "profile", "force", "params", "pause-source", "agent", "name"].some(key => ctx.values[key] !== undefined)) throw ctx.cli.fail(2, "--connected selects an existing console agent; do not combine it with a local source or package options.");
    target = await supported(ctx, target, undefined, fetcher);
    return deployConnected(ctx, ctx.values.connected, target, { fetch: fetcher });
  }
  const selection = selected(ctx);
  outsideProject(ctx, selection.project);
  target = await supported(ctx, target, selection.runtime, fetcher);
  if (!capture) {
    const { SERVE_PACKAGE } = await import("./start.mjs");
    try { capture = (await import(`${SERVE_PACKAGE}/deployment-source`)).deploymentSource; }
    catch { throw ctx.cli.fail(5, "This CLI's matching source exporter is unavailable. Update the AgentRun CLI before deploying a local setup."); }
  }
  let captured;
  try { captured = await capture({ ...selection, environment: ctx.env, secretValues: [target.token] }); }
  catch (error) { throw ctx.cli.fail(2, `The local setup could not be captured (${error?.code ?? error?.name ?? "source_unavailable"}). Nothing was uploaded.`); }
  return deployCapturedSetup(ctx, captured, target, { fetch: fetcher, connectOnly, now });
}

export const SOURCE_OPTIONS = { workspace: { type: "string" }, from: { type: "string" }, "source-agent": { type: "string" }, profile: { type: "string" }, name: { type: "string" }, "dry-run": { type: "boolean" } };
export const SOURCE_HELP = [
  ["--workspace ID", "require the authenticated destination to be this workspace; sign in there first"],
  ["--from HARNESS", "copy the whole local setup: claude-code, codex or pi; SOURCE is its project directory (default: current directory)"],
  ["--source-agent NAME", "the selected named Claude Code agent"], ["--profile NAME", "the selected Codex profile"],
  ["--name NAME", "the console agent's name when first connected"], ["--dry-run", "inspect a local setup or connected agent without uploading or deploying"],
];
export const CONNECT = { command: ["connect"], pathParams: ["project"], argsOptional: true,
  summary: "Connect and copy a selected local agent setup into AgentRun Console, ready for deployment",
  route: ["POST /connectors/enrollment", "POST /connectors", "POST /connectors/{connector_id}/import", "POST /connectors/{connector_id}/targets/{target_id}/sync"],
  options: { ...SOURCE_OPTIONS, to: { type: "string" }, yes: { type: "boolean" } },
  help: [...SOURCE_HELP, ["--to URL", "cloud, or the selected AgentRun Console server's address"], ["--yes", "copy the selected setup without an interactive confirmation"]],
  run: ctx => localSetup(ctx, { connectOnly: true }) };
