// The report skill's tests run in shards (test/binaries/report-skill-<n>.test.mjs), each a range of the test numbers of
// report-skill.body.mjs: the ranges must hold every test once, so none is dropped and none runs twice.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const dir = new URL("./binaries/", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir), "utf8");

test("the report-skill shards' ranges hold every test of the body once, from the first to the last", () => {
  const shards = fs.readdirSync(dir).filter((name) => /^report-skill-\d+\.test\.mjs$/.test(name)).sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  assert.ok(shards.length > 1, "the tests run in more than one shard");
  const ranges = shards.map((name) => {
    const range = /globalThis\.REPORT_SKILL_SHARD = \{ from: (\d+), to: (\d+|Infinity) \};/.exec(read(name));
    assert.ok(range, `${name} sets its range`);
    return { name, from: Number(range[1]), to: range[2] === "Infinity" ? Infinity : Number(range[2]) };
  });
  assert.equal(ranges[0].from, 0, `${ranges[0].name} starts at the first test`);
  for (const [i, range] of ranges.entries()) {
    assert.ok(range.from < range.to, `${range.name} holds at least one test`);
    if (i + 1 < ranges.length) assert.equal(range.to, ranges[i + 1].from, `${range.name} ends where ${ranges[i + 1].name} starts`);
  }
  assert.equal(ranges.at(-1).to, Infinity, `${ranges.at(-1).name} runs to the last test, so a test added to the body runs`);
  // The range is set before the body runs: a static import would run it first, with no range, and the shard would run every test.
  for (const { name } of ranges) {
    const text = read(name);
    assert.doesNotMatch(text, /^import\s/m, `${name} imports the body only after it sets its range`);
    assert.ok(text.indexOf("globalThis.REPORT_SKILL_SHARD =") < text.indexOf('await import("./report-skill.body.mjs")'), `${name} sets its range, then imports the body`);
  }
  const tests = read("report-skill.body.mjs").match(/^test\(/gm).length;
  assert.ok(ranges.at(-1).from < tests, `the last shard starts within the body's ${tests} tests`);
});
