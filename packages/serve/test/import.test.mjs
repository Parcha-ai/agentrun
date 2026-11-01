// `agentrun-serve import`: synthetic Claude Code, Codex and pi sessions under a scratch home, into a data directory.
// Each project is one agent with a revision per harness, its CLAUDE.md or AGENTS.md and its skill folders; each session a
// run ended as it ended, its transcript its timeline, its cost the source's or unknown. What is written holds no value of
// a key-shaped variable and is the owner's only; a link, a binary file, an oversized file and a folder with no SKILL.md
// are left out by name; an imported run takes no message, and a stop, a cancel or a restart moves nothing of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openStore, openStoreReader } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { planImport, runImport } from "../dist/import.js";
import { claudeSession, codexSession, piSession } from "./fixtures/import-sessions.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const CANARY = "CANARY-VALUE-7f3e9d2c1b0a6e5d";
const ENV = { OPENAI_API_KEY: CANARY, PATH: "/usr/bin" };

/** A scratch home with three projects (one used by Claude Code and Codex, one by pi, one by Codex alone), a project
 *  that is gone, one under the temp directory, a session still being written, and two children. */
function home(root) {
  const at = join(root, "home");
  const site = join(at, "code", "acme-site");
  const notes = join(at, "code", "field-notes");
  const tests = join(at, "code", "test-runner");
  for (const dir of [site, notes, tests]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(site, "CLAUDE.md"), `Keep the site fast. Deploy key: ${CANARY}\n`);
  writeFileSync(join(site, "AGENTS.md"), "Run the tests before a commit.\n");
  mkdirSync(join(site, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(site, ".claude", "skills", "deploy", "SKILL.md"), `---\nname: deploy\n---\nDeploy the site with ${CANARY}.\n`);
  writeFileSync(join(site, ".claude", "skills", "deploy", "steps.md"), `1. build\n2. upload, key ${CANARY}\n`);
  mkdirSync(join(site, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(site, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\n---\nReview a change.\n");
  claudeSession(at, site, 1, { output: `README.md (env ${CANARY})`, env: { OPENAI_API_KEY: CANARY } });
  claudeSession(at, site, 2, { prompt: "Fix the header.", interrupted: true, cost: 0.01 });
  codexSession(at, site, 3);
  piSession(at, notes, 4);
  codexSession(at, tests, 5, { aborted: true });
  claudeSession(at, join(at, "code", "gone"), 6);
  claudeSession(at, join(root, "tmp", "scratch-project"), 7);
  mkdirSync(join(root, "tmp", "scratch-project"), { recursive: true });
  piSession(at, notes, 8, { fresh: true });
  claudeSession(at, site, 9, { sidechain: true });
  codexSession(at, site, 10, { subagent: true });
  return { at, site, notes, tests, temp: join(root, "tmp") };
}

const options = (h, extra = {}) => ({ home: h.at, env: ENV, temp: h.temp, ...extra });

async function imported(t) {
  const root = await scratch(t);
  const h = home(root);
  const data = join(root, "agents");
  const store = openStore(data);
  t.after(() => store.close());
  const plan = await planImport(options(h));
  const report = await runImport(store, plan, options(h));
  return { root, h, data, store, report, plan };
}

/** Every file under `dir`: its path, mode and bytes, hashed. */
function treeHash(dir) {
  const hash = createHash("sha256");
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const stats = statSync(path);
      hash.update(`${path}\0${stats.mode}\0`);
      if (stats.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

const runsOf = (store, agentId) => store.listRuns({ agent: agentId }).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.importedFrom.session.localeCompare(b.importedFrom.session));

test("each project is one agent with a revision per harness, its CLAUDE.md or AGENTS.md and its skill folders; each session one run, ended as it ended, at the source's cost or unknown", { timeout: 60_000 }, async (t) => {
  const { h, data, store, report } = await imported(t);
  assert.deepEqual(report.agents.map((a) => [a.cwd, a.runs]), [[h.site, 3], [h.notes, 1], [h.tests, 1]]);
  const site = report.agents[0];
  const { agent, revisions } = store.readAgent(site.id);
  assert.equal(agent.name, "acme-site");
  const byNote = Object.fromEntries(revisions.map((r) => [r.note, r]));
  const claude = byNote["imported from claude-code"].body;
  const codex = byNote["imported from codex"].body;
  assert.equal(claude.harness, "claude-agent");
  assert.equal(claude.model, "anthropic/claude-sonnet-5");
  assert.match(claude.instructions, /^Keep the site fast\./);
  assert.equal(codex.harness, "codex");
  assert.equal(codex.model, "openai/gpt-sol-6.1");
  assert.equal(codex.instructions, "Run the tests before a commit.\n");
  assert.deepEqual(Object.keys(claude.skills).sort(), ["deploy/SKILL.md", "deploy/steps.md", "review/SKILL.md"]);
  // The latest session (Codex's) names the current revision.
  assert.equal(revisions.find((r) => r.current).note, "imported from codex");
  const runs = runsOf(store, site.id);
  assert.deepEqual(runs.map((r) => [r.importedFrom.source, r.state, r.costUsd ?? null]), [["claude-code", "completed", 0.0421], ["claude-code", "stopped", 0.01], ["codex", "completed", null]]);
  assert.equal(runs[0].startedAt, "2026-10-20T09:00:00.000Z");
  const [notes] = store.listRuns({ agent: report.agents[1].id });
  assert.equal(store.readAgent(report.agents[1].id).revisions[0].body.harness, undefined, "pi is the default harness, never stored");
  assert.ok(Math.abs(notes.costUsd - 0.005) < 1e-12, "pi's requests' costs, summed");
  assert.equal(store.listRuns({ agent: report.agents[2].id })[0].state, "stopped", "an aborted Codex turn");

  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  const view = await api("GET", `/runs/${runs[0].id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.status, "completed");
  assert.deepEqual(view.body.imported_from, { source: "claude-code", session: "00000000-0000-4000-8000-000000000001" });
  const page = (await api("GET", `/agents/${site.id}/runs`)).body;
  const listed = page.runs;
  assert.equal(listed.length, 3);
  // An imported run and its summaries meet the served document whole.
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Run" }, view.body), [], JSON.stringify(view.body));
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/RunList" }, page), [], JSON.stringify(page));
  assert.ok(listed.every((r) => r.imported_from?.source), "each listed run says where it was imported from");
  assert.equal((await api("GET", `/runs/${runs[2].id}`)).body.cost.usd, null, "Codex records no cost: unknown, never 0");
  assert.equal((await api("GET", `/runs/${runs[0].id}`)).body.cost.usd, 0.0421);
  const { body } = await api("GET", `/runs/${runs[0].id}/timeline`);
  const rows = body.rows.map((r) => `${r.kind}:${r.text ?? r.name ?? ""}`).join("\n");
  assert.match(rows, /^user_message:List the files\.$/m);
  assert.ok(body.rows.some((r) => r.kind === "tool_use" && r.tool_name === "Bash" && r.tool_input_preview === "ls"), "the Bash call");
  assert.ok(body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "Bash"), "and its output");
  assert.match(rows, /The files: README\.md/);
  assert.doesNotMatch(rows, /hook's note|environment_context/, "a hook's or the CLI's own user records are not the person's");
});

test("nothing written holds a key-shaped variable's value, and every file a run gets is the owner's only, whatever the umask", async (t) => {
  const before = process.umask(0);
  t.after(() => process.umask(before));
  const { data, store, report } = await imported(t);
  const all = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else all.push(path);
    }
  };
  walk(data);
  for (const file of all) assert.ok(!readFileSync(file).includes(CANARY), `no canary in ${file}`);
  const run = runsOf(store, report.agents[0].id)[0];
  const dir = join(data, "runs", run.id);
  assert.equal(statSync(join(dir, "store", "run.sqlite")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "serve.json")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(dir, "store")), ["run.sqlite"], "no -wal or -shm left");
  assert.deepEqual(readdirSync(data).filter((name) => name.startsWith(".import-")), [], "no pending transcript left");
  const timeline = readFileSync(join(dir, "store", "run.sqlite"));
  assert.ok(timeline.includes("[redacted]"), "the canary's places are marked");
  // The revision's skill texts, as the store keeps them (by content hash): the cut runs on each.
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  const texts = db.prepare("SELECT content FROM skills").all().map((r) => r.content);
  db.close();
  assert.ok(texts.some((text) => text.startsWith("---\nname: deploy") && text.includes("[redacted]")), "SKILL.md, cut");
  assert.ok(texts.some((text) => text.startsWith("1. build") && text.includes("[redacted]")), "the skill's other file, cut");
  assert.ok(!texts.some((text) => text.includes(CANARY)));
});

test("an imported run takes no message (409 not_continuable, reason imported); a stop, a cancel and a restart answer as for an ended run and move nothing", { timeout: 60_000 }, async (t) => {
  const { data, store, report } = await imported(t);
  const run = runsOf(store, report.agents[0].id)[0];
  const dir = join(data, "runs", run.id);
  const one = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  const api = client(one.baseUrl, one.token);
  const before = treeHash(dir);
  const message = await api("POST", `/runs/${run.id}/messages`, { content: "go on" });
  assert.equal(message.status, 409, JSON.stringify(message.body));
  assert.equal(message.body.error.code, "not_continuable");
  assert.deepEqual(message.body.error.details, { reason: "imported", imported_from: "claude-code" });
  const stop = await api("POST", `/runs/${run.id}/stop`);
  assert.deepEqual([stop.status, stop.body.stopped, stop.body.status], [200, false, "completed"]);
  const cancel = await api("POST", `/runs/${run.id}/cancel`);
  assert.deepEqual([cancel.status, cancel.body.cancel_requested, cancel.body.already_terminal], [202, false, true]);
  await one.close();
  closed = true;
  const two = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => two.close());
  assert.equal((await client(two.baseUrl, two.token)("GET", `/runs/${run.id}`)).body.status, "completed");
  assert.equal(treeHash(dir), before, "the run's directory is byte for byte as imported");
  assert.equal(openStoreReader(data).readRun(run.id).state, "completed");
});

test("an imported run with no transcript and no work/ reads as such: its timeline and files answer, never 500", { timeout: 60_000 }, async (t) => {
  const { data, store, report } = await imported(t);
  const run = runsOf(store, report.agents[0].id)[0];
  rmSync(join(data, "runs", run.id, "store"), { recursive: true });
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("GET", `/runs/${run.id}`)).status, 200);
  const timeline = await api("GET", `/runs/${run.id}/timeline`);
  assert.equal(timeline.status, 200, JSON.stringify(timeline.body));
  assert.deepEqual(timeline.body.rows, []);
  const files = await api("GET", `/runs/${run.id}/files`);
  assert.deepEqual([files.status, files.body.files], [200, []]);
});

test("a link, a binary file, an oversized SKILL.md and a folder with no SKILL.md are each left out by name; what a link points at is never read", async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const skills = join(h.site, ".claude", "skills");
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "OUTSIDE-MARKER\n");
  symlinkSync(outside, join(skills, "linked"));
  mkdirSync(join(skills, "huge"));
  writeFileSync(join(skills, "huge", "SKILL.md"), "x".repeat(256 * 1024 + 1));
  writeFileSync(join(skills, "deploy", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  // Latin-1, not UTF-8, and no NUL byte: only a strict decode tells it is not text.
  writeFileSync(join(skills, "deploy", "notes.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b, 0x0a]));
  mkdirSync(join(skills, "notes"));
  writeFileSync(join(skills, "notes", "todo.md"), "not a skill\n");
  symlinkSync(join(outside, "SKILL.md"), join(h.notes, "AGENTS.md"));
  mkdirSync(join(h.notes, ".pi"));
  symlinkSync(outside, join(h.notes, ".pi", "skills"));
  const data = join(root, "agents");
  const store = openStore(data);
  t.after(() => store.close());
  const report = await runImport(store, await planImport(options(h)), options(h));
  const why = Object.fromEntries(report.skipped.map((s) => [s.what, s.why]));
  assert.equal(why[join(skills, "linked")], "a link: not followed");
  assert.equal(why[join(skills, "huge", "SKILL.md")], `over ${256 * 1024} bytes`);
  assert.equal(why[join(skills, "deploy", "logo.png")], "not text");
  assert.equal(why[join(skills, "deploy", "notes.md")], "not text", "invalid UTF-8 with no NUL byte");
  assert.equal(why[join(skills, "notes")], "no SKILL.md: not a skill");
  assert.equal(why[join(h.notes, "AGENTS.md")], "a link: not followed");
  assert.equal(why[join(h.notes, ".pi", "skills")], "a link: not followed", "a skill folder that is itself a link");
  const kept = store.readAgent(report.agents[0].id).revisions[0].body.skills;
  assert.deepEqual(Object.keys(kept).sort(), ["deploy/SKILL.md", "deploy/steps.md", "review/SKILL.md"]);
  assert.equal(store.readAgent(report.agents[1].id).revisions[0].body.instructions, "");
  for (const file of [join(data, "store.sqlite")]) assert.ok(!readFileSync(file).includes("OUTSIDE-MARKER"), "a link's target is never read");
});

test("run again, it imports only what it has not; a session written lately, a child, a project gone or temporary are left out, and --all keeps the last two", async (t) => {
  const { h, store, report, plan } = await imported(t);
  const why = report.skipped.map((s) => s.why).join("\n");
  assert.match(why, /written in the last 10 minutes/);
  assert.match(why, /code\/gone is gone/);
  assert.match(why, /scratch-project is a temp directory/);
  assert.equal(plan.projects.flatMap((p) => p.sessions).filter((s) => s.child).length, 0, "no subagent's or child thread's session");
  // Without the store, every file is read again, and each session is found held.
  const again = await runImport(store, await planImport(options(h)), options(h));
  assert.deepEqual(again.agents.map((a) => [a.runs, a.already, a.finished, a.created]), [[0, 3, 0, false], [0, 1, 0, false], [0, 1, 0, false]]);
  // With it, a file its imports read whole and that has not changed is not read at all.
  const unchanged = await planImport(options(h), store);
  assert.deepEqual([unchanged.projects.length, unchanged.already], [0, 5]);
  const all = await planImport(options(h, { all: true }));
  assert.deepEqual(all.projects.map((p) => p.name).sort(), ["acme-site", "field-notes", "gone", "scratch-project", "test-runner"]);
});

test("the CLI's --dry-run lists each project and writes nothing; the import itself is the explicit command", async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const data = join(root, "agents");
  const env = { ...process.env, HOME: h.at, OPENAI_API_KEY: CANARY };
  const dry = spawnSync(process.execPath, [CLI, "import", "--data", data, "--dry-run", "--all"], { env, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /acme-site {2}claude-code 2, codex 1 {2}cost known 2\/3/);
  assert.match(dry.stdout, /nothing was written \(dry run\)/);
  assert.equal(existsSync(data), false, "no data directory, no store");
  const real = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all"], { env, encoding: "utf8" });
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /runs imported into/);
  assert.ok(!real.stdout.includes(CANARY));
});

test("a skill folder this user cannot read, or a skills directory it cannot read, is named unreadable, never dropped silently; the rest still imports", { skip: process.getuid?.() === 0 ? "root reads a mode 000 folder" : false }, async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const locked = join(h.site, ".claude", "skills", "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "SKILL.md"), "---\nname: locked\n---\nUnseen.\n");
  const codexSkills = join(h.site, ".codex", "skills");
  mkdirSync(join(codexSkills, "triage"), { recursive: true });
  writeFileSync(join(codexSkills, "triage", "SKILL.md"), "---\nname: triage\n---\nUnseen.\n");
  const data = join(root, "agents");
  const store = openStore(data);
  t.after(() => store.close());
  // Given back before the test ends: the scratch directory's removal runs first among the after hooks.
  chmodSync(locked, 0o000);
  chmodSync(codexSkills, 0o000);
  let report;
  try {
    report = await runImport(store, await planImport(options(h)), options(h));
  } finally {
    chmodSync(locked, 0o700);
    chmodSync(codexSkills, 0o700);
  }
  const why = Object.fromEntries(report.skipped.map((s) => [s.what, s.why]));
  assert.equal(why[locked], "unreadable", "a skill folder at mode 000");
  assert.equal(why[codexSkills], "unreadable", "a skills directory at mode 000");
  const kept = store.readAgent(report.agents[0].id).revisions[0].body.skills;
  assert.deepEqual(Object.keys(kept).sort(), ["deploy/SKILL.md", "deploy/steps.md", "review/SKILL.md"], "the readable skills still import");
});

test("an import the process left without its transcript is finished by the next one, not counted as imported", async (t) => {
  const { h, data, store, report } = await imported(t);
  const run = runsOf(store, report.agents[0].id)[0];
  const dir = join(data, "runs", run.id);
  // As a process stopped between the run's row and its transcript leaves it.
  rmSync(join(dir, "store", "run.sqlite"));
  rmSync(join(dir, "serve.json"));
  const before = process.umask(0);
  let again;
  try {
    again = await runImport(store, await planImport(options(h), store), options(h));
  } finally {
    process.umask(before);
  }
  // Only its file is read again: the other four, unchanged and whole, are not.
  assert.deepEqual(again.agents.map((a) => [a.cwd, a.runs, a.finished, a.already]), [[h.site, 0, 1, 0]]);
  assert.equal(again.already, 4);
  assert.equal(statSync(join(dir, "store", "run.sqlite")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "serve.json")).mode & 0o777, 0o600);
  const db = new DatabaseSync(join(dir, "store", "run.sqlite"), { readOnly: true });
  const entries = db.prepare("SELECT COUNT(*) AS n FROM entries").get().n;
  db.close();
  assert.ok(entries > 0, "the transcript is there");
  assert.equal(store.listRuns().length, 5, "no second run for it");
});

test("a session file this user cannot read is named and passed over; the rest still import", { skip: process.getuid?.() === 0 ? "root reads a mode 000 file" : false }, async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const locked = codexSession(h.at, h.tests, 11, { prompt: "Locked away." });
  const data = join(root, "agents");
  const store = openStore(data);
  t.after(() => store.close());
  chmodSync(locked, 0o000);
  let report;
  try {
    report = await runImport(store, await planImport(options(h), store), options(h));
  } finally {
    chmodSync(locked, 0o600);
  }
  assert.equal(report.skipped.find((s) => s.what === locked)?.why, "not read (EACCES)");
  assert.equal(store.listRuns().length, 5, "the five readable sessions");
});

test("a re-import does not read a file its imports took whole and that has not changed", { skip: process.getuid?.() === 0 ? "root reads a mode 000 file" : false }, async (t) => {
  const { h, store, report } = await imported(t);
  const file = join(h.at, ".claude", "projects", h.site.replaceAll("/", "-"), "00000000-0000-4000-8000-000000000001.jsonl");
  assert.ok(existsSync(file));
  // Unreadable now, yet unchanged in size and time: a re-import that opened it would name it.
  chmodSync(file, 0o000);
  let plan;
  try {
    plan = await planImport(options(h), store);
  } finally {
    chmodSync(file, 0o600);
  }
  assert.equal(plan.skipped.find((s) => s.what === file), undefined, "never opened");
  assert.equal(plan.already, 5);
  assert.equal(report.agents.reduce((n, a) => n + a.runs, 0), 5);
});

test("a key value in a session file's own path is in no file the import writes, and a second run still imports none again", async (t) => {
  const root = await scratch(t);
  const h = home(root);
  // The project folder Claude Code named holds the key value; the project itself does not.
  const file = claudeSession(h.at, h.site, 12, { prompt: "From an odd folder.", slug: `odd-${CANARY}` });
  assert.ok(file.includes(CANARY));
  const data = join(root, "agents");
  const store = openStore(data);
  t.after(() => store.close());
  const first = await runImport(store, await planImport(options(h), store), options(h));
  assert.equal(first.agents.reduce((n, a) => n + a.runs, 0), 6);
  const written = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else written.push(path);
    }
  };
  walk(data);
  for (const path of written) assert.ok(!readFileSync(path).includes(CANARY), `no key value in ${path}`);
  const plan = await planImport(options(h), store);
  assert.deepEqual([plan.projects.length, plan.already], [0, 6], "every file, the odd one too, known and unread");
  const second = await runImport(store, plan, options(h));
  assert.equal(second.agents.reduce((n, a) => n + a.runs, 0), 0);
  assert.equal(store.listRuns().length, 6);
});
