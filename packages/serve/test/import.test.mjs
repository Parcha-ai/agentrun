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
import { runMetricsOf, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { startServe } from "../dist/index.js";
import { planImport, runImport } from "../dist/import.js";
import { ACTIVE_GAP_MS, readSession } from "../dist/import-sources.js";
import { summaryLines } from "../dist/import-summary.js";
import { at as minute, claudeSession, codexSession, piSession, sessionId, writeSession } from "./fixtures/import-sessions.mjs";
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
  const listed = (await api("GET", `/agents/${site.id}/runs`)).body.runs;
  assert.equal(listed.length, 3);
  assert.ok(listed.every((r) => r.imported_from?.source), "each listed run says where it was imported from");
  assert.equal((await api("GET", `/runs/${runs[2].id}`)).body.cost.usd, null, "Codex records no cost: unknown, never 0");
  assert.equal((await api("GET", `/runs/${runs[0].id}`)).body.cost.usd, 0.0421);
  const { body } = await api("GET", `/runs/${runs[0].id}/timeline`);
  assert.equal(body.rows.findLast((r) => r.kind === "usage")?.usage?.requests, store.runMetrics(runs[0].id).requests, "the served usage row counts the requests the metrics do");
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

test("a current Codex rollout, the person's turns user messages with no user_message event, imports without --all, its user turns the person's words alone; an older one, with both, has each turn once", async (t) => {
  const root = await scratch(t);
  const h = { at: join(root, "home"), temp: join(root, "tmp") };
  const project = join(h.at, "code", "lint-bot");
  mkdirSync(project, { recursive: true });
  const current = codexSession(h.at, project, 21, { prompt: "Lint the code.", then: "<task>Fix what it found.</task>", events: false });
  const older = codexSession(h.at, project, 22, { prompt: "Check the build.", then: "Ship it." });
  const plan = await planImport(options(h));
  assert.deepEqual(plan.skipped, [], "neither is passed over as holding no message of the person's");
  assert.deepEqual(
    plan.projects.flatMap((p) => p.sessions).map((s) => [s.file, s.users, s.firstPrompt]),
    [
      [current, 2, "Lint the code."],
      [older, 2, "Check the build."],
    ],
  );
  const turns = async (file) => (await readSession(file, "codex")).turns.map((turn) => (turn.role === "user" ? `user:${turn.text}` : turn.role));
  // The CLI's AGENTS.md and environment blocks are no turn and an image's wrapper tags no words; a prompt the person tagged is theirs.
  assert.deepEqual(await turns(current), ["user:Lint the code.", "assistant", "toolResult", "assistant", "user:[image]\n<task>Fix what it found.</task>", "assistant"]);
  assert.deepEqual(await turns(older), ["user:Check the build.", "assistant", "toolResult", "assistant", "user:Ship it.", "assistant"]);
  const store = openStore(join(root, "agents"));
  t.after(() => store.close());
  const report = await runImport(store, plan, options(h));
  assert.deepEqual(report.agents.map((a) => [a.cwd, a.runs]), [[project, 2]]);
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

/** One project under a scratch home, its sessions written by `write(home, project)`, imported: the store and its runs by
 *  source. */
async function importedOne(t, write) {
  const root = await scratch(t);
  const h = { at: join(root, "home"), temp: join(root, "tmp") };
  const project = join(h.at, "code", "metered");
  mkdirSync(project, { recursive: true });
  write(h.at, project);
  const data = join(root, "agents");
  const store = openStore(data);
  t.after(() => store.close());
  await runImport(store, await planImport(options(h)), options(h));
  const runs = store.listRuns().sort((a, b) => a.importedFrom.session.localeCompare(b.importedFrom.session));
  return { data, store, runs };
}

/** A run's stored metrics, checked against its own transcript: runMetricsOf of its entries, and its settled timeline's
 *  usage row. Returns the metrics (without `at`) and the transcript's answers. */
function metricsOf(data, store, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  const entries = db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
  db.close();
  const { at, activeMs, effort, ...counted } = store.runMetrics(runId);
  assert.ok(at, "written with its run");
  assert.deepEqual(counted, runMetricsOf(entries), "the metrics are what the run's own transcript says");
  assert.equal(timelineOf(entries, { settled: true }).findLast((r) => r.kind === "usage")?.usage.requests, counted.requests, "the timeline's usage row counts the same requests");
  return { metrics: { ...counted, activeMs, ...(effort ? { effort } : {}) }, answers: entries.filter((e) => e.kind === "pi.assistant").map((e) => e.model[0]), kinds: entries.map((e) => e.kind) };
}
const tokensIn = (answer) => [answer.model, answer.usage.input, answer.usage.cacheRead, answer.usage.cacheWrite, answer.usage.output];

test("a Claude Code import counts each request once, its records repeated around a parallel call's result or written twice; each answer keeps its model, a failed call its error, and the run its effort and time at work, a pause cut to the cap", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => claudeSession(home, project, 31, { parallel: true, answerModel: "claude-haiku-5", pause: 60 }));
  const { metrics, answers } = metricsOf(data, store, runs[0].id);
  assert.deepEqual(metrics, {
    input: 8,
    cacheRead: 2300,
    cacheWrite: 300,
    output: 80,
    requests: 2,
    unmetered: 0,
    models: { "anthropic/claude-sonnet-5": 1, "anthropic/claude-haiku-5": 1 },
    model: "anthropic/claude-sonnet-5",
    tools: { Bash: { calls: 1, errors: 0 }, Read: { calls: 1, errors: 1 } },
    activeMs: 2 * 60_000 + ACTIVE_GAP_MS,
    effort: "high",
  });
  assert.equal(ACTIVE_GAP_MS, 15 * 60_000);
  // The first request's last record holds its final usage, not its stream's start; the answer written twice is one.
  assert.deepEqual(answers.map(tokensIn), [["claude-sonnet-5", 3, 1000, 200, 50], ["claude-haiku-5", 5, 1300, 100, 30]]);
  assert.deepEqual(answers[0].content.filter((b) => b.type === "toolCall").map((b) => b.name), ["Bash", "Read"]);
  assert.deepEqual(answers[1].content, [{ type: "text", text: "The files: README.md." }]);
});

test("a Codex import counts each request once from its token_count events, or from its token_usage_records where it has them; input is OpenAI's less the cached, a call fails as its output or its completed item says, and each turn keeps its model", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => {
    codexSession(home, project, 32, { failing: true, then: "Ship it.", thenModel: "gpt-luna-6" });
    codexSession(home, project, 33, { failing: true, then: "Ship it.", thenModel: "gpt-luna-6", usage: "records", events: false });
  });
  const expected = {
    input: 300 + 100 + 200,
    cacheRead: 600 + 900 + 1000,
    cacheWrite: 0,
    output: 40 + 25 + 10,
    requests: 3,
    unmetered: 0,
    models: { "openai/gpt-sol-6.1": 2, "openai/gpt-luna-6": 1 },
    model: "openai/gpt-sol-6.1",
    tools: { shell: { calls: 3, errors: 2 } },
    activeMs: 5 * 60_000,
    effort: "medium",
  };
  for (const run of runs) {
    const { metrics, answers } = metricsOf(data, store, run.id);
    assert.deepEqual(metrics, expected, run.importedFrom.session);
    // The first request's three calls are one answer; the token_count written twice, and the record, count once.
    assert.deepEqual(answers.map(tokensIn), [["gpt-sol-6.1", 300, 600, 0, 40], ["gpt-sol-6.1", 100, 900, 0, 25], ["gpt-luna-6", 200, 1000, 0, 10]]);
    assert.equal(answers[0].content.filter((b) => b.type === "toolCall").length, 3);
  }
});

