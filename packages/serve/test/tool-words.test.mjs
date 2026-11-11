// What a model reads about web_fetch and the browser when it picks between them (ported from tool-words.test.mjs, which read
// the tool list a run's own process sent). Granted both, it must be told which keeps cookies and sign-ins: web_fetch reads
// one page cold; the browser keeps cookies across pages, and its agent's saved sign-ins only where the run was handed one.
// A CLI harness (claude-agent, codex) gets web_fetch as a host tool with the same description pi's tool carries.
import assert from "node:assert/strict";
import { test } from "node:test";

const { webFetchTool } = await import("../dist/web-fetch.js");
const { hostToolOf } = await import("../dist/host-tools.js");
const { BROWSER_KEEPS, browserToolsFor } = await import("@parcha/pi-browser");

const COLD = "it reads one page cold";
const runOf = (signIns) => browserToolsFor(signIns).find((tool) => tool.name === "run");

test("web_fetch says it reads one page cold, with no cookies, sign-ins or session", () => {
  const { description } = webFetchTool({});
  assert.ok(description.includes(COLD), description.slice(0, 200));
  assert.match(description, /no cookies, sign-ins or session/);
});

test("the browser with no saved sign-in says it keeps cookies across pages and claims no sign-in; handed its agent's saved sign-in, it says it keeps those", () => {
  const plain = runOf(false).description;
  assert.ok(plain.includes(BROWSER_KEEPS.cookies), plain);
  assert.ok(!plain.includes(BROWSER_KEEPS.signIns), "no sign-in claimed without one");
  const signedIn = runOf(true).description;
  assert.ok(signedIn.includes(BROWSER_KEEPS.signIns), signedIn);
});

test("a CLI harness's web_fetch, as its session is handed it (a host tool), carries the same description: it reads one page cold", () => {
  const tool = webFetchTool({});
  const host = hostToolOf("web_fetch", tool, {});
  assert.ok(host, "web_fetch is a tool a host runs");
  assert.equal(host.description, tool.description);
  assert.ok(host.description.includes(COLD));
});
