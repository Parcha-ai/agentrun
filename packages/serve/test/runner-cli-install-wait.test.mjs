// A CLI run claimed while its harness's first-use install is still running (#2196): the claim waits for that install
// and then runs on it, never failing with the line that installs it by hand while it installs; an install that fails
// fails the run in the install's own words. The claim reads the install's mark beside the harness's directory
// (harness-install.ts installSettled), which the server's one installer (HarnessInstall.ensure) keeps while it runs, so a
// runner beside the server and one in a process of its own read it alike. Each wait here is held open by a gate the test
// opens once the claim is seen waiting, never by time.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { HarnessInstall, HarnessNotInstalled, HARNESS_INSTALLS, installDirOf, installMarkOf, installSettled } = await import("../dist/harness-install.js");
const { claudePins } = await import("../dist/adapters.js");
const { DATA_ENV } = await import("../dist/server-fs.js");
const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const spec = await import("../dist/runner/cli-run-spec.js");
const { fakeAnthropic } = await import("@parcha/agentrun-harness-claude/testing");
const { linkHarnesses } = await import("./support.mjs");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
/** The bound on a wait for an event of the case's own: it caps the wait, it never orders anything. */
const EVENT_WAIT_MS = 30_000;

const until = async (done, what, ms = EVENT_WAIT_MS) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A gate the test opens. */
function gate() {
  let open = () => {};
  const opened = new Promise((resolve) => (open = resolve));
  return { opened, open };
}

const scratch = (t, name) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---- installSettled on a fake harness ----------------------------------------------------------------------------------

/** A harness whose install is whole once its directory holds the file `whole`. */
const FAKE = { id: "fake", label: "Fake CLI", package: "fake-cli", lock: "/nowhere/package-lock.json", lacking: (dir) => (existsSync(join(dir, "whole")) ? undefined : "its CLI") };
const PINS = { version: "1.0.0", platform: "linux-x64" };

/** The server's installer of FAKE into `target`, its install held at a gate, then landing whole (or failing with `fails`). */
function heldInstall(target, { fails } = {}) {
  const held = gate();
  const install = new HarnessInstall(FAKE, target, async () => PINS, async (_entry, dir) => {
    await held.opened;
    if (fails) throw new Error(fails);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "whole"), "");
  });
  return { install, held };
}

test("installSettled: while the server's install runs it waits for it, and reads installed once it lands, the install's mark gone", async (t) => {
  const target = join(scratch(t, "install-wait"), "harnesses", "fake");
  const { install, held } = heldInstall(target);
  const installing = install.ensure();
  await until(() => existsSync(installMarkOf(target)), "the install's mark");
  const settled = installSettled(FAKE, target, PINS, { pollMs: 5 });
  held.open();
  await installing;
  assert.equal(await settled, "installed", "it waited for the install, never reading it missing while it ran");
  assert.ok(!existsSync(installMarkOf(target)), "the mark goes once the install is in");
});

test("installSettled: an install that fails is read with the install's own words", async (t) => {
  const target = join(scratch(t, "install-fail"), "harnesses", "fake");
  const why = "Couldn't install Fake CLI (fake-cli@1.0.0) from npm: the registry answered 503";
  const { install, held } = heldInstall(target, { fails: why });
  const installing = install.ensure().then(() => assert.fail("the install fails"), (error) => error);
  await until(() => existsSync(installMarkOf(target)), "the install's mark");
  const settled = installSettled(FAKE, target, PINS, { pollMs: 5 });
  held.open();
  assert.equal((await installing).message, why);
  assert.deepEqual(await settled, { failed: why });
});

test("installSettled: with no install running (no mark, or one a process that is gone left) it reads none at once; installed whole, installed", async (t) => {
  const target = join(scratch(t, "install-none"), "harnesses", "fake");
  assert.equal(await installSettled(FAKE, target, PINS), "none", "no mark");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(installMarkOf(target), JSON.stringify({ host: hostname(), pid: 999_999_999, startedAt: Date.now() }));
  assert.equal(await installSettled(FAKE, target, PINS, { isAlive: () => false }), "none", "its installer on this host is gone");
  writeFileSync(installMarkOf(target), JSON.stringify({ host: hostname(), pid: process.pid, startedAt: Date.now() - 11 * 60_000 }));
  assert.equal(await installSettled(FAKE, target, PINS), "none", "past the install's own limit");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "whole"), "");
  assert.equal(await installSettled(FAKE, target, PINS), "installed");
});

test("installSettled: another host's install (a runner in its own container on the same volume) is trusted within the install's limit, its pid unread here: it waits, and reads installed once it lands; past the limit, none", async (t) => {
  const target = join(scratch(t, "install-other-host"), "harnesses", "fake");
  mkdirSync(join(target, ".."), { recursive: true });
  // Its pid means nothing in this PID namespace: read as gone here, it must not end the wait.
  writeFileSync(installMarkOf(target), JSON.stringify({ host: `${hostname()}-installer`, pid: 1, startedAt: Date.now() }));
  const settled = installSettled(FAKE, target, PINS, { pollMs: 5, isAlive: () => false });
  // The other host's install lands.
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "whole"), "");
  assert.equal(await settled, "installed", "it waited on the other host's install");
  rmSync(join(target, "whole"));
  writeFileSync(installMarkOf(target), JSON.stringify({ host: `${hostname()}-installer`, pid: 1, startedAt: Date.now() - 11 * 60_000 }));
  assert.equal(await installSettled(FAKE, target, PINS, { isAlive: () => true }), "none", "past the limit the mark is stale: the claim says it is not installed");
});