test("a pi import keeps each request's usage as pi wrote it, its model, its thinking level and a failed call", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => piSession(home, project, 34, { answerModel: "claude-opus-5", readFails: true, thinking: "xhigh" }));
  const { metrics, answers } = metricsOf(data, store, runs[0].id);
  assert.deepEqual(metrics, {
    input: 200,
    cacheRead: 800,
    cacheWrite: 60,
    output: 40,
    requests: 2,
    unmetered: 0,
    models: { "anthropic/claude-sonnet-5": 1, "anthropic/claude-opus-5": 1 },
    model: "anthropic/claude-sonnet-5",
    tools: { read: { calls: 1, errors: 1 } },
    activeMs: 3 * 60_000,
    effort: "xhigh",
  });
  assert.deepEqual(answers.map(tokensIn), [["claude-sonnet-5", 100, 400, 30, 20], ["claude-opus-5", 100, 400, 30, 20]]);
  assert.ok(Math.abs(runs[0].costUsd - 0.005) < 1e-12, "its cost as before");
});

test("a session whose source gives no counts imports its requests as unmetered, never as 0 tokens; a Codex request still ends at its call's result", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => {
    claudeSession(home, project, 35, { usage: false });
    codexSession(home, project, 36, { usage: "none" });
    piSession(home, project, 37, { counted: false });
  });
  assert.deepEqual(runs.map((r) => r.importedFrom.source), ["claude-code", "codex", "pi"]);
  for (const run of runs) {
    const { metrics, answers } = metricsOf(data, store, run.id);
    assert.deepEqual([metrics.requests, metrics.unmetered, metrics.input, metrics.cacheRead, metrics.cacheWrite, metrics.output], [2, 2, 0, 0, 0, 0], run.importedFrom.source);
    assert.ok(answers.every((a) => a.usage.input + a.usage.cacheRead + a.usage.cacheWrite + a.usage.output === 0), "zeros written, read as unknown");
  }
  // With no usage to close it, the answer after the call's result is a request of its own, after that result.
  assert.deepEqual(metricsOf(data, store, runs[1].id).kinds, ["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant"]);
});

