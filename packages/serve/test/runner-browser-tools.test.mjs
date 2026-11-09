// A pi run through the dispatch lists the browser's tools exactly as main's per-run process binds them for the same
// revision and plane: tools.ts's browser bound through the runner's ToolHost (the run's store, claim and seal key, its
// live viewers through the store), each wrapped as a HostTool under the adapter loop's one gate, with the same names and
// descriptions. The browser's vendor is the run's launch plane checked again against the keys the claim reads from the
// store, as main's launch checks it; under --faux, the faux browser. A revision that names no browser lists none of
// them. Their calls on the runner wait on the tool task's own api (the end-to-end todo in sign-in-runner.test.mjs).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";
import { scratch } from "./support.mjs";

const { TOOLS, FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_PLANE_ENV, recheckPlane } = await import("../dist/tool-plane.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX = { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER };
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const KERNEL = { KERNEL_API_KEY: "fake-kernel-key" };
const BROWSER_TOOLS = ["snapshot", "run", "screenshot", "browser_read", "browser_release", "browser_relaunch", "browser_request_handoff", "browser_downloads", "browser_upload"];

/** The browser's tools as main's per-run process binds them for `plane`, under the keys its launch handed it. */
async function mainTools(t, plane, keys) {
  const root = await scratch(t);
  mkdirSync(join(root, "work"), { recursive: true });
  const env = { ...FAUX, ...keys, [TOOL_PLANE_ENV]: JSON.stringify(recheckPlane(plane, keys)) };
  const host = { where: { root, work: join(root, "work"), ref: { id: "run-main" } }, env, install() {}, onConversation() {}, beforeResume() {}, beforeRelease() {} };
  return (await TOOLS.browser.bind(host)).tools.map((tool) => ({ name: tool.name, description: tool.description }));
}
/** The spec's browser tools, as the adapter loop offers them. */
const runnerTools = (spec) => spec.session.tools.filter((tool) => BROWSER_TOOLS.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description }));

test("a run whose revision names the browser lists its tools on the runner as main binds them: the same names and descriptions, on Browserbase", async (t) => {
  const plane = { browser: "browserbase" };
  const { spec } = await specFor(t, { body: { tools: ["read", "browser"] }, launch: { plane }, env: FAUX, keys: BROWSERBASE });
  const main = await mainTools(t, plane, BROWSERBASE);
  assert.deepEqual(main.map((tool) => tool.name).sort(), [...BROWSER_TOOLS].sort(), "main's browser tools on Browserbase");
  assert.deepEqual(runnerTools(spec), main);
  assert.ok(spec.session.tools.some((tool) => tool.name === "read"), "beside the hands");
});

test("on Kernel, as main: no browser_downloads (Kernel keeps none of a session's downloads), the rest the same", async (t) => {
  const plane = { browser: "kernel" };
  const { spec } = await specFor(t, { body: { tools: ["browser"] }, launch: { plane }, env: FAUX, keys: KERNEL });
  const main = await mainTools(t, plane, KERNEL);
  assert.ok(!main.some((tool) => tool.name === "browser_downloads"));
  assert.deepEqual(runnerTools(spec), main);
});

test("a revision that names no browser lists none of its tools", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read", "web_fetch"] }, launch: { plane: { browser: "browserbase" } }, env: FAUX, keys: BROWSERBASE });
  assert.deepEqual(runnerTools(spec), []);
});

test("a run whose browser keys are gone since its start lists what main lists then: the same tools, each call refused in the plane's words", async (t) => {
  const plane = { browser: "browserbase" };
  const { spec } = await specFor(t, { body: { tools: ["browser"] }, launch: { plane }, env: FAUX, keys: {} });
  assert.deepEqual(runnerTools(spec), await mainTools(t, plane, {}));
});
