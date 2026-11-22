// A template's apply keeps, on the revision it writes, the names of the keys the package declared (never a value): an
// export of the agent names them after the server's copy of the package changes, as bundled templates do on every
// upgrade. The same package applied again still writes no revision.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { scratch, serve, withEnv } from "./support.mjs";

/** A test value for the package's key, given through the server's environment: no store may hold it. */
const KEY_VALUE = `not-a-secret-${"revision-secrets"}-4f1c9a`;

/** The scout package at `version`, declaring `secrets`, written into the templates folder `dir`. */
function writeScout(dir, version, secrets) {
  mkdirSync(join(dir, "scout"), { recursive: true });
  writeFileSync(join(dir, "scout", "agent.md"), `---\nname: scout\nversion: ${version}\ndescription: Looks things up.\nmodel:\n  tier: balanced\ntools: [read]\nsecrets: [${secrets.join(", ")}]\n---\nLook it up.\n`);
}

const manifestOf = (answer) => parseYaml(/^---\n([\s\S]*?)\n---/.exec(answer.files.find((file) => file.path === "agent.md").content)[1]);

async function scoutServer(t) {
  withEnv(t, { PARALLEL_API_KEY: KEY_VALUE });
  const templates = join(await scratch(t), "templates");
  writeScout(templates, "1.0.0", ["PARALLEL_API_KEY"]);
  const server = await serve(t, { templates });
  const applied = await server.api("POST", "/templates/scout/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  return { server, templates, id: applied.body.agent_id };
}

test("an export names the keys the package declared at its apply after the server's copy of the package changes, with no remade entry", { timeout: 120_000 }, async (t) => {
  const { server, templates, id } = await scoutServer(t);
  await server.stop();
  // The server's copy is a new version that declares none, as an upgrade changes a bundled template.
  writeScout(templates, "2.0.0", []);
  const upgraded = await serve(t, { data: server.data, templates });
  const held = (await upgraded.api("GET", "/templates")).body.templates.find((one) => one.id === "scout");
  assert.equal(held?.version, "2.0.0", JSON.stringify(held));

  const exported = await upgraded.api("GET", `/agents/${id}/package`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const manifest = manifestOf(exported.body);
  assert.equal(manifest.version, "1.0.0", "the version it was applied from");
  assert.deepEqual(manifest.secrets, ["PARALLEL_API_KEY"], "the key the package it was applied from declared");
  assert.deepEqual(exported.body.report.remade.filter((entry) => entry.kind === "secrets"), [], JSON.stringify(exported.body.report));
});

test("the same package applied again writes no revision: the key names it keeps are the same", { timeout: 120_000 }, async (t) => {
  const { server, id } = await scoutServer(t);
  const again = await server.api("POST", "/templates/scout/apply", { agent_id: id });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.agent_change, again.body.revision_version], ["unchanged", 1], JSON.stringify(again.body));
  assert.equal((await server.store.agents.revisions(id)).length, 1, "one revision");
});

test("a revision keeps the key's name and never its value: no row of the store and no byte of its file holds the value", { timeout: 120_000 }, async (t) => {
  const { server, id } = await scoutServer(t);
  const revisions = await server.store.agents.revisions(id);
  assert.deepEqual(revisions.map((row) => row.package?.secrets), [["PARALLEL_API_KEY"]], "the name, on the revision the apply wrote");
  assert.doesNotMatch(JSON.stringify(revisions), new RegExp(KEY_VALUE), "no revision row holds the value");
  // On SQLite, the store's file and its write-ahead log, read whole (a Postgres store is read through its rows above).
  const files = ["store.sqlite", "store.sqlite-wal"].map((name) => join(server.data, name)).filter((file) => existsSync(file));
  if (!process.env.AGENTRUN_STORE_URL) assert.ok(files.length, `the store's file is in ${server.data}`);
  for (const file of files) assert.equal(readFileSync(file).indexOf(KEY_VALUE), -1, `${file}: 0 hits`);
  // The search reads: the key's name is in the file, so the value would have been found beside it.
  if (files.length) assert.ok(files.some((file) => readFileSync(file).includes("PARALLEL_API_KEY")), "the name is in the file");
});
