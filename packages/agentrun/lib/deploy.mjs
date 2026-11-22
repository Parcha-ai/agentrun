// `agentrun deploy [AGENT|DIR] --to URL`: an agent's package sent to another AgentRun and made into its agent there. The
// package is a folder (DIR, default the current one) or an agent of this install (AGENT, read from its export, GET
// /agents/{id}/package). It is uploaded (POST /templates/import {files}), its plan read (apply with dry_run) and printed,
// applied once confirmed (on a terminal, or with --yes), and a lock written: DIR/.agentrun/deploy.json for a folder, the
// CLI config's deploy.json (by this install's address and the agent's id) for an install's agent. The lock names the
// target, the agent and its revision, and the package's sha256: the next deploy of the same package is up to date and
// sends nothing that writes; a changed one writes the agent's next revision; one whose target was edited since the lock
// is refused unless --force. `deploy rollback` makes the agent's previous revision current; `deploy delete` deletes the
// agent there and the lock here. Exit codes: 0 done or up to date, 2 refused (bad input, a link in the folder, edited on
// the target, not confirmed), 3 not runnable yet (keys or MCP servers the target lacks: nothing is made, the setup page
// printed when the target gives one), 1 the target refused otherwise or could not be reached, 4 no token for it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { refusalExit } from "./login.mjs";
import { toUrl } from "./target.mjs";

/** The folder's own files a package never holds: the lock's folder and git's. */
const SKIPPED = new Set([".agentrun", ".git"]);
/** What an upload takes (the server's import limits): refused here before anything is read past them. */
const MAX_FILES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const LOCK_FIELDS = ["target", "workspace", "agent_id", "revision_id", "package_sha256", "deployed_at"];

/** A request's refusal already said on stderr: the command ends with `code`. */
class Stopped {
  constructor(code) {
    this.code = code;
  }
}

/** A package's sha256: hex over its files sorted by path, each `path NUL bytes NUL` (the server's for an upload). */
export function packageSha256(files) {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) hash.update(path).update("\0").update(files.get(path)).update("\0");
  return hash.digest("hex");
}

/** A folder's files by path, each its bytes. A symbolic link, or anything that is neither a file nor a folder, refuses
 *  the deploy with nothing sent, in the import's own words. */
function readFolder(dir, fail) {
  const files = new Map();
  let bytes = 0;
  const walk = (sub) => {
    for (const entry of readdirSync(sub ? join(dir, sub) : dir, { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (!sub && SKIPPED.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw fail(2, `${rel} is a symbolic link: a package holds files and folders alone, so nothing was sent.`);
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.isFile()) throw fail(2, `${rel} is neither a file nor a folder: a package holds files and folders alone, so nothing was sent.`);
      if (files.size >= MAX_FILES) throw fail(2, `The package holds over ${MAX_FILES} files: nothing was sent.`);
      const data = readFileSync(join(dir, rel));
      bytes += data.length;
      if (bytes > MAX_BYTES) throw fail(2, `The package's files are over the ${MAX_BYTES} bytes an import keeps: nothing was sent.`);
      files.set(rel, data);
    }
  };
  walk("");
  return files;
}

/** The files as an upload sends them: text as it is, unless JSON's escapes make it longer than base64 would (a file of
 *  newlines or control characters), and any other bytes base64. So the body stays within the base64 size the server's
 *  upload limit allows for. */
const filesBody = (files) => [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, data]) => {
  const text = data.toString("utf8");
  const base64 = data.toString("base64");
  return Buffer.from(text, "utf8").equals(data) && Buffer.byteLength(JSON.stringify(text)) <= base64.length + 2 ? { path, encoding: "utf8", content: text } : { path, encoding: "base64", content: base64 };
});

/** A lock read back: its fields as written, or a refusal naming the file. */
function lockOf(value, file, fail) {
  if (value === undefined) return undefined;
  const ok = value && typeof value === "object" && ["target", "agent_id", "revision_id"].every((field) => typeof value[field] === "string") && (value.package_sha256 === null || typeof value.package_sha256 === "string");
  if (!ok) throw fail(2, `${file} is not a deploy lock (target, agent_id, revision_id, package_sha256): fix or remove it.`);
  return Object.fromEntries(LOCK_FIELDS.map((field) => [field, value[field] ?? null]));
}

