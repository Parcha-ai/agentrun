// No migration (the lead's ruling): the server's open refuses a data directory an earlier version wrote, naming what it
// found, with words to start in a new, empty directory. Nothing is read, moved or changed there. An empty directory (or one
// not made yet, or one holding this version's store) opens.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test as nodeTest } from "node:test";
import { sqliteAdapterTests } from "./store-target.mjs";

const test = sqliteAdapterTests(nodeTest, "an earlier version's data directory files");

const { openSqliteStore } = await import("../dist/store/index.js");

function dataDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-earlier-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const file = (path, text = "{}") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const sqlite = (path) => {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY)");
  db.close();
};

/** A link at `path` to a directory elsewhere that `make` fills: an earlier version's home or run kept outside the data
 *  directory and linked in, as the server's own check of old homes follows (server.ts oldHomes). */
const linked = (path, make) => {
  const target = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-earlier-target-"));
  linkedTargets.push(target);
  make(target);
  mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(target, path, "dir");
};
const linkedTargets = [];
after(() => {
  for (const target of linkedTargets) rmSync(target, { recursive: true, force: true });
});

const SHAPES = [
  ["an earlier version's store.sqlite (no schema_version row)", (dir) => sqlite(join(dir, "store.sqlite")), "store.sqlite"],
  ["an agent home's agent.sqlite", (dir) => sqlite(join(dir, "agent-1", "agent.sqlite")), join("agent-1", "agent.sqlite")],
  ["an agents/ home's agent.sqlite", (dir) => sqlite(join(dir, "agents", "agent-1", "agent.sqlite")), join("agents", "agent-1", "agent.sqlite")],
  ["a run's run.sqlite under runs/", (dir) => sqlite(join(dir, "runs", "run-1", "run.sqlite")), join("runs", "run-1", "run.sqlite")],
  ["a run's run.sqlite on the disk", (dir) => sqlite(join(dir, "disk", "agents", "agent-1", "runs", "run-1", "run.sqlite")), join("disk", "agents", "agent-1", "runs", "run-1", "run.sqlite")],
  ["mcp-servers.json", (dir) => file(join(dir, "mcp-servers.json")), "mcp-servers.json"],
  ["triggers.json", (dir) => file(join(dir, "triggers.json")), "triggers.json"],
  ["tool-keys.json", (dir) => file(join(dir, "tool-keys.json")), "tool-keys.json"],
  ["trigger-secrets.json", (dir) => file(join(dir, "trigger-secrets.json")), "trigger-secrets.json"],
  ["webhook.json", (dir) => file(join(dir, "webhook.json")), "webhook.json"],
  ["webhook-outbox.json", (dir) => file(join(dir, "webhook-outbox.json")), "webhook-outbox.json"],
  [".idempotency.json", (dir) => file(join(dir, ".idempotency.json")), ".idempotency.json"],
  ["learning-usage.jsonl", (dir) => file(join(dir, "learning-usage.jsonl"), ""), "learning-usage.jsonl"],
  ["a home's sign-ins.json", (dir) => file(join(dir, "homes", "home-1", "sign-ins", "sign-ins.json")), join("homes", "home-1", "sign-ins", "sign-ins.json")],
  // The per-run door's token: only an earlier version's runs had a door.
  [".door-token", (dir) => file(join(dir, ".door-token"), "token"), ".door-token"],
  // A home or run linked in from elsewhere is the earlier version's all the same.
  ["a linked agent home's agent.sqlite", (dir) => linked(join(dir, "agent-1"), (to) => sqlite(join(to, "agent.sqlite"))), join("agent-1", "agent.sqlite")],
  ["a linked agents/ home's agent.sqlite", (dir) => linked(join(dir, "agents", "agent-1"), (to) => sqlite(join(to, "agent.sqlite"))), join("agents", "agent-1", "agent.sqlite")],
  ["a linked run's run.sqlite under runs/", (dir) => linked(join(dir, "runs", "run-1"), (to) => sqlite(join(to, "run.sqlite"))), join("runs", "run-1", "run.sqlite")],
  ["a linked home's sign-ins.json", (dir) => linked(join(dir, "homes", "home-1"), (to) => file(join(to, "sign-ins", "sign-ins.json"))), join("homes", "home-1", "sign-ins", "sign-ins.json")],
];

test("this version's own files beside its store open: .token, .server.json, and a leftover box-image.json the cutover stopped writing", async (t) => {
  const dir = dataDir(t);
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  await store.close();
  for (const name of [".token", ".server.json", "box-image.json"]) file(join(dir, name), "{}");
  const again = await openSqliteStore({ dataDir: dir, role: "server" });
  await again.close();
});

for (const [what, make, named] of SHAPES) {
  test(`the server refuses a data directory holding ${what}, by name, and changes nothing there`, async (t) => {
    const dir = dataDir(t);
    make(dir);
    const before = readdirSync(dir, { recursive: true }).sort();
    await assert.rejects(openSqliteStore({ dataDir: dir, role: "server" }), (error) => {
      assert.equal(error.name, "StoreFromEarlierVersion");
      assert.ok(error.found.includes(named), `it names ${named}: ${JSON.stringify(error.found)}`);
      assert.match(error.message, /earlier version/);
      assert.match(error.message, /new, empty directory/);
      return true;
    });
    assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before, "nothing made, moved or removed");
  });
}

test("an empty data directory, one not made yet, and one holding this version's store all open", async (t) => {
  const empty = dataDir(t);
  const store = await openSqliteStore({ dataDir: empty, role: "server" });
  await store.close();
  const again = await openSqliteStore({ dataDir: empty, role: "server" });
  await again.close();
  const fresh = join(dataDir(t), "not-yet");
  const made = await openSqliteStore({ dataDir: fresh, role: "server" });
  await made.close();
});
