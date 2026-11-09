// A github_app MCP server's credential (runner/mcp-github.ts through the claim step, runner/mcp-claim.ts): its server row
// keeps none; the run's installation token is minted at each claim, used by the run's gateway, minted again once, mid-run,
// with five minutes left (55 of 60), and never stored. A claim's fresh() again within its life mints nothing. A token that
// could not be renewed answers its calls in words once it expires, as does an App that is not installed or a run with no
// repository: nothing is sent, nothing crashes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { mcpClaim } = await import("../dist/runner/mcp-claim.js");
const { mcpGateway } = await import("../dist/mcp-gateway.js");

const HOUR = 3_600_000;
const ADD = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } };
const token = (n) => `not-a-secret-${"ghs-installation-token"}-${n}`;

/** A store with run-1 claimed and a github_app server "gh" (no credential stored) in front of a fake MCP server that takes
 *  the tokens `valid` holds; a fake App whose mint answers `answers` in turn (default: a new token for an hour); timers
 *  held for the test to fire. */
async function setUp(t, { answers = [] } = {}) {
  const valid = new Set();
  const fake = await startFakeMcp({ token: (authorization) => valid.has(String(authorization).replace(/^Bearer /, "")) });
  t.after(() => fake.close());
  const opened = await storeOn(t);
  const { store, clock } = opened;
  await store.mcp.put({ name: "gh", url: fake.url, auth: "github_app", tools: [ADD], sealed: null });
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const mints = [];
  const mint = async (target) => {
    mints.push(target);
    const answer = answers[mints.length - 1] ?? "ok";
    if (answer !== "ok") return answer;
    const minted = token(mints.length);
    valid.add(minted);
    return { ok: true, token: minted, expires_at: clock.now + HOUR };
  };
  const timers = [];
  const githubTimer = (fire, ms) => {
    const timer = { at: clock.now + ms, fire, cleared: false, clear: () => void (timer.cleared = true) };
    timers.push(timer);
    return timer;
  };
  /** The clock moved to `at`, and every timer due by then fired. */
  const to = async (at) => {
    clock.now = at;
    for (const timer of timers.filter((tm) => !tm.cleared && !tm.fired && tm.at <= at)) {
      timer.fired = true;
      timer.fire();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const work = mkdtempSync(join(tmpdir(), "mcp-github-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const claimOf = (access = { mint, target: { installation: 7, repo: "acme/widgets" } }) =>
    mcpClaim({ store, claim, grants: ["mcp:gh/add"], sealKey: undefined, signal: new AbortController().signal, now: () => clock.now, githubApp: access, githubTimer });
  const call = (step) => mcpGateway({ pin: step.pin, credentials: step.credentials, work: () => work, liveCredentials: true }).call("gh", "add", { a: 1, b: 1 }, { signal: new AbortController().signal });
  return { store, clock, fake, valid, mints, timers, to, claimOf, call, mint };
}
const bearer = (step) => step.credentials.gh?.headers?.authorization;
const calls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");

test("G1: a run's github_app token is minted at its claim for its repository, used by its gateway, in its redaction set, never stored", async (t) => {
  const { store, mints, claimOf, call } = await setUp(t);
  const step = await claimOf();
  assert.deepEqual(mints, [{ installation: 7, repo: "acme/widgets" }], "minted once, for the run's repository");
  assert.equal(bearer(step), `Bearer ${token(1)}`);
  assert.ok(step.secrets.has(`Bearer ${token(1)}`), "the token is in the redaction set");
  assert.deepEqual(await call(step), { content: [{ type: "text", text: "2" }] }, "the gateway's call carries it");
  assert.equal((await store.mcp.server("gh")).sealed, null, "nothing stored on the server's row");
  step.release();
});

test("G2: a run past 55 minutes has its token minted again once, mid-run, and its next call carries the new one; fresh() within a token's life mints nothing", async (t) => {
  const { clock, valid, mints, to, claimOf, call } = await setUp(t);
  const step = await claimOf();
  await step.fresh();
  assert.equal(mints.length, 1, "a fresh() while the token has more than five minutes left mints nothing");
  await to(clock.now + 55 * 60_000);
  assert.equal(mints.length, 2, "minted again once, at 55 minutes");
  assert.equal(bearer(step), `Bearer ${token(2)}`);
  valid.delete(token(1));
  assert.deepEqual(await call(step), { content: [{ type: "text", text: "2" }] }, "the next call carries the new token");
  await to(clock.now + 60_000);
  assert.equal(mints.length, 2, "no second refresh before the new token's own 55 minutes");
  step.release();
});

test("G3: a token that could not be renewed is used until it expires, then its calls are refused in words, nothing sent", async (t) => {
  const failed = { ok: false, reason: "github_failed", message: "GitHub answered 502" };
  const { clock, fake, mints, to, claimOf, call } = await setUp(t, { answers: ["ok", failed] });
  const start = clock.now;
  const step = await claimOf();
  await to(start + 55 * 60_000);
  assert.equal(mints.length, 2, "the refresh was tried");
  assert.equal(bearer(step), `Bearer ${token(1)}`, "the token held is still used before it expires");
  await to(start + HOUR);
  const before = calls(fake).length;
  const refused = await call(step);
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, "The MCP server gh's credential can't be used right now: its GitHub App token expired and a new one could not be made (GitHub answered 502).");
  assert.equal(calls(fake).length, before, "nothing was sent");
  step.release();
});

test("G4: an App not installed on the run's repository, a run with no repository, or no App at all: calls refused in words, never a crash", async (t) => {
  const { fake, claimOf, call, mint } = await setUp(t, { answers: [{ ok: false, reason: "not_installed", message: "no installation" }] });
  const notInstalled = await claimOf();
  assert.equal((await call(notInstalled)).content[0].text, "The MCP server gh's credential can't be used right now: the GitHub App is not installed on acme/widgets: install it on that repository in GitHub.");
  const noRepo = await claimOf({ mint, target: undefined });
  assert.equal((await call(noRepo)).content[0].text, "The MCP server gh's credential can't be used right now: this run names no GitHub repository, so the GitHub App has no repository to make a token for.");
  const noApp = await claimOf(null);
  assert.equal((await call(noApp)).content[0].text, "The MCP server gh's credential can't be used right now: this server has no GitHub App set up for its runs.");
  assert.deepEqual(calls(fake), [], "nothing was sent");
});
