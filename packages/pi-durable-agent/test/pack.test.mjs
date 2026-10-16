import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  AgentHomeError, carryBack, createAgentHome, EXPORTABLE_KINDS, homeRevision, importPack, openAgentHome, packHome, readAgentHome, readPack, refreshAgentHome, setAlias, setBindings, startRun,
} from "../dist/index.js";
import { buildSignedInHome, checkExportClean, SIGN_IN_MARKER, signedInHomeSkip } from "./fixtures/signed-in-home.mjs";
import { tarSize } from "../dist/tar.js";
import { listTar, manifestOf, tamper, withManifest, writeTarFile } from "./pack-support.mjs";
import { ctx, openSession, scratch } from "./support.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = Date.parse("2026-10-16T05:00:00.000Z");
const COOKIE = "CHROME-COOKIE-MARKER";
const skip = { skip: signedInHomeSkip };

const dirSuffix = (member) => (member.typeflag === "5" && !member.name.endsWith("/") ? `${member.name}/` : member.name);
const names = (file) => listTar(file).map(dirSuffix);
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** Every path under `dir` with the digest of each file, so "left unchanged" is a comparison. A SQLite side file is left
 *  out: merely reading a store, as `homeRevision` does, may create one. */
const tree = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => !/-(wal|shm)$/.test(entry.name)).map((entry) => {
  const file = path.join(entry.parentPath, entry.name);
  return `${path.relative(dir, file)}${entry.isFile() ? `:${sha(file)}` : entry.isSymbolicLink() ? ":link" : "/"}`;
}).sort();
const rejects = (promise, code) => assert.rejects(promise, (error) => error instanceof AgentHomeError && error.code === code, `expected ${code}`);

/** The signed-in fixture home, plus a source sha, work files of every kind a pack must or must not carry, and a
 *  `chrome/`, `repo/` and `tmp/` beside the run directories. With `live`, a second run that has not been carried back. */
async function fixture({ live = false } = {}) {
  const dir = await scratch();
  const built = await buildSignedInHome(dir);
  const { home, runId } = built;
  const state = await readAgentHome(home);
  await refreshAgentHome(home, { sha: SHA, definition: state.definition, skills: Object.fromEntries(Object.entries(state.skills).map(([key, skill]) => [key, skill.content])) });
  const work = path.join(home.dir, "runs", runId, "work");
  mkdirSync(path.join(work, "sub", "deep"), { recursive: true });
  writeFileSync(path.join(work, "notes.txt"), "hello\n");
  writeFileSync(path.join(work, "sub", "deep", "a.md"), "# deep\n");
  writeFileSync(path.join(work, ".env"), "TOKEN=nope\n");
  symlinkSync("notes.txt", path.join(work, "link"));
  for (const outside of ["chrome", "repo", "tmp"]) mkdirSync(path.join(home.dir, outside));
  writeFileSync(path.join(home.dir, "chrome", "Cookies"), COOKIE);
  writeFileSync(path.join(home.dir, "repo", "README.md"), "# repo\n");
  writeFileSync(path.join(home.dir, "tmp", "scratch.txt"), "scratch\n");
  linkSync(path.join(home.dir, "chrome", "Cookies"), path.join(work, "stolen"));
  if (live) {
    await startRun(home, { runId: "live-1", host: "fixture-host" });
    writeFileSync(path.join(home.dir, "runs", "live-1", "work", "partial.txt"), "in progress\n");
  }
  return { ...built, dir, out: path.join(dir, "home.tar"), work };
}

const CLEAN = ["manifest.json", "agent.sqlite", "runs/signed-in/work/", "runs/signed-in/work/notes.txt", "runs/signed-in/work/sub/", "runs/signed-in/work/sub/deep/", "runs/signed-in/work/sub/deep/a.md"];

