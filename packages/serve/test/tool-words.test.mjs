// What a model reads about web_fetch and the browser when it picks between them (ported from tool-words.test.mjs, which read
// the tool list a run's own process sent). Granted both, it must be told which keeps cookies and sign-ins: web_fetch reads
// one page cold; the browser keeps cookies across pages, and its agent's saved sign-ins only where the run was handed one.
// A CLI harness (claude-agent, codex) gets web_fetch as a host tool with the same description pi's tool carries.
import assert from "node:assert/strict";
import { test } from "node:test";

const { webFetchTool } = await import("../dist/web-fetch.js");
const { hostToolOf } = await import("../dist/host-tools.js");
const { BROWSER_KEEPS, SIGNED_IN_LINE, browserSection, browserToolsFor } = await import("@parcha/pi-browser");

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

test("handed its agent's saved sign-in, the browser says the sign-in exists, that it opens with it, and that web_fetch reads signed out", () => {
  const signedIn = runOf(true).description;
  assert.match(signedIn, /This agent has a saved sign-in, and this browser opens with it/);
  assert.match(signedIn, /web_fetch reads every page signed out/);
  assert.doesNotMatch(runOf(false).description, /saved sign-in/, "no sign-in claimed without one");
});

test("the browser's prompt section says the agent has a saved sign-in, before the tools, only when the browser opens with one", () => {
  const signedIn = browserSection({ idleReleaseS: 180 }, { signedIn: true });
  const lines = signedIn.split("\n");
  assert.equal(lines[0], "You control one remote browser:");
  assert.equal(lines[1], SIGNED_IN_LINE, "said once, before the tools");
  assert.match(SIGNED_IN_LINE, /Do not use web_fetch for such a page: it reads every page signed out/);
  // The line names no profile, pointer or account: the sign-in's existence only.
  assert.doesNotMatch(SIGNED_IN_LINE, /default|pointer|profile|context|@/);
  assert.ok(!browserSection({ idleReleaseS: 180 }).includes(SIGNED_IN_LINE), "no sign-in line without one");
  assert.ok(!browserSection({ idleReleaseS: 180 }, { signedIn: false }).includes(SIGNED_IN_LINE));
});

test("a CLI harness's web_fetch, as its session is handed it (a host tool), carries the same description: it reads one page cold", () => {
  const tool = webFetchTool({});
  const host = hostToolOf("web_fetch", tool, {});
  assert.ok(host, "web_fetch is a tool a host runs");
  assert.equal(host.description, tool.description);
  assert.ok(host.description.includes(COLD));
});