const writeAtomic = (file, text, mode) => {
  mkdirSync(dirname(file), { recursive: true, ...(mode ? { mode: 0o700 } : {}) });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, mode ? { mode } : {});
  renameSync(temp, file);
};

/** A folder's lock: DIR/.agentrun/deploy.json. */
function folderLock(dir, fail) {
  const file = join(dir, ".agentrun", "deploy.json");
  return {
    file,
    read() {
      if (!existsSync(file)) return undefined;
      let value;
      try {
        value = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        value = null;
      }
      return lockOf(value, file, fail);
    },
    write: (lock) => writeAtomic(file, `${JSON.stringify(lock, null, 2)}\n`),
    remove() {
      rmSync(file, { force: true });
      try {
        rmdirSync(dirname(file));
      } catch {
        // the folder holds something else of its owner's: kept
      }
    },
  };
}

/** An install agent's lock: the CLI config's deploy.json (0600), one lock per `<install's address> <agent id>`. */
function installLock(env, cli, source, agentId, fail) {
  const file = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentrun", "deploy.json");
  const key = `${source} ${agentId}`;
  const all = () => {
    const text = cli.privateFile(file);
    if (text === undefined) return {};
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // refused below
    }
    throw fail(2, `${file} is not the CLI's deploy locks (an object of locks by install and agent): fix or remove it.`);
  };
  const save = (locks) => writeAtomic(file, `${JSON.stringify(locks, null, 2)}\n`, 0o600);
  return {
    file,
    read: () => lockOf(all()[key], file, fail),
    write: (lock) => save({ ...all(), [key]: lock }),
    remove() {
      const { [key]: _, ...rest } = all();
      save(rest);
    },
  };
}

/** The exit code of a target's refusal: 3 for a package not runnable there, 2 for one it refused as given (its input,
 *  a stale revision, a trigger name another owns), else the CLI's own (4 for the token, 5 for an operation it lacks). */
const exitOf = (status, code) => (status === 409 && code === "agent_not_runnable" ? 3 : status === 422 || status === 412 || (status === 409 && code === "name_taken") ? 2 : refusalExit(status));

/** Requests to one AgentRun (`base`, else the one every command finds), with its token (the CLI's custody: targetOf,
 *  clientOf): `call(method, path, body?, allow?)` answers `{status, value}`, or prints the refusal and stops with its
 *  exit code. A server not reached is exit 1 here: 3 is a package not runnable. */