test("a pack holds its allowlist in a fixed order, and the manifest says what the source had", skip, async () => {
  const f = await fixture();
  const { manifest, skipped } = await packHome(f.home, { out: f.out, now: NOW });
  assert.deepEqual(names(f.out), CLEAN);
  assert.deepEqual(skipped.sort(), ["runs/signed-in/work/.agents", "runs/signed-in/work/.env", "runs/signed-in/work/link", "runs/signed-in/work/stolen"]);
  const state = await readAgentHome(f.home);
  assert.deepEqual(manifest, {
    format: "agentrun.home/1", agent_id: state.identity.id, definition: state.definition,
    skills: [{ path: "practice/SKILL.md", sha256: state.skills["practice/SKILL.md"].sha256, size_bytes: Buffer.byteLength(state.skills["practice/SKILL.md"].content) }],
    sign_ins: [{ key: "practice", provider: "browserbase" }], vault: [], runs: { count: 1, live: 0 },
    size_bytes: statSync(f.out).size, created_at: "2026-10-16T05:00:00.000Z", source: { sha: SHA, refreshed_at: state.source.refreshedAt },
  });
  assert.deepEqual(manifestOf(listTar(f.out)), manifest);
  assert.equal(state.source.sha, SHA);
  const read = await readPack(f.out);
  assert.equal(read.ok, true);
  assert.deepEqual(read.checks.map((check) => [check.name, check.status]), [["format", "ok"], ["definition", "ok"], ["sign_ins", "warn"], ["size", "ok"], ["live_runs", "ok"]]);
  assert.deepEqual(read.manifest, manifest);
});

test("members are sorted, owned by 0/0, mode 0644 or 0755, and stamped with the manifest's created_at", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const second = path.join(f.dir, "again.tar");
  await packHome(f.home, { out: second, now: NOW });
  const headers = (file) => listTar(file).map(({ name, typeflag, mode, uid, gid, mtime, size }) => ({ name, typeflag, mode, uid, gid, mtime, size }));
  const members = headers(f.out);
  for (const member of members) {
    assert.equal(member.uid, 0);
    assert.equal(member.gid, 0);
    assert.equal(member.mtime, Math.floor(NOW / 1000));
    assert.equal(member.mode, member.typeflag === "5" ? 0o755 : 0o644);
  }
  assert.deepEqual(members.map((member) => member.name).slice(2), members.map((member) => member.name).slice(2).sort());
  assert.deepEqual(headers(second).filter((member) => member.name !== "agent.sqlite" && member.name !== "manifest.json"), members.filter((member) => member.name !== "agent.sqlite" && member.name !== "manifest.json"));
});

test("no sign-in, lease, binding, alias or host reaches the pack, in rows or in bytes; agent.sqlite is a vacuumed new store", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  checkExportClean(f.out);
  assert.ok(!readFileSync(f.out).includes(COOKIE), "no chrome file");
  assert.ok(!readFileSync(f.out).includes("fixture-host") && !readFileSync(f.out).includes("ext-fixture-1"), "no host, no alias");
  const file = path.join(f.dir, "from-pack.sqlite");
  writeFileSync(file, listTar(f.out).find((member) => member.name === "agent.sqlite").data);
  const bytes = readFileSync(file);
  assert.deepEqual([bytes[18], bytes[19]], [1, 1], "not in WAL mode: a vacuum rewrote it");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA freelist_count").get().freelist_count, 0);
    assert.deepEqual(db.prepare("SELECT kind FROM documents GROUP BY kind ORDER BY kind").all().map((row) => JSON.parse(row.kind)), [...EXPORTABLE_KINDS].sort());
  } finally {
    db.close();
  }
  assert.deepEqual(readdirSync(f.dir).filter((entry) => /-(wal|shm)$/.test(entry)), []);
});

test("a run that is still live travels as its index entry only", skip, async () => {
  const f = await fixture({ live: true });
  const hooked = [];
  const { manifest } = await packHome(f.home, {
    out: f.out, now: NOW,
    exportRunStore: async (storePath, outPath) => { hooked.push(path.basename(path.dirname(path.dirname(storePath)))); await (await openSession(outPath)).close(ctx); },
  });
  assert.deepEqual(manifest.runs, { count: 2, live: 1 });
  assert.deepEqual(hooked, ["signed-in"], "the exporter is never asked for a live run's store");
  assert.ok(names(f.out).every((name) => !name.startsWith("runs/live-1")), "neither its store nor its work");
  assert.ok(names(f.out).includes("runs/signed-in/store/run.sqlite"));
  assert.ok(!readFileSync(f.out).includes("in progress"));
  const read = await readPack(f.out);
  assert.equal(read.ok, true);
  assert.equal(read.checks.find((check) => check.name === "live_runs").status, "warn");
  assert.ok(!readFileSync(f.out).includes(SIGN_IN_MARKER), "the live run's store holds the sign-in; it stays home");
});

