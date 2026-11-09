// `agentrun-serve import`: synthetic Claude Code, Codex and pi sessions under a scratch home, into a data directory.
// Each project is one agent with a revision per harness, its CLAUDE.md or AGENTS.md and its skill folders; each session a
// run ended as it ended, its transcript its timeline, its cost the source's or unknown. What is written holds no value of
// a key-shaped variable and is the owner's only; a link, a binary file, an oversized file and a folder with no SKILL.md
// are left out by name; an imported run takes no message, and a stop, a cancel or a restart moves nothing of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { runMetricsOf, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { startServe } from "../dist/index.js";
import { agentIdOf, importCommand, planImport, runImport } from "../dist/import.js";
import { ACTIVE_GAP_MS, readSession } from "../dist/import-sources.js";
import { summaryLines } from "../dist/import-summary.js";
import { openSqliteStore } from "../dist/store/index.js";
import { listRuns } from "../dist/store-reads/runs.js";
import { runEntries } from "../dist/store-reads/journal.js";
import { toolKeysOverStore } from "../dist/tool-keys-store.js";
import { at as minute, claudeSession, claudeSubagent, codexSession, piSession, sessionId, writeSession } from "./fixtures/import-sessions.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, client, FAUX, scratch, triggerStore } from "./support.mjs";

/** The server's store on a data directory: role "server" to import into, role "runner" to read what an import wrote. */
const openData = (data, role = "server") => openSqliteStore({ dataDir: data, role });
/** A run's stored metrics, as the old store.runMetrics gave them (the object the import wrote on the run row). */
const storedMetrics = async (store, id) => (await store.runs.get(id)).metrics;
/** An agent and its revisions in the old readAgent shape: each revision carries `current` (its id is the agent's current). */
async function agentOf(store, id) {
  const agent = await store.agents.get(id);
  if (!agent) return undefined;
  const revisions = (await store.agents.revisions(id)).map((r) => ({ ...r, current: r.id === agent.currentRevision }));
  return { agent, revisions };
}
/** A run's entries from its journal, in log order (the old run.sqlite "SELECT record FROM entries ORDER BY id"). */
const entriesOf = (store, id) => runEntries(store, id, ctx);
/** The runs as the old listRuns gave them (view rows: state completed/stopped, ISO times, importedFrom {source, session}). */
const rowsOf = (store, agentId) => listRuns(store, agentId ? { agent: agentId } : {}, ctx);
/** A saved tool key, sealed into the store under `seal` (the switch keeps tool keys in the store, not a tool-keys.json file). */
async function seedToolKey(data, seal, id, values) {
  const store = await openData(data);
  try {
    const keys = toolKeysOverStore(store, { AGENTRUN_SEAL_KEY: seal }, () => {});
    await keys.load();
    await keys.save(id, { values });
  } finally {
    await store.close();
  }
}

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
  // Import through a server-role store (the owner lock), then release it and reopen read-only (role runner), which coexists
  // with a server a test starts on the same data; the server role would be refused the owner lock while the test's server holds it.
  const writer = await openData(data);
  const plan = await planImport(options(h));
  const report = await runImport(writer, plan, options(h));
  await writer.close();
  const store = await openData(data, "runner");
  t.after(async () => await store.close());
  return { root, h, data, store, report, plan };
}

const runsOf = async (store, agentId) => (await rowsOf(store, agentId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.importedFrom.session.localeCompare(b.importedFrom.session));

test("each project is one agent with a revision per harness, its CLAUDE.md or AGENTS.md and its skill folders; each session one run, ended as it ended, at the source's cost or unknown", { timeout: 60_000 }, async (t) => {
  const { h, data, store, report } = await imported(t);
  assert.deepEqual(report.agents.map((a) => [a.cwd, a.runs]), [[h.site, 3], [h.notes, 1], [h.tests, 1]]);
  const site = report.agents[0];
  const { agent, revisions } = await agentOf(store, site.id);
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
  const runs = await runsOf(store, site.id);
  assert.deepEqual(runs.map((r) => [r.importedFrom.source, r.state, r.costUsd ?? null]), [["claude-code", "completed", 0.0421], ["claude-code", "stopped", 0.01], ["codex", "completed", null]]);
  assert.equal(runs[0].startedAt, "2026-10-20T09:00:00.000Z");
  const [notes] = await rowsOf(store, report.agents[1].id);
  assert.equal((await agentOf(store, report.agents[1].id)).revisions[0].body.harness, undefined, "pi is the default harness, never stored");
  assert.ok(Math.abs(notes.costUsd - 0.005) < 1e-12, "pi's requests' costs, summed");
  assert.equal((await rowsOf(store, report.agents[2].id))[0].state, "stopped", "an aborted Codex turn");

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
  assert.equal(body.rows.findLast((r) => r.kind === "usage")?.usage?.requests, (await storedMetrics(store, runs[0].id)).requests, "the served usage row counts the requests the metrics do");
  const rows = body.rows.map((r) => `${r.kind}:${r.text ?? r.name ?? ""}`).join("\n");
  assert.match(rows, /^user_message:List the files\.$/m);
  assert.ok(body.rows.some((r) => r.kind === "tool_use" && r.tool_name === "Bash" && r.tool_input_preview === "ls"), "the Bash call");
  assert.ok(body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "Bash"), "and its output");
  assert.match(rows, /The files: README\.md/);
  assert.doesNotMatch(rows, /hook's note|environment_context/, "a hook's or the CLI's own user records are not the person's");
});

test("nothing the import writes holds a key-shaped variable's value; its places are marked, and a skill's text is cut", async (t) => {
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
  assert.ok(all.some((file) => readFileSync(file).includes("[redacted]")), "the canary's places are marked in the store");
  // The revision's skill texts, as the store keeps them (on the revision's row): the cut runs on each.
  const texts = (await agentOf(store, report.agents[0].id)).revisions.flatMap((r) => Object.values(r.skills ?? {}));
  assert.ok(texts.some((text) => text.startsWith("---\nname: deploy") && text.includes("[redacted]")), "SKILL.md, cut");
  assert.ok(texts.some((text) => text.startsWith("1. build") && text.includes("[redacted]")), "the skill's other file, cut");
  assert.ok(!texts.some((text) => text.includes(CANARY)));
});

test("an imported run takes no message (409 not_continuable, reason imported); a stop, a cancel and a restart answer as for an ended run and move nothing", { timeout: 60_000 }, async (t) => {
  const { data, store, report } = await imported(t);
  const run = (await runsOf(store, report.agents[0].id))[0];
  const one = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  const api = client(one.baseUrl, one.token);
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
  // The run stays as imported: still ended, took no message, moved nothing.
  assert.equal((await rowsOf(store)).find((r) => r.id === run.id).state, "completed");
});

test("an imported run whose journal holds nothing to render reads as such: its timeline and files answer, never 500", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const data = join(root, "agents");
  const writer = await openData(data);
  const report = await runImport(writer, await planImport(options(h)), options(h));
  const agentId = report.agents[0].id;
  const revisionId = (await writer.agents.get(agentId)).currentRevision;
  // A run written with no transcript batches: its journal renders nothing, as an imported run with no turns would. The
  // server must answer its views, never 500.
  await writer.importRun({ id: "thin-run", agentId, revisionId, importedFrom: { source: "pi", session: "thin" }, launch: { body: { input: { content: "" }, title: "thin", place: { mode: "runner" } } }, startedAt: Date.parse("2026-10-20T09:00:00Z"), transcript: [] });
  await writer.close();
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("GET", `/runs/thin-run`)).status, 200);
  const timeline = await api("GET", `/runs/thin-run/timeline`);
  assert.equal(timeline.status, 200, JSON.stringify(timeline.body));
  assert.deepEqual(timeline.body.rows, []);
  const files = await api("GET", `/runs/thin-run/files`);
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
  const store = await openData(data);
  t.after(async () => await store.close());
  const report = await runImport(store, await planImport(options(h)), options(h));
  const why = Object.fromEntries(report.skipped.map((s) => [s.what, s.why]));
  assert.equal(why[join(skills, "linked")], "a link: not followed");
  assert.equal(why[join(skills, "huge", "SKILL.md")], `over ${256 * 1024} bytes`);
  assert.equal(why[join(skills, "deploy", "logo.png")], "not text");
  assert.equal(why[join(skills, "deploy", "notes.md")], "not text", "invalid UTF-8 with no NUL byte");
  assert.equal(why[join(skills, "notes")], "no SKILL.md: not a skill");
  assert.equal(why[join(h.notes, "AGENTS.md")], "a link: not followed");
  assert.equal(why[join(h.notes, ".pi", "skills")], "a link: not followed", "a skill folder that is itself a link");
  const kept = (await agentOf(store, report.agents[0].id)).revisions[0].body.skills;
  assert.deepEqual(Object.keys(kept).sort(), ["deploy/SKILL.md", "deploy/steps.md", "review/SKILL.md"]);
  assert.equal((await agentOf(store, report.agents[1].id)).revisions[0].body.instructions, "");
  for (const file of keptUnder(data)) assert.ok(!file[1].includes("OUTSIDE-MARKER"), "a link's target is never read");
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
  assert.deepEqual(again.agents.map((a) => [a.runs, a.already, a.created]), [[0, 3, false], [0, 1, false], [0, 1, false]]);
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
  const store = await openData(join(root, "agents"));
  t.after(async () => await store.close());
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
  // OPENAI_API_KEY is one of the launcher's secrets, out of process.env once the CLI starts: still read by name, and cut.
  const written = readdirSync(data, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  for (const file of written) assert.ok(!readFileSync(file).includes(CANARY), `no key value in ${file}`);
});

test("the CLI's import cuts the server's own keys out of what it keeps, wherever a session holds one: its text, a subagent's, its first message (the run's title), its project's path and its file's name", async (t) => {
  const root = await scratch(t);
  const h = home(root);
  // The key in a subagent's answer, in a session's first message, in a project's directory name, and in the name of a
  // session file whose records carry no session id (the import then names the session after its file).
  claudeSubagent(h.at, h.site, 1, 1, { answer: `The config holds ${CANARY}.` });
  claudeSession(h.at, h.site, 11, { prompt: `Rotate the key ${CANARY} today.` });
  const keyed = join(h.at, "code", `deploy-${CANARY}`);
  mkdirSync(keyed, { recursive: true });
  claudeSession(h.at, keyed, 12);
  const named = claudeSession(h.at, h.site, 13, { prompt: "Check the logs." });
  const lines = readFileSync(named, "utf8").trimEnd().split("\n").map((line) => { const { sessionId: _, ...rest } = JSON.parse(line); return JSON.stringify(rest); });
  rmSync(named);
  writeFileSync(join(dirname(named), `${CANARY}.jsonl`), `${lines.join("\n")}\n`);
  utimesSync(join(dirname(named), `${CANARY}.jsonl`), new Date(minute(10)), new Date(minute(10)));
  const data = join(root, "agents");
  // No launcher: the key is in the environment the server starts with, which its start moves out of process.env.
  const env = { ...process.env, HOME: h.at, OPENAI_API_KEY: CANARY };
  const ran = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all"], { env, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  // Every byte the import kept, the store's write-ahead log included, and every path under the data directory.
  const kept = [];
  const walk = (at) => { for (const entry of readdirSync(at, { withFileTypes: true })) { const path = join(at, entry.name); if (entry.isDirectory()) walk(path); else kept.push([path, readFileSync(path)]); } };
  walk(data);
  assert.deepEqual(kept.filter(([path, bytes]) => bytes.includes(CANARY) || path.includes(CANARY)).map(([path]) => path.slice(data.length + 1).replaceAll(CANARY, "<key>")), [], "the key is nowhere in what the import kept");
  assert.ok(kept.some(([, bytes]) => bytes.includes("[redacted]")), "its places are marked");
  // Each case was imported, so none passes by being left out.
  const reader = await openData(data, "runner");
  const runs = await rowsOf(reader);
  await reader.close();
  assert.ok(kept.some(([, bytes]) => bytes.includes("Rotate the key [redacted]")), "the run titled with the key is in, its title cut");
  assert.ok(kept.some(([, bytes]) => bytes.includes("deploy-[redacted]")), "the project named with the key is in, its name cut");
  assert.ok(runs.some((run) => run.importedFrom?.source === "claude-code" && !/^0{8}-/.test(run.importedFrom.session)), "the session named after its file is in");
  // The file named with the key grows by a turn, and a second import finds the run the first made of it under the id as
  // kept: no second run of it.
  const last = JSON.parse(lines.at(-1));
  appendFileSync(join(dirname(named), `${CANARY}.jsonl`), `${JSON.stringify({ ...last, type: "user", uuid: "u9-13", parentUuid: last.uuid ?? null, timestamp: minute(9), message: { role: "user", content: "One more thing." } })}\n`);
  utimesSync(join(dirname(named), `${CANARY}.jsonl`), new Date(minute(20)), new Date(minute(20)));
  const again = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all"], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  const after = await openData(data, "runner");
  t.after(async () => await after.close());
  assert.equal((await rowsOf(after)).length, runs.length, "no run made twice");
});

