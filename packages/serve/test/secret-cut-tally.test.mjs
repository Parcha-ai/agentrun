// The per-run tally of the server's secret cut: what one imported run held, counted apart from the cut's own total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { secretCut } from "../dist/secret-cut.js";

const ENV = { OPENAI_API_KEY: "sk-tally-aaaaaaaaaaaaaaaa", GITHUB_TOKEN: "ghp_tallybbbbbbbbbbbbbbbbbbbb" };

test("a tally counts each value cut while it is open once, and its stop may be called again: the same number, nothing cut after the first", () => {
  const { text, tally } = secretCut(ENV);
  const stop = tally();
  text(`one ${ENV.OPENAI_API_KEY} and ${ENV.OPENAI_API_KEY} again`);
  assert.equal(stop(), 1, "one value, met twice, counts once");
  text(`after the stop: ${ENV.GITHUB_TOKEN}`);
  assert.equal(stop(), 1, "a second stop gives the same count, and the value cut after the first is not in it");
  assert.equal(text.removed, 2, "the cut's own total still counts both");
});

test("a tally stopped counts nothing a later tally counts: each run's count is its own", () => {
  const { text, tally } = secretCut(ENV);
  const first = tally();
  text(ENV.OPENAI_API_KEY);
  first();
  const second = tally();
  text(ENV.GITHUB_TOKEN);
  assert.deepEqual([first(), second()], [1, 1]);
});
