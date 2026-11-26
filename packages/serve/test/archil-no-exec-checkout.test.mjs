// A run's checkout (runner/pr-checkout.ts: `checkout: pull_request` and `checkout: repository`) on a Mode 2 server whose
// Archil region has no serverless exec (gcp-us-central1, where every exec answers "Exec is not enabled"). The checkout
// is the server's own git fetch, one command over the run's folder. Where the region has exec, that command is Archil's
// exec over the disk, before the run's computer exists, as before. Where it has none, the disk runs no command, so the
// checkout waits for the run's computer, and runs in it, through its own exec, once it has mounted the run's folder:
// the same script, the token on its stdin (process.write), never on its argv or in its environment. A run with no
// computer that mounts the folder there gets no checkout, and is told why up front, the timeline naming a sandbox
// computer, instead of a fetch that fails on Archil's "Exec is not enabled". Both spec builders (pi's and the CLI's), over
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
const { prCheckout, CHECKOUT_DIR } = await import("../dist/runner/pr-checkout.js");
const { localWorkspace } = await import("../dist/workspace/local.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");

const GCP = "gcp-us-central1";
const AWS = "aws-us-east-1";
const NO_EXEC = /gcp-us-central1 has no serverless exec/;

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
/** The computer's process.start calls that ran the checkout's git script. */
const checkoutStarts = (computer) => computer.calls.filter(([method, params]) => method === "process.start" && params.argv.some((arg) => /git init -q/.test(arg)));

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

  test(`${name}, Mode 2 on ${AWS} (a region with exec), a sandbox that mounts the run's folder: unchanged, the checkout is one exec on the disk, before the computer's mount, and nothing of it runs in the computer`, { timeout: 120_000 }, async (t) => {
    const gh = join(await scratch(t), "gh");
    const { at, launch, note } = KINDS.pull_request(pullRepo(gh, "acme/widgets"));
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, region: AWS, processes: true, body: { checkout: "pull_request" }, launch, deps: { githubWeb: `file://${gh}` } });
    const { spec } = await run.claimNext(build);
    const fetches = disk.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.op === "exec" && /git init -q/.test(call.command));
    assert.equal(fetches.length, 1, JSON.stringify(execsOf(disk).map((call) => call.command.slice(0, 80))));
    assert.ok(fetches[0].index < run.mounts[0].at, "before the computer's mount took the disk's write delegation");
    assert.deepEqual(checkoutStarts(run.computer), [], "nothing of the checkout ran in the computer");
    assert.equal(disk.files.get(`${KEY}/${CHECKOUT_DIR}/README.md`)?.toString("utf8"), "the head's readme 1\n", "the checkout is in the run's folder on the disk");
    const line = spec.session.system.find((one) => / checked out in repo\//.test(one)) ?? spec.session.system.join("\n");
    assert.match(line, note);
    assert.ok(line.includes(`detached at its head ${at}`), line);
  });
}

test("a checkout through a computer's exec (an attached Workspace) carries the App's token on the process's stdin alone: never in its argv or its environment, never in any other call the computer is sent; the checkout lands, the token is revoked, and the run's folder keeps none", { timeout: 120_000 }, async (t) => {
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