/** A key of every format secretlint's recommended rules find, though no environment holds it: each made here, random
 *  (the private key a real one, made here), so no scanner reads this file as holding one, and none is anyone's. */
function shapedKeys() {
  const pick = (n, set) => Array.from(randomBytes(n), (b) => set[b % set.length]).join("");
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const URL64 = `${ALNUM}_-`;
  const OPENAI = ["T3Blbk", "FJ"].join("");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey.trim();
  return {
    anthropic: ["sk", "ant", "api03", pick(93, URL64)].join("-") + "AA",
    openaiProject: ["sk", "proj", `${pick(74, ALNUM)}${OPENAI}${pick(74, ALNUM)}`].join("-"),
    openai: ["sk", `${pick(20, ALNUM)}${OPENAI}${pick(20, ALNUM)}`].join("-"),
    github: `${["gh", "p"].join("")}_${pick(36, ALNUM)}`,
    githubFine: ["github", "pat", pick(82, `${ALNUM}_`)].join("_"),
    slack: [["xo", "xb"].join(""), pick(12, "0123456789"), pick(13, "0123456789"), pick(24, ALNUM)].join("-"),
    stripe: ["sk", "live", pick(24, ALNUM)].join("_"),
    pem: { block: pem, lines: pem.split("\n").slice(1, -1) },
  };
}

test("an import cuts every key secretlint finds though no environment holds it, wherever a session or project holds one, and says how many it removed", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "payments");
  const k = shapedKeys();
  // The project's instructions and a skill, its content and its folder's name.
  mkdirSync(join(site, ".claude", "skills", `rotate-${k.githubFine}`), { recursive: true });
  // A second folder named after another token: the two stay two skills.
  mkdirSync(join(site, ".claude", "skills", `rotate-${k.github}`), { recursive: true });
  writeFileSync(join(site, ".claude", "skills", `rotate-${k.github}`, "SKILL.md"), "---\nname: rotate-again\n---\nThe second one.\n");
  writeFileSync(join(site, "CLAUDE.md"), `Deploy with ${k.stripe}.\n${k.pem.block}\n`);
  writeFileSync(join(site, ".claude", "skills", `rotate-${k.githubFine}`, "SKILL.md"), `---\nname: rotate\n---\nThe old key was ${k.openai}\n`);
  // A session's text (a .env an agent printed), its first message (the run's title), a subagent's answer, and a
  // session file named after a key (its records carry no session id, so the import names the session after its file).
  claudeSession(at, site, 1, { prompt: `Rotate ${k.anthropic} and ${k.github} today.`, output: `cat .env:\nOPENAI_API_KEY=${k.openai}\nSLACK=${k.slack}` });
  claudeSubagent(at, site, 1, 1, { answer: `The colleague's key is ${k.openai} and the bot's ${k.slack}.` });
  const named = claudeSession(at, site, 2, { prompt: "Check the logs.", output: `Found ${k.openaiProject} in the logs.` });
  const records = readFileSync(named, "utf8").trimEnd().split("\n").map((line) => { const { sessionId: _, ...rest } = JSON.parse(line); return JSON.stringify(rest); });
  rmSync(named);
  writeFileSync(join(dirname(named), `${k.openaiProject}.jsonl`), `${records.join("\n")}\n`);
  utimesSync(join(dirname(named), `${k.openaiProject}.jsonl`), new Date(minute(10)), new Date(minute(10)));
  // A file named after a token that is no session: skipped, and its name printed in the skipped line.
  const unnamed = `${["gh", "s"].join("")}_${randomBytes(18).toString("hex")}`;
  writeFileSync(join(dirname(named), `${unnamed}.jsonl`), "not a session\n");
  utimesSync(join(dirname(named), `${unnamed}.jsonl`), new Date(minute(10)), new Date(minute(10)));
  const data = join(root, "agents");
  // No environment holds any of them.
  const run = async (...args) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home: at, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
    return lines;
  };
  // The default output (its left-out counts and reasons among it), then --verbose's file by file lines, the skipped one
  // among them: the import's again, with nothing new to take.
  const dry = await run("--dry-run");
  const dryVerbose = await run("--dry-run", "--verbose");
  const lines = await run();
  const verbose = await run("--verbose");
  const values = { ...k, pem: k.pem.lines };
  const kinds = Object.keys(values).length;
  // Every byte the import kept, and every name under the data directory.
  const kept = [];
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); kept.push([path, entry.isDirectory() ? Buffer.alloc(0) : readFileSync(path)]); if (entry.isDirectory()) walk(path); } };
  walk(data);
  const left = Object.entries(values).flatMap(([kind, value]) => (Array.isArray(value) ? value : [value]).flatMap((v) => kept.filter(([path, bytes]) => bytes.includes(v) || path.includes(v)).map(([path]) => `${kind} in ${path.slice(data.length + 1)}`)));
  assert.deepEqual(left, [], "no key or token is anywhere in what the import kept");
  assert.ok(kept.some(([, bytes]) => bytes.includes("[redacted]")), "its places are marked");
  assert.ok(dry.includes(`${kinds} secrets would be removed`), `the dry run counts what the import removes: ${dry.filter((l) => /removed/.test(l))}`);
  // Nothing it printed names a key: the skipped file's name is cut where it is printed.
  for (const [kind, value] of [...Object.entries(values).flatMap(([kind, v]) => (Array.isArray(v) ? v : [v]).map((x) => [kind, x])), ["skipped file", unnamed]]) assert.ok(![...dry, ...dryVerbose, ...lines, ...verbose].some((l) => l.includes(value)), `${kind} printed`);
  assert.ok([dry, lines].every((out) => out.some((l) => l.startsWith("left out: "))), "the default output counts what it left out");
  assert.ok([dryVerbose, verbose].every((out) => out.some((l) => l.startsWith("skipped ") && l.includes("[redacted].jsonl"))), "the skipped line, its name cut");
  // Each is counted once, however many places held it (the private key one of them).
  assert.ok(lines.includes(`${kinds} secrets removed`), `the import says it removed ${kinds}: ${lines.filter((l) => /removed/.test(l))}`);
  const reader = await openData(data, "runner");
  t.after(async () => await reader.close());
  assert.equal((await rowsOf(reader)).length, 2, "both sessions are in, the one named after a key under its id as kept");
  assert.ok((await rowsOf(reader)).some((r) => /^redacted-[0-9a-f]{16}$/.test(r.importedFrom.session)));
  const skills = Object.keys((await agentOf(reader, agentIdOf(site))).revisions.find((r) => r.current).body.skills).filter((path) => path.endsWith("SKILL.md"));
  assert.equal(skills.length, 2, `the two folders named after keys stay two skills: ${skills}`);
  assert.ok(skills.every((path) => /redacted-[0-9a-f]{12}\//.test(path)), skills.join(" "));
});

test("keys in a JSON string a session holds, as Codex keeps a shell's output and as Claude Code keeps a printed file, are cut and counted once", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "vault");
  mkdirSync(site, { recursive: true });
  const k = shapedKeys();
  const config = JSON.stringify({ anthropic: k.anthropic, github: k.github, slack: k.slack, stripe: k.stripe, private_key: k.pem.block });
  // Codex: the shell's output is a JSON string in the record, the printed file a JSON string inside that.
  codexSession(at, site, 1, { output: JSON.stringify({ output: `$ cat config.json\n${config}`, metadata: { exit_code: 0, duration_seconds: 0.4 } }) });
  // Claude Code: the printed file is the tool result's text.
  claudeSession(at, site, 2, { output: config });
  const data = join(root, "agents");
  const lines = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
  for (const value of [k.anthropic, k.github, k.slack, k.stripe, ...k.pem.lines]) for (const [file, bytes] of keptUnder(data)) assert.ok(!bytes.includes(value), `${file.slice(data.length + 1)} holds ${value.slice(0, 8)}…`);
  assert.ok(lines.includes("5 secrets removed"), lines.filter((l) => /removed/.test(l)).join(" "));
});

test("keys an environment holds and sessions of each harness hold too are each counted once, however each was found: the summary counts the values the import cut", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const [billing, site] = [join(at, "code", "billing"), join(at, "code", "site")];
  for (const dir of [billing, site]) mkdirSync(dir, { recursive: true });
  const k = shapedKeys();
  // As a person's environment holds them, and as their sessions printed or pasted them: Claude Code twice, Codex, pi.
  const keys = { OPENAI_API_KEY: k.openai, STRIPE_SECRET_KEY: k.stripe, ANTHROPIC_API_KEY: k.anthropic };
  claudeSession(at, billing, 1, { prompt: "Check the environment.", output: Object.entries(keys).map(([name, value]) => `${name}=${value}`).join("\n") });
  codexSession(at, site, 2, { prompt: `Run the eval with ${keys.OPENAI_API_KEY}.` });
  piSession(at, site, 3, { prompt: `Rotate ${keys.ANTHROPIC_API_KEY} today.` });
  claudeSession(at, site, 4, { prompt: "Log in to Stripe again.", output: `stripe login --api-key ${keys.STRIPE_SECRET_KEY}` });
  const data = join(root, "agents");
  const run = async (...args) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home: at, env: { PATH: "/usr/bin", ...keys }, out: (line) => lines.push(line) }), 0);
    return lines.filter((line) => /removed/.test(line));
  };
  assert.deepEqual(await run("--dry-run"), ["3 secrets would be removed"]);
  assert.deepEqual(await run(), ["3 secrets removed"]);
  for (const [name, value] of Object.entries(keys)) assert.deepEqual(keptUnder(data).filter(([, bytes]) => bytes.includes(value)).map(([path]) => path.slice(data.length + 1)), [], `${name}'s value`);
});

