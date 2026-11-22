// `agentrun deploy [AGENT|DIR] --to URL`: an agent's package sent to another AgentRun and made into its agent there. The
// package is a folder (DIR, default the current one: its agent.md, skills/, rules/ and evals/ and the answer's schema,
// nothing else of it) or an agent of this install (AGENT, read from its export, GET /agents/{id}/package). It is
// uploaded (POST /templates/import {files}), its plan read (apply with dry_run) and printed, applied once confirmed (on
// a terminal, or with --yes), and a lock written: DIR/.agentrun/deploy.json for a folder, the CLI config's deploy.json
// (by this install's address and the agent's id) for an install's agent. The lock names the target, the agent and its
// revision, and the package's sha256: the next deploy of the same package is up to date and sends nothing that writes;
// a changed one writes the agent's next revision; one whose target was edited since the lock is refused unless --force. `deploy rollback` makes the agent's previous revision current; `deploy delete` deletes the
// agent there and the lock here. Exit codes: 0 done or up to date, 2 refused (bad input, a link in the folder, edited on
// the target, not confirmed), 3 not runnable yet (keys or MCP servers the target lacks: nothing is made, the setup page
// printed when the target gives one), 1 the target refused otherwise or could not be reached, 4 no token for it.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { refusalExit } from "./login.mjs";
import { toUrl } from "./target.mjs";

/** What of a folder its package is, as the target reads it (its readPackage reads nothing else): agent.md, these trees,
 *  and the answer's schema file the manifest names at the folder's root. */
const MANIFEST = "agent.md";
const TREES = ["skills", "rules", "evals"];
/** What an upload takes (the server's import limits): refused here before anything is read past them. */
const MAX_FILES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const LOCK_FIELDS = ["target", "workspace", "agent_id", "revision_id", "package_sha256", "deployed_at"];
/** The CLI's deploy record's lock (privateRecord): how often a change looks for it and how long it waits. */
const LOCK_POLL_MS = 25;
const LOCK_WAIT_MS = 10_000;
/** A hold's folder left empty this long (tryHold): its maker ended before naming itself. */
const HOLD_EMPTY_MS = 60_000;

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

/** The server's manifest reader (its `manifest` export; the server is this package's one dependency), so agent.md is
 *  read here as the target reads it. Loaded for a folder's deploy alone. */
async function serverManifest(fail) {
  // Loaded here: start.mjs loads cli.mjs, which loads this module.
  const { SERVE_PACKAGE } = await import("./start.mjs");
  try {
    return (await import(`${SERVE_PACKAGE}/manifest`)).manifestOf;
  } catch {
    throw fail(2, `AgentRun's server (${SERVE_PACKAGE}) is not installed beside this command, and it is the server's reader that reads agent.md: nothing was sent.`);
  }
}

/** The answer's schema file agent.md names (`output: {schema}`) when it is a file at the package's root other than
 *  agent.md. One under skills/, rules/ or evals/ goes with its tree, and the target takes no other folder. None when
 *  the manifest names none or does not parse: the target refuses it then, in its own words. */
function rootSchemaOf(manifest, manifestOf) {
  const schema = manifestOf(manifest.toString("utf8"))?.output?.schema;
  return typeof schema === "string" && /^[^/\\]+$/.test(schema) && schema !== "." && schema !== ".." && schema !== MANIFEST ? schema : undefined;
}

/** A folder's package by path, each file its bytes: agent.md, the skills/, rules/ and evals/ trees, and the answer's
 *  schema file the manifest names at the root. Nothing else of the folder is sent (a .env, a key, a README, another
 *  folder), nor a hidden file or folder inside the trees. No agent.md, a symbolic link, or anything that is neither a file nor a folder refuses the deploy with
 *  nothing sent. */
