// The import's leak count: each run keeps in its metrics how many distinct keys and tokens the import cut out of what it
// wrote of that run (an environment's key-shaped values, the keys saved on the server, and every key of a known format
// secretlint finds). A number alone: no value, shape or place of a key. GET /v2/wrapped sums the year's runs from it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planImport, runImport } from "../dist/import.js";
import { openSqliteStore } from "../dist/store/index.js";
import { listRuns } from "../dist/store-reads/runs.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { claudeSession, claudeSubagent, sessionId } from "./fixtures/import-sessions.mjs";
import { scratch } from "./support.mjs";

const pick = (n) => Array.from(randomBytes(n), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");

test("each imported run keeps how many distinct keys and tokens were cut out of it, a number alone; the import's own total counts each key once", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const cwd = join(home, "code", "site");
  mkdirSync(cwd, { recursive: true });
  // A token of a format secretlint finds (made here, random), and a value of a key-shaped variable of the import's environment.
  const github = `${["gh", "p"].join("")}_${pick(36)}`;
  const deployToken = `dt-${pick(24)}`;
  // Session 1 holds both, the environment's twice; session 2 neither; session 3 the same GitHub token again.
  claudeSession(home, cwd, 1, { prompt: `Deploy with ${deployToken}, then again with ${deployToken}.`, output: `remote: ${github}` });
  claudeSession(home, cwd, 2, { prompt: "List the files." });
  claudeSession(home, cwd, 3, { prompt: "Push it.", output: `token ${github}` });
  const options = { home, env: { PATH: "/usr/bin", DEPLOY_TOKEN: deployToken }, temp: join(root, "tmp") };
  const data = join(root, "agents");
  const writer = await openSqliteStore({ dataDir: data, role: "server" });
  const report = await runImport(writer, await planImport(options), options);
  await writer.close();
  assert.equal(report.secretsRemoved, 2, "the import's total counts the GitHub token once though two runs held it");
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  t.after(async () => await store.close());
  const runs = await listRuns(store, {}, ctx);
  const secretsOf = async (n) => (await store.runs.get(runs.find((r) => r.importedFrom.session === sessionId(n)).id)).metrics.secrets;
  assert.deepEqual([await secretsOf(1), await secretsOf(2), await secretsOf(3)], [2, 0, 1]);
});

test("a run's count is of what the import keeps of it: a key in the session's id or in its own title counts in that run; one only in a subagent's text, which the import does not keep, counts nowhere; none reaches the store", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const cwd = join(home, "code", "site");
  mkdirSync(cwd, { recursive: true });
  const slug = cwd.replaceAll("/", "-");
  const [inAgent, inId, inTitle] = [`sa-${pick(24)}`, `id-${pick(24)}`, `tt-${pick(24)}`];
  // Session 4 asks a helper, whose own text alone holds a key: the import keeps a subagent's requests, not its words.
  claudeSession(home, cwd, 4, { prompt: "Ask a helper." });
  claudeSubagent(home, cwd, 4, 1, { answer: `Log in with ${inAgent}.` });
  // Session 5's file is named for an id that holds a key (Claude Code names a session for its file).
  renameSync(claudeSession(home, cwd, 5), join(home, ".claude", "projects", slug, `${inId}.jsonl`));
  // Session 6 was renamed (/rename) to a title holding a key, which no line of its transcript holds.
  const titled = claudeSession(home, cwd, 6);
  appendFileSync(titled, `${JSON.stringify({ type: "custom-title", customTitle: `Deploy ${inTitle}`, sessionId: sessionId(6) })}\n`);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(titled, old, old);
  const options = { home, env: { PATH: "/usr/bin", AGENT_TOKEN: inAgent, ID_TOKEN: inId, TITLE_TOKEN: inTitle }, temp: join(root, "tmp") };
  const data = join(root, "agents");
  const writer = await openSqliteStore({ dataDir: data, role: "server" });
  const report = await runImport(writer, await planImport(options), options);
  await writer.close();
  assert.equal(report.secretsRemoved, 2, "the id's and the title's");
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  t.after(async () => await store.close());
  const runs = await listRuns(store, {}, ctx);
  const secretsOf = async (run) => (await store.runs.get(run.id)).metrics.secrets;
  const bySession = (n) => runs.find((r) => r.importedFrom.session === sessionId(n));
  const keptId = runs.find((r) => r.importedFrom.session.startsWith("redacted-"));
  assert.ok(keptId, "the run whose id held a key is kept under a redacted id");
  assert.deepEqual([await secretsOf(bySession(4)), await secretsOf(keptId), await secretsOf(bySession(6))], [0, 1, 1], "the id's and the title's, each in its own run; the subagent's was not kept, so not cut");
  assert.equal((await store.runs.get(bySession(4).id)).metrics.requests, 4, "the subagent was read: its requests are the run's");
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const file of files(data)) for (const value of [inAgent, inId, inTitle]) assert.ok(!readFileSync(file).includes(value), `no stored byte holds a key (${file.slice(data.length)})`);
});