test("this server's own secrets, pasted into sessions, are cut out of what the import keeps and prints, and counted: its webhook signing secret, its token and its sign-in sessions' secret", async (t) => {
  const root = await scratch(t);
  const data = join(root, "agents");
  const seal = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
  const before = process.env.AGENTRUN_SEAL_KEY;
  t.after(() => (before === undefined ? delete process.env.AGENTRUN_SEAL_KEY : (process.env.AGENTRUN_SEAL_KEY = before)));
  process.env.AGENTRUN_SEAL_KEY = seal.AGENTRUN_SEAL_KEY;
  // A server that made each of them, the webhook's secret shown once at its first PUT. Closed before the import, as a
  // person runs one.
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true });
  let open = true;
  t.after(() => open && server.close());
  const api = client(server.baseUrl, server.token);
  const set = await api("PUT", "/settings/webhook", { url: "http://127.0.0.1:9/hook" });
  assert.equal(set.status, 201, JSON.stringify(set.body));
  await server.close();
  open = false;
  // The per-run door token is gone (the runner cutover deleted it): the server keeps its API token, its sign-in session
  // secret and the webhook's signing secret.
  const own = {
    webhook: set.body.secret,
    token: server.token,
    session: readFileSync(join(data, ".session-secret"), "utf8").trim(),
  };
  for (const [name, value] of Object.entries(own)) assert.ok(typeof value === "string" && value.length >= 32, `${name}: ${typeof value}`);
  const at = join(root, "home");
  const site = join(at, "code", "hooks");
  mkdirSync(site, { recursive: true });
  claudeSession(at, site, 1, { prompt: `The webhook's secret is ${own.webhook}, check the receiver.`, output: `token ${own.token}` });
  codexSession(at, site, 2, { prompt: `The API token is ${own.token}.` });
  piSession(at, site, 3, { prompt: `The session secret is ${own.session}.` });
  // What was there before the import: the server's own files, which hold them as the server keeps them.
  const had = new Map(keptUnder(data));
  const run = async (args, env = { PATH: "/usr/bin", ...seal }) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home: at, env, out: (line) => lines.push(line) }), 0);
    return lines;
  };
  // With no seal key, the webhook's secret does not open: the other two are cut all the same.
  assert.deepEqual((await run(["--dry-run"], { PATH: "/usr/bin" })).filter((l) => /removed/.test(l)), ["2 secrets would be removed"]);
  const dry = await run(["--dry-run"]);
  const lines = await run([]);
  const wrote = keptUnder(data).filter(([path, bytes]) => !had.get(path)?.equals(bytes));
  assert.ok(wrote.length > 0, "the import wrote");
  for (const [name, value] of Object.entries(own)) {
    assert.deepEqual(wrote.filter(([, bytes]) => bytes.includes(value)).map(([path]) => path.slice(data.length + 1)), [], `${name}: in no byte the import wrote`);
    assert.ok(![...dry, ...lines].some((line) => line.includes(value)), `${name}: in no printed line`);
  }
  assert.ok(dry.includes("3 secrets would be removed"), dry.filter((l) => /removed/.test(l)).join(" "));
  assert.ok(lines.includes("3 secrets removed"), lines.filter((l) => /removed/.test(l)).join(" "));
});

test("a webhook trigger's key or the outbound webhook's, pasted into sessions as base64, base64url or hex, is cut out of what the import keeps and prints", async (t) => {
  const root = await scratch(t);
  const data = join(root, "agents");
  const seal = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
  const before = process.env.AGENTRUN_SEAL_KEY;
  t.after(() => (before === undefined ? delete process.env.AGENTRUN_SEAL_KEY : (process.env.AGENTRUN_SEAL_KEY = before)));
  process.env.AGENTRUN_SEAL_KEY = seal.AGENTRUN_SEAL_KEY;
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", store: await triggerStore() });
  let open = true;
  t.after(() => open && server.close());
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", agent("target"))).status, 201);
  const trigger = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "target", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const outbound = await api("PUT", "/settings/webhook", { url: "https://hooks.example/in" });
  assert.equal(outbound.status, 201, JSON.stringify(outbound.body));
  await server.close();
  open = false;
  const forms = {};
  for (const [what, secret] of [["trigger", trigger.body.secret], ["outbound", outbound.body.secret]]) {
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    Object.assign(forms, { [`${what} base64`]: secret.slice("whsec_".length), [`${what} base64url`]: key.toString("base64url"), [`${what} hex`]: key.toString("hex") });
  }
  const at = join(root, "home");
  const site = join(at, "code", "hooks");
  mkdirSync(site, { recursive: true });
  claudeSession(at, site, 1, { prompt: `The trigger's key is ${forms["trigger base64"]}, or ${forms["trigger base64url"]}.`, output: `hex ${forms["trigger hex"]}` });
  codexSession(at, site, 2, { prompt: `The webhook's key is ${forms["outbound base64"]}, or ${forms["outbound base64url"]}.` });
  piSession(at, site, 3, { prompt: `As hex: ${forms["outbound hex"]}.` });
  const had = new Map(keptUnder(data));
  const lines = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin", ...seal }, out: (line) => lines.push(line) }), 0);
  const wrote = keptUnder(data).filter(([path, bytes]) => !had.get(path)?.equals(bytes));
  assert.ok(wrote.length > 0, "the import wrote");
  for (const [form, value] of Object.entries(forms)) {
    assert.deepEqual(wrote.filter(([, bytes]) => bytes.includes(value)).map(([path]) => path.slice(data.length + 1)), [], `the ${form} key: in no byte the import wrote`);
    assert.ok(!lines.some((line) => line.includes(value)), `the ${form} key: in no printed line`);
  }
});

test("an import that cannot open this server's webhook secret (no seal key, or another one) says so once, its dry run too, and imports all the same; with the key it says nothing", async (t) => {
  const root = await scratch(t);
  const data = join(root, "agents");
  const key = randomBytes(32).toString("base64");
  const before = process.env.AGENTRUN_SEAL_KEY;
  t.after(() => (before === undefined ? delete process.env.AGENTRUN_SEAL_KEY : (process.env.AGENTRUN_SEAL_KEY = before)));
  process.env.AGENTRUN_SEAL_KEY = key;
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let open = true;
  t.after(() => open && server.close());
  assert.equal((await client(server.baseUrl, server.token)("PUT", "/settings/webhook", { url: "http://127.0.0.1:9/hook" })).status, 201);
  await server.close();
  open = false;
  const at = join(root, "home");
  const site = join(at, "code", "hooks");
  mkdirSync(site, { recursive: true });
  claudeSession(at, site, 1);
  const { AGENTRUN_SEAL_KEY: _, ...inherited } = process.env;
  const said = (seal, ...args) => {
    const ran = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all", ...args], { env: { ...inherited, HOME: at, ...(seal ? { AGENTRUN_SEAL_KEY: seal } : {}) }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stderr.split("\n").filter((line) => line.includes("event=webhook_secret"));
  };
  for (const [seal, condition] of [[undefined, "seal_key_missing"], [randomBytes(32).toString("base64"), "unreadable"]])
    for (const args of [["--dry-run"], []]) {
      const lines = said(seal, ...args);
      assert.equal(lines.length, 1, `${condition} ${args}: ${lines.join("\n")}`);
      assert.equal(lines[0].replace(/at=\S+ /, ""), `agentrun-serve import: event=webhook_secret condition=${condition} name=AGENTRUN_SEAL_KEY file=${join(data, "webhook.json")} effect="this server's webhook secret cannot be read, so the import does not cut it"`);
    }
  for (const args of [["--dry-run"], []]) assert.deepEqual(said(key, ...args), [], "with the key it opens, nothing is said");
  const reader = await openData(data, "runner");
  t.after(async () => await reader.close());
  assert.equal((await rowsOf(reader)).length, 1, "imported all the same");
});

test("what an import says on stderr goes through the cut its other lines do: a data directory whose path holds a key prints it as [redacted], once", async (t) => {
  const root = await scratch(t);
  // A key of the environment's, in the data directory's path, as a folder named after one would hold it.
  const value = `not-a-secret-${randomBytes(12).toString("hex")}`;
  const data = join(root, `agents-${value}`);
  const before = process.env.AGENTRUN_SEAL_KEY;
  t.after(() => (before === undefined ? delete process.env.AGENTRUN_SEAL_KEY : (process.env.AGENTRUN_SEAL_KEY = before)));
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let open = true;
  t.after(() => open && server.close());
  assert.equal((await client(server.baseUrl, server.token)("PUT", "/settings/webhook", { url: "http://127.0.0.1:9/hook" })).status, 201);
  await server.close();
  open = false;
  const at = join(root, "home");
  const site = join(at, "code", "hooks");
  mkdirSync(site, { recursive: true });
  claudeSession(at, site, 1);
  const { AGENTRUN_SEAL_KEY: _, ...inherited } = process.env;
  // No seal key: the webhook's secret does not open, and the line naming its file is said.
  for (const args of [["--dry-run"], []]) {
    const ran = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all", ...args], { env: { ...inherited, HOME: at, OPENAI_API_KEY: value }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(![ran.stdout, ran.stderr].some((text) => text.includes(value)), `${args}: the key is printed`);
    const lines = ran.stderr.split("\n").filter((line) => line.includes("event=webhook_secret"));
    assert.equal(lines.length, 1, `${args}: ${ran.stderr}`);
    assert.ok(lines[0].includes(`file=${join(root, "agents-[redacted]", "webhook.json")}`), lines[0]);
  }
});

test("this repository's own source, imported as a session's output, has nothing cut from it", async (t) => {
  const repo = new URL("../../../", import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", "coverage", "storybook-static"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) files.push(path);
    }
  };
  for (const top of ["packages", "apps"]) walk(join(repo, top));
  // Every file must come through whole.
  const source = files;
  assert.ok(source.length > 300, `the source read: ${source.length} files`);
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "agentrun");
  mkdirSync(site, { recursive: true });
  // Each file printed whole by a session, about a megabyte of source a session.
  let [n, chunk, size] = [1, [], 0];
  const flushed = () => (chunk.length && claudeSession(at, site, n++, { prompt: "Read the source.", output: chunk.join("\n") }), (chunk = []), (size = 0));
  for (const file of source) {
    const text = readFileSync(file, "utf8");
    chunk.push(`==> ${file.slice(repo.length)}\n${text}`);
    size += text.length;
    if (size > 1_000_000) flushed();
  }
  flushed();
  const data = join(root, "agents");
  const lines = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
  assert.ok(lines.includes("0 secrets removed"), `${source.length} files: ${lines.filter((l) => /removed/.test(l)).join(" ")}`);
});

test("secretlint finds nothing in code that names keys and passwords", async () => {
  const { secretsIn } = await import("../dist/secret-cut.js");
  for (const line of [
    "const apiKey = process.env.OPENAI_API_KEY;",
    "user.password = bcrypt.hashSync(password, 10);",
    "const { accessKeyId, secretAccessKey } = await sts.assumeRole({ RoleArn: roleArn }).promise();",
    'headers: { "x-api-key": config.apiKey, authorization: `Bearer ${session.accessToken}` }',
  ])
    assert.deepEqual(await secretsIn(line), [], line);
});

test("setup's count reads no session through secretlint; an import reads each run once, as it reads it, and a plan only each session's id", async (t) => {
  const { secretlintCalls } = await import("../dist/secret-cut.js");
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "count");
  mkdirSync(site, { recursive: true });
  for (let n = 1; n <= 5; n++) claudeSession(at, site, n);
  const env = { PATH: "/usr/bin" };
  const before = secretlintCalls.count;
  // As setup's count asks for it (import-worker.ts): a listing, no transcript kept, so no scan.
  const counted = await planImport({ home: at, env, all: true, keys: false });
  assert.equal(counted.projects[0].sessions.length, 5);
  assert.equal(secretlintCalls.count, before, "the count read no session through secretlint");
  const store = await openData(join(root, "agents"));
  t.after(async () => await store.close());
  const plan = await planImport({ home: at, env, all: true }, store);
  const planned = secretlintCalls.count;
  assert.equal(planned - before, 5, "the import's plan reads each session's id alone, no file");
  await runImport(store, plan, { home: at, env, all: true });
  assert.equal(secretlintCalls.count - planned, 1 + 5, "the import: its project's own text once, and each run once");
});

