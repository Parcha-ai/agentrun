// A cursor an earlier release saved (0.1.0-beta.58's reader state, made by fixtures/old-cursors/make.mjs from that
// release's build), resumed by this one over lines appended since: the same requests as that release's own resume. A
// source whose cursor this release can go on from resumes it; one whose state changed shape (Codex: its open and unpaid
// requests held as Answers, now by their index) reads the file from its start instead of misreading the state.
import assert from "node:assert/strict";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deserialize } from "node:v8";
import { READERS } from "../dist/index.js";
import { tempHome, writeJsonl } from "./fixtures.mjs";
import { CASES, HOME, jsonl, rehomed, summary } from "./fixtures/old-cursors/cases.mjs";
import SAVED from "./fixtures/old-cursors/cursors.json" with { type: "json" };

/** The sources whose cursor state changed shape since the release that saved these. */
const CHANGED = new Set(["codex"]);

for (const { name, mode, cursor, resumed: then } of SAVED) {
  const { source, file: path, one, two } = CASES.find((c) => c.name === name);
  test(`${name} ${JSON.stringify(mode)}: an earlier release's cursor gives the requests its own resume gave`, async (t) => {
    const home = await tempHome(t);
    const file = await writeJsonl(join(home, path), one);
    // The cursor as saved, on this file: the same bytes, in this home, at this file's device and inode.
    const { dev, ino } = await stat(file);
    const saved = { ...rehomed(deserialize(Buffer.from(cursor, "base64")), HOME, home), dev, ino };
    await appendFile(file, jsonl(two));
    const now = summary(await READERS[source].read({ file }, saved, mode));
    // As cursors.json holds it: JSON, no undefined field.
    assert.deepEqual(JSON.parse(JSON.stringify({ ...now, resumed: undefined })), JSON.parse(JSON.stringify({ ...then, resumed: undefined })));
    assert.equal(now.resumed, !CHANGED.has(source), CHANGED.has(source) ? "read from the start" : "resumed");
  });
}
