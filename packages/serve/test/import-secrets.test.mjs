// The import's leak count: each run keeps in its metrics how many distinct keys and tokens the import cut out of what it
// wrote of that run (an environment's key-shaped values, the keys saved on the server, and every key of a known format
// secretlint finds). A number alone: no value, shape or place of a key. GET /v2/wrapped sums the year's runs from it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planImport, runImport } from "../dist/import.js";
import { openSqliteStore } from "../dist/store/index.js";
import { listRuns } from "../dist/store-reads/runs.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { claudeSession, sessionId } from "./fixtures/import-sessions.mjs";
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
