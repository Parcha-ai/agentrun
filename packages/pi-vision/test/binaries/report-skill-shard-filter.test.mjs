// Each shard's range, given to report-skill.body.mjs, registers exactly that range of its tests, in order: none outside it and
// none twice. The body is imported once for each range, as a module of its own, with a register that only records the names,
// so no test runs here; its fixtures are built each time (it needs ffmpeg, so it runs with the binaries suites).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const dir = new URL("./", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir), "utf8");
const names = [...read("report-skill.body.mjs").matchAll(/^test\((["`])(.*?)\1,/gm)].map((match) => match[2]);
const ranges = fs.readdirSync(dir).filter((name) => /^report-skill-\d+\.test\.mjs$/.test(name)).map((name) => {
  const [, from, to] = /globalThis\.REPORT_SKILL_SHARD = \{ from: (\d+), to: (\d+|Infinity) \};/.exec(read(name));
  return { name, from: Number(from), to: to === "Infinity" ? Infinity : Number(to) };
});

test("each shard's range registers exactly its tests of the body, by name and in order", async () => {
  assert.ok(names.length > 0 && ranges.length > 1, "the body has tests and there are shards");
  for (const { name, from, to } of ranges) {
    const registered = [];
    globalThis.REPORT_SKILL_SHARD = { from, to, register: (test) => registered.push(test) };
    try {
      await import(new URL(`report-skill.body.mjs?shard=${encodeURIComponent(name)}`, dir).href);
    } finally {
      delete globalThis.REPORT_SKILL_SHARD;
    }
    assert.deepEqual(registered, names.slice(from, to === Infinity ? undefined : to), name);
  }
});