test("a run store travels only through the exporter, and the packer refuses one that holds a sign-in or has a side file", skip, async () => {
  const f = await fixture();
  const clean = async (storePath, outPath) => { await (await openSession(outPath)).close(ctx); };
  const { manifest } = await packHome(f.home, { out: f.out, now: NOW, exportRunStore: clean });
  assert.equal(manifest.runs.count, 1);
  assert.ok(names(f.out).includes("runs/signed-in/store/run.sqlite"));
  assert.equal((await readPack(f.out)).ok, true);

  const refused = async (exportRunStore, pattern) => {
    const out = path.join(f.dir, `refused-${pattern.source.length}.tar`);
    await assert.rejects(packHome(f.home, { out, now: NOW, exportRunStore }), (error) => error instanceof AgentHomeError && error.code === "check" && pattern.test(error.message));
    assert.equal(existsSync(out), false, "nothing was written");
    assert.deepEqual(readdirSync(f.dir).filter((entry) => entry.includes(".part-")), []);
  };
  await refused(async (storePath, outPath) => { writeFileSync(outPath, readFileSync(storePath)); }, /browser\.profiles documents/);
  await refused(async (storePath, outPath) => { await clean(storePath, outPath); writeFileSync(`${outPath}-wal`, ""); }, /-wal file beside it/);
  await refused(async (storePath, outPath) => { writeFileSync(outPath, "not a database"); }, /not a readable SQLite database/);
});

test("a work file that is a SQLite store with a sign-in is refused, whatever its name", skip, async () => {
  const f = await fixture();
  writeFileSync(path.join(f.work, "innocent.txt"), readFileSync(f.agentStore));
  await assert.rejects(packHome(f.home, { out: f.out, now: NOW }), (error) => error.code === "check" && /innocent\.txt holds \S+ documents, which never travel/.test(error.message));
  assert.equal(existsSync(f.out), false);
});

test("work names over 100 bytes, or beyond ASCII, round trip through a pax header", skip, async () => {
  const f = await fixture();
  const long = path.join(f.work, "a".repeat(40), "b".repeat(40), `${"c".repeat(40)}-café.txt`);
  mkdirSync(path.dirname(long), { recursive: true });
  writeFileSync(long, "long\n");
  await packHome(f.home, { out: f.out, now: NOW });
  const rel = `runs/signed-in/work/${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(40)}-café.txt`;
  assert.ok(names(f.out).includes(rel));
  assert.ok(Buffer.byteLength(rel) > 100);
  const target = path.join(f.dir, "imported");
  await importPack(f.out, target);
  assert.equal(readFileSync(path.join(target, rel), "utf8"), "long\n");
});

test("maxBytes refuses before anything is written; readPack judges the same limit", skip, async () => {
  const f = await fixture();
  await rejects(packHome(f.home, { out: f.out, now: NOW, maxBytes: 1000 }), "too_large");
  assert.equal(existsSync(f.out), false);
  assert.deepEqual(readdirSync(f.dir).filter((entry) => entry.includes(".part-")), []);
  const { manifest } = await packHome(f.home, { out: f.out, now: NOW, maxBytes: 10_000_000 });
  assert.ok(manifest.size_bytes < 10_000_000);
  const tight = await readPack(f.out, { maxBytes: 1000 });
  assert.equal(tight.ok, false);
  assert.match(tight.checks.find((check) => check.name === "size").message, /over the limit of 1000/);
  assert.deepEqual(tight.manifest, manifest, "the manifest is still read");
});

test("reading a pack writes nothing beside it", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const before = readdirSync(f.dir).sort();
  await readPack(f.out);
  assert.deepEqual(readdirSync(f.dir).sort(), before);
});