test("a key a session still being written adds after the plan read it is cut all the same: the import finds keys in what it reads", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "live");
  mkdirSync(site, { recursive: true });
  const file = claudeSession(at, site, 1, { prompt: "Deploy it." });
  const env = { PATH: "/usr/bin" };
  const data = join(root, "agents");
  const store = await openData(data);
  t.after(async () => await store.close());
  const plan = await planImport({ home: at, env, all: true }, store);
  // Written after the plan: one more message of the person's, holding a key.
  const key = shapedKeys().github;
  const first = JSON.parse(readFileSync(file, "utf8").split("\n").find((line) => line.includes('"type":"user"')));
  appendFileSync(file, `${JSON.stringify({ ...first, uuid: "late-1", timestamp: minute(30), message: { role: "user", content: `Rotate ${key} now.` } })}\n`);
  const report = await runImport(store, plan, { home: at, env, all: true });
  assert.equal(report.agents[0]?.runs, 1, JSON.stringify(report.agents));
  for (const [path, bytes] of keptUnder(data)) assert.ok(!bytes.includes(key), `${path.slice(data.length + 1)} holds the key`);
  assert.equal(report.secretsRemoved, 1);
});

test("a key found in a project's sessions is cut from its instructions too, where it stands bare: every key of a project is known before any of it is written", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "infra");
  mkdirSync(site, { recursive: true });
  const pick = (n, set) => Array.from(randomBytes(n), (b) => set[b % set.length]).join("");
  const id = `${["AK", "IA"].join("")}${pick(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`;
  // Its last character a letter or a digit: secretlint's AWS rule ends the 40 characters at a word boundary, so a secret
  // that ends in "/" or "+" is one it does not find (a known miss, pinned in its own test).
  const secret = `${pick(39, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+")}${pick(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`;
  // Bare in the project's instructions, no name or id beside it: no rule finds it there.
  writeFileSync(join(site, "CLAUDE.md"), `Deploy with ${secret} on Fridays.\n`);
  // Beside its name in a session: secretlint's AWS rule finds it.
  claudeSession(at, site, 1, { prompt: "Show the credentials.", output: `AWS_ACCESS_KEY_ID=${id}\nAWS_SECRET_ACCESS_KEY=${secret}` });
  const data = join(root, "agents");
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin" }, out: () => {} }), 0);
  for (const form of [secret, secret.replaceAll("/", "\\/")]) for (const [file, bytes] of keptUnder(data)) assert.ok(!bytes.includes(form), `${file.slice(data.length + 1)} holds the secret`);
  const reader = await openData(data, "runner");
  t.after(async () => await reader.close());
  assert.match((await agentOf(reader, agentIdOf(site))).revisions.find((r) => r.current).body.instructions, /Deploy with \[redacted\] on Fridays\./);
});

test("a key found in one project's sessions is cut from another project's instructions where it stands bare, though that project is imported first: every key is known before anything is written", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  // In the import's order (by path), the docs project comes first.
  const [docs, infra] = [join(at, "code", "a-docs"), join(at, "code", "b-infra")];
  for (const dir of [docs, infra]) mkdirSync(dir, { recursive: true });
  const pick = (n, set) => Array.from(randomBytes(n), (b) => set[b % set.length]).join("");
  const id = `${["AK", "IA"].join("")}${pick(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`;
  // Its last character a letter or a digit: secretlint's AWS rule ends the 40 characters at a word boundary, so a secret
  // that ends in "/" or "+" is one it does not find (a known miss, pinned in its own test).
  const secret = `${pick(39, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+")}${pick(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`;
  // Bare in the first project's instructions; beside its name only in the second project's session.
  writeFileSync(join(docs, "CLAUDE.md"), `Deploy with ${secret} on Fridays.\n`);
  claudeSession(at, docs, 1, { prompt: "Tidy the docs." });
  claudeSession(at, infra, 2, { prompt: "Show the credentials.", output: `AWS_ACCESS_KEY_ID=${id}\nAWS_SECRET_ACCESS_KEY=${secret}` });
  const data = join(root, "agents");
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin" }, out: () => {} }), 0);
  for (const form of [secret, secret.replaceAll("/", "\\/")]) for (const [file, bytes] of keptUnder(data)) assert.ok(!bytes.includes(form), `${file.slice(data.length + 1)} holds the secret`);
  const reader = await openData(data, "runner");
  t.after(async () => await reader.close());
  assert.match((await agentOf(reader, agentIdOf(docs))).revisions.find((r) => r.current).body.instructions, /Deploy with \[redacted\] on Fridays\./);
});

test("what the CLI prints is cut with every key the import finds: a secret beside its name in one project's session is cut where another project's folder name holds it bare", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const pick = (n, set) => Array.from(randomBytes(n), (b) => set[b % set.length]).join("");
  const id = `${["AK", "IA"].join("")}${pick(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`;
  const secret = pick(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  // Bare in the first project's folder name (printed with its path); beside its name only in the second project's session.
  const [docs, infra] = [join(at, "code", `a-${secret}`), join(at, "code", "b-infra")];
  for (const dir of [docs, infra]) mkdirSync(dir, { recursive: true });
  claudeSession(at, docs, 1, { prompt: "Tidy the docs." });
  claudeSession(at, infra, 2, { prompt: "Show the credentials.", output: `AWS_ACCESS_KEY_ID=${id}\nAWS_SECRET_ACCESS_KEY=${secret}` });
  const data = join(root, "agents");
  for (const args of [["--dry-run"], []]) {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home: at, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
    assert.ok(!lines.some((line) => line.includes(secret)), `${args.join(" ") || "import"}: ${lines.filter((line) => line.includes(secret)).join("\n")}`);
    assert.ok(lines.some((line) => line.includes("a-[redacted]")), lines.join("\n"));
  }
});

test("a known miss of secretlint's AWS rule, pinned: an AWS secret whose last character is not a letter or a digit is not found", async () => {
  const { secretsIn } = await import("../dist/secret-cut.js");
  const body = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbC";
  // secretlint's AWS rule (@secretlint/secretlint-rule-aws, reportAWSSecretAccessKey, in the recommended preset) matches
  // `([A-Za-z0-9/\+=]{40})${QUOTE}\b`: the trailing \b needs a word character last, so a secret that ends in "/", "+"
  // or "=" is not found. A later preset that fixes the rule turns this test red: then drop the test and the known miss
  // in the PR's description.
  for (const last of ["/", "+", "="]) assert.deepEqual(await secretsIn(`AWS_SECRET_ACCESS_KEY=${body}${last}\nnext`), [], last);
  assert.deepEqual(await secretsIn(`AWS_SECRET_ACCESS_KEY=${body}a\nnext`), [`${body}a`]);
});

test("an import's plan reads no subagent file through secretlint: a subagent of a session the import leaves out is never read", async (t) => {
  const { secretlintCalls } = await import("../dist/secret-cut.js");
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "fresh");
  mkdirSync(site, { recursive: true });
  // A session written a moment ago (left out: it may still be running), with a subagent's file.
  const live = claudeSession(at, site, 1);
  utimesSync(live, new Date(), new Date());
  claudeSubagent(at, site, 1, 1, { answer: "notes ".repeat(10_000) });
  const before = secretlintCalls.count;
  const plan = await planImport({ home: at, env: { PATH: "/usr/bin" }, all: false });
  assert.equal(plan.projects.length, 0, "the live session is left out");
  assert.equal(secretlintCalls.count, before, "no subagent file read through secretlint");
});


test("a secretlint-disable line in what an import reads turns no rule off: a key after it in the same run is cut", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "lint");
  mkdirSync(site, { recursive: true });
  const token = `${["gh", "p"].join("")}_${Array.from(randomBytes(36), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("")}`;
  // A repository's own secretlint config printed in one turn, a token in the next.
  claudeSession(at, site, 1, { prompt: `$ cat .secretlintrc.js\n// ${"secretlint"}-disable`, output: `GITHUB_TOKEN=${token}` });
  const data = join(root, "agents");
  const lines = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
  for (const [file, bytes] of keptUnder(data)) assert.ok(!bytes.includes(token), `${file.slice(data.length + 1)} holds the token`);
  assert.ok(lines.includes("1 secret removed"), lines.filter((l) => /removed/.test(l)).join(" "));
});

test("reading text through secretlint leaves no performance marks behind in the process", async () => {
  const { secretsIn } = await import("../dist/secret-cut.js");
  const before = performance.getEntriesByType("mark").length;
  for (let i = 0; i < 5; i++) await secretsIn(`round ${i}: ${["gh", "p"].join("")}_${"a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36)}`);
  assert.equal(performance.getEntriesByType("mark").length, before);
});

test("what the CLI prints is cut with the saved tool keys too: a skipped file named after one is printed cut", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "saved");
  mkdirSync(site, { recursive: true });
  const file = claudeSession(at, site, 1);
  const seal = randomBytes(32).toString("base64");
  const saved = `not-a-secret-saved-${randomBytes(8).toString("hex")}`;
  const named = join(dirname(file), `${saved}.jsonl`);
  writeFileSync(named, "not a session\n");
  utimesSync(named, new Date(minute(10)), new Date(minute(10)));
  const data = join(root, "agents");
  mkdirSync(data, { recursive: true });
  await seedToolKey(data, seal, "monid", { MONID_API_KEY: saved });
  // The default output (its left-out counts and reasons), then --verbose, which names the skipped file.
  const quiet = [];
  const lines = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin", AGENTRUN_SEAL_KEY: seal }, out: (line) => quiet.push(line) }), 0);
  assert.equal(await importCommand(["--data", data, "--all", "--verbose"], "usage", { home: at, env: { PATH: "/usr/bin", AGENTRUN_SEAL_KEY: seal }, out: (line) => lines.push(line) }), 0);
  assert.ok(![...quiet, ...lines].some((line) => line.includes(saved)), [...quiet, ...lines].join("\n"));
  assert.ok(quiet.some((line) => line.startsWith("left out: ")), quiet.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("skipped ") && line.includes("[redacted].jsonl")), lines.join("\n"));
});

test("the README says what an import removes and what it leaves", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes("Known key formats are removed. Other secrets in your session history, like passwords in config files, are imported as they are."));
  assert.ok(readme.includes("So are a key-shaped value this server did not make (a `whsec_` secret from another service) and a run's own door token."));
});

test("a key of the environment's that holds a slash, across a skill's folders, leaves no part of itself in what the import keeps, and the skill stays one skill", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "deploys");
  // A 65-character key, two 32-character halves around its "/", as a base64 secret can hold one: the first half ends the
  // skill's folder name and the second names a folder in it.
  const [head, tail] = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
  mkdirSync(join(site, ".claude", "skills", `push-${head}`, tail), { recursive: true });
  writeFileSync(join(site, ".claude", "skills", `push-${head}`, "SKILL.md"), "---\nname: push\n---\nPush it.\n");
  writeFileSync(join(site, ".claude", "skills", `push-${head}`, tail, "notes.md"), "Notes.\n");
  claudeSession(at, site, 1, { prompt: "Push the release." });
  const data = join(root, "agents");
  const key = `${head}/${tail}`;
  const printed = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin", OPENAI_API_KEY: key }, out: (line) => printed.push(line) }), 0);
  const reader = await openData(data, "runner");
  t.after(async () => await reader.close());
  const paths = Object.keys((await agentOf(reader, agentIdOf(site))).revisions.find((r) => r.current).body.skills).sort();
  // No half of the key is left: not in a kept path, not in any byte of the data directory, not in what the CLI printed.
  for (const half of [head, tail]) {
    assert.ok(paths.every((path) => !path.includes(half)), `no kept path holds a half of the key: ${paths.join(" ")}`);
    for (const [file, bytes] of keptUnder(data)) assert.ok(!bytes.includes(half), `${file} holds a half of the key`);
    assert.ok(!printed.join("\n").includes(half), printed.join("\n"));
  }
  // And the skill stays one skill: its SKILL.md and its notes under the one folder, kept as `redacted-` and a hash.
  assert.equal(paths.length, 2, paths.join(" "));
  const folders = new Set(paths.map((path) => path.split("/")[0]));
  assert.equal(folders.size, 1, paths.join(" "));
  const [folder] = folders;
  assert.match(folder, /^redacted-[0-9a-f]{12}$/);
  assert.ok(paths.includes(`${folder}/SKILL.md`), paths.join(" "));
  assert.ok(printed.includes("1 secret removed"), printed.join("\n"));
});

