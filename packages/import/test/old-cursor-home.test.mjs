// parseHome over a HomeState that holds an earlier release's Codex cursor (review P3-6): Codex's state changed shape
// (stateVersion 2), so its line reader reads such a file from its start (resumed: false), and parseHome reads the
// source again from nothing. The totals are a fresh import's: no request counted twice, none left out. The cursors are
// the old-cursors fixture's (0.1.0-beta.58's reader state, fixtures/old-cursors/make.mjs); every file is synthetic.
import assert from "node:assert/strict";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deserialize } from "node:v8";
import { parseHome, tempHome, writeJsonl } from "./fixtures.mjs";
import { CASES, HOME, jsonl, rehomed } from "./fixtures/old-cursors/cases.mjs";
import SAVED from "./fixtures/old-cursors/cursors.json" with { type: "json" };

/** A parseHome cursor is a totals read's: no turns kept, totals asked. */
const TOTALS = { turns: false, totals: true };
const CODEX = CASES.filter((c) => c.source === "codex");

const canon = (sessions) => JSON.stringify(sessions.map(({ key, calls, turns, tokens, costUsd }) => ({ key, calls, turns, tokens, costUsd })).sort((a, b) => (a.key < b.key ? -1 : 1)));

test("a HomeState holding an earlier release's Codex cursors: the file is read again, and the totals are a fresh import's", async (t) => {
  const home = await tempHome(t);
  const files = await Promise.all(CODEX.map((c) => writeJsonl(join(home, c.file), c.one)));
  // A state as this release keeps it, its Codex cursors then put back as the earlier release saved them on these files.
  const state = {};
  await parseHome(home, { state, catalog: false });
  const cursors = state.sources.codex.cursors;
  assert.equal(cursors.size, CODEX.length, "one cursor a Codex file");
  for (const [i, c] of CODEX.entries()) {
    const saved = SAVED.find((s) => s.name === c.name && JSON.stringify(s.mode) === JSON.stringify(TOTALS));
    const { dev, ino } = await stat(files[i]);
    const old = { ...rehomed(deserialize(Buffer.from(saved.cursor, "base64")), HOME, home), dev, ino };
    assert.equal(old.stateVersion, undefined, "the earlier release's cursor has no stateVersion");
    const key = [...cursors.keys()].find((k) => k.includes(c.file));
    assert.ok(key, `a cursor for ${c.name}`);
    cursors.set(key, old);
  }
  for (const [i, c] of CODEX.entries()) await appendFile(files[i], jsonl(c.two));
  const bytes = (await Promise.all(files.map((f) => stat(f)))).reduce((n, s) => n + s.size, 0);
  const appended = CODEX.reduce((n, c) => n + Buffer.byteLength(jsonl(c.two)), 0);
  const resumed = await parseHome(home, { state, catalog: false });
  // Each old cursor is read from its file's start, not resumed: the pass reads every byte of the files (a resume would
  // read only the appended ones).
  assert.ok(state.read >= bytes, `the files reread from their start: ${state.read} bytes read of ${bytes} (${appended} appended)`);
  const fresh = await parseHome(home, { catalog: false });
  assert.equal(canon(resumed), canon(fresh), "the totals of a fresh import");
  assert.ok(fresh.reduce((n, s) => n + s.calls, 0) > 0, "the fixture's requests are counted");
  // The next pass goes on from this release's cursors, and still gives the same totals.
  for (const [k, cursor] of state.sources.codex.cursors) assert.equal(cursor.stateVersion, 2, `${k}: rewritten at this release's version`);
  assert.equal(canon(await parseHome(home, { state, catalog: false })), canon(fresh), "a pass after, from the new cursors");
});