test("round trip: pack, read, import into a fresh directory; the exported kinds are equal, nothing else came", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const target = path.join(f.dir, "elsewhere", "imported");
  const { home, report } = await importPack(f.out, target);
  assert.equal(home.dir, target);
  assert.deepEqual([report.ok, report.written, report.replaces], [true, true, false]);
  const before = await readAgentHome(f.home);
  const after = await readAgentHome(home);
  for (const kind of ["identity", "definition", "source", "skills"]) assert.deepEqual(after[kind], before[kind], kind);
  assert.deepEqual(after.runs, Object.fromEntries(Object.entries(before.runs).map(([id, { host, ...run }]) => [id, run])), "the host is stripped from a run");
  for (const kind of ["profiles", "leases", "bindings", "aliases"]) assert.deepEqual(after[kind], {}, kind);
  assert.equal(readFileSync(path.join(target, "runs", "signed-in", "work", "sub", "deep", "a.md"), "utf8"), "# deep\n");
  for (const gone of ["runs/signed-in/work/.env", "runs/signed-in/work/link", "runs/signed-in/work/stolen", "runs/signed-in/store", "chrome", "repo", "tmp"]) assert.equal(existsSync(path.join(target, gone)), false, gone);
  assert.ok(!Buffer.concat(readdirSync(target, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(path.join(entry.parentPath, entry.name)))).includes(SIGN_IN_MARKER));
  assert.deepEqual(readdirSync(path.dirname(target)), ["imported"], "no scratch directory is left beside it");
});

test("a run that was live arrives as an ended index entry", skip, async () => {
  const f = await fixture({ live: true });
  await packHome(f.home, { out: f.out, now: NOW });
  const target = path.join(f.dir, "imported");
  const { home, report } = await importPack(f.out, target, { now: NOW });
  const run = (await readAgentHome(home)).runs["live-1"];
  assert.deepEqual([run.endedAt, run.outcome], ["2026-10-16T05:00:00.000Z", "not_carried_back"]);
  assert.match(report.checks.find((check) => check.name === "live_runs").message, /1 runs were live at the source/);
  assert.equal(existsSync(path.join(target, "runs", "live-1")), false);
  await importPack(f.out, target, { replace: true });
});

/** The refusals: each one leaves the target, and the directory beside it, exactly as it was. */
async function unchanged(target, action) {
  const before = { inside: tree(target), beside: readdirSync(path.dirname(target)).sort(), revision: await homeRevision(await openAgentHome(target)) };
  await action();
  assert.deepEqual(tree(target), before.inside);
  assert.deepEqual(readdirSync(path.dirname(target)).sort(), before.beside);
  assert.equal(await homeRevision(await openAgentHome(target)), before.revision);
}

test("importPack refuses a target with a live run, another agent, a stale revision, or no replace; each leaves the target unchanged", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const target = path.join(f.dir, "target");
  const { home } = await importPack(f.out, target);

  await unchanged(target, () => rejects(importPack(f.out, target), "exists"));

  const revision = await homeRevision(home);
  await unchanged(target, () => rejects(importPack(f.out, target, { replace: true, ifRevision: 0 }), "stale"));

  await startRun(home, { runId: "target-live", host: "elsewhere" });
  await unchanged(target, () => assert.rejects(importPack(f.out, target, { replace: true }), (error) => {
    assert.equal(error.code, "check");
    assert.equal(error.checks.find((check) => check.name === "live_runs").status, "fail");
    assert.deepEqual(error.checks.find((check) => check.name === "live_runs").detail, { live: ["target-live"] });
    return true;
  }));
  assert.notEqual(await homeRevision(home), revision, "a run started: the revision moved");

  const other = await createAgentHome(path.join(f.dir, "other"), { definition: { version: 1, name: "Other", instructions: "x", skills: [], tools: [] } });
  await unchanged(other.dir, () => rejects(importPack(f.out, other.dir, { replace: true }), "invalid"));

  const stranger = path.join(f.dir, "stranger");
  mkdirSync(stranger);
  writeFileSync(path.join(stranger, "file.txt"), "mine\n");
  await rejects(importPack(f.out, stranger), "invalid");
  assert.deepEqual(readdirSync(stranger), ["file.txt"], "not even a lock file is left in a directory that is not a home");
  await rejects(importPack(f.out, path.join(f.dir, "fresh"), { ifRevision: revision }), "stale");
  assert.equal(existsSync(path.join(f.dir, "fresh")), false);
});

