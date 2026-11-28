// A run's checkout (runner/pr-checkout.ts: `checkout: pull_request` and `checkout: repository`) on a Mode 2 server whose
// Archil region has no serverless exec (gcp-us-central1, where every exec answers "Exec is not enabled"). The checkout
// is the server's own git fetch, one command over the run's folder. Where the region has exec, that command is Archil's
// exec over the disk, before the run's computer exists, as before. Where it has none, the disk runs no command, so the
// checkout waits for the run's computer, and runs in it, through its own exec, once it has mounted the run's folder:
// the same script, the token on its stdin (process.write), never on its argv or in the environment it starts with. A run
// with no computer that mounts the folder there gets no checkout, and is told why up front, the timeline naming a sandbox
// computer, instead of a fetch that fails on Archil's "Exec is not enabled". Nor does a run whose computer this claim did
// not start (a kept sandbox taken back, the agent's own, a paired one): it may already have run the agent's code. Both spec builders (pi's and the CLI's), over
// the Archil fake (its disk, its control plane) with a fake E2B sandbox whose processes run for real in a local folder
// standing in for the mounted run's folder, and a folder of bare repositories or git's own HTTP server on loopback
// standing in for GitHub: no network.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { git, gitHttp, pullRepo } from "./fixtures/git-http.mjs";
import { KEY, mode2Run } from "./fixtures/mode2-mounted-run.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { realProcesses } from "./workspace-fake-processes.mjs";

const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { checkoutWhereNoExec, prCheckout, CHECKOUT_DIR } = await import("../dist/runner/pr-checkout.js");
const { localWorkspace } = await import("../dist/workspace/local.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");

const GCP = "gcp-us-central1";
const AWS = "aws-us-east-1";
const NO_EXEC = /gcp-us-central1 has no serverless exec/;
/** Why a computer this claim did not start gets no checkout. */
const REUSED_WORDS = /the run's computer is not one this claim started \(a sandbox kept through a wait, the agent's own computer or a paired one\): it may already have run the agent's code, so the server hands it no GitHub token/;
/** What a computer this claim did not start is told about a repo/ folder its mount may still hold. */
const NOT_ITS_REPO = /A repo\/ folder in the run's folder, if there is one, is not this claim's checkout: an earlier claim's, whose removal failed, so it may be stale\./;

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "no-exec-checkout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A run's first input, as a GitHub pull_request firing gives it (triggers.ts inputOf). */
const firing = (repo, { number = 7, head, base, installation = 777 }) => ({
  content: `Review the pull request.\n\n<trigger-payload source="github" scheme="github" event="pull_request" action="opened" installation="${installation}" repo="${repo}" number="${number}" head_sha="${head}"${base ? ` base_sha="${base}"` : ""} untrusted>\n{"action":"opened"}\n</trigger-payload>\n\n(From the GitHub trigger "prs", received at now.)`,
});

