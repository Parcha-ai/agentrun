// A tool's result is shown on the Timeline as its row's summary and preview (a read of a page, a search, a provider's
// answer), and a tool provider can echo a key it was given. The second-model read of #1562 found those rows unredacted:
// a held tool key (Parallel's here) that comes back in a result reached the Timeline whole. A tool's output now goes
// through the same redactor as an error's, before its summary and preview are cut, so no piece of a held key shows: not
// echoed plainly, not across the preview's cut, not base64-encoded. A pi run reads a file the test plants in its
// workspace, which plays the echoing provider.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, runDir, scratch, serve, withEnv } from "./support.mjs";

/** A held tool key, made at runtime: distinct per run, and no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "parallel-tool-key", randomBytes(6).toString("hex")].join("-");
/** Whether `text` holds any 8-character run of `secret`. */
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

const CASES = [
  ["echoed plainly", () => `status: ok\nthe provider was called with key=${KEY}\nresults: 3\n`],
  // The preview keeps 497 characters and "...": 20 of the key's characters before that cut.
  ["across the preview's cut", () => `${"x".repeat(477)}${KEY}${"y".repeat(200)}\n`],
  ["base64-encoded", () => `status: ok\nauth=${Buffer.from(KEY).toString("base64")}\n`],
];

for (const [how, content] of CASES) {
  test(`a tool's result echoing a held tool key ${how}: no 8 characters of it on the Timeline`, { timeout: 60_000 }, async (t) => {
    withEnv(t, { PARALLEL_API_KEY: KEY });
    const dir = await scratch(t);
    const go = join(dir, "go");
    const { api, data } = await serve(t);
    assert.equal((await api("POST", "/agents", agent("echoes", { tools: ["read"] }))).status, 201);
    const started = await api("POST", "/agents/echoes/runs", { input: { content: `Read these paths once ${go} exists: ${JSON.stringify(["found.txt"])}` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const work = join(runDir(data, started.body.run_id), "work");
    for (let i = 0; !existsSync(work); i++) {
      assert.ok(i < 300, "the run's workspace");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await writeFile(join(work, "found.txt"), content());
    await writeFile(go, "");
    const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
    const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === "read");
    assert.ok(result, `a read result row: ${JSON.stringify(rows.map((row) => row.kind))}`);
    assert.ok(result.tool_result_preview, "the row has a preview");
    const timeline = JSON.stringify((await api("GET", `/runs/${started.body.run_id}/timeline`)).body);
    assert.ok(!holdsRun(`${result.summary}\n${result.tool_result_preview}`, KEY), `the row shows part of the key: ${JSON.stringify([result.summary, result.tool_result_preview])}`);
    assert.ok(!holdsRun(timeline, KEY), "no 8 characters of the key anywhere on the Timeline");
    if (how === "base64-encoded") assert.ok(!holdsRun(timeline, Buffer.from(KEY).toString("base64")), "nor of its base64 form");
  });
}