test("replace keeps the target's own sign-ins, aliases, bindings, chrome/ and repo/, and takes the pack's runs", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  await setAlias(f.home, "hosted", "ext-2");
  await setBindings(f.home, "hosted", { browser: "hosted" });
  const before = await readAgentHome(f.home);
  const revision = await homeRevision(f.home);
  const { home, report } = await importPack(f.out, f.home.dir, { replace: true, ifRevision: revision });
  assert.equal(report.replaces, true);
  const after = await readAgentHome(home);
  assert.equal(after.profiles.practice.ref, SIGN_IN_MARKER, "the target's own sign-in stays");
  assert.deepEqual(after.aliases, before.aliases);
  assert.deepEqual(after.bindings, before.bindings);
  assert.equal(readFileSync(path.join(f.home.dir, "chrome", "Cookies"), "utf8"), COOKIE);
  assert.equal(readFileSync(path.join(f.home.dir, "repo", "README.md"), "utf8"), "# repo\n");
  assert.equal(existsSync(path.join(f.work, ".env")), false, "the old run's files are replaced");
  assert.equal(existsSync(f.runStore), false, "its store did not travel");
  assert.equal(existsSync(path.join(f.home.dir, "tmp")), false);
  const { host, ...stripped } = before.runs["signed-in"];
  assert.equal(host, "fixture-host");
  assert.deepEqual(after.runs["signed-in"], stripped);
  assert.deepEqual(readdirSync(path.dirname(f.home.dir)).filter((entry) => entry.startsWith(".")), []);
});

test("a replace keeps the target's own runs the pack does not have, and the pack's wins for a run in both", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const mine = await startRun(f.home, { runId: "target-only", host: "laptop" });
  writeFileSync(path.join(mine.workspace, "result.txt"), "kept\n");
  await carryBack(f.home, mine, { outcome: "completed", finalAnswer: "done" });
  const before = await readAgentHome(f.home);
  const { home } = await importPack(f.out, f.home.dir, { replace: true, ifRevision: await homeRevision(f.home) });
  const after = await readAgentHome(home);
  assert.deepEqual(Object.keys(after.runs).sort(), ["signed-in", "target-only"]);
  assert.deepEqual(after.runs["target-only"], before.runs["target-only"], "its entry, with its host");
  assert.equal(readFileSync(path.join(f.home.dir, "runs", "target-only", "work", "result.txt"), "utf8"), "kept\n");
  assert.equal(existsSync(path.join(f.home.dir, "runs", "target-only", "store", "run.sqlite")), true, "and its store");
  assert.equal(after.runs["signed-in"].host, undefined, "the pack's entry wins for a run in both");
  assert.equal(existsSync(f.runStore), false, "and so does its directory");
  assert.deepEqual(readdirSync(path.dirname(f.home.dir)).filter((entry) => entry.startsWith(".")), []);
});

test("a home with no sign-in has an ok sign_ins check; ifRevision is a non-negative integer", async () => {
  const dir = await scratch();
  const home = await createAgentHome(path.join(dir, "plain"), { definition: { version: 1, name: "Plain", instructions: "x", skills: [], tools: [] } });
  const out = path.join(dir, "plain.tar");
  const { manifest } = await packHome(home, { out });
  assert.deepEqual([manifest.sign_ins, manifest.vault, manifest.source, manifest.runs], [[], [], null, { count: 0, live: 0 }]);
  const read = await readPack(out);
  assert.deepEqual(read.checks.map((check) => [check.name, check.status]), [["format", "ok"], ["definition", "ok"], ["sign_ins", "ok"], ["size", "ok"], ["live_runs", "ok"]]);
  for (const bad of [-1, 1.5, "7"]) await rejects(importPack(out, path.join(dir, "never"), { ifRevision: bad }), "invalid");
  assert.equal(existsSync(path.join(dir, "never")), false);
  const { home: copy } = await importPack(out, path.join(dir, "copy"));
  assert.equal(copy.identity.id, home.identity.id);
});