function remote(cli, values, env, io, base) {
  const target = cli.targetOf(base === undefined ? values : { ...values, "base-url": base }, env);
  const client = cli.clientOf(target, io);
  const call = async (method, path, body, allow = []) => {
    let response;
    try {
      response = await client.fetch(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    } catch (error) {
      // Only the cause's code: a fetch error's message can quote a header, the token's among them.
      throw cli.fail(1, `Cannot reach ${target.base} (${error?.cause?.code ?? error?.name}).`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    let value;
    try {
      value = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined;
    } catch {
      value = undefined;
    }
    if (response.ok || allow.includes(response.status)) {
      if (response.ok && response.status !== 204 && value === undefined) throw cli.fail(1, `${method} ${path} on ${target.base} answered ${response.status} with no JSON.`);
      return { status: response.status, value };
    }
    io.stderr.write(bytes.length ? bytes : `${response.status} ${response.statusText}`);
    if (!bytes.length || bytes.at(-1) !== 10) io.stderr.write("\n");
    throw new Stopped(exitOf(response.status, value?.error?.code));
  };
  return { base: target.base, call };
}

const enc = encodeURIComponent;
const say = (io, line) => io.stderr.write(`${line}\n`);
/** `--to` as an API base (target.mjs toUrl), checked as every base URL is (exit 2 naming --to). */
const toOf = (cli, given, env) => cli.baseOf(toUrl(given, env), "--to");

/** Yes on a terminal, or --yes: false means the command stops (exit 2) with `asked` said. */
async function confirmed(io, values, question, offTerminal) {
  if (values.yes) return true;
  if (!io.stdin.isTTY) return say(io, offTerminal), false;
  const rl = createInterface({ input: io.stdin, output: io.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** The plan's lines, as the deploy prints them before it applies anything. */
function planLines(base, template, sha, plan, grants) {
  const rows = [];
  rows.push([plan.action === "revise" ? "~" : "+", "agent", template.name, plan.action === "revise" ? `revise ${plan.agent_id}` : "new"]);
  for (const name of plan.missing_secrets) rows.push(["!", "key", name, "missing: add it on the target"]);
  for (const need of plan.unmatched_mcp) rows.push([need.required ? "!" : "?", "tools", `${need.toolkit} (${need.source})`, need.required ? "missing: save a server of it on the target" : "missing: the agent runs without them"]);
  for (const tool of grants) rows.push(["+", "grant", tool, "allowed"]);
  for (const trigger of plan.triggers) {
    const mark = { create: "+", update: "~", remove: "-", skip: "!" }[trigger.action] ?? "?";
    rows.push([mark, "trigger", trigger.name, `${trigger.kind}${trigger.action === "skip" ? ` skipped: ${trigger.reason ?? ""}` : trigger.reason ? ` (${trigger.reason})` : ""}`]);
  }
  if (plan.computer) rows.push([" ", "computer", plan.computer.kind, plan.computer.provider ?? ""]);
  const width = Math.max(...rows.map(([, , name]) => name.length));
  return [`Plan for ${base} (${template.id}, sha256 ${sha.slice(0, 12)}):`, ...rows.map(([mark, kind, name, what]) => `  ${mark} ${kind.padEnd(8)} ${name.padEnd(width)}  ${what}`.trimEnd())];
}

/** What the command deploys: a folder's files, or an install agent's export; its lock; and, for an install agent, the
 *  install it came from. */
async function sourceOf({ values, args, env, io, cli }, fail) {
  const given = args[0] ?? ".";
  const dir = resolve(given);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    if (values["pause-source"]) throw fail(2, "--pause-source is for an agent deployed from an install (agentrun deploy AGENT_ID): a folder has no schedules running anywhere.");
    return { kind: "folder", dir, lock: folderLock(dir, fail), files: () => readFolder(dir, fail) };
  }
  if (/[\\/]/.test(given) || given.startsWith(".")) throw fail(2, `${given} is not a folder: deploy takes a package folder or an agent id of this install.`);
  // The install the agent is on: --base-url, else as every command finds it; never with AGENTRUN_API_KEY, which is the
  // target's token here.
  const source = remote(cli, values, { ...env, AGENTRUN_API_KEY: "" }, io, undefined);
  return {
    kind: "agent",
    agentId: given,
    source,
    lock: installLock(env, cli, source.base, given, fail),
    async files() {
      // No such agent here, or one this install does not export (409 not_exportable: a workflow, an agent with no
      // revision, one another system owns): refused as given, as `agentrun export` refuses it.
      const { status, value } = await source.call("GET", `/agents/${enc(given)}/package`, undefined, [404, 409, 422]);
      if (status !== 200) throw fail(2, `${source.base} does not export ${given}: ${value?.error?.message ?? status}. Nothing was sent.`);
      const blocked = Array.isArray(value?.report?.blocked) ? value.report.blocked : [];
      if (blocked.length) {
        for (const one of blocked) say(io, `  ! ${one.kind} ${one.name}: ${one.reason}`);
        throw fail(2, `The agent ${given} can't be deployed as it is: its export blocks on what is listed above. Nothing was sent.`);
      }
      for (const one of Array.isArray(value?.report?.remade) ? value.report.remade : []) say(io, `  ~ ${one.kind} ${one.name}: ${one.reason}`);
      if (!Array.isArray(value?.files)) throw fail(1, `The agent ${given}'s export holds no files.`);
      const files = new Map(value.files.map((file) => [file.path, Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")]));
      if (typeof value.sha256 === "string" && value.sha256 !== packageSha256(files)) throw fail(1, `The agent ${given}'s export names a sha256 its files do not have.`);
      return files;
    },
  };
}

/** The schedules of the install agent that still fire there: turned off with --pause-source, else warned of. */
async function sourceSchedules(io, from, values) {
  const { value } = await from.source.call("GET", "/triggers");
  const live = (value?.triggers ?? []).filter((one) => (one.agent_id ?? one.target?.agent_id) === from.agentId && one.source?.kind === "schedule" && one.enabled);
  if (!live.length) return;
  if (!values["pause-source"]) return say(io, `Warning: the agent's schedules (${live.map((one) => one.name).join(", ")}) still run on ${from.source.base}, so each fires in both places. --pause-source turns them off there.`);
  for (const one of live) {
    await from.source.call("PATCH", `/triggers/${enc(one.id ?? one.trigger_id)}`, { enabled: false });
    say(io, `Paused ${one.name} on ${from.source.base}.`);
  }
}

async function deploy(ctx) {
  const { values, env, io, cli } = ctx;
  const fail = cli.fail;
  const from = await sourceOf(ctx, fail);
  const files = await from.files();
  const sha = packageSha256(files);
  let parameters;
  if (values.params !== undefined) {
    try {
      parameters = JSON.parse(readFileSync(values.params, "utf8"));
    } catch (error) {
      throw fail(2, `--params ${values.params}: ${error.code === "ENOENT" ? "no such file" : error instanceof SyntaxError ? "not JSON" : `cannot be read (${error.code})`}.`);
    }
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw fail(2, `--params ${values.params} is not a JSON object of the package's parameters.`);
  }
  const prior = from.lock.read();
  const base = values.to !== undefined ? toOf(cli, values.to, env) : prior?.target;
  if (base === undefined) throw fail(2, `Where to? Pass --to URL (cloud, or an AgentRun's address); a deploy after the first reads it from ${from.lock.file}.`);
  const lock = prior && prior.target === base ? prior : undefined;
  if (prior && !lock) say(io, `The lock names ${prior.target}; this deploy is to ${base}, so it makes the agent there and the lock names it after.`);
  const to = remote(cli, values, env, io, base);

  // The lock's agent as the target has it now: gone (deployed anew), edited since (refused unless --force), or the same
  // revision with the same package (up to date: nothing sent that writes, unless --params asks for parameters the lock
  // can't vouch for; the apply then keeps the revision when they are the same).
  let onto;
  if (lock) {
    const { status, value: agent } = await to.call("GET", `/agents/${enc(lock.agent_id)}`, undefined, [404, 410]);
    if (status !== 200) say(io, `The agent ${lock.agent_id} is gone from ${to.base}: deploying it anew.`);
    else {
      if (agent.revision !== lock.revision_id && !values.force) throw fail(2, `The agent ${lock.agent_id} on ${to.base} was edited in the cloud; --force to replace it with this package (its current revision is not the one ${from.lock.file} names).`);
      if (agent.revision === lock.revision_id && lock.package_sha256 === sha && parameters === undefined) {
        say(io, `This package is up to date on ${to.base}: the agent ${lock.agent_id}, revision ${lock.revision_id}. Nothing was sent.`);
        if (from.kind === "agent") await sourceSchedules(io, from, values);
        ctx.io.stdout.write(`${JSON.stringify({ status: "up_to_date", target: to.base, agent_id: lock.agent_id, revision_id: lock.revision_id, package_sha256: sha })}\n`);
        return 0;
      }
      // Onto the revision read here: one written after this read (an edit, another deploy) makes the apply 412.
      onto = { agent_id: lock.agent_id, revision: agent.revision };
    }
  }

  const { value: imported } = await to.call("POST", "/templates/import", { files: filesBody(files) });
  const template = imported.template;
  const grants = (template.mcp ?? []).flatMap((need) => (need.tools ?? []).map((tool) => tool.tool)).filter((tool) => typeof tool === "string");
  // The plan and the apply both name the package uploaded here (its sha): another upload of the same name in between
  // makes them 412, never applies a package this deploy did not plan.
  const body = { grants, sha: template.sha, ...(parameters ? { parameters } : {}), ...(onto ?? {}) };
  const { value: planned } = await to.call("POST", `/templates/${enc(template.id)}/apply`, { ...body, dry_run: true });
  const plan = planned.plan;
  for (const line of planLines(to.base, template, sha, plan, grants)) say(io, line);
  if (plan.missing_secrets.length || plan.unmatched_mcp.some((need) => need.required)) {
    const setup = typeof planned.setup_url === "string" ? planned.setup_url : typeof plan.setup_url === "string" ? plan.setup_url : undefined;
    say(io, `Not runnable yet on ${to.base}: add what is marked ! there, then deploy again. Nothing was created.${setup ? ` Finish setup: ${setup}` : ""}`);
    io.stdout.write(`${JSON.stringify({ status: "not_runnable", target: to.base, template: template.id, plan, ...(setup ? { setup_url: setup } : {}) })}\n`);
    return 3;
  }
  if (!(await confirmed(io, values, `Apply this plan to ${to.base}?`, "Not applied: off a terminal, deploy applies only with --yes (read the plan above first)."))) {
    if (io.stdin.isTTY) say(io, "Not applied.");
    return 2;
  }
  const { value: applied } = await to.call("POST", `/templates/${enc(template.id)}/apply`, body);
  const written = { target: to.base, workspace: null, agent_id: applied.agent_id, revision_id: applied.revision_id, package_sha256: sha, deployed_at: new Date().toISOString() };
  from.lock.write(written);
  for (const warning of applied.warnings ?? []) say(io, `Warning (${warning.field}): ${warning.message}`);
  say(io, `Deployed ${template.name} to ${to.base}: the agent ${applied.agent_id}, revision ${applied.revision_version} (${applied.agent_change}). Lock: ${from.lock.file}.`);
  if (from.kind === "agent") await sourceSchedules(io, from, values);
  io.stdout.write(`${JSON.stringify({ status: "deployed", ...written, revision_version: applied.revision_version, agent_change: applied.agent_change, template: template.id, warnings: applied.warnings ?? [] })}\n`);
  return 0;
}

/** The lock a rollback or delete acts on, and the target it names (--to wins). */
async function locked(ctx) {
  const { values, env, cli } = ctx;
  const from = await sourceOf(ctx, cli.fail);
  const lock = from.lock.read();
  if (!lock) throw cli.fail(2, `Nothing deployed here: ${from.lock.file} does not exist.`);
  const base = values.to !== undefined ? toOf(cli, values.to, env) : lock.target;
  return { from, lock, to: remote(cli, values, env, ctx.io, base) };
}

async function rollback(ctx) {
  const { io, cli } = ctx;
  const { from, lock, to } = await locked(ctx);
  const { value: agent } = await to.call("GET", `/agents/${enc(lock.agent_id)}`);
  // Every page: the previous revision may be on any of them.
  const revisions = [];
  for (let cursor; ; ) {
    const { value: listed } = await to.call("GET", `/agents/${enc(lock.agent_id)}/revisions${cursor ? `?cursor=${enc(cursor)}` : ""}`);
    revisions.push(...(listed.revisions ?? []));
    if (typeof listed.next_cursor !== "string" || !listed.next_cursor || listed.next_cursor === cursor) break;
    cursor = listed.next_cursor;
  }
  const current = revisions.find((one) => one.revision === agent.revision);
  const previous = revisions.filter((one) => current && one.version < current.version).sort((a, b) => b.version - a.version)[0];
  if (!previous) throw cli.fail(2, `The agent ${lock.agent_id} on ${to.base} has no revision before its current one: nothing to roll back to.`);
  await to.call("POST", `/agents/${enc(lock.agent_id)}/current`, { revision: previous.revision });
  // The lock follows the revision now current. Which package that revision was made from is not read anywhere (the
  // agent's `template` is the newest package applied, not the restored one), so the lock names none: the next deploy is
  // never up to date, and its apply keeps this revision when the package and parameters are the ones it holds.
  const written = { ...lock, target: to.base, revision_id: previous.revision, package_sha256: null, deployed_at: new Date().toISOString() };
  from.lock.write(written);
  say(io, `Rolled back: the agent ${lock.agent_id} on ${to.base} runs revision ${previous.version} again (it was on ${current.version}).`);
  io.stdout.write(`${JSON.stringify({ status: "rolled_back", target: to.base, agent_id: lock.agent_id, revision_id: previous.revision, version: previous.version, from_revision_id: agent.revision })}\n`);
  return 0;
}

async function remove(ctx) {
  const { io, values } = ctx;
  const { from, lock, to } = await locked(ctx);
  if (!(await confirmed(io, values, `Delete the agent ${lock.agent_id} from ${to.base}, its runs and its learning with it?`, `Not deleted: off a terminal, deploy delete deletes only with --yes.`))) {
    if (io.stdin.isTTY) say(io, "Not deleted.");
    return 2;
  }
  // An agent is deleted once archived (which turns its triggers off, so no run starts) and once no run of it is live:
  // each one the DELETE names is cancelled, as the confirmation said, and the DELETE sent again. One already gone is gone.
  const archived = await to.call("POST", `/agents/${enc(lock.agent_id)}/archive`, undefined, [404, 409, 410]);
  for (let round = 1; archived.status !== 404 && archived.status !== 410; round++) {
    const last = round === 5;
    const { status, value } = await to.call("DELETE", `/agents/${enc(lock.agent_id)}`, undefined, last ? [404, 410] : [404, 409, 410]);
    if (status !== 409) break;
    if (value?.error?.code !== "run_not_final") {
      io.stderr.write(`${JSON.stringify(value)}\n`);
      return 1;
    }
    for (const run of Array.isArray(value.error.details?.runs) ? value.error.details.runs : []) {
      await to.call("POST", `/runs/${enc(run)}/cancel`, undefined, [404, 409, 410]);
      say(io, `Cancelled the run ${run}.`);
    }
    await new Promise((done) => setTimeout(done, 200 * round));
  }
  from.lock.remove();
  say(io, `Deleted the agent ${lock.agent_id} from ${to.base}, and the lock ${from.lock.file}.`);
  io.stdout.write(`${JSON.stringify({ status: "deleted", target: to.base, agent_id: lock.agent_id })}\n`);
  return 0;
}

/** Each entry's `run`, its stop (a refusal already said) its exit code. */
const ending = (work) => async (ctx) => {
  try {
    return await work(ctx);
  } catch (error) {
    if (error instanceof Stopped) return error.code;
    throw error;
  }
};

const SOURCE = ["SOURCE", "a package folder (default: the current one), or an agent id of this install (its export)"];
const TO = ["--to URL", "where: cloud (the hosted AgentRun; AGENTRUN_CLOUD_URL overrides its address), or an AgentRun's address; left out after the first deploy, the lock's target"];
const TOKEN = "The target's token: AGENTRUN_API_KEY, else api_key in the CLI config for that address. An install agent's own install is --base-url, else as every command finds it.";

export const DEPLOY = {
  command: ["deploy"],
  pathParams: ["source"],
  argsOptional: true,
  summary: "Deploy an agent's package to another AgentRun: upload, plan, apply, lock (deploy rollback, deploy delete)",
  help: [
    SOURCE,
    TO,
    ["--yes", "apply without asking (needed off a terminal)"],
    ["--force", "replace an agent edited on the target since the last deploy"],
    ["--params FILE", "the package's parameters, a JSON object"],
    ["--pause-source", "an install agent: turn its schedules off on this install once deployed (else they fire in both places)"],
    ["", TOKEN],
    ["", "Exit codes: 0 deployed or up to date, 2 refused (bad input, edited on the target, not confirmed), 3 not runnable yet there (nothing made), 1 the target refused or was not reached."],
  ],
  options: { to: { type: "string" }, yes: { type: "boolean" }, force: { type: "boolean" }, params: { type: "string" }, "pause-source": { type: "boolean" } },
  run: ending(deploy),
};

export const DEPLOY_ROLLBACK = {
  command: ["deploy", "rollback"],
  pathParams: ["source"],
  argsOptional: true,
  summary: "Make the deployed agent's previous revision current on its target, and the lock follow",
  help: [SOURCE, ["--to URL", "the target, in place of the lock's"], ["", TOKEN]],
  options: { to: { type: "string" } },
  run: ending(rollback),
};

export const DEPLOY_DELETE = {
  command: ["deploy", "delete"],
  pathParams: ["source"],
  argsOptional: true,
  summary: "Delete the deployed agent from its target (archived first), and the lock here",
  help: [SOURCE, ["--to URL", "the target, in place of the lock's"], ["--yes", "delete without asking (needed off a terminal)"], ["", TOKEN]],
  options: { to: { type: "string" }, yes: { type: "boolean" } },
  run: ending(remove),
};