test("installSettled: a claim stopped while it waits stops waiting", async (t) => {
  const target = join(scratch(t, "install-stop"), "harnesses", "fake");
  const { install, held } = heldInstall(target);
  const installing = install.ensure();
  t.after(async () => (held.open(), await installing));
  await until(() => existsSync(installMarkOf(target)), "the install's mark");
  const stop = new AbortController();
  const settled = installSettled(FAKE, target, PINS, { pollMs: 5, signal: stop.signal });
  stop.abort(new Error("the claim was stopped"));
  await assert.rejects(settled, { message: "the claim was stopped" });
});

// ---- a claude-agent run claimed mid-install ----------------------------------------------------------------------------

/** A claude-agent run claimed while the server's install of Claude Code runs (held at a gate; it lands by linking the
 *  pinned SDK and CLI as a first use installs them, or fails with `fails`). The gate opens once the claim is seen waiting
 *  for the install (its spec's installSettled entered) with the run still running. Returns the run's end. */
async function claimedMidInstall(t, { fails, stop = false } = {}) {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Hello from Claude." }) });
  t.after(() => fake.close());
  const dir = scratch(t, "runner-cli-install-wait");
  const entry = HARNESS_INSTALLS["claude-agent"];
  const target = installDirOf(dir, "claude-agent");
  const held = gate();
  const install = new HarnessInstall(entry, target, () => claudePins(), async (_entry, into, pins) => {
    await held.opened;
    if (fails) throw new HarnessNotInstalled(entry, into, pins.version, fails);
    await linkHarnesses(dir);
  });
  let landed = false;
  const installing = install.ensure().then(() => void (landed = true), (error) => error);
  await until(() => existsSync(installMarkOf(target)), "the install's mark");

  const env = { [DATA_ENV]: dir, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url };
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    held.open();
    await installing;
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", harness: "claude-agent", tools: ["read"] } });
  const launch = { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, harness: "claude-agent", model: { provider: "anthropic", modelId: "claude-haiku-4-5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const waiting = gate();
  const deps = {
    env,
    data: dir,
    journal: (claim) => store.journal(claim),
    store,
    sealKey: SEAL_KEY,
    routeOf: async () => assert.fail("a CLI run takes no pi route"),
    computerForClaim: async () => ({ release: async () => {} }),
    installSettled: (...args) => (waiting.open(), installSettled(...args)),
  };
  runner = startRunner({
    store,
    name: "runner-a",
    ...CONFORMANCE_TIMING,
    leaseMs: 30_000,
    stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === "claude-agent" ? createAdapterLoop((claim, run) => spec.cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  // The claim reaches the wait; a build with no wait fails the run on the missing install instead, said here by name ...
  let reached = false;
  void waiting.opened.then(() => (reached = true));
  const first = await until(async () => {
    if (reached) return { waited: true };
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && { waited: false, now };
  }, "the claim waits for the install, or the run ends");
  assert.ok(first.waited, `the claim waits for the install, never ending the run while it runs: ${JSON.stringify(first.now)}`);
  assert.equal((await server.runs.get(RUN)).state, "running", "waiting for the install, the run is running, not failed");
  // ... and only then does the install go on (or, `stop`, the person stops the run while it waits).
  if (stop) await server.command(RUN, { kind: "stop" });
  else held.open();
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const stillInstalling = !landed && existsSync(installMarkOf(target));
  if (stop) held.open();
  return { row, entries, messages: messagesOf(entries), install: await installing, stillInstalling };
}

/** The run's phase rows' words (the host's own steps on its timeline). */
const phasesOf = (entries) => entries.filter((entry) => typeof entry.data?.summary === "string" && /phase/.test(entry.kind)).map((entry) => entry.data.summary);

test("a claude-agent run claimed while Claude Code's first-use install runs waits for it, then runs on it and ends with its answer", { timeout: 180_000 }, async (t) => {
  const { row, messages, entries } = await claimedMidInstall(t);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [["person", "Say hello."], ["model", "Hello from Claude."]]);
  assert.ok(phasesOf(entries).includes("Installing Claude Code (first use)…"), `the run said it waited for the install: ${JSON.stringify(phasesOf(entries))}`);
});

test("a person's stop of a claude-agent run waiting for Claude Code's first-use install ends it stopped at once; the install goes on", { timeout: 180_000 }, async (t) => {
  const { row, stillInstalling } = await claimedMidInstall(t, { stop: true });
  assert.equal(row.state, "stopped", `the run stopped: ${JSON.stringify(row)}`);
  assert.ok(stillInstalling, "it ended while the install still ran: the stop ended the wait, never the install");
});

test("a claude-agent run claimed while Claude Code's first-use install runs, which then fails, fails in the install's own words", { timeout: 180_000 }, async (t) => {
  const why = "Couldn't install Claude Code from npm: the registry answered 503";
  const { row, install } = await claimedMidInstall(t, { fails: why });
  assert.ok(install instanceof HarnessNotInstalled, "the install failed");
  assert.equal(row.state, "failed", `the run failed: ${JSON.stringify(row)}`);
  assert.ok(row.summary?.includes(why), `in the install's words: ${row.summary}`);
});