const TAMPERED = {
  "a member off the list": [(m) => [...m, { name: "evil.txt", data: Buffer.from("x") }], "format", /evil\.txt: it is not a member/],
  "a .. member": [(m) => [...m, { name: "runs/signed-in/work/../../../x", data: Buffer.from("x") }], "format", /\.\./],
  "an absolute member": [(m) => [...m, { name: "/etc/passwd", data: Buffer.from("x") }], "format", /\/etc\/passwd/],
  "a symbolic link": [(m) => [...m, { name: "runs/signed-in/work/l", typeflag: "2", linkname: "/etc/passwd" }], "format", /symbolic link/],
  "a hard link": [(m) => [...m, { name: "runs/signed-in/work/h", typeflag: "1", linkname: "agent.sqlite" }], "format", /hard link/],
  "a device": [(m) => [...m, { name: "runs/signed-in/work/d", typeflag: "3" }], "format", /device/],
  "a dotfile": [(m) => [...m, { name: "runs/signed-in/work/.env", data: Buffer.from("x") }], "format", /\.env/],
  "a chrome/ member": [(m) => [...m, { name: "chrome/Cookies", data: Buffer.from("x") }], "format", /chrome\/Cookies/],
  "a SQLite side file": [(m) => [...m, { name: "runs/signed-in/store/run.sqlite-wal", data: Buffer.from("x") }], "format", /side file/],
  "a run the index does not list": [(m) => [...m, { name: "runs/ghost/work/a.txt", data: Buffer.from("x") }], "format", /ghost/],
  "a duplicate member": [(m) => [...m, m[1]], "format", /appears twice/],
  "the manifest not first": [(m) => [...m.slice(1), m[0]], "format", /first member/],
  "a higher format": [(m) => withManifest(m, (manifest) => { manifest.format = "agentrun.home/2"; }), "format", /this version reads agentrun\.home\/1/],
  "an unknown manifest field": [(m) => withManifest(m, (manifest) => { manifest.extra = 1; }), "format", /fields it does not keep: extra/],
  "a vault entry with a value": [(m) => withManifest(m, (manifest) => { manifest.vault = [{ name: "k", value: "v" }]; }), "format", /vault entries are not \{name\}/],
  "a source in the package's own names": [(m) => withManifest(m, (manifest) => { manifest.source = { sha: manifest.source.sha, refreshedAt: manifest.source.refreshed_at }; }), "format", /source is not null or \{sha, refreshed_at\}/],
  "a source that is not the one stored": [(m) => withManifest(m, (manifest) => { manifest.source = null; }), "format", /source is not the one in agent\.sqlite/],
  "an agent id that is not an id": [(m) => withManifest(m, (manifest) => { manifest.agent_id = "not an id"; }), "format", /agent_id is not an id/],
  "a definition whose id is not agent_id": [(m) => withManifest(m, (manifest) => { manifest.agent_id = "someone-else"; }), "definition", /id differs from agent_id/],
  "another agent's id throughout": [(m) => withManifest(m, (manifest) => { manifest.agent_id = "someone-else"; manifest.definition.id = "someone-else"; }), "definition", /is for agent someone-else, but agent\.sqlite holds agent/],
  "a bad skill sha": [(m) => withManifest(m, (manifest) => { manifest.skills[0].sha256 = "0".repeat(64); }), "definition", /does not match its sha256 or size/],
  "a bad skill size": [(m) => withManifest(m, (manifest) => { manifest.skills[0].size_bytes += 1; }), "definition", /does not match its sha256 or size/],
  "other run counts": [(m) => withManifest(m, (manifest) => { manifest.runs.live = 1; }), "format", /run counts/],
};

test("tampered packs are refused by readPack and importPack, and importPack writes nothing", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const target = path.join(f.dir, "never");
  for (const [label, [change, check, pattern]] of Object.entries(TAMPERED)) {
    const bad = tamper(f.out, path.join(f.dir, "bad.tar"), change);
    const read = await readPack(bad);
    assert.equal(read.ok, false, label);
    assert.match(read.checks.find((entry) => entry.name === check).message, pattern, label);
    assert.equal(read.checks.find((entry) => entry.name === check).status, "fail", label);
    await assert.rejects(importPack(bad, target), (error) => error instanceof AgentHomeError && error.code === "check" && error.checks.some((entry) => entry.status === "fail"), label);
    assert.equal(existsSync(target), false, label);
  }
  assert.deepEqual(readdirSync(f.dir).filter((entry) => entry.startsWith(".")), []);
});

