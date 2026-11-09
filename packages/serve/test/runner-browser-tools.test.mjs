// A pi run through the dispatch and the browser's tools. tools.ts's browser binds through the runner's ToolHost (the run's
// store, claim and seal key, its live viewers through the store, its per-claim sign-in), its vendor the launch's plane
// checked again against the keys the claim reads from the store. It fails closed on money: until the adapter loop hands
// the claim's one-ledger booking to the ToolHost (host.paid), the runner lists none of the browser's tools and never
// binds it, so no browser call is held on the process's own spend (browserSpend's process-spend path). With host.paid,
// the tools are main's for the same revision and plane (a named todo until spendcap-1's seam lands); its calls' money on
// that booking is runner-browser-ledger.test.mjs's.
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

test("fail closed: with no one-ledger booking on its ToolHost (host.paid), a runner-path run whose revision names the browser lists none of its tools, and the browser's binding (browserSpend's process-spend path among it) is never reached", async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  writeFileSync(log, "");
  withEnv(t, { FAUX_BROWSER_LOG: log }, ["FAUX_BROWSER_LOG"]);
  const { spec } = await specFor(t, { body: { tools: ["read", "browser"] }, launch: { plane: { browser: "browserbase" } }, env: FAUX, keys: BROWSERBASE });
  assert.deepEqual(runnerTools(spec), [], "no browser tool is listed");
  assert.ok(spec.session.tools.some((tool) => tool.name === "read"), "the hands still are");
  assert.equal(readFileSync(log, "utf8"), "", "the browser was never bound: no provider made, no spend set up");
});

test.todo("with the claim's one-ledger booking on its ToolHost (host.paid), a runner-path run lists the browser's tools as main binds them (the same names and descriptions; Browserbase's nine, Kernel's without browser_downloads; with its keys gone since its start, main's then), its provider through browserSpend with { paid: host.paid }: waits on spendcap-1: the adapter loop handing the claim's PaidBooking to the spec (host.paid). The ledger itself is covered with a booking of the kernel cap's own in runner-browser-ledger.test.mjs");

test("a revision that names no browser lists none of its tools", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read", "web_fetch"] }, launch: { plane: { browser: "browserbase" } }, env: FAUX, keys: BROWSERBASE });
  assert.deepEqual(runnerTools(spec), []);
});

test.todo("a person's take-over and the agent's held ask are held and booked on the run's one ledger (main's personTime holds and carriedSince booking): waits on spendcap-1's browser-cost ledger change");