async function readFolder(dir, fail) {
  const files = new Map();
  let bytes = 0;
  const entryOf = (rel) => {
    try {
      return lstatSync(join(dir, rel));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    }
  };
  const take = (rel, entry) => {
    if (entry.isSymbolicLink()) throw fail(2, `${rel} is a symbolic link: a package holds files and folders alone, so nothing was sent.`);
    if (entry.isDirectory()) {
      // A hidden file or folder (.env, .DS_Store) is never part of a package: the target leaves it out too.
      for (const one of readdirSync(join(dir, rel), { withFileTypes: true })) if (!one.name.startsWith(".")) take(`${rel}/${one.name}`, one);
      return;
    }
    if (!entry.isFile()) throw fail(2, `${rel} is neither a file nor a folder: a package holds files and folders alone, so nothing was sent.`);
    if (files.size >= MAX_FILES) throw fail(2, `The package holds over ${MAX_FILES} files: nothing was sent.`);
    const data = readFileSync(join(dir, rel));
    bytes += data.length;
    if (bytes > MAX_BYTES) throw fail(2, `The package's files are over the ${MAX_BYTES} bytes an import keeps: nothing was sent.`);
    files.set(rel, data);
  };
  const manifest = entryOf(MANIFEST);
  if (!manifest || manifest.isDirectory()) throw fail(2, `${dir} has no agent.md: a package is a folder with agent.md (its manifest in the front matter, the agent's instructions in the body), so nothing was sent.`);
  take(MANIFEST, manifest);
  for (const tree of TREES) {
    const entry = entryOf(tree);
    if (entry && !entry.isFile()) take(tree, entry);
  }
  const schema = rootSchemaOf(files.get(MANIFEST), await serverManifest(fail));
  const entry = schema === undefined ? undefined : entryOf(schema);
  if (entry && !entry.isDirectory()) take(schema, entry);
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

/** A hold on `held`: a folder made only where none is, holding one empty file named for its process (`host-pid`).
 *  Answers `{release}`, or `{owner}` (the process holding it; none while its maker has yet to name itself). A hold left
 *  by an ended process of this machine is taken, and no live one is ever touched: the ended one's file is removed by
 *  its name alone, the folder only by whoever removed that file (rmdir keeps a folder that holds anything), and a
 *  release removes only its own. A folder left empty (its maker ended before naming itself) is taken once
 *  HOLD_EMPTY_MS old. The parent is made again if another command's cleanup removed it meanwhile. */
function tryHold(held) {
  const host = hostname();
  const me = `${host}-${process.pid}`;
  for (let tries = 0; tries < 5; tries++) {
    try {
      mkdirSync(dirname(held), { recursive: true });
      mkdirSync(held);
      writeFileSync(join(held, me), "", { flag: "wx" });
      return {
        release() {
          rmSync(join(held, me), { force: true });
          try {
            rmdirSync(held);
          } catch {
            // not ours to remove
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
    }
    let names;
    let age;
    try {
      names = readdirSync(held);
      age = Date.now() - statSync(held).mtimeMs;
    } catch {
      continue; // let go of meanwhile
    }
    if (!names.length) {
      if (age < HOLD_EMPTY_MS) return { owner: undefined };
      try {
        rmdirSync(held);
      } catch {
        // named meanwhile
      }
      continue;
    }
    const at = names[0].lastIndexOf("-");
    const owner = { host: names[0].slice(0, at), pid: Number(names[0].slice(at + 1)) };
    if (owner.host !== host || !(owner.pid > 0) || alive(owner.pid)) return { owner };
    try {
      rmSync(join(held, names[0]));
    } catch {
      continue; // another took it first
    }
    try {
      rmdirSync(held);
    } catch {
      // named meanwhile
    }
  }
  return { owner: undefined };
}

/** One command at a time per source (its hold: tryHold), so two deploys of one source never both read no lock and each
 *  make an agent. Another process's refuses the command (exit 2) with nothing sent. Answers its letting go. */
function holdSource(held, fail) {
  const { release, owner } = tryHold(held);
  if (release) return release;
  throw fail(2, `Another agentrun deploy of this source is running${owner ? ` (process ${owner.pid}${owner.host === hostname() ? "" : ` on ${owner.host}`})` : ""}: try again once it ends, or remove ${held} if none is. Nothing was sent.`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** A folder's lock: DIR/.agentrun/deploy.json. Either a symbolic link is refused (nothing sent): the lock would be
 *  another folder's, which deploy, rollback and delete would then act on. */
function folderLock(dir, fail) {
  for (const rel of [".agentrun", ".agentrun/deploy.json"]) {
    let linked = false;
    try {
      linked = lstatSync(join(dir, rel)).isSymbolicLink();
    } catch {
      // not there
    }
    if (linked) throw fail(2, `${rel} is a symbolic link: a folder's deploy lock is its own file, so nothing was sent.`);
  }
  const file = join(dir, ".agentrun", "deploy.json");
  return {
    file,
    hold() {
      const release = holdSource(`${file}.held`, fail);
      return () => {
        release();
        try {
          rmdirSync(dirname(file));
        } catch {
          // it holds the lock, or something else of its owner's: kept
        }
      };
    },
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
    remove: () => rmSync(file, { force: true }),
  };
}

/** The CLI's own deploy record, its config's deploy.json (0600): an install agent's lock per `<install's address> <agent
 *  id>`, and under `targets` each address a deploy was sent to from here (a folder lock's target is trusted by it). A
 *  change that waits for another's says so on `io`. */
function privateRecord(env, cli, fail, io) {
  const file = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentrun", "deploy.json");
  const all = () => {
    const text = cli.privateFile(file);
    if (text === undefined) return {};
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value) && (value.targets === undefined || (Array.isArray(value.targets) && value.targets.every((one) => typeof one === "string")))) return value;
    } catch {
      // refused below
    }
    throw fail(2, `${file} is not the CLI's deploy record (an object of locks by install and agent, and its targets): fix or remove it.`);
  };
  // Each change is read and written holding `<file>.lock` (tryHold), so two CLIs deploying at the same time never write
  // back a record the other has changed since. A change waits for another's.
  const update = (change) => {
    const held = `${file}.lock`;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    let got;
    for (let waited = 0; !(got = tryHold(held)).release; waited += LOCK_POLL_MS) {
      if (waited >= LOCK_WAIT_MS) throw fail(1, `Another deploy holds ${file} (${held}${got.owner ? `, process ${got.owner.pid} on ${got.owner.host}` : ""}): try again once it ends, or remove ${held} if none is running.`);
      if (waited === 0 && io) say(io, `Waiting for another agentrun deploy${got.owner ? ` (process ${got.owner.pid}${got.owner.host === hostname() ? "" : ` on ${got.owner.host}`})` : ""} to save ${file}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
    try {
      writeAtomic(file, `${JSON.stringify(change(all()), null, 2)}\n`, 0o600);
    } finally {
      got.release();
    }
  };
  return {
    file,
    all,
    update,
    knows: (target) => (all().targets ?? []).includes(target),
    learn: (target) => update((record) => ((record.targets ?? []).includes(target) ? record : { ...record, targets: [...(record.targets ?? []), target] })),
  };
}

/** An install agent's lock, in the CLI's own record (privateRecord). */
function installLock(env, cli, source, agentId, fail, io) {
  const record = privateRecord(env, cli, fail, io);
  const key = `${source} ${agentId}`;
  return {
    file: record.file,
    hold() {
      mkdirSync(dirname(record.file), { recursive: true, mode: 0o700 });
      return holdSource(join(dirname(record.file), `deploy.${createHash("sha256").update(key).digest("hex").slice(0, 16)}.held`), fail);
    },
    read: () => lockOf(record.all()[key], record.file, fail),
    write: (lock) => record.update((all) => ({ ...all, [key]: lock })),
    remove: () => record.update(({ [key]: _, ...rest }) => rest),
  };
}

/** Where a deploy may send this CLI's key: an address `--to` names, else the lock's target. An install agent's lock is
 *  the CLI's own; a folder's comes with the folder, so one from elsewhere can name any address: its target is used only
 *  where this CLI has deployed before (privateRecord `targets`) or it is AgentRun cloud, else `--to` must name it. */
function targetFor({ values, env, cli }, from, lock, fail) {
  if (values.to !== undefined) return toOf(cli, values.to, env);
  if (lock === undefined || from.kind !== "folder") return lock?.target;
  if (lock.target === toOf(cli, "cloud", env) || privateRecord(env, cli, fail).knows(lock.target)) return lock.target;
  throw fail(2, `${from.lock.file} names ${lock.target} as its target, an address this CLI has not deployed to: pass --to ${lock.target} to deploy there. Nothing was sent (a lock comes with its folder, and the deploy sends your API key to its target).`);
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
async function sourceOf({ values, args, env, io, cli, releases }, fail) {
  const given = args[0] ?? ".";
  const dir = resolve(given);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    if (values["pause-source"]) throw fail(2, "--pause-source is for an agent deployed from an install (agentrun deploy AGENT_ID): a folder has no schedules running anywhere.");
    // A lock this CLI writes teaches it the target (privateRecord), so the next deploy of the folder needs no --to.
    const lock = folderLock(dir, fail);
    releases.push(lock.hold());
    const write = (written) => (lock.write(written), privateRecord(env, cli, fail, io).learn(written.target));
    return { kind: "folder", dir, lock: { ...lock, write }, files: () => readFolder(dir, fail) };
  }
  if (/[\\/]/.test(given) || given.startsWith(".")) throw fail(2, `${given} is not a folder: deploy takes a package folder or an agent id of this install.`);
  // The install the agent is on: --base-url, else as every command finds it; never with AGENTRUN_API_KEY, which is the
  // target's token here.
  const source = remote(cli, values, { ...env, AGENTRUN_API_KEY: "" }, io, undefined);
  const lock = installLock(env, cli, source.base, given, fail, io);
  releases.push(lock.hold());
  return {
    kind: "agent",
    agentId: given,
    source,
    lock,
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
  const base = targetFor(ctx, from, prior, fail);
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
  // A trigger the apply could not make yet (a connection or a feed the target lacks; a warning says which) is not in its
  // answer. The lock then names no package, so the next deploy of the same files applies again and makes it once it can.
  const there = new Set((applied.triggers ?? []).map((one) => one.name));
  const unmade = plan.triggers.filter((one) => one.action !== "remove" && !there.has(one.name)).map((one) => one.name);
  const written = { target: to.base, workspace: null, agent_id: applied.agent_id, revision_id: applied.revision_id, package_sha256: unmade.length ? null : sha, deployed_at: new Date().toISOString() };
  from.lock.write(written);
  for (const warning of applied.warnings ?? []) say(io, `Warning (${warning.field}): ${warning.message}`);
  if (unmade.length) say(io, `Not made on ${to.base} yet: ${unmade.join(", ")}. Until they are, the lock names no package, so the next deploy applies again (keeping the revision when nothing else changed).`);
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
  return { from, lock, to: remote(cli, values, env, ctx.io, targetFor(ctx, from, lock, cli.fail)) };
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
  // A 404 (or 410) means gone only when the agent is not there: a server that does not serve the route (an older
  // install, a front door without it) answers 404 too, while the agent is still there and running. Then nothing is
  // deleted and the lock stays.
  const absent = (status) => status === 404 || status === 410;
  const mustBeGone = async (step, after) => {
    const { status } = await to.call("GET", `/agents/${enc(lock.agent_id)}`, undefined, [404, 410]);
    if (!absent(status)) throw ctx.cli.fail(2, `${to.base} did not ${step} ${lock.agent_id}; nothing was deleted${after}. The lock ${from.lock.file} is kept.`);
  };
  // An agent is deleted once archived (which turns its triggers off, so no run starts) and once no run of it is live:
  // each one the DELETE names is cancelled, as the confirmation said, and the DELETE sent again.
  const archived = await to.call("POST", `/agents/${enc(lock.agent_id)}/archive`, undefined, [404, 409, 410]);
  if (absent(archived.status)) await mustBeGone("archive", "");
  for (let round = 1; !absent(archived.status); round++) {
    const last = round === 5;
    const { status, value } = await to.call("DELETE", `/agents/${enc(lock.agent_id)}`, undefined, last ? [404, 410] : [404, 409, 410]);
    if (absent(status)) await mustBeGone("delete", " (it stays archived there)");
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
  // What the command holds (its source's hold: sourceOf), let go of however it ends.
  const releases = [];
  try {
    return await work({ ...ctx, releases });
  } catch (error) {
    if (error instanceof Stopped) return error.code;
    throw error;
  } finally {
    for (const release of releases) release();
  }
};

const SOURCE = ["SOURCE", "a package folder (default: the current one), or an agent id of this install (its export)"];
const TO = ["--to URL", "where: cloud (the hosted AgentRun; AGENTRUN_CLOUD_URL overrides its address), or an AgentRun's address; left out after the first deploy, the lock's target (a folder's, only where this CLI deployed it, or cloud)"];
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