/** The run's launch and the commit its checkout lands at, for each kind of checkout, over the bare repositories in `gh`. */
const KINDS = {
  pull_request: ({ head, base }) => ({ launch: { input: firing("acme/widgets", { head, base }), inputOrigin: { kind: "trigger", source: "github" } }, at: head, note: /^The pull request acme\/widgets#7 is checked out in repo\// }),
  repository: ({ base }) => ({ launch: { input: { content: "Scan https://github.com/acme/widgets for places an agent would help." } }, at: base, note: /^The repository acme\/widgets is checked out in repo\// }),
};

/** The disk's execs: Archil's serverless exec, asked. */
const execsOf = (disk) => disk.calls.filter((call) => call.op === "exec");
/** The checkout's git script, by its init. */
const CHECKOUT_SCRIPT = /\binit -q --template= /;
/** The computer's process.start calls that ran the checkout's git script. */
const checkoutStarts = (computer) => computer.calls.filter(([method, params]) => method === "process.start" && params.argv.some((arg) => CHECKOUT_SCRIPT.test(arg)));

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  for (const kind of Object.keys(KINDS)) {
    test(`${name}, Mode 2 on ${GCP}, a sandbox that mounts the run's folder, checkout ${kind}: the checkout is made in the computer after its mount, through its own exec, never asked of the disk's exec; the run is told it is there; the release removes it`, { timeout: 120_000 }, async (t) => {
      const gh = join(await scratch(t), "gh");
      const { at, launch, note } = KINDS[kind](pullRepo(gh, "acme/widgets"));
      const disk = new FakeArchilDisk();
      disk.noExec = true;
      const run = await mode2Run(t, { harness, disk, region: GCP, processes: true, body: { checkout: kind }, launch, deps: { githubWeb: `file://${gh}` } });
      const { spec } = await run.claimNext(build);
      const system = spec.session.system.join("\n");
      const repo = join(run.scratch, CHECKOUT_DIR);
      assert.ok((await readdir(run.scratch)).includes(CHECKOUT_DIR), system);
      assert.equal(git(repo, "rev-parse", "HEAD"), at, system);
      assert.match(spec.session.system.find((line) => / checked out in repo\//.test(line)) ?? system, note);
      assert.deepEqual(execsOf(disk), [], "nothing was asked of the disk's exec, which this region does not have");
      assert.equal(run.mounts.length, 1, "the run's computer mounts its folder");
      const [[, started]] = checkoutStarts(run.computer);
      assert.equal(started.cwd, "/workspace", "in the run's folder as the computer mounts it");
      assert.equal(started.stdin, true, "its stdin open for the header (empty here: no App, an anonymous fetch)");
      assert.deepEqual(disk.refusedByDelegation, [], "nothing written over the disk's file API while the mount holds it");
      await spec.release();
      assert.ok(!(await readdir(run.scratch)).includes(CHECKOUT_DIR), "the release removed the checkout, through the computer");
    });
  }

  test(`${name}, Mode 2 on ${GCP}, no computer: no checkout, and the run is told why up front (the region has no exec, so a checkout needs a computer that mounts its folder), the timeline naming a sandbox computer; the disk's exec is never asked`, { timeout: 120_000 }, async (t) => {
    const gh = join(await scratch(t), "gh");
    const named = pullRepo(gh, "acme/widgets");
    for (const kind of Object.keys(KINDS)) {
      const { launch } = KINDS[kind](named);
      const disk = new FakeArchilDisk();
      disk.noExec = true;
      const run = await mode2Run(t, { harness, disk, region: GCP, computer: false, body: { checkout: kind }, launch, deps: { githubWeb: `file://${gh}` } });
      const { spec } = await run.claimNext(build);
      const line = spec.session.system.find((one) => /checkout|checked out/i.test(one));
      t.diagnostic(`${kind}: ${line}`);
      assert.ok(line, `the run is told about its checkout: ${spec.session.system.join(" | ")}`);
      assert.match(line, /^No checkout was made/, kind);
      assert.match(line, NO_EXEC, kind);
      assert.match(line, /a computer that mounts the run's folder/, kind);
      assert.doesNotMatch(line, /Exec is not enabled|could not run/, "never a failed fetch's words");
      assert.deepEqual(execsOf(disk), [], "the disk's exec was never asked");
      const told = run.said.find((words) => NO_EXEC.test(words));
      assert.ok(told, `the timeline says why: ${JSON.stringify(run.said)}`);
      assert.match(told, /sandbox computer/);
    }
  });

  test(`${name}, Mode 2 on ${GCP}, a computer that mounts the run's folder but that this claim did not start (a sandbox an earlier claim kept at its park and this one took back, the agent's own computer, a paired computer): no checkout is made in it, and the run and its timeline are told why (it may already have run the agent's code, so the server hands it no GitHub token)`, { timeout: 120_000 }, async (t) => {
    const gh = join(await scratch(t), "gh");
    const named = pullRepo(gh, "acme/widgets");
    // What computerForClaim answers for each (workspace-computer-kept, workspace-agent-computer and
    // workspace-computer-for-claim pin it): the same mounted computer, but not one this claim started (no `fresh`).
    const REUSED = {
      "a kept sandbox taken back": (computer) => ({ ...computer, fresh: undefined }),
      "the agent's own computer": (computer) => ({ ...computer, fresh: undefined, made: undefined, keeps: undefined, outlives: true }),
      "a paired computer": (computer) => ({ ...computer, fresh: undefined, made: undefined, keeps: undefined, outlives: true }),
    };
    for (const [which, reused] of Object.entries(REUSED)) {
      for (const kind of Object.keys(KINDS)) {
        const { launch } = KINDS[kind](named);
        const disk = new FakeArchilDisk();
        disk.noExec = true;
        const run = await mode2Run(t, { harness, disk, region: GCP, processes: true, body: { checkout: kind }, launch, deps: { githubWeb: `file://${gh}` } });
        const claimed = run.deps.computerForClaim;
        run.deps.computerForClaim = async (...args) => reused(await claimed(...args));
        const { spec } = await run.claimNext(build);
        const line = spec.session.system.find((one) => /checkout|checked out/i.test(one));
        t.diagnostic(`${which}, ${kind}: ${line}`);
        assert.equal(run.mounts.length, 1, `${which}: the computer mounts the run's folder`);
        assert.deepEqual(checkoutStarts(run.computer), [], `${which}, ${kind}: nothing of the checkout ran in the computer`);
        assert.ok(!(await readdir(run.scratch)).includes(CHECKOUT_DIR), `${which}, ${kind}: no repo/ folder`);
        assert.deepEqual(execsOf(disk), [], "the disk's exec was never asked");
        assert.ok(line, `the run is told about its checkout: ${spec.session.system.join(" | ")}`);
        assert.match(line, /^No checkout was made: /, `${which}, ${kind}`);
        assert.match(line, NOT_ITS_REPO, `${which}, ${kind}`);
        assert.match(line, NO_EXEC, `${which}, ${kind}`);
        assert.match(line, REUSED_WORDS, `${which}, ${kind}`);
        const told = run.said.find((words) => /^No checkout in repo\//.test(words));
        assert.ok(told, `the timeline says why: ${JSON.stringify(run.said)}`);
        assert.match(told, REUSED_WORDS);
        assert.doesNotMatch(told, /Give the agent a sandbox computer/, "the run has one: the fix is not a sandbox");
        await spec.release();
      }
    }
  });

  test(`${name}, Mode 2 on ${AWS} (a region with exec), a sandbox that mounts the run's folder: unchanged, the checkout is one exec on the disk, before the computer's mount, and nothing of it runs in the computer`, { timeout: 120_000 }, async (t) => {
    const gh = join(await scratch(t), "gh");
    const { at, launch, note } = KINDS.pull_request(pullRepo(gh, "acme/widgets"));
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, region: AWS, processes: true, body: { checkout: "pull_request" }, launch, deps: { githubWeb: `file://${gh}` } });
    const { spec } = await run.claimNext(build);
    const fetches = disk.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.op === "exec" && CHECKOUT_SCRIPT.test(call.command));
    assert.equal(fetches.length, 1, JSON.stringify(execsOf(disk).map((call) => call.command.slice(0, 80))));
    assert.ok(fetches[0].index < run.mounts[0].at, "before the computer's mount took the disk's write delegation");
    assert.deepEqual(checkoutStarts(run.computer), [], "nothing of the checkout ran in the computer");
    assert.equal(disk.files.get(`${KEY}/${CHECKOUT_DIR}/README.md`)?.toString("utf8"), "the head's readme 1\n", "the checkout is in the run's folder on the disk");
    const line = spec.session.system.find((one) => / checked out in repo\//.test(one)) ?? spec.session.system.join("\n");
    assert.match(line, note);
    assert.ok(line.includes(`detached at its head ${at}`), line);
  });
}

test("checkoutWhereNoExec, a computer that mounts the run's folder but that the claim did not start: the server's GitHub App is never opened (no token minted), nothing runs in the computer, and the run and its timeline are told why; one the claim started gets its checkout", { timeout: 60_000 }, async (t) => {
  const asked = [];
  // The store the App is read from (github-app.ts appOf): none here, so a checkout that went on would fetch anonymously.
  // The claim's run is in no workspace.
  const deps = { store: { triggerSettings: { get: async (adapter) => (asked.push(adapter), []) }, runs: { workspace: async () => null } }, sealKey: Buffer.alloc(32, 1) };
  const ran = [];
  const workspace = { exec: async (argv) => (ran.push(argv), { code: 0, signal: null, stdout: new Uint8Array(), stderr: "", timedOut: false, truncated: false }) };
  const named = pullRepo(join(await scratch(t), "gh"), "acme/widgets");
  for (const kind of Object.keys(KINDS)) {
    const { launch } = KINDS[kind](named);
    const said = [];
    const held = [];
    const made = await checkoutWhereNoExec(deps, "run-1", { workspace, fresh: false }, GCP, launch, { hold: () => {} }, undefined, (part) => held.push(part), kind, (words) => void said.push(words));
    assert.deepEqual(asked, [], `${kind}: the App was never opened, so no token was minted`);
    assert.deepEqual(ran, [], `${kind}: nothing ran in the computer`);
    assert.deepEqual(held, [], `${kind}: no removal to hold`);
    assert.match(made.note, /^No checkout was made: /);
    assert.match(made.note, NOT_ITS_REPO);
    assert.match(made.note, REUSED_WORDS);
    assert.match(made.note, kind === "pull_request" ? /Read the change through the GitHub tools/ : /Read it through the GitHub tools/);
    assert.equal(said.length, 1);
    assert.match(said[0], REUSED_WORDS);
    await made.end();
  }
  const fresh = await checkoutWhereNoExec(deps, "run-1", { workspace, fresh: true }, GCP, KINDS.pull_request(named).launch, { hold: () => {} }, undefined, () => {}, "pull_request");
  assert.deepEqual(asked, ["github"], "one the claim started: the App is opened for its fetch");
  assert.equal(ran.length, 1, `its fetch ran in the computer: ${fresh.note}`);
});

test("checkoutWhereNoExec, a computer the claim did not start: whatever its mount holds, the run gets the one note, that a repo/ folder there, if there is one, is not this claim's checkout and may be stale; the computer is never asked to look, and nothing runs in it", { timeout: 60_000 }, async (t) => {
  const deps = { store: { triggerSettings: { get: async () => [] } }, sealKey: Buffer.alloc(32, 1) };
  const named = pullRepo(join(await scratch(t), "gh"), "acme/widgets");
  const ran = [];
  const looked = [];
  const computer = (stat) => ({ exec: async (argv) => (ran.push(argv), { code: 0, signal: null, stdout: new Uint8Array(), stderr: "", timedOut: false, truncated: false }), stat: async (path) => (looked.push(path), stat(path)) });
  for (const kind of Object.keys(KINDS)) {
    const { launch } = KINDS[kind](named);
    const notes = [];
    for (const [what, stat] of [
      ["a repo/ there", (path) => (path === CHECKOUT_DIR ? { kind: "dir", size: 0, mtimeMs: 0 } : undefined)],
      ["none there", () => undefined],
      ["a look that would never answer", () => new Promise(() => {})],
    ]) {
      const made = await checkoutWhereNoExec(deps, "run-1", { workspace: computer(stat), fresh: false }, GCP, launch, { hold: () => {} }, undefined, () => {}, kind, () => {});
      assert.match(made.note, /^No checkout was made: /, `${kind}, ${what}: ${made.note}`);
      assert.match(made.note, NOT_ITS_REPO, `${kind}, ${what}: ${made.note}`);
      assert.doesNotMatch(made.note, /there is no repo\/ folder/, `${kind}, ${what}`);
      assert.match(made.note, REUSED_WORDS);
      notes.push(made.note);
      await made.end();
    }
    assert.equal(new Set(notes).size, 1, `${kind}: one note, whatever the mount holds`);
  }
  assert.deepEqual(looked, [], "the computer is never asked to look");
  assert.deepEqual(ran, [], "nothing ran in the computer");
});

test("a checkout through a computer's exec (an attached Workspace) carries the App's token on the process's stdin alone: never in its argv or the environment it starts with, never in any other call the computer is sent; the checkout lands, the token is revoked, and the run's folder keeps none", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const { head, base, mergeBase } = pullRepo(gh, "acme/private");
  const token = `ghs_${"C".repeat(36)}`;
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const header = `Authorization: ${authorization}`;
  const server = await gitHttp(t, gh, { authorization });
  const root = join(dir, "run");
  await mkdir(root);
  const computer = realProcesses(fakeComputer(root), root);
  const workspace = await localWorkspace(root).attach(computer, { readBackOf });
  computer.clear();
  const revoked = [];
  const held = [];
  const mint = async () => ({ ok: true, token, expires_at: Date.now() + 3600_000 });
  const made = await prCheckout({ workspace, fromGitHub: true, input: firing("acme/private", { head, base }), mint, revoke: async (gone) => void revoked.push(gone), hold: (secrets) => held.push(...secrets), web: server.url });
  const repo = join(root, CHECKOUT_DIR);
  assert.ok((await readdir(root)).includes(CHECKOUT_DIR), made.note);
  assert.equal(git(repo, "rev-parse", "HEAD"), head, made.note);
  assert.equal(git(repo, "rev-parse", "pr/merge-base"), mergeBase);
  assert.ok(server.seen.length > 0 && server.seen.every((request) => request.authorization === authorization), "every request carried the token's header");
  assert.deepEqual(revoked, [token]);
  assert.ok(held.includes(token), "the token joined the run's redactor before it was used");
  const secrets = [token, authorization, authorization.slice("Basic ".length)];
  const writes = computer.calls.filter(([method]) => method === "process.write");
  assert.equal(writes.map(([, params]) => Buffer.from(params.data ?? "", "base64").toString("utf8")).join(""), `${header}\n`, "the header went on stdin");
  assert.ok(writes.at(-1)[1].close, "and stdin was closed after it");
  for (const [method, params] of computer.calls.filter(([method]) => method !== "process.write")) {
    const text = JSON.stringify(params ?? {});
    for (const secret of secrets) assert.ok(!text.includes(secret), `${method} carries no token: ${text.slice(0, 200)}`);
  }
  const config = await readFile(join(repo, ".git", "config"), "utf8");
  assert.ok(!/extraheader|x-access-token|credential/i.test(config), config);
  await made.end();
  assert.deepEqual(await readdir(root), [], "the end removed the checkout, through the computer");
});
