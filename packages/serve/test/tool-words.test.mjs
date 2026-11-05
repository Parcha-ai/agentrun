// What the model reads about web_fetch and the browser, from the tool list a run's process sends it (faux-tools.mjs
// answers with that list). Granted both, a model must be told which one keeps cookies and sign-ins: web_fetch reads one
// page cold, the browser keeps cookies across pages, and its agent's saved sign-in where the run was handed one.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { KEY as BB_KEY } from "./fixtures/faux-browserbase-check.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const TOOLS = new URL("./fixtures/faux-tools.mjs", import.meta.url).pathname;
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL", "KERNEL_API_KEY", "AGENTRUN_SEAL_KEY", "FAUX_BROWSER_LOG"];

/** The tools the model of a run of agent `id` (granted web_fetch and the browser) was offered, by name. */
async function offered(api, id) {
  assert.equal((await api("POST", "/agents", agent(id, { tools: ["web_fetch", "browser"] }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Open https://httpbin.org/cookies" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  const answer = (await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer;
  return new Map(JSON.parse(answer).map((tool) => [tool.name, tool.description]));
}

const COLD = "It has no cookies, sign-ins or session: it reads one page cold, so a page behind a sign-in, or one that depends on an earlier page, needs the browser.";
const SIGN_INS = "It keeps this agent's saved sign-ins and cookies: use it for anything behind a sign-in, or a page that depends on an earlier one.";
const COOKIES = "It keeps cookies across pages: use it for a page that depends on an earlier one, or one that sets cookies.";

test("web_fetch says it reads one page cold, with no cookies or sign-in; the browser, with no saved sign-in, says it keeps cookies across pages and claims no sign-in", { timeout: 120_000 }, async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" }, KEYS);
  const { api } = await serve(t, { faux: TOOLS, fauxBrowser: FAUX_BROWSER });
  const tools = await offered(api, "cold");
  assert.ok(tools.get("web_fetch").startsWith(`Read one web page from a public host, a part at a time. ${COLD}`), tools.get("web_fetch"));
  const run = tools.get("run");
  assert.ok(run.includes(COOKIES), run);
  assert.ok(!/sign-in/.test(run), "no sign-in is claimed where the run has none");
});

test("a run handed its agent's saved sign-in: the browser says it keeps this agent's saved sign-ins and cookies, for anything behind a sign-in", { timeout: 120_000 }, async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, KEYS);
  const { api } = await serve(t, { faux: TOOLS, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const tools = await offered(api, "signed");
  assert.ok(tools.get("web_fetch").includes(COLD), tools.get("web_fetch"));
  const run = tools.get("run");
  assert.ok(run.includes(SIGN_INS), run);
  assert.ok(!run.includes(COOKIES), "one sentence about what the browser keeps");
});