test("a key in a project's path counts once, in the dry run and in the import: finding the folders it touches counts nothing", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  // A key in a folder's name, with a folder after it: blanking each to find the folders the key touches is no cut.
  const site = join(at, "code", `keys-${shapedKeys().github}`, "app");
  mkdirSync(site, { recursive: true });
  claudeSession(at, site, 1, { prompt: "Build it." });
  const data = join(root, "agents");
  const run = async (...args) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home: at, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
    return lines.filter((line) => /secrets? (would be )?removed/.test(line));
  };
  assert.deepEqual(await run("--dry-run"), ["1 secret would be removed"]);
  assert.deepEqual(await run(), ["1 secret removed"]);
});

test("a key of the environment's that holds a slash, across a project's own folders, leaves no part of itself in the agent's name", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const [head, tail] = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
  const site = join(at, "code", `deploy-${head}`, tail);
  mkdirSync(site, { recursive: true });
  claudeSession(at, site, 1, { prompt: "Deploy it." });
  const data = join(root, "agents");
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: at, env: { PATH: "/usr/bin", OPENAI_API_KEY: `${head}/${tail}` }, out: () => {} }), 0);
  const reader = await openData(data, "runner");
  t.after(async () => await reader.close());
  const { agent } = await agentOf(reader, agentIdOf(site));
  assert.match(agent.name, /^redacted-[0-9a-f]{12}$/, `the agent's name holds no half of the key: ${agent.name}`);
  for (const half of [head, tail]) for (const [file, bytes] of keptUnder(data)) assert.ok(!bytes.includes(half), `${file} holds a half of the key`);
});

/** The server's own key names: the launcher's SECRETS list, read as secrets.ts reads it (loading secrets.ts here would take
 *  them out of this process's environment). */
const SERVER_KEYS = /^SECRETS='([A-Z0-9_ ]+)'$/m.exec(readFileSync(new URL("../launcher/agentrun-serve", import.meta.url), "utf8"))[1].split(" ").filter(Boolean);
/** A canary per key name, each its own value. */
const canaryOf = (name) => `CANARY-${name}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
/** Every file under `dir` (its path and bytes), and every path. */
const keptUnder = (dir) => {
  const kept = [];
  const walk = (at) => { for (const entry of readdirSync(at, { withFileTypes: true })) { const path = join(at, entry.name); if (entry.isDirectory()) walk(path); else kept.push([path, readFileSync(path)]); } };
  walk(dir);
  return kept;
};
const cliImport = (h, data, env) => {
  const ran = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all"], { env: { ...process.env, HOME: h.at, ...env }, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  return ran;
};

test("the CLI's import cuts every one of the server's own keys, whatever its name: each launcher secret, its own value, is nowhere in what it keeps", async (t) => {
  // The list holds names no key pattern matches (the seal key's among them): each one's value is cut all the same.
  assert.ok(SERVER_KEYS.includes("AGENTRUN_SEAL_KEY") && SERVER_KEYS.includes("OPENAI_API_KEY") && SERVER_KEYS.some((name) => !/(_API_KEY|_TOKEN)$|SECRET/i.test(name)), SERVER_KEYS.join(" "));
  const root = await scratch(t);
  const h = home(root);
  const values = SERVER_KEYS.map(canaryOf);
  appendFileSync(join(h.site, "CLAUDE.md"), `Keys: ${values.join(" ")}\n`);
  claudeSession(h.at, h.site, 14, { prompt: "Print the environment.", output: values.join(" ") });
  const data = join(root, "agents");
  cliImport(h, data, Object.fromEntries(SERVER_KEYS.map((name) => [name, canaryOf(name)])));
  const kept = keptUnder(data);
  const found = SERVER_KEYS.filter((name) => kept.some(([path, bytes]) => bytes.includes(canaryOf(name)) || path.includes(canaryOf(name))));
  assert.deepEqual(found, [], "no server key's value is in what the import kept");
  assert.ok(kept.some(([, bytes]) => bytes.includes("[redacted]")), "their places are marked");
});

test("two session files named after two different keys, in two projects, stay two runs under two ids; neither key is kept, and a second import makes no new run", async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const [a, b] = [canaryOf("OPENAI_API_KEY"), canaryOf("ANTHROPIC_API_KEY")];
  // Each file's records carry no session id: the import names each session after its file.
  const renamed = [];
  for (const [cwd, n, key] of [[h.site, 15, a], [h.notes, 16, b]]) {
    const file = claudeSession(h.at, cwd, n, { prompt: `Session ${n}.` });
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => { const { sessionId: _, ...rest } = JSON.parse(line); return JSON.stringify(rest); });
    rmSync(file);
    const named = join(dirname(file), `${key}.jsonl`);
    writeFileSync(named, `${lines.join("\n")}\n`);
    utimesSync(named, new Date(minute(10)), new Date(minute(10)));
    renamed.push([named, lines]);
  }
  const data = join(root, "agents");
  const env = { OPENAI_API_KEY: a, ANTHROPIC_API_KEY: b };
  cliImport(h, data, env);
  const kept = keptUnder(data);
  assert.deepEqual(kept.filter(([path, bytes]) => [a, b].some((key) => bytes.includes(key) || path.includes(key))).map(([path]) => path.slice(data.length + 1)), [], "neither key is kept");
  const reader = await openData(data, "runner");
  const named = (await rowsOf(reader)).filter((run) => run.importedFrom?.source === "claude-code" && !/^0{8}-/.test(run.importedFrom.session));
  const count = (await rowsOf(reader)).length;
  await reader.close();
  assert.equal(named.length, 2, "two runs");
  assert.equal(new Set(named.map((run) => run.importedFrom.session)).size, 2, "under two ids");
  assert.notEqual(new Set(named.map((run) => run.agent)).size, 1, "in their two projects");
  // Each file grows by a turn; a second import finds each one's run under its own id.
  for (const [file, lines] of renamed) {
    const last = JSON.parse(lines.at(-1));
    appendFileSync(file, `${JSON.stringify({ ...last, type: "user", uuid: `u9-${file.length}`, parentUuid: null, timestamp: minute(9), message: { role: "user", content: "One more thing." } })}\n`);
    utimesSync(file, new Date(minute(20)), new Date(minute(20)));
  }
  cliImport(h, data, env);
  const after = await openData(data, "runner");
  t.after(async () => await after.close());
  assert.equal((await rowsOf(after)).length, count, "no new run");
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
  const store = await openData(data);
  t.after(async () => await store.close());
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
  const kept = (await agentOf(store, report.agents[0].id)).revisions[0].body.skills;
  assert.deepEqual(Object.keys(kept).sort(), ["deploy/SKILL.md", "deploy/steps.md", "review/SKILL.md"], "the readable skills still import");
});

test("a session file this user cannot read is named and passed over; the rest still import", { skip: process.getuid?.() === 0 ? "root reads a mode 000 file" : false }, async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const locked = codexSession(h.at, h.tests, 11, { prompt: "Locked away." });
  const data = join(root, "agents");
  const store = await openData(data);
  t.after(async () => await store.close());
  chmodSync(locked, 0o000);
  let report;
  try {
    report = await runImport(store, await planImport(options(h), store), options(h));
  } finally {
    chmodSync(locked, 0o600);
  }
  assert.equal(report.skipped.find((s) => s.what === locked)?.why, "not read (EACCES)");
  assert.equal((await rowsOf(store)).length, 5, "the five readable sessions");
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
  const store = await openData(data);
  t.after(async () => await store.close());
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
  assert.equal((await rowsOf(store)).length, 6);
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
  const store = await openData(data);
  t.after(async () => await store.close());
  await runImport(store, await planImport(options(h)), options(h));
  const runs = (await rowsOf(store)).sort((a, b) => a.importedFrom.session.localeCompare(b.importedFrom.session));
  return { data, store, runs };
}

/** A run's stored metrics, checked against its own transcript: runMetricsOf of its entries, and its settled timeline's
 *  usage row. Returns the metrics (its counts plus activeMs and effort) and the transcript's answers. */
async function metricsOf(store, runId) {
  const entries = await entriesOf(store, runId);
  const { activeMs, effort, costUsdEst, costBasis, ...counted } = await storedMetrics(store, runId);
  assert.deepEqual(counted, runMetricsOf(entries), "the metrics are what the run's own transcript says");
  assert.equal(timelineOf(entries, { settled: true }).findLast((r) => r.kind === "usage")?.usage.requests, counted.requests, "the timeline's usage row counts the same requests");
  return { metrics: { ...counted, activeMs, ...(effort ? { effort } : {}) }, answers: entries.filter((e) => e.kind === "pi.assistant").map((e) => e.model[0]), kinds: entries.map((e) => e.kind) };
}
const tokensIn = (answer) => [answer.model, answer.usage.input, answer.usage.cacheRead, answer.usage.cacheWrite, answer.usage.output];

test("a Claude Code import counts each request once, its records repeated around a parallel call's result or written twice; each answer keeps its model, a failed call its error, and the run its effort and time at work, a pause past the cap counting nothing", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => claudeSession(home, project, 31, { parallel: true, answerModel: "claude-haiku-5", pause: 60 }));
  const { metrics, answers } = await metricsOf(store, runs[0].id);
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
    // The 61-minute pause before the answer is past ACTIVE_GAP_MS: it counts nothing, as WakaTime counts it.
    activeMs: 2 * 60_000,
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
    const { metrics, answers } = await metricsOf(store, run.id);
    assert.deepEqual(metrics, expected, run.importedFrom.session);
    // The first request's three calls are one answer; the token_count written twice, and the record, count once.
    assert.deepEqual(answers.map(tokensIn), [["gpt-sol-6.1", 300, 600, 0, 40], ["gpt-sol-6.1", 100, 900, 0, 25], ["gpt-luna-6", 200, 1000, 0, 10]]);
    assert.equal(answers[0].content.filter((b) => b.type === "toolCall").length, 3);
  }
});

test("a pi import keeps each request's usage as pi wrote it, its model, its thinking level and a failed call", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => piSession(home, project, 34, { answerModel: "claude-opus-5", readFails: true, thinking: "xhigh" }));
  const { metrics, answers } = await metricsOf(store, runs[0].id);
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
    const { metrics, answers } = await metricsOf(store, run.id);
    assert.deepEqual([metrics.requests, metrics.unmetered, metrics.input, metrics.cacheRead, metrics.cacheWrite, metrics.output], [2, 2, 0, 0, 0, 0], run.importedFrom.source);
    assert.ok(answers.every((a) => a.usage.input + a.usage.cacheRead + a.usage.cacheWrite + a.usage.output === 0), "zeros written, read as unknown");
  }
  // With no usage to close it, the answer after the call's result is a request of its own, after that result.
  assert.deepEqual((await metricsOf(store, runs[1].id)).kinds, ["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant"]);
});

test("a Claude Code API error is a request that failed, at its 0 tokens, never unmetered; a turn the CLI wrote itself is no request, kept as its note", async (t) => {
  let noted;
  const { data, store, runs } = await importedOne(t, (home, project) => {
    claudeSession(home, project, 38, { failed: true });
    noted = claudeSession(home, project, 39, { interrupted: true, noted: true });
  });
  const [failed, interrupted] = runs;
  assert.deepEqual([failed.state, interrupted.state], ["failed", "stopped"], "the CLI's note ends no request");
  const one = await metricsOf(store, failed.id);
  assert.deepEqual([one.metrics.requests, one.metrics.unmetered, one.metrics.input, one.metrics.output, one.metrics.models], [2, 0, 3, 50, { "anthropic/claude-sonnet-5": 2 }]);
  assert.deepEqual([one.answers[1].stopReason, one.answers[1].errorMessage, one.answers[1].content], ["error", "API Error: overloaded", []]);
  const two = await metricsOf(store, interrupted.id);
  assert.deepEqual([two.metrics.requests, two.metrics.unmetered], [2, 0]);
  assert.deepEqual(two.kinds, ["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant", "pi.user", "pi.user"]);
  const rows = async (id) => timelineOf(await entriesOf(store, id), { settled: true });
  assert.ok((await rows(failed.id)).some((r) => r.kind === "error" && r.summary === "Model request failed: API Error: overloaded"));
  assert.equal((await rows(interrupted.id)).findLast((r) => r.kind === "user_message").summary, "Claude Code: No response requested.");
  assert.equal((await readSession(noted, "claude-code")).users, 2, "the note is not the person's");
});

test("a pi request that failed imports as failed, at its 0 tokens; one cut short keeps its text but not the start of its counts, so it is unmetered", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => {
    piSession(home, project, 40, { ended: "error" });
    piSession(home, project, 41, { ended: "aborted" });
  });
  const [failed, cut] = runs;
  assert.deepEqual([failed.state, cut.state], ["failed", "stopped"]);
  const one = await metricsOf(store, failed.id);
  assert.deepEqual([one.metrics.requests, one.metrics.unmetered, one.metrics.input], [2, 0, 100]);
  assert.deepEqual([one.answers[1].stopReason, one.answers[1].errorMessage], ["error", "529 overloaded"]);
  const two = await metricsOf(store, cut.id);
  assert.deepEqual([two.metrics.requests, two.metrics.unmetered, two.metrics.input], [2, 1, 100]);
  assert.deepEqual(two.answers[1].content, [{ type: "text", text: "Read: three notes." }]);
});

/** The catalog's list price of `provider/id` for these tokens, from pi-ai's catalog itself (USD per million). */
async function listPrice(provider, id, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const { cost } = builtinModels().getModels().find((m) => m.provider === provider && m.id === id);
  return (input * cost.input + output * cost.output + cacheRead * cost.cacheRead + cacheWrite * cost.cacheWrite) / 1e6;
}

test("a run its source did not price gets the catalog's estimate at its own provider's price, its cost still unknown; an unlisted model, a provider the catalog does not list for it, or a request of unknown tokens leaves it unknown, a source's cost is kept with none, and a provider's $0 is $0", async (t) => {
  const { store, runs } = await importedOne(t, (home, project) => {
    codexSession(home, project, 51, { model: "gpt-5.5" });
    codexSession(home, project, 52);
    codexSession(home, project, 53, { model: "gpt-5.5", usage: "none" });
    claudeSession(home, project, 54, { unknownCost: true });
    claudeSession(home, project, 55);
    piSession(home, project, 56, { provider: "google", modelId: "gemma-4-26b-a4b-it", costs: [null, null] });
    // A provider of its own: the catalog lists gpt-5.5, but not as this provider serves it.
    codexSession(home, project, 57, { model: "gpt-5.5", provider: "router" });
    // Free from this provider, though others list it paid: its own price, never another's.
    piSession(home, project, 58, { provider: "qwen-token-plan", modelId: "deepseek-v4-pro", costs: [null, null] });
  });
  const priced = [];
  for (const run of runs) {
    const { costUsdEst, costBasis } = await storedMetrics(store, run.id);
    priced.push([run.importedFrom.source, run.costUsd ?? null, costUsdEst ?? null, costBasis ?? null]);
  }
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
    ["codex", null, null, null],
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
  const store = await openData(data);
  t.after(async () => await store.close());
  await runImport(store, plan, options(h));
  const [run] = await rowsOf(store);
  assert.equal((await store.runs.launch(run.id)).body.title, "Tidy the notes.");
});

test("a block a resumed Claude Code file repeats, at its own earlier times, adds no time at work", async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "resumed");
  mkdirSync(project, { recursive: true });
  const file = claudeSession(home, project, 81);
  const once = (await readSession(file, "claude-code")).activeMs;
  // As a resumed session writes it: its first records again, after its last.
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  writeFileSync(file, `${[...lines, ...lines.slice(0, 4)].join("\n")}\n`);
  assert.equal(once, 3 * 60_000);
  assert.equal((await readSession(file, "claude-code")).activeMs, once);
});

test("a dry run counts a session the store holds already from its run, as the import does, though its file grew since", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const site = join(home, "code", "acme-site");
  mkdirSync(site, { recursive: true });
  const file = claudeSession(home, site, 82);
  const data = join(root, "agents");
  const block = async (...args) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
    return lines.slice(-5);
  };
  const imported = await block();
  // The session went on after its import: a later request in its file, which the import does not take again.
  appendFileSync(file, `${JSON.stringify({ sessionId: sessionId(82), cwd: site, type: "assistant", uuid: "later", timestamp: minute(10), message: { id: "msg_later", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Later." }], usage: { input_tokens: 700, output_tokens: 90 } } })}\n`);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(file, old, old);
  const dry = await block("--dry-run");
  assert.deepEqual(dry.slice(2), imported.slice(2), "the numbers the import keeps for its held run");
  assert.equal(dry[0], imported[0]);
});

/** Session `n` resumed from the one at `file`, as Claude Code writes it: every record of the first, its uuid, message id
 *  and time kept, its session id the new one's; then, unless `own: false`, a prompt and an answer of its own. */
function resumed(file, n, { own = true } = {}) {
  const copied = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)).map((r) => (r.sessionId ? { ...r, sessionId: sessionId(n) } : r));
  const base = { sessionId: sessionId(n), cwd: copied[0].cwd, isSidechain: false, userType: "external", version: "2.1.0" };
  return writeSession(join(dirname(file), `${sessionId(n)}.jsonl`), [
    ...copied,
    ...(own
      ? [
          { ...base, type: "user", uuid: `own-u-${n}`, timestamp: minute(20), message: { role: "user", content: "And the tests?" } },
          { ...base, type: "assistant", uuid: `own-a-${n}`, timestamp: minute(21), message: { id: `msg_own_${n}`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "They pass." }], usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 60 } } },
        ]
      : []),
  ]);
}

