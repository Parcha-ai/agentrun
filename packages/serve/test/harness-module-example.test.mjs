// The harness module HARNESS.md walks through (examples/harness-module: Goose as an ACP agent under an id of its own),
// loaded the way an owner's server loads it (AGENTRUN_HARNESS_MODULES). Its harness is offered after the built-in ones,
// which are offered as before. What no key fixes (its binary) is said before any key, so an offer never names a key that
// would not run it. A run of it on a real model is the guide's live walk, not this file's.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";

const [table, harness, model] = await Promise.all([import("../dist/harness-table.js"), import("../dist/harness.js"), import("../dist/model.js")]);
const { HARNESS_MODULES_ENV, harnessIds } = table;

const EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples/harness-module/index.mjs");
const { BINARY_SETTING, ID } = await import(EXAMPLE);
const loaded = { [HARNESS_MODULES_ENV]: JSON.stringify([EXAMPLE]) };
const ANTHROPIC = { ANTHROPIC_API_KEY: "anthropic-test-value" };

/** Its offer on `env`, with the built-in harnesses' offers there with and without the module. */
async function offers(t, env) {
  const data = { AGENTRUN_SERVE_DATA: await scratch(t), ...env };
  const plain = await harness.harnessOffers(data);
  const withModule = await harness.harnessOffers({ ...data, ...loaded });
  return { plain, builtins: withModule.slice(0, plain.length), added: withModule.slice(plain.length) };
}

test("the example module adds its harness after the built-in ones, which are offered as before, and its key rows are Anthropic's and OpenRouter's", async (t) => {
  assert.equal(ID, "goose-module");
  assert.deepEqual([...harnessIds(loaded)].slice(-1), [ID]);
  for (const env of [{}, ANTHROPIC, { OPENROUTER_API_KEY: "sk-or-placeholder-0000" }]) {
    const { plain, builtins, added } = await offers(t, env);
    assert.deepEqual(builtins, plain, JSON.stringify(Object.keys(env)));
    assert.deepEqual(added.map((offer) => [offer.id, offer.label, offer.steer]), [[ID, "Goose (module)", false]]);
  }
  assert.deepEqual(model.MODEL_KEYS.filter((row) => model.keyHarnesses(row, loaded).includes(ID)).map((row) => row.id), ["anthropic", "openrouter"]);
});

test("with no binary named, its offer says to name one and names no key, with a key saved or not", async (t) => {
  for (const env of [{}, ANTHROPIC]) {
    const [offer] = (await offers(t, env)).added;
    assert.equal(offer.available, false, JSON.stringify(Object.keys(env)));
    assert.match(offer.reason, new RegExp(`set ${BINARY_SETTING} to its absolute path`));
    assert.equal(offer.keys, undefined, "no key runs it until its binary is there");
  }
});

test("a binary that is not the pinned Goose is refused before any key, saying what to point the setting at", async (t) => {
  const dir = await scratch(t);
  const binary = join(dir, "goose");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const [offer] = (await offers(t, { ...ANTHROPIC, [BINARY_SETTING]: binary })).added;
  assert.equal(offer.available, false);
  assert.match(offer.reason, new RegExp(`cannot run ${binary.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*Point ${BINARY_SETTING} at the pinned Goose`));
  assert.equal(offer.keys, undefined);
});
