// The registry's interface: a reader discovers locators ({ file, id? }) under a home, reads a locator into sessions, and
// names the id of a session no record names (idOf). A source that keeps many sessions in one file (OpenCode's SQLite database) is one more
// reader with no change anywhere else: its sessions are keyed by `relpath#id`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { locatorKey, parseHome, READERS, readSession } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, piAnswer, piFile, piMeta, piUser, SESSION, tempHome, writeJsonl } from "./fixtures.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A reader of a made-up format: one JSON file holding many sessions, each with its requests' usage. */
const manyInOne = {
  source: "many",
  name: "Many In One",
  harness: "pi",
  async discover(home) {
    return [{ file: join(home, ".many", "store.json") }];
  },
  idOf: (locator) => locator.id ?? "",
  async read(locator) {
    const { readFile } = await import("node:fs/promises");
    const rows = JSON.parse(await readFile(locator.file, "utf8"));
    const sessions = rows
      .filter((row) => locator.id === undefined || row.id === locator.id)
      .map((row) => {
        const requests = row.usage.map((usage, i) => ({ role: "assistant", text: "", calls: [], at: i, usage }));
        const session = { source: "many", id: row.id, file: locator.file, state: "completed", child: false, turns: [], users: row.users, activeMs: 0, copies: 0 };
        return { locator: { file: locator.file, id: row.id }, session, requests };
      });
    return { sessions };
  },
};

test("a built-in reader discovers locators and reads one into sessions", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }), claudeAnswer({ uuid: "a1", msg: "m1", req: "r1", usage: anthropicUsage(1, 2), i: 1 })]);
  const reader = READERS["claude-code"];
  assert.deepEqual(await reader.discover(home), [{ file }]);
  const first = await reader.read({ file });
  assert.equal(first.sessions.length, 1);
  assert.deepEqual(first.sessions[0].locator, { file });
  assert.equal(first.sessions[0].session.id, SESSION);
  assert.equal(first.sessions[0].requests.length, 1);
});

test("a pi file whose session record names no id: idOf gives the id its read gives, the last _ part of its name", async (t) => {
  const home = await tempHome(t);
  const { id: _id, ...nameless } = piMeta("pi-nameless-7");
  const file = await writeJsonl(piFile(home, "pi-nameless-7"), [nameless, piUser("Fixture question."), piAnswer({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })]);
  const read = await readSession(file, "pi");
  assert.equal(read.id, "pi-nameless-7");
  assert.equal(READERS.pi.idOf({ file }), read.id);
  assert.equal(READERS["claude-code"].idOf({ file: claudeFile(home) }), SESSION);
});

test("a fourth reader that keeps many sessions in one file: parseHome keys each by relpath#id, readSession picks one by id", async (t) => {
  const home = await tempHome(t);
  await mkdir(join(home, ".many"), { recursive: true });
  const store = join(home, ".many", "store.json");
  await writeFile(
    store,
    JSON.stringify([
      { id: "s1", users: 2, usage: [{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }] },
      { id: "s2", users: 1, usage: [{ input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }] },
    ]),
  );
  const lines = await parseHome(home, { sources: ["many"], readers: { many: manyInOne }, catalog: false });
  const keys = [sha(".many/store.json#s1"), sha(".many/store.json#s2")];
  assert.deepEqual(lines.map((line) => line.key), [...keys].sort());
  const by = Object.fromEntries(lines.map((line) => [line.id, line]));
  assert.deepEqual([by.s1.tokens.input, by.s1.turns, by.s1.calls], [1, 2, 1]);
  assert.deepEqual([by.s2.tokens.output, by.s2.turns, by.s2.calls], [25, 1, 2]);
  assert.equal(locatorKey({ file: store, id: "s2" }), `${store}#s2`);
  assert.equal(locatorKey({ file: store }), store);
  assert.equal((await readSession({ file: store, id: "s2" }, "many", { readers: { many: manyInOne } })).id, "s2");
});