test("a response a resumed session's file copies counts once across the import, in the file that holds it first, and once still when a later import finds the copy", async (t) => {
  // One import finds both.
  const one = await importedOne(t, (home, project) => resumed(claudeSession(home, project, 91), 92));
  const [first, copy] = [await storedMetrics(one.store, one.runs[0].id), await storedMetrics(one.store, one.runs[1].id)];
  assert.deepEqual([first.requests, first.input, first.output], [2, 8, 80], "the first session keeps its own");
  assert.deepEqual([copy.requests, copy.input, copy.output, copy.tools, copy.activeMs], [1, 50, 60, {}, 60_000], "the resumed one adds only its own request, and no time for the copy");
  const kinds = (await entriesOf(one.store, one.runs[1].id)).map((e) => e.kind);
  assert.deepEqual(kinds, ["pi.user", "pi.assistant"], "its transcript is its own turns");

  // A later import finds the copy: the run held already is counted, not the copy.
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "metered");
  mkdirSync(project, { recursive: true });
  const original = claudeSession(home, project, 93);
  const data = join(root, "agents");
  const store = await openData(data);
  t.after(async () => await store.close());
  const opts = { home, env: ENV, temp: join(root, "tmp") };
  await runImport(store, await planImport(opts, store), opts);
  resumed(original, 94);
  resumed(original, 98, { own: false });
  const report = await runImport(store, await planImport({ ...opts, all: true }, store), { ...opts, all: true });
  const later = (await rowsOf(store)).find((run) => run.importedFrom.session === sessionId(94));
  const counted = await storedMetrics(store, later.id);
  assert.deepEqual([counted.requests, counted.input, counted.output, counted.tools, counted.activeMs], [1, 50, 60, {}, 60_000], "its own request, and no time for the copy");
  const laterKinds = (await entriesOf(store, later.id)).map((e) => e.kind);
  assert.deepEqual(laterKinds, ["pi.user", "pi.assistant"], "no copied prompt or result in its transcript");
  assert.equal((await rowsOf(store)).find((run) => run.importedFrom.session === sessionId(98)), undefined, "a file of copies alone is no run");
  assert.ok(report.skipped.some((s) => s.why === "holds only records of sessions imported already"));
});

test("a session's subagents are no runs of their own: their requests, tokens and tool calls are the session's, its model and transcript its own", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => {
    claudeSession(home, project, 95);
    claudeSubagent(home, project, 95, 1);
    codexSession(home, project, 96);
    codexSession(home, project, 97, { subagent: true, parent: sessionId(96) });
    // A subagent's own subagent: the session's too.
    codexSession(home, project, 99, { subagent: true, parent: sessionId(97) });
    // A subagents folder that is a link points at what is not this session's: never followed.
    const elsewhere = join(home, "elsewhere");
    claudeSubagent(home, join(home, "code", "other"), 100, 2, { slug: "other" });
    symlinkSync(join(home, ".claude", "projects", "other", sessionId(100), "subagents"), elsewhere);
    claudeSession(home, project, 101);
    mkdirSync(join(home, ".claude", "projects", project.replaceAll("/", "-"), sessionId(101)), { recursive: true });
    symlinkSync(elsewhere, join(home, ".claude", "projects", project.replaceAll("/", "-"), sessionId(101), "subagents"));
  });
  assert.deepEqual(runs.map((run) => run.importedFrom.session), [sessionId(95), sessionId(96), sessionId(101)], "no child is a run");
  const claude = await storedMetrics(store, runs[0].id);
  assert.deepEqual([claude.input, claude.cacheRead, claude.output, claude.requests, claude.unmetered], [8 + 11 + 17, 2300, 80 + 13 + 19, 4, 0]);
  assert.deepEqual(claude.models, { "anthropic/claude-sonnet-5": 2, "anthropic/claude-haiku-5": 2 });
  assert.equal(claude.model, "anthropic/claude-sonnet-5", "the run's model stays its own");
  assert.deepEqual(claude.tools, { Bash: { calls: 1, errors: 0 }, Grep: { calls: 1, errors: 0 } });
  const codex = await storedMetrics(store, runs[1].id);
  assert.deepEqual([codex.input, codex.cacheRead, codex.output, codex.requests, codex.tools], [1200, 4500, 195, 6, { shell: { calls: 3, errors: 0 } }], "its subagent's and that one's own");
  const linked = await storedMetrics(store, runs[2].id);
  assert.deepEqual([linked.requests, linked.tools], [2, { Bash: { calls: 1, errors: 0 } }], "nothing through a linked folder");
  const answers = (await entriesOf(store, runs[0].id)).filter((e) => e.kind === "pi.assistant").length;
  assert.equal(answers, 2, "the transcript holds the session's own answers");
});

