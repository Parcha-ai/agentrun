// The README's first quickstart is examples/01-durable-chat/on-a-directory.mjs, verbatim (scripts/stranger.mjs runs the
// README's copy in an empty directory), and it runs: a durable chat on a directory of this machine, killed after its third
// answer and resumed by a second process, every message answered once.
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runExample } from "./examples/_run-example.ts";

const example = new URL("../examples/01-durable-chat/on-a-directory.mjs", import.meta.url);
const HEADING = "## Quickstart on one machine: no disk, no key";

it("the README's first quickstart carries the example file verbatim", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const at = readme.indexOf(`${HEADING}\n`);
  assert.ok(at >= 0, `the README has "${HEADING}"`);
  const block = /```js\n([\s\S]*?)```/.exec(readme.slice(at))?.[1];
  assert.equal(block, readFileSync(example, "utf8"));
});

it("runs on a directory of this machine: killed after its third answer, resumed by a second process, every message answered once", { timeout: 120_000 }, async () => {
  const result = await runExample("quickstart", { entry: "01-durable-chat/on-a-directory.mjs" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^generation 1 answered message 3$/m);
  assert.match(result.stdout, /^generation 2 opened the run in .* \(\d answered before\)$/m);
  assert.match(result.stdout, /^ok: 6 messages answered once each, by generations 1 and 2, from the store in /m);
});