test("a store in the pack that holds a sign-in kind is refused, in agent.sqlite or in a run store", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const swap = (name, bytes) => (members) => (members.some((member) => member.name === name) ? members.map((member) => (member.name === name ? { ...member, data: bytes } : member)) : [...members, { name, data: bytes }]);
  for (const [change, pattern] of [
    [swap("agent.sqlite", readFileSync(f.agentStore)), /agent\.sqlite holds \S+ documents, which never travel/],
    [swap("runs/signed-in/store/run.sqlite", readFileSync(f.runStore)), /run\.sqlite holds browser\.profiles documents/],
  ]) {
    const read = await readPack(tamper(f.out, path.join(f.dir, "secret.tar"), change));
    assert.equal(read.ok, false);
    assert.match(read.checks.find((check) => check.name === "format").message, pattern);
  }
  const notStore = await readPack(tamper(f.out, path.join(f.dir, "notstore.tar"), swap("runs/signed-in/store/run.sqlite", Buffer.from("plain text"))));
  assert.match(notStore.checks.find((check) => check.name === "format").message, /not a SQLite database/);
});

test("a truncated pack and a corrupt header are refused", skip, async () => {
  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const cut = path.join(f.dir, "cut.tar");
  writeFileSync(cut, readFileSync(f.out).subarray(0, 3000));
  const truncated = await readPack(cut);
  assert.equal(truncated.ok, false);
  assert.match(truncated.checks.find((check) => check.name === "format").message, /cut short|ends without/);
  const corrupt = path.join(f.dir, "corrupt.tar");
  const bytes = Buffer.from(readFileSync(f.out));
  bytes[10] ^= 0xff;
  writeFileSync(corrupt, bytes);
  assert.match((await readPack(corrupt)).checks.find((check) => check.name === "format").message, /bad checksum/);
  const trailing = path.join(f.dir, "trailing.tar");
  writeFileSync(trailing, Buffer.concat([readFileSync(f.out), Buffer.from("extra")]));
  assert.match((await readPack(trailing)).checks.find((check) => check.name === "format").message, /after the end/);
  await rejects(readPack(path.join(f.dir, "missing.tar")), "missing");
  truncateSync(cut, 0);
  assert.equal((await readPack(cut)).ok, false);
});

test("a pack written by another tool is read: a long name split over the ustar prefix", skip, async () => {
  const f = await fixture();
  const long = path.join(f.work, "a".repeat(60), "b".repeat(60), "c.txt");
  mkdirSync(path.dirname(long), { recursive: true });
  writeFileSync(long, "long\n");
  await packHome(f.home, { out: f.out, now: NOW });
  const rewritten = path.join(f.dir, "other-tool.tar");
  writeTarFile(rewritten, listTar(f.out).map((member) => ({ ...member, name: dirSuffix(member) })));
  assert.ok(listTar(rewritten).some((member) => member.name === `runs/signed-in/work/${"a".repeat(60)}/${"b".repeat(60)}/c.txt`));
  const read = await readPack(rewritten);
  assert.equal(read.checks.find((check) => check.name === "format").status, "ok");
  assert.equal(read.checks.find((check) => check.name === "definition").status, "ok");
});

test("a size over 8 GiB is a pax record, and a pax size is read in place of the header's", skip, async () => {
  const entry = { name: "work-file", kind: "file", mode: 0o644, mtime: 0 };
  const GIB = 1024 ** 3;
  const plain = tarSize([{ ...entry, size: 7 * GIB }]);
  assert.equal(plain, 512 + 7 * GIB + 1024);
  assert.equal(tarSize([{ ...entry, size: 9 * GIB }]), 512 + 512 + 512 + 9 * GIB + 1024, "a pax header and its record come first");

  const f = await fixture();
  await packHome(f.home, { out: f.out, now: NOW });
  const viaPax = tamper(f.out, path.join(f.dir, "pax-size.tar"), (members) => members.map((member) => (member.name.endsWith("a.md") ? { ...member, paxSize: true } : member)));
  assert.equal(listTar(viaPax).find((member) => member.name.endsWith("a.md")).size, "# deep\n".length);
  const read = await readPack(viaPax);
  assert.equal(read.checks.find((check) => check.name === "format").status, "ok");
  assert.equal(read.checks.find((check) => check.name === "definition").status, "ok");
});