test("a subagent whose file names no parent is no session and no run: its tokens and tool calls count in the summary's totals alone", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "untied");
  mkdirSync(project, { recursive: true });
  claudeSession(home, project, 110);
  codexSession(home, project, 111, { subagent: true, parent: null });
  const data = join(root, "agents");
  const lines = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
  // The Claude Code session's 2,688 tokens and the subagent's 1,965 (cache reads 2,300 + 1,500 of 2,608 + 1,900 input);
  // Bash and the subagent's shell call, one each.
  const block = lines.slice(-5);
  assert.deepEqual(block.slice(0, 2), ["Found 1 session  Claude Code 1", "Imported into 1 agent (one per project)"]);
  assert.match(block[2], /^\+ 4\.7K tokens \(84% cached\) · /);
  assert.match(block[3], / · top tool: Bash \(50%\)$/);
  const store = await openData(data, "runner");
  t.after(async () => await store.close());
  assert.equal((await rowsOf(store)).length, 1, "no run for the subagent");
});

test("a tool key saved through the settings API is cut from every file the import writes, opened on the host with the seal key; with no seal key it is not known, so not cut", async (t) => {
  const root = await scratch(t);
  const h = home(root);
  const seal = randomBytes(32).toString("base64");
  const saved = `not-a-secret-saved-${randomBytes(8).toString("hex")}`;
  assert.ok(readFileSync(claudeSession(h.at, h.site, 13, { prompt: "Which key?", output: `MONID_API_KEY=${saved}` })).includes(saved));
  const into = async (name, env) => {
    const data = join(root, name);
    mkdirSync(data, { recursive: true });
    await seedToolKey(data, seal, "monid", { MONID_API_KEY: saved });
    assert.equal(await importCommand(["--data", data, "--all"], "usage", { home: h.at, env, out: () => undefined }), 0);
    const files = readdirSync(data, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
    return files.filter((file) => readFileSync(file).includes(saved));
  };
  assert.deepEqual(await into("agents", { ...ENV, AGENTRUN_SEAL_KEY: seal }), [], "cut from every file the import writes");
  assert.notDeepEqual(await into("unsealed", ENV), [], "the control: the same import with no seal key keeps it");
});

test("one number per run: an imported run's timeline usage row counts its subagents' requests, as its stored metrics do, and its transcript gives the same totals", async (t) => {
  const { data, store, runs } = await importedOne(t, (home, project) => {
    claudeSession(home, project, 115);
    claudeSubagent(home, project, 115, 1);
    codexSession(home, project, 116);
    codexSession(home, project, 117, { subagent: true, parent: sessionId(116) });
  });
  for (const run of runs) {
    const stored = await storedMetrics(store, run.id);
    // As the run's page reads it: its root conversation's entries, settled.
    const entries = await entriesOf(store, run.id);
    assert.equal(timelineOf(entries, { settled: true }).findLast((r) => r.kind === "usage")?.usage.requests, stored.requests, run.importedFrom.source);
    assert.equal(stored.requests, 4, "the session's two and its subagent's two");
    const own = runMetricsOf(entries);
    assert.deepEqual([own.input, own.cacheRead, own.cacheWrite, own.output, own.requests, own.unmetered], [stored.input, stored.cacheRead, stored.cacheWrite, stored.output, stored.requests, stored.unmetered]);
    assert.equal(timelineOf(entries, { settled: true }).filter((r) => r.kind !== "usage").length, timelineOf(entries.filter((e) => e.kind !== "agentrun.request_cost"), { settled: true }).filter((r) => r.kind !== "usage").length, "the marks show no row");
  }
});

test("an untied subagent's own subagents count in the summary's totals with it, and are no session or run either", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "untied");
  mkdirSync(project, { recursive: true });
  claudeSession(home, project, 120);
  codexSession(home, project, 121, { subagent: true, parent: null });
  codexSession(home, project, 122, { subagent: true, parent: sessionId(121) });
  const data = join(root, "agents");
  const lines = [];
  assert.equal(await importCommand(["--data", data, "--all"], "usage", { home, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
  // 2,688 + 1,965 + 1,965 tokens; cache reads 2,300 + 1,500 + 1,500 of 2,608 + 1,900 + 1,900 input; one Bash call, two shell.
  const block = lines.slice(-5);
  assert.deepEqual(block.slice(0, 2), ["Found 1 session  Claude Code 1", "Imported into 1 agent (one per project)"]);
  assert.match(block[2], /^\+ 6\.6K tokens \(83% cached\) · /);
  assert.match(block[3], / · top tool: shell \(67%\)$/);
  const store = await openData(data, "runner");
  t.after(async () => await store.close());
  assert.equal((await rowsOf(store)).length, 1);
});

/** A session file's records `minutes` later, each through `map`, as a file of `name` beside it. */
function shifted(file, name, minutes, map = (r) => r) {
  const later = (time) => (typeof time === "string" ? new Date(Date.parse(time) + minutes * 60_000).toISOString() : time);
  const records = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)).map((r) => map({ ...r, timestamp: later(r.timestamp), ...(r.payload?.timestamp ? { payload: { ...r.payload, timestamp: later(r.payload.timestamp) } } : {}) }));
  rmSync(file);
  return writeSession(join(dirname(file), name), records);
}

/** A home, its dry run's measured tokens and the import's runs: what `write(home, project)` put there. */
async function measuredAndImported(t, write) {
  const root = await scratch(t);
  const h = { at: join(root, "home"), temp: join(root, "tmp") };
  const project = join(h.at, "code", "threads");
  mkdirSync(project, { recursive: true });
  write(h.at, project);
  const plan = await planImport(options(h, { measure: true }));
  const measured = plan.found.reduce((n, f) => n + f.metrics.input + f.metrics.cacheRead + f.metrics.cacheWrite + f.metrics.output, 0);
  const store = await openData(join(root, "agents"));
  t.after(async () => await store.close());
  await runImport(store, await planImport(options(h)), options(h));
  const runs = [];
  for (const run of await rowsOf(store)) runs.push({ run, metrics: await storedMetrics(store, run.id) });
  return { measured, found: plan.found.length, runs, imported: runs.reduce((n, { metrics: m }) => n + m.input + m.cacheRead + m.cacheWrite + m.output, 0) };
}

test("a Codex thread resumed in a new file of the same id is one run, in the project of its first file: each file's requests and its child's once, as the dry run counts them, whatever the files' names", async (t) => {
  for (const name of ["10-00-00", "08-00-00"]) {
    const at = {};
    const { measured, found, runs, imported } = await measuredAndImported(t, (home, project) => {
      at.project = project;
      const elsewhere = join(home, "code", "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      codexSession(home, project, 181);
      // The thread resumed an hour later in another directory, in a file of its own with the same thread id.
      shifted(codexSession(home, elsewhere, 182), `rollout-2026-10-20T${name}-${sessionId(182)}.jsonl`, 60, (r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: sessionId(181) } } : r));
      codexSession(home, project, 183, { subagent: true, parent: sessionId(181) });
    });
    assert.deepEqual(runs.map(({ run }) => [run.importedFrom.session, run.agent]), [[sessionId(181), agentIdOf(at.project)]], name);
    assert.equal(runs[0].metrics.requests, 6, `${name}: each file's 2 requests and the child's 2, once`);
    assert.deepEqual([found, measured], [1, imported], `${name}: the dry run counts what the import holds`);
  }
});

test("a dry run counts sessions as the import takes them: a thread resumed in a second file of the same id is one session in its project's line and in the plan's total, as the summary found it", async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "counted");
  mkdirSync(project, { recursive: true });
  const first = codexSession(home, project, 201);
  // The thread resumed an hour later, in a new file of the same id.
  const later = shifted(codexSession(home, project, 202), `rollout-2026-10-20T10-00-00-${sessionId(202)}.jsonl`, 60, (r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: sessionId(201) } } : r));
  claudeSession(home, project, 203);
  const data = join(root, "agents");
  const run = async (...args) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
    return lines;
  };
  const dry = await run("--dry-run");
  const line = dry.find((l) => l.startsWith(`${project}  `));
  assert.match(line, /[ ,]codex 1(,|  )/, "the thread's two files, one session");
  assert.match(line, /[ ,]claude-code 1(,|  )/);
  assert.match(line, /cost known 1\/2$/, "a session's cost is known when each of its files' is: the Claude Code session's");
  assert.match(dry.find((l) => l.includes("nothing was written")), /^1 projects?, 2 sessions; /);
  assert.match(dry.find((l) => l.startsWith("Found ")), /^Found 2 sessions /, "the summary's count, the same");
  // Imported, then both of the thread's files touched a minute on (still long ended): planned again, as one session the
  // store holds already.
  assert.equal((await run()).find((l) => l.includes("runs imported into")).split(" ")[2], "2");
  for (const file of [first, later]) {
    const touched = new Date(statSync(file).mtimeMs + 60_000);
    utimesSync(file, touched, touched);
  }
  const again = (await run("--dry-run")).find((l) => l.startsWith(`${project}  `));
  assert.match(again, /codex 1 {2}cost known 0\/1 {2}already imported 1$/);
});

test("a Codex child counts in its thread's run whichever of the thread's files the import keeps", async (t) => {
  for (const why of ["its project is gone", "no message of the person's"]) {
    const { runs, measured, imported } = await measuredAndImported(t, (home, project) => {
      // The thread's first file is left out (in a directory that is gone, or with no message of the person's). The
      // child ran then; the later file is kept.
      if (why === "its project is gone") codexSession(home, join(home, "code", "gone"), 193);
      else {
        const file = codexSession(home, project, 193);
        const said = (r) => (r.type === "response_item" && r.payload?.type === "message" && r.payload.role === "user") || (r.type === "event_msg" && r.payload?.type === "user_message");
        writeSession(file, readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)).filter((r) => !said(r)));
      }
      codexSession(home, project, 195, { subagent: true, parent: sessionId(193) });
      shifted(codexSession(home, project, 194), `rollout-2026-10-20T10-00-00-${sessionId(194)}.jsonl`, 60, (r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: sessionId(193) } } : r));
    });
    assert.deepEqual(runs.map(({ run, metrics }) => [run.importedFrom.session, metrics.requests]), [[sessionId(193), 4]], `${why}: the kept file's 2 requests and the child's 2`);
    assert.equal(measured, imported, why);
  }
});

test("a dry run counts what the import stores: its sessions, tokens and tool calls", async (t) => {
  const root = await scratch(t);
  const h = home(root);
  // Beside the fixture home's: a Codex thread resumed in a new file, with a child, and a Claude Code session resumed in a
  // file holding copies of its records.
  codexSession(h.at, h.site, 186);
  shifted(codexSession(h.at, h.site, 187), `rollout-2026-10-20T10-00-00-${sessionId(187)}.jsonl`, 60, (r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: sessionId(186) } } : r));
  codexSession(h.at, h.site, 188, { subagent: true, parent: sessionId(186) });
  resumed(claudeSession(h.at, h.tests, 189), 190);
  claudeSubagent(h.at, h.tests, 189, 1);
  const total = (all) => [all.length, all.reduce((n, m) => n + m.input + m.cacheRead + m.cacheWrite + m.output, 0), all.reduce((n, m) => n + Object.values(m.tools).reduce((k, tool) => k + tool.calls, 0), 0)];
  const dry = (await planImport(options(h, { measure: true }))).found.map((f) => f.metrics);
  const store = await openData(join(root, "agents"));
  t.after(async () => await store.close());
  await runImport(store, await planImport(options(h)), options(h));
  const stored = [];
  for (const run of await rowsOf(store)) stored.push(await storedMetrics(store, run.id));
  assert.deepEqual(total(dry), total(stored));
  assert.equal(stored.length, 8, "the fixture's 5 sessions, the thread's one run and the resumed pair's two");
});

