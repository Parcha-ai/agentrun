// A pi run through the dispatch and the browser. tools.ts's browser binds through the runner's ToolHost (the run's store,
// claim and seal key, its live viewers through the store, its per-claim sign-in), and its durable extension goes to pi's
// native route (runner-browser-native.test.mjs: offered once, its release drained). It fails closed on money: with no
// ledger booking on the ToolHost (host.ledger.paid) it is never bound, so no browser call is held on the process's own
// spend (browserSpend's process-spend path); its calls' money on that booking is runner-browser-ledger.test.mjs's.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";
import { scratch, withEnv } from "./support.mjs";

const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX = { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER };
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const BROWSER_TOOLS = ["snapshot", "run", "screenshot", "browser_read", "browser_release", "browser_relaunch", "browser_request_handoff", "browser_downloads", "browser_upload"];

/** The spec's browser tools, as the adapter loop offers them. */
const runnerTools = (spec) => spec.session.tools.filter((tool) => BROWSER_TOOLS.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description }));

test("fail closed: with no ledger booking on its ToolHost (host.ledger.paid), a runner-path run whose revision names the browser lists none of its tools, and the browser's binding (browserSpend's process-spend path among it) is never reached", async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  writeFileSync(log, "");
  withEnv(t, { FAUX_BROWSER_LOG: log }, ["FAUX_BROWSER_LOG"]);
  const { spec } = await specFor(t, { body: { tools: ["read", "browser"] }, launch: { plane: { browser: "browserbase" } }, env: FAUX, keys: BROWSERBASE });
  assert.deepEqual(runnerTools(spec), [], "no browser tool is listed");
  assert.ok(spec.session.tools.some((tool) => tool.name === "read"), "the hands still are");
  assert.equal(readFileSync(log, "utf8"), "", "the browser was never bound: no provider made, no spend set up");
});

test("the browser installs on the runner only on the native route, with the run's ledger booking and the grant (browserListed)", async () => {
  const spec = await import("../dist/runner/adapter-run-spec.js");
  const paid = { admit: async () => {}, settle: async () => {} };
  assert.equal(spec.BROWSER_ON_RUNNER, true, "on: pi's native route carries pi-browser's durable extension");
  assert.equal(spec.browserListed({ ledger: { paid } }, ["browser"]), true, "a booking and the grant");
  assert.equal(spec.browserListed({}, ["browser"]), false, "no booking: fail closed");
  assert.equal(spec.browserListed({ ledger: { paid } }, ["read"]), false, "no grant");
});

test("a revision that names no browser lists none of its tools", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read", "web_fetch"] }, launch: { plane: { browser: "browserbase" } }, env: FAUX, keys: BROWSERBASE });
  assert.deepEqual(runnerTools(spec), []);
});

test.todo("a person's take-over and the agent's held ask are held and booked on the run's one ledger (main's personTime holds and carriedSince booking): waits on spendcap-1's browser-cost ledger change");
