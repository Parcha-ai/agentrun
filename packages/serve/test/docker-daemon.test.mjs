// Whether a Docker computer can be had here (docker-daemon.ts): the daemon asked within a short bound, the answer kept for
// a while and asked again after it, so a daemon that comes up after the start is seen; and the one wording a person reads
// when none answers, which a run's start (resolve-computer.ts computerReadiness) says too. Every ask is a stand-in: no
// docker command runs here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerDaemonCheck, noDockerWords } from "../dist/docker-daemon.js";
import { computerReadiness } from "../dist/workspace/index.js";
import { KINDS, PROVIDERS } from "./workspace-kinds-fixture.mjs";

/** Mode 1 (run folders on this server's disk): a vendor sandbox can't reach them until Archil is on. */
const NO_DOCKER_SANDBOX = "No Docker on this server: Render and most hosted services run none. A vendor sandbox (Daytona, Modal or E2B) needs Archil turned on in Settings → Workspace.";
/** Mode 2 (run folders on Archil): a vendor sandbox mounts them. */
const NO_DOCKER_SANDBOX_ARCHIL = "No Docker on this server: Render and most hosted services run none. Use a vendor computer, e.g. Daytona, Modal or E2B for a sandbox.";
/** Either mode: a desktop holds no run folder, so any vendor's works. */
const NO_DOCKER_DESKTOP = "No Docker on this server: Render and most hosted services run none. Use a vendor computer, e.g. E2B or Orgo for a desktop.";

/** A stand-in ask that answers each call with the next of `answers`, counting calls. */
function asks(...answers) {
  const calls = [];
  return { calls, ask: async (signal) => (calls.push(signal), answers[Math.min(calls.length - 1, answers.length - 1)]) };
}

test("the words name only what works in the server's mode, of the vendors this server has for the kind", () => {
  assert.equal(noDockerWords("sandbox", PROVIDERS, 1), NO_DOCKER_SANDBOX, "Mode 1: a vendor sandbox needs Archil first");
  assert.equal(noDockerWords("sandbox", PROVIDERS, 2), NO_DOCKER_SANDBOX_ARCHIL, "Mode 2: a vendor sandbox mounts the run's folder");
  for (const mode of [1, 2]) assert.equal(noDockerWords("desktop", PROVIDERS, mode), NO_DOCKER_DESKTOP, `a desktop in Mode ${mode}`);
  const e2bOnly = PROVIDERS.filter((one) => one.id === "docker" || one.id === "e2b");
  assert.equal(noDockerWords("sandbox", e2bOnly, 1), "No Docker on this server: Render and most hosted services run none. A vendor sandbox (E2B) needs Archil turned on in Settings → Workspace.");
  assert.equal(noDockerWords("sandbox", e2bOnly, 2), "No Docker on this server: Render and most hosted services run none. Use a vendor computer, e.g. E2B for a sandbox.");
  // A sandbox that can't mount Archil is never named for one: it could not hold the run's folder in either mode.
  const unmounted = PROVIDERS.filter((one) => one.id === "docker").concat(PROVIDERS.filter((one) => one.id === "daytona").map((one) => ({ ...one, mounts: [] })));
  for (const mode of [1, 2]) assert.equal(noDockerWords("sandbox", unmounted, mode), "No Docker on this server: Render and most hosted services run none. Pick another kind of computer, or none.");
});

test("a failing ask is not ready; a succeeding one is ready; the answer is kept within the TTL and asked again after it, so a daemon that comes up is seen", async () => {
  let clock = 1_000;
  const absent = { up: false, absent: true, reason: "docker version failed: exit 1" };
  const { calls, ask } = asks(absent, { up: true });
  const check = dockerDaemonCheck({ ask, ttlMs: 30_000, now: () => clock });
  assert.deepEqual(await check(), absent);
  clock += 29_999;
  assert.deepEqual(await check(), absent, "kept within the TTL");
  assert.equal(calls.length, 1, "one ask so far");
  clock += 1;
  assert.deepEqual(await check(), { up: true }, "asked again once the TTL is over: the daemon is up now");
  assert.equal(calls.length, 2);
  assert.deepEqual(await check(), { up: true });
  assert.equal(calls.length, 2);
});

test("reads while an ask is out share it; an ask that does not answer within the bound is no daemon, and one that throws is none either", async () => {
  let release;
  const slow = { calls: 0, ask: () => (slow.calls++, new Promise((resolve) => { release = resolve; })) };
  const shared = dockerDaemonCheck({ ask: slow.ask, timeoutMs: 60_000 });
  const both = Promise.all([shared(), shared()]);
  release({ up: true });
  assert.deepEqual(await both, [{ up: true }, { up: true }]);
  assert.equal(slow.calls, 1, "one ask for both reads");

  let aborted = false;
  const hung = dockerDaemonCheck({ ask: (signal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }), timeoutMs: 20 });
  const late = await hung();
  assert.deepEqual([late.up, late.absent], [false, true]);
  assert.match(late.reason, /did not answer within 20 ms/);
  assert.equal(aborted, true, "the ask is aborted at the bound");

  const thrown = await dockerDaemonCheck({ ask: async () => { throw new Error("spawn failed"); } })();
  assert.deepEqual([thrown.up, thrown.absent], [false, true]);
});

test("a run's start (computerReadiness) refuses a Docker sandbox or desktop where no daemon answers, in the words Settings → Computers says; takes it where one does", async () => {
  const keyOf = async () => undefined;
  const absent = async () => ({ up: false, absent: true, reason: "exit 1" });
  assert.deepEqual(await computerReadiness({ kind: "sandbox", provider: "docker" }, 1, KINDS, keyOf, absent), { refused: NO_DOCKER_SANDBOX, box: "docker" });
  assert.deepEqual(await computerReadiness({ kind: "desktop", provider: "docker" }, 1, KINDS, keyOf, absent), { refused: NO_DOCKER_DESKTOP, box: "docker" });
  assert.deepEqual(await computerReadiness({ kind: "desktop", provider: "docker" }, 2, KINDS, keyOf, absent), { refused: NO_DOCKER_DESKTOP, box: "docker" }, "a Docker desktop needs the daemon in Mode 2 too");
  assert.deepEqual(await computerReadiness({ kind: "sandbox", provider: "docker" }, 1, KINDS, keyOf, async () => ({ up: true })), { ok: true });
  // A daemon there that refuses this process: its own reason, in the start's sentence.
  assert.deepEqual(await computerReadiness({ kind: "sandbox", provider: "docker" }, 1, KINDS, keyOf, async () => ({ up: false, absent: false, reason: "This server's process isn't in the docker group." })), { refused: "This agent's computer is a Docker sandbox, and this server cannot run it: This server's process isn't in the docker group.", box: "docker" });
  // A vendor's computer is never asked.
  const asked = [];
  await computerReadiness({ kind: "desktop", provider: "orgo" }, 1, KINDS, keyOf, async (id) => (asked.push(id), { up: true }));
  assert.deepEqual(asked, []);
});