test("a Claude Code session moved to another project folder keeps its id there, with copies of its subagents' files: one run, each record and subagent request once, in either folder order", async (t) => {
  for (const moved of ["-a-moved", "~z-moved"]) {
    const { measured, runs, imported } = await measuredAndImported(t, (home, project) => {
      const file = claudeSession(home, project, 185);
      claudeSubagent(home, project, 185, 1);
      // The copy: the session's records and its subagent's file, then a turn and a subagent of its own.
      const there = join(home, ".claude", "projects", moved);
      const base = { sessionId: sessionId(185), cwd: project, isSidechain: false, userType: "external", version: "2.1.0" };
      const lines = (path) => readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      writeSession(join(there, `${sessionId(185)}.jsonl`), [
        ...lines(file),
        { ...base, type: "user", uuid: "moved-u", timestamp: minute(30), message: { role: "user", content: "Again, here." } },
        { ...base, type: "assistant", uuid: "moved-a", timestamp: minute(31), message: { id: "msg_moved", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 6 } } },
      ]);
      writeSession(join(there, sessionId(185), "subagents", "agent-a1.jsonl"), lines(join(dirname(file), sessionId(185), "subagents", "agent-a1.jsonl")));
      claudeSubagent(home, project, 185, 2, { slug: moved });
    });
    assert.equal(runs.length, 1, moved);
    // The session's 2 requests and its first subagent's 2; the copy's own 1 and its second subagent's 2.
    assert.deepEqual([runs[0].metrics.requests, runs[0].metrics.input + runs[0].metrics.output], [7, 88 + 60 + 11 + 60], moved);
    assert.equal(measured, imported, moved);
  }
});

test("a later file of a session imported already is held as the session's growth is: its run stays as imported, and the dry run counts what the store holds", async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "later");
  mkdirSync(project, { recursive: true });
  codexSession(home, project, 191);
  const data = join(root, "agents");
  const run = async (...args) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
    return lines.slice(-5);
  };
  const first = await run();
  // The thread resumed later, in a new file of the same id.
  shifted(codexSession(home, project, 192), `rollout-2026-10-20T10-00-00-${sessionId(192)}.jsonl`, 60, (r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: sessionId(191) } } : r));
  const second = await run();
  assert.deepEqual(second, first, "the run as it was imported");
  const store = await openData(data, "runner");
  t.after(async () => await store.close());
  assert.equal((await rowsOf(store)).length, 1);
  assert.deepEqual((await run("--dry-run")).slice(2), second.slice(2), "the dry run counts the run the store holds");
});

test("a moved session's copy holding only copies adds no time, its copied system records included, in either folder order", async (t) => {
  const write = (home, project, moved) => {
    const file = claudeSession(home, project, 196);
    const base = { sessionId: sessionId(196), cwd: project, isSidechain: false, userType: "external", version: "2.1.0" };
    // Two records of the CLI's own after the answer: time at work, read once.
    appendFileSync(file, `${JSON.stringify({ ...base, type: "system", subtype: "info", uuid: "sys-1", timestamp: minute(6), content: "Saved." })}\n${JSON.stringify({ ...base, type: "system", subtype: "info", uuid: "sys-2", timestamp: minute(9), content: "Saved." })}\n`);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
    if (moved) writeSession(join(home, ".claude", "projects", moved, `${sessionId(196)}.jsonl`), readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)));
  };
  const alone = await measuredAndImported(t, (home, project) => write(home, project));
  for (const moved of ["-a-moved", "~z-moved"]) {
    const { runs, measured, imported } = await measuredAndImported(t, (home, project) => write(home, project, moved));
    assert.deepEqual(runs.map(({ metrics }) => [metrics.requests, metrics.activeMs]), alone.runs.map(({ metrics }) => [metrics.requests, metrics.activeMs]), moved);
    assert.equal(measured, imported, moved);
  }
});

test("a moved Claude Code session's cost is its running total, counted once: its copy goes on from the original's total, in either folder order", async (t) => {
  for (const moved of ["-a-moved", "~z-moved"]) {
    const { runs, measured, imported } = await measuredAndImported(t, (home, project) => {
      const file = claudeSession(home, project, 198, { cost: 1 });
      const base = { sessionId: sessionId(198), cwd: project, isSidechain: false, userType: "external", version: "2.1.0" };
      writeSession(join(home, ".claude", "projects", moved, `${sessionId(198)}.jsonl`), [
        ...readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)),
        { ...base, type: "user", uuid: "cost-u", timestamp: minute(30), message: { role: "user", content: "Again, here." } },
        { ...base, type: "assistant", uuid: "cost-a", timestamp: minute(31), message: { id: "msg_cost", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 6 } } },
        { type: "cost-state", sessionId: sessionId(198), totalCostUSD: 1.5, hasUnknownModelCost: false, timestamp: minute(31) },
      ]);
    });
    assert.deepEqual(runs.map(({ run }) => run.costUsd), [1.5], `${moved}: the session's total, not 1 + 1.5`);
    assert.equal(measured, imported, moved);
  }
});

test("a session's files merge in the order they ran: the transcript, final state and answer are the same whichever file is read first", async (t) => {
  const seen = [];
  for (const name of ["10-00-00", "08-00-00"]) {
    const root = await scratch(t);
    const h = { at: join(root, "home"), temp: join(root, "tmp") };
    const project = join(h.at, "code", "order");
    mkdirSync(project, { recursive: true });
    codexSession(h.at, project, 199, { output: "2 passed" });
    // The thread resumed an hour later and cut short, in a file whose name sorts before or after the original's.
    shifted(codexSession(h.at, project, 200, { output: "3 passed", aborted: true }), `rollout-2026-10-20T${name}-${sessionId(200)}.jsonl`, 60, (r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: sessionId(199) } } : r));
    const store = await openData(join(root, "agents"));
    t.after(async () => await store.close());
    await runImport(store, await planImport(options(h)), options(h));
    const [run] = await rowsOf(store);
    const said = (await entriesOf(store, run.id)).filter((e) => e.kind === "pi.user").map((e) => e.model[0].timestamp);
    assert.deepEqual([...said].sort((a, b) => a - b), said, `${name}: the transcript in the order it ran`);
    seen.push([run.state, run.summary, said]);
  }
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0][0], "stopped", "the state of the file that ended last");
});

test("a subagent's failed request with zero tokens is a request of known zero tokens in its session's run, not one of unknown tokens", async (t) => {
  const { runs } = await measuredAndImported(t, (home, project) => {
    claudeSession(home, project, 201);
    const base = { sessionId: sessionId(201), cwd: project, isSidechain: true, userType: "external", version: "2.1.0", agentId: "af" };
    writeSession(join(home, ".claude", "projects", project.replaceAll("/", "-"), sessionId(201), "subagents", "agent-af.jsonl"), [
      { ...base, type: "user", uuid: "fail-u", timestamp: minute(1), message: { role: "user", content: "Find the config." } },
      { ...base, type: "assistant", uuid: "fail-a", timestamp: minute(1), isApiErrorMessage: true, error: "rate_limit", message: { id: "msg_fail", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: overloaded" }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } },
    ]);
  });
  assert.deepEqual([runs[0].metrics.requests, runs[0].metrics.unmetered], [3, 0], "the session's 2 and the failed one, every count known");
});

test("a moved Claude Code session whose copy adds work it could not price has an unknown cost and the catalog's estimate, never the original's total, in either folder order", async (t) => {
  for (const moved of ["-a-moved", "~z-moved"]) {
    const { runs } = await measuredAndImported(t, (home, project) => {
      const file = claudeSession(home, project, 203, { cost: 1 });
      const base = { sessionId: sessionId(203), cwd: project, isSidechain: false, userType: "external", version: "2.1.0" };
      writeSession(join(home, ".claude", "projects", moved, `${sessionId(203)}.jsonl`), [
        ...readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)),
        { ...base, type: "user", uuid: "unpriced-u", timestamp: minute(30), message: { role: "user", content: "Again, here." } },
        { ...base, type: "assistant", uuid: "unpriced-a", timestamp: minute(31), message: { id: "msg_unpriced", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 6 } } },
        { type: "cost-state", sessionId: sessionId(203), totalCostUSD: 1.25, hasUnknownModelCost: true, timestamp: minute(31) },
      ]);
    });
    assert.deepEqual(runs.map(({ run, metrics }) => [run.costUsd ?? null, typeof metrics.costUsdEst, metrics.costBasis]), [[null, "number", "catalog"]], moved);
  }
});

test("an untied thread resumed in a second file of the same id counts its own subagent once, in the import's summary and the dry run's", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "untied-twice");
  mkdirSync(project, { recursive: true });
  claudeSession(home, project, 204);
  codexSession(home, project, 205, { subagent: true, parent: null });
  // The untied thread resumed an hour later, in a file of its own with the same thread id; its child names the thread.
  shifted(codexSession(home, project, 206, { subagent: true, parent: null }), `rollout-2026-10-20T10-00-00-${sessionId(206)}.jsonl`, 60, (r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id: sessionId(205) } } : r));
  codexSession(home, project, 207, { subagent: true, parent: sessionId(205) });
  const data = join(root, "agents");
  const run = async (...args) => {
    const lines = [];
    assert.equal(await importCommand(["--data", data, "--all", ...args], "usage", { home, env: { PATH: "/usr/bin" }, out: (line) => lines.push(line) }), 0);
    return lines.slice(-5);
  };
  // 2,688 + 1,965 + 1,965 + 1,965 tokens: the session, the thread's two files, its child once.
  for (const block of [await run("--dry-run"), await run()]) assert.match(block[2], /^\+ 8\.6K tokens /);
});

test("a moved session's copy holding only copies still has its subagents' folder read: a request only it holds counts once, in the import and the dry run, in either folder order", async (t) => {
  for (const moved of ["-a-moved", "~z-moved"]) {
    const { runs, measured, imported } = await measuredAndImported(t, (home, project) => {
      const file = claudeSession(home, project, 208);
      claudeSubagent(home, project, 208, 1);
      // The copy: the session's records only, its subagent's file, and a subagent's file the original's folder lacks.
      const lines = (path) => readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      writeSession(join(home, ".claude", "projects", moved, `${sessionId(208)}.jsonl`), lines(file));
      writeSession(join(home, ".claude", "projects", moved, sessionId(208), "subagents", "agent-a1.jsonl"), lines(join(dirname(file), sessionId(208), "subagents", "agent-a1.jsonl")));
      claudeSubagent(home, project, 208, 2, { slug: moved });
    });
    // The session's 2 requests, its first subagent's 2 once, and the second subagent's 2.
    assert.deepEqual(runs.map(({ metrics }) => [metrics.requests, metrics.input + metrics.output]), [[6, 88 + 60 + 60]], moved);
    assert.equal(measured, imported, moved);
  }
});

test("the import refuses a data directory whose store an earlier version wrote, in words naming it, and writes nothing into it", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const site = join(at, "code", "app");
  mkdirSync(site, { recursive: true });
  claudeSession(at, site, 1, { prompt: "Build it." });
  const data = join(root, "agents");
  mkdirSync(data, { recursive: true });
  // A real earlier-version store: a store.sqlite with the file-era agent store's tables and no store_meta row.
  const file = join(data, "store.sqlite");
  const earlier = new DatabaseSync(file);
  earlier.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, body_json TEXT NOT NULL)");
  earlier.prepare("INSERT INTO agents (id, body_json) VALUES ('held', '{}')").run();
  earlier.close();
  const before = readFileSync(file);
  const ran = spawnSync(process.execPath, [CLI, "import", "--data", data, "--all"], { env: { ...process.env, HOME: at }, encoding: "utf8" });
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /store\.sqlite/, "the refusal names the earlier version's store");
  assert.match(ran.stderr, /earlier version's data/);
  assert.match(ran.stderr, /new, empty directory/, "and says the one next step");
  // Nothing written: the earlier store is byte for byte as it was, and no store of this version was made beside it.
  assert.ok(readFileSync(file).equals(before), "the earlier version's store is untouched");
  assert.deepEqual(readdirSync(data).sort(), ["store.sqlite"], "nothing else was written into the directory");
});