test("a Claude Code API error is a request that failed, at its 0 tokens, never unmetered; a turn the CLI wrote itself is no request, kept as its note", async (t) => {
  let noted;
  const { data, store, runs } = await importedOne(t, (home, project) => {
    claudeSession(home, project, 38, { failed: true });
    noted = claudeSession(home, project, 39, { interrupted: true, noted: true });
  });
  const [failed, interrupted] = runs;
  assert.deepEqual([failed.state, interrupted.state], ["failed", "stopped"], "the CLI's note ends no request");
  const one = metricsOf(data, store, failed.id);
  assert.deepEqual([one.metrics.requests, one.metrics.unmetered, one.metrics.input, one.metrics.output, one.metrics.models], [2, 0, 3, 50, { "anthropic/claude-sonnet-5": 2 }]);
  assert.deepEqual([one.answers[1].stopReason, one.answers[1].errorMessage, one.answers[1].content], ["error", "API Error: overloaded", []]);
  const two = metricsOf(data, store, interrupted.id);
  assert.deepEqual([two.metrics.requests, two.metrics.unmetered], [2, 0]);
  assert.deepEqual(two.kinds, ["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant", "pi.user", "pi.user"]);
  const rows = (id) => {
    const db = new DatabaseSync(join(data, "runs", id, "store", "run.sqlite"), { readOnly: true });
    const entries = db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
    db.close();
    return timelineOf(entries, { settled: true });
  };
  assert.ok(rows(failed.id).some((r) => r.kind === "error" && r.summary === "Model request failed: API Error: overloaded"));
  assert.equal(rows(interrupted.id).findLast((r) => r.kind === "user_message").summary, "Claude Code: No response requested.");
  assert.equal((await readSession(noted, "claude-code")).users, 2, "the note is not the person's");
});

test("a pi request that failed imports as failed, at its 0 tokens; one cut short keeps its text but not the start of its counts, so it is unmetered", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => {
    piSession(home, project, 40, { ended: "error" });
    piSession(home, project, 41, { ended: "aborted" });
  });
  const [failed, cut] = runs;
  assert.deepEqual([failed.state, cut.state], ["failed", "stopped"]);
  const one = metricsOf(data, store, failed.id);
  assert.deepEqual([one.metrics.requests, one.metrics.unmetered, one.metrics.input], [2, 0, 100]);
  assert.deepEqual([one.answers[1].stopReason, one.answers[1].errorMessage], ["error", "529 overloaded"]);
  const two = metricsOf(data, store, cut.id);
  assert.deepEqual([two.metrics.requests, two.metrics.unmetered, two.metrics.input], [2, 1, 100]);
  assert.deepEqual(two.answers[1].content, [{ type: "text", text: "Read: three notes." }]);
});

/** The catalog's list price of `provider/id` for these tokens, from pi-ai's catalog itself (USD per million). */
async function listPrice(provider, id, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const { cost } = builtinModels().getModels().find((m) => m.provider === provider && m.id === id);
  return (input * cost.input + output * cost.output + cacheRead * cost.cacheRead + cacheWrite * cost.cacheWrite) / 1e6;
}

test("a run its source did not price gets the catalog's estimate, its cost still unknown; an unlisted model or a request of unknown tokens leaves it unknown, a source's cost is kept with none, and a model listed at $0 is $0", async (t) => {
  const { store, runs } = await importedOne(t, (home, project) => {
    codexSession(home, project, 51, { model: "gpt-5.5" });
    codexSession(home, project, 52);
    codexSession(home, project, 53, { model: "gpt-5.5", usage: "none" });
    claudeSession(home, project, 54, { unknownCost: true });
    claudeSession(home, project, 55);
    piSession(home, project, 56, { provider: "google", modelId: "gemma-4-26b-a4b-it", costs: [null, null] });
  });
  const priced = runs.map((run) => {
    const { costUsdEst, costBasis } = store.runMetrics(run.id);
    return [run.importedFrom.source, run.costUsd ?? null, costUsdEst ?? null, costBasis ?? null];
  });
  const codex = await listPrice("openai", "gpt-5.5", { input: 300 + 100, cacheRead: 600 + 900, output: 40 + 25 });
  const claude = await listPrice("anthropic", "claude-sonnet-5", { input: 3 + 5, cacheRead: 1000 + 1300, cacheWrite: 200 + 100, output: 50 + 30 });
  assert.ok(codex > 0 && claude > 0);
  assert.deepEqual(priced, [
    ["codex", null, Math.round(codex * 1e6) / 1e6, "catalog"],
    ["codex", null, null, null],
    ["codex", null, null, null],
    ["claude-code", null, Math.round(claude * 1e6) / 1e6, "catalog"],
    ["claude-code", 0.0421, null, null],
    ["pi", null, 0, "catalog"],
  ]);
});

test("import ends with the summary of every session found, read again from the store once held; a dry run prints the same from what it would import; hours are local", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const [site, tests, notes] = ["acme-site", "test-runner", "field-notes"].map((name) => join(at, "code", name));
  for (const dir of [site, tests, notes]) mkdirSync(dir, { recursive: true });
  claudeSession(at, site, 61);
  claudeSession(at, site, 62, { unknownCost: true });
  codexSession(at, tests, 63);
  piSession(at, notes, 64);
  const data = join(root, "agents");
  const { AGENTRUN_PUBLIC_URL: _, RENDER_EXTERNAL_URL: __, ...inherited } = process.env;
  const env = { ...inherited, HOME: at, TZ: "America/Puerto_Rico" };
  const block = (...args) => {
    const ran = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all", "--port", "7555", ...args], { env, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout.trimEnd().split("\n").slice(-5);
  };
  // Every request at 09:01 or 09:03 UTC: 05:00 in Puerto Rico (UTC-4). Bash is two of the four tool calls.
  const expected = [
    "Found 4 sessions  Claude Code 2 · Codex 1 · pi 1",
    "Imported into 3 agents (one per project)",
    "+ 8.4K tokens (84% cached) · 0.2 h of agent time",
    "+ Busiest hour: 05:00 · top tool: Bash (50%)",
    "Open http://127.0.0.1:7555/",
  ];
  const dry = block("--dry-run");
  assert.deepEqual(dry, [expected[0], "Would import into 3 agents (one per project)", ...expected.slice(2)]);
  assert.equal(existsSync(data), false, "the dry run wrote nothing");
  assert.deepEqual(block(), expected);
  assert.deepEqual(block(), expected, "run again, every session is held, and counted from the store");
});

test("the summary says unknown where it has no data", () => {
  const lines = summaryLines([{ source: "codex", agent: "a" }, { source: "pi", agent: "b", metrics: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tools: {} } }], "http://127.0.0.1:7340");
  assert.deepEqual(lines, [
    "Found 2 sessions  Codex 1 · pi 1",
    "Imported into 2 agents (one per project)",
    "+ tokens unknown · agent time unknown · 1 session unknown",
    "+ Busiest hour: unknown · top tool: none",
    "Open http://127.0.0.1:7340/",
  ]);
  assert.deepEqual(summaryLines([], "http://127.0.0.1:7340").slice(0, 4), ["Found 0 sessions", "Imported into 0 agents (one per project)", "+ tokens unknown · agent time unknown", "+ Busiest hour: unknown · top tool: unknown"]);
});

test("the CLI's own note is never the person's turn: a session holding only notes is passed over without --all, and a note before the first prompt is not the run's title", async (t) => {
  const root = await scratch(t);
  const h = { at: join(root, "home"), temp: join(root, "tmp") };
  const project = join(h.at, "code", "notes-only");
  mkdirSync(project, { recursive: true });
  const base = { cwd: project, isSidechain: false, userType: "external", version: "2.1.0" };
  const note = (n, uuid, time) => ({ ...base, sessionId: sessionId(n), type: "assistant", uuid, timestamp: minute(time), message: { id: `msg_${uuid}`, role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }], usage: { input_tokens: 0, output_tokens: 0 } } });
  const slug = project.replaceAll("/", "-");
  const only = writeSession(join(h.at, ".claude", "projects", slug, `${sessionId(71)}.jsonl`), [note(71, "n1", 0), note(71, "n2", 1)]);
  writeSession(join(h.at, ".claude", "projects", slug, `${sessionId(72)}.jsonl`), [note(72, "n3", 0), { ...base, sessionId: sessionId(72), type: "user", uuid: "u1", timestamp: minute(1), message: { role: "user", content: "Tidy the notes." } }]);
  const plan = await planImport(options(h));
  assert.deepEqual(plan.skipped.map((s) => [s.what, s.why]), [[only, "no message of the person's"]]);
  const [session] = plan.projects.flatMap((p) => p.sessions);
  assert.deepEqual([session.id, session.users, session.firstPrompt], [sessionId(72), 1, "Tidy the notes."]);
  const data = join(root, "agents");
  const store = openStore(data);
  t.after(() => store.close());
  await runImport(store, plan, options(h));
  const [run] = store.listRuns();
  assert.equal(JSON.parse(readFileSync(join(data, "runs", run.id, "serve.json"), "utf8")).title, "Tidy the notes.");
});
