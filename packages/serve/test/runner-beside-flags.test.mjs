// The runner beside the server holds what the server's own flags say (runner/beside.ts besideRunnerOptions, cli.ts):
// --max-runs is the most runs it holds at once (the same number the capabilities report), the rest waiting queued; and
// --drain-timeout is how long its close lets a turn in flight finish, its outcome journaled once and never sent again.
// Each loop here holds its one turn until the test lets it end, and a claim the runner could make is seen by its polls
// (onBeat), so nothing waits on time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { maxRunsOf } from "../dist/host.js";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { besideRunnerOptions, besideStopping, DRAIN_TIMEOUT } from "../dist/runner/beside.js";
import { durationMs } from "../dist/print.js";
import { DEADLINE_MARGIN_MS } from "../dist/stop-signals.js";
import { RUNNER_DRAIN_TIMEOUT, runnerArgs, runnerHolds } from "../dist/runner/main.js";
import { RUNNER_LEASE_MS, RUNNER_RENEWALS_SERVED_MS, RUNNER_STOP_MARGIN_MS, runnerCloseBoundMs, startRunner } from "../dist/runner/runner.js";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 20 };
const ROOT = 1;
/** Every callback the event loop holds now has run, so close()'s first steps (it awaits no store call here) are done. */
const settled = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

/** Loops whose one turn is held until `finishTurn()`: then it commits its answer and ends. A stop ends it interrupted. */
function heldTurns() {
  const loops = [];
  let going = 0;
  let most = 0;
  const createLoop = (deps) => {
    let finishTurn;
    const answered = new Promise((resolve) => (finishTurn = resolve));
    let stopNow;
    const stopped = new Promise((resolve) => (stopNow = resolve));
    const loop = {
      deps,
      claim: null,
      stopCalls: [],
      finishTurn: () => finishTurn(),
      async start(claim) {
        loop.claim = claim;
        most = Math.max(most, ++going);
        try {
          const how = await Promise.race([answered.then(() => "answered"), stopped.then(() => "stop")]);
          if (how === "stop") return { state: "interrupted" };
          const journal = deps.journal(claim);
          const id = await journal.mintId();
          journal.stage({ run: { state: "ended" }, effect: id });
          await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: { id, conversationId: ROOT, kind: "message" } }], BACKGROUND_CONTEXT);
          return { state: "ended" };
        } finally {
          going--;
        }
      },
      async command() {
        return { taken: true };
      },
      async stop(reason) {
        loop.stopCalls.push(reason);
        stopNow();
      },
    };
    loops.push(loop);
    return loop;
  };
  return { loops, createLoop, most: () => most };
}

/** A runner over its own store, from the server's flags as the CLI start makes it, with `ids` queued. */
async function besideRunner(t, flags, ids) {
  const { server, runners: [store] } = await stores();
  for (const id of ids) await queue(server, id);
  const record = recorder();
  const turns = heldTurns();
  const events = [];
  let beats = 0;
  const runner = startRunner({ store: observed(store, record), createLoop: turns.createLoop, name: "runner-a", onEvent: (event) => events.push(event), onBeat: () => void beats++, ...besideRunnerOptions(flags, {}), ...TIMING });
  t.after(() => {
    for (const loop of turns.loops) loop.finishTurn();
    return runner.close();
  });
  return { server, runner, turns, events, record, beats: () => beats };
}

test("the server's flags are the beside runner's: --max-runs its loops, as the capabilities count them, and --drain-timeout its drain", () => {
  assert.deepEqual(besideRunnerOptions({ maxRuns: 2, drainTimeout: "6s" }, {}), { loops: 2, loopsTold: true, drainMs: 6_000 });
  assert.deepEqual(besideRunnerOptions({}, { AGENTRUN_MAX_RUNS: "3" }), { loops: 3, loopsTold: true, drainMs: 30_000 }, "AGENTRUN_MAX_RUNS, and the documented 30s drain");
  assert.equal(DRAIN_TIMEOUT, "30s");
  assert.equal(besideRunnerOptions({}, {}).loops, maxRunsOf({}), "with neither, as many as the host holds: the capabilities' own number");
  assert.equal(besideRunnerOptions({}, {}).loopsTold, false, "the host's memory's count is no number given: on uid isolation it is cut to the slots, never refused");
  assert.equal(besideRunnerOptions({ drainTimeout: "0s" }, {}).drainMs, 0);
});

test("a runner process of its own (`agentrun-serve runner`, beside a --no-runner server) holds the same: --loops, else AGENTRUN_MAX_RUNS, else what the host holds; --drain-timeout, else AGENTRUN_DRAIN_TIMEOUT, else the image's 6s", () => {
  assert.deepEqual(runnerArgs(["--data", "/d", "--drain-timeout", "8s"]), { dataDir: "/d", drainMs: 8_000 });
  assert.deepEqual(runnerArgs(["--data", "/d", "--drain-timeout=0s"]), { dataDir: "/d", drainMs: 0 });
  assert.throws(() => runnerArgs(["--data", "/d", "--drain-timeout", "soon"]), /--drain-timeout is a duration such as 6s/);
  assert.deepEqual(runnerHolds({ loops: 4, drainMs: 1_000 }, { AGENTRUN_MAX_RUNS: "2" }), { loops: 4, drainMs: 1_000 }, "its own flags first");
  assert.deepEqual(runnerHolds({}, { AGENTRUN_MAX_RUNS: "2" }), { loops: 2, drainMs: 6_000 }, "else the server's AGENTRUN_MAX_RUNS and the image's drain");
  assert.equal(RUNNER_DRAIN_TIMEOUT, "6s");
  assert.equal(runnerHolds({}, {}).loops, maxRunsOf({}), "with neither, as many as the host holds, as the server counts them");
  assert.throws(() => runnerHolds({}, { AGENTRUN_MAX_RUNS: "lots" }), /max runs is a positive integer/);
  assert.equal(runnerHolds({}, { AGENTRUN_DRAIN_TIMEOUT: "2s" }).drainMs, 2_000, "else AGENTRUN_DRAIN_TIMEOUT");
  assert.equal(runnerHolds({ drainMs: 0 }, { AGENTRUN_DRAIN_TIMEOUT: "2s" }).drainMs, 0, "--drain-timeout over the environment");
  assert.throws(() => runnerHolds({}, { AGENTRUN_DRAIN_TIMEOUT: "soon" }), /AGENTRUN_DRAIN_TIMEOUT is a duration such as 6s/);
  for (const bad of ["0", "-3", "2.5", "many"]) assert.throws(() => runnerHolds({}, { AGENTRUN_FREE_MODEL_REQUESTS: bad }), /AGENTRUN_FREE_MODEL_REQUESTS is a whole number of requests above 0/, bad);
  assert.doesNotThrow(() => runnerHolds({}, { AGENTRUN_FREE_MODEL_REQUESTS: "200" }));
});

test("the CLI's stop deadline covers the runner's whole close: its drain, then the stop of the loops left, from the runner's own lease and margin", () => {
  const stopWindow = RUNNER_LEASE_MS - RUNNER_STOP_MARGIN_MS;
  assert.equal(stopWindow, 25_000, "a loop that does not stop is given up 25 s after the drain");
  assert.equal(runnerCloseBoundMs(6_000), 6_000 + stopWindow);
  assert.deepEqual(besideStopping({ runs: 0, boundMs: 0 }, 1, 6_000), { runs: 1, boundMs: 31_000 }, "the image's 6 s drain: 31 s, then the stop's margin");
  assert.deepEqual(besideStopping({ runs: 2, boundMs: 90_000 }, 3, 30_000), { runs: 5, boundMs: 90_000 }, "a longer server bound stands");
  assert.equal(besideStopping({ runs: 0, boundMs: 0 }, 0, 0).boundMs, RUNNER_RENEWALS_SERVED_MS + stopWindow, "with no drain, a ChatGPT renewal told RUNNER_RENEWALS_SERVED_MS in and its whole window, past the loops' stop");
  assert.ok(DEADLINE_MARGIN_MS > 0);
});

test("a runner of its own stops inside the stop grace of compose, the Helm chart and the Coolify and Dokploy templates: its default drain and the loops' stop after it", async () => {
  const compose = await readFile(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8");
  const runner = /x-runner: &runner\n(?:  .*\n)*?  stop_grace_period: (\d+)s/.exec(compose);
  assert.ok(runner, "compose's runners name their stop_grace_period");
  const values = await readFile(new URL("../../../deploy/helm/agentrun/values.yaml", import.meta.url), "utf8");
  const pod = /^terminationGracePeriodSeconds: (\d+)$/m.exec(values);
  assert.ok(pod, "the chart names its pod's terminationGracePeriodSeconds");
  const bound = runnerCloseBoundMs(durationMs(RUNNER_DRAIN_TIMEOUT));
  assert.equal(bound, 31_000, "6 + 25 = 31 s");
  assert.ok(bound < Number(runner[1]) * 1_000, `the runner's close (${bound} ms) is inside compose's ${runner[1]} s`);
  assert.ok(bound < Number(pod[1]) * 1_000, `the runner's close (${bound} ms) is inside the chart's ${pod[1]} s`);
  for (const path of ["deploy/coolify/agentrun.yaml", "deploy/dokploy/agentrun/docker-compose.yml"]) {
    const grace = /^(\d+)s$/.exec(parseYaml(await readFile(new URL(`../../../${path}`, import.meta.url), "utf8")).services.agentrun.stop_grace_period);
    assert.ok(grace && bound < Number(grace[1]) * 1_000, `the runner's close (${bound} ms) is inside ${path}'s stop_grace_period`);
  }
});

/** A tracked file of the repo, by its path from the root. */
const repoFile = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
/** The compose file `install.sh --vps` writes (/opt/agentrun/compose.yaml): its heredoc. */
const installerCompose = async () => {
  const script = await repoFile("packages/agentrun/install.sh");
  const body = /cat > "\$work\/compose\.yaml" << 'EOF'\n([\s\S]*?)\nEOF\n/.exec(script);
  assert.ok(body, "install.sh writes its compose file from a heredoc");
  return body[1];
};
/** What Render waits after SIGTERM (render.com/docs/deploys#zero-downtime-deploys): 30 s, fixed for a service with a
 *  persistent disk, which takes no maxShutdownDelaySeconds. */
const RENDER_GRACE_S = 30;

test("every shipped deploy gives each AgentRun process at least a signed-in server's stop bound (the ChatGPT sign-in's close and a renewal's drain) before it kills: the quickstart, the --no-runner server, its runners, the --vps installer's compose, the chart and the templates", async () => {
  const { PLAN_STOP_BOUND_MS } = await import("../dist/server.js");
  assert.equal(PLAN_STOP_BOUND_MS, 27_000, "2 s close + 15 s refresh + 10 s store write");
  const composes = [["compose.yaml", await repoFile("compose.yaml")], ["deploy/compose.yaml", await repoFile("deploy/compose.yaml")], ["deploy/coolify/agentrun.yaml", await repoFile("deploy/coolify/agentrun.yaml")], ["deploy/dokploy/agentrun/docker-compose.yml", await repoFile("deploy/dokploy/agentrun/docker-compose.yml")], ["install.sh --vps (/opt/agentrun/compose.yaml)", await installerCompose()]];
  for (const [path, text] of composes) {
    const { services } = parseYaml(text, { merge: true });
    // AgentRun's own processes: its image or a build of it, never a service it runs beside (the "pg" profile's Postgres).
    const ours = Object.entries(services).filter(([, service]) => service.build !== undefined || /agentrun/i.test(String(service.image ?? "")));
    assert.ok(ours.length > 0, `${path} runs AgentRun`);
    for (const [name, service] of ours) {
      const grace = /^(\d+)s$/.exec(String(service.stop_grace_period ?? ""));
      assert.ok(grace && Number(grace[1]) * 1_000 >= PLAN_STOP_BOUND_MS, `${path}'s ${name}: stop_grace_period ${service.stop_grace_period ?? "(Docker's 10 s)"} is under ${PLAN_STOP_BOUND_MS / 1_000} s, so a stop is killed inside a renewal's drain`);
    }
  }
});

test("every stop grace the repo ships, found by a scan of its files and not a list, is at least a signed-in server's stop bound and the bound of a ChatGPT renewal its runner serves, and every deploy target sets one: Compose, the chart, Fly, launchd, Railway, the CLI's stop and the installer's (Render's is the platform's fixed 30 s)", async () => {
  const { PLAN_STOP_BOUND_MS } = await import("../dist/server.js");
  const { RUNNER_RENEWAL_BOUND_MS } = await import("../dist/runner/runner.js");
  // A stop is killed after the grace: by then the server's stop is over, and so is every renewal its runner sent, whatever
  // the drain that target's runner runs (the image's 6 s, the CLI start's 30 s): a runner tells its renewals to stop
  // RUNNER_RENEWALS_SERVED_MS into its close at the latest.
  const bound = Math.max(PLAN_STOP_BOUND_MS, RUNNER_RENEWAL_BOUND_MS);
  assert.equal(bound, 29_000, "a renewal a runner serves outlasts a server's 27 s stop");
  const { renderValue } = await import(new URL("../../../deploy/railway/template.mjs", import.meta.url));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // Each way a shipped file sets how long a stop may take before the kill, and its value in seconds.
  const seconds = (given) => {
    const m = /^"?(\d+)(s|m)?"?$/.exec(given.trim());
    return m ? Number(m[1]) * (m[2] === "m" ? 60 : 1) : NaN;
  };
  const settings = [
    ["stop_grace_period", /stop_grace_period:\s*(\S+)/g, seconds],
    ["terminationGracePeriodSeconds", /terminationGracePeriodSeconds:\s*(\S+)/g, (v) => (v.startsWith("{{") ? undefined : seconds(v))],
    ["kill_timeout", /kill_timeout\s*=\s*(\S+)/g, seconds],
    ["ExitTimeOut", /<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/g, seconds],
    ["TimeoutStopSec", /TimeoutStopSec=(\S+)/g, seconds],
    ["maxShutdownDelaySeconds", /maxShutdownDelaySeconds:\s*(\S+)/g, seconds],
    ["RAILWAY_DEPLOYMENT_DRAINING_SECONDS", /"RAILWAY_DEPLOYMENT_DRAINING_SECONDS"\s*:\s*\{\s*"defaultValue"\s*:\s*("(?:[^"\\]|\\.)*")/g, (v) => seconds(renderValue(JSON.parse(v), { domain: "x" }))],
    ["STOP_WAIT_MS", /STOP_WAIT_MS = ([\d_]+);/g, (v) => Number(v.replace(/_/g, "")) / 1_000],
    ["the background stop's wait", /ours "\$server"; \} && \[ "\$waited" -lt (\d+) \]/g, Number],
  ];
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter((path) => path && !/(^|\/)test\//.test(path) && !path.endsWith(".md") && !path.startsWith("changes/"));
  const found = new Map();
  for (const path of files) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    for (const [what, pattern, parse] of settings) {
      for (const m of text.matchAll(pattern)) {
        const s = parse(m[1]);
        if (s === undefined) continue;
        const line = text.slice(0, m.index).split("\n").length;
        found.set(path, [...(found.get(path) ?? []), what]);
        assert.ok(s * 1_000 >= bound, `${path}:${line}: ${what} ${m[1]} is under ${bound / 1_000} s, so a stop is killed inside a renewal's drain`);
      }
    }
  }
  // Each deploy target the repo ships, and what it must set: one without it gets its platform's default (Docker's 10 s,
  // launchd's 20 s, Railway's 0 s).
  for (const [path, what] of [
    ["compose.yaml", "stop_grace_period"],
    ["deploy/compose.yaml", "stop_grace_period"],
    ["deploy/coolify/agentrun.yaml", "stop_grace_period"],
    ["deploy/dokploy/agentrun/docker-compose.yml", "stop_grace_period"],
    ["packages/agentrun/install.sh", "stop_grace_period"],
    ["deploy/helm/agentrun/values.yaml", "terminationGracePeriodSeconds"],
    ["deploy/fly/fly.toml", "kill_timeout"],
    ["packages/agentrun/lib/service.mjs", "ExitTimeOut"],
    ["deploy/railway/template.json", "RAILWAY_DEPLOYMENT_DRAINING_SECONDS"],
    ["packages/agentrun/lib/service.mjs", "STOP_WAIT_MS"],
    ["packages/agentrun/install.sh", "the background stop's wait"],
  ]) assert.ok(found.get(path)?.includes(what), `${path} sets no ${what}`);
  // Render: no setting of its own (it takes no maxShutdownDelaySeconds with a persistent disk); its fixed wait holds.
  assert.equal(found.get("render.yaml"), undefined, "render.yaml sets no grace Render would refuse");
  assert.ok(RENDER_GRACE_S * 1_000 >= bound, `Render's ${RENDER_GRACE_S} s is under ${bound / 1_000} s`);
});

test("--max-runs 2 with 4 runs queued: the runner holds 2 at once, the other 2 wait queued, then run as places free", async (t) => {
  const { server, runner, turns, events, beats } = await besideRunner(t, { maxRuns: 2 }, ["run-1", "run-2", "run-3", "run-4"]);
  await until(() => turns.loops.filter((loop) => loop.claim).length === 2, "two runs claimed");
  // Polls go on while the runner is full: had it a place, the next of them would claim a waiting run.
  const seen = beats();
  await until(() => beats() >= seen + 3, "three more polls");
  assert.equal(turns.loops.length, 2, "no third loop while 2 are held");
  assert.equal(runner.held().length, 2);
  const held = new Set(runner.held().map((claim) => claim.runId));
  const waiting = ["run-1", "run-2", "run-3", "run-4"].filter((id) => !held.has(id));
  for (const id of waiting) assert.equal((await server.runs.get(id)).state, "queued", `${id} waits queued`);
  // Each end frees a place, which a waiting run takes.
  for (const loop of [...turns.loops]) loop.finishTurn();
  await until(() => turns.loops.length === 4 && turns.loops.every((loop) => loop.claim), "the waiting two claimed once places freed");
  for (const loop of turns.loops) loop.finishTurn();
  await until(() => events.filter((event) => event.type === "released").length === 4, "all four released");
  assert.equal(turns.most(), 2, "never more than 2 runs going at once");
  for (const id of ["run-1", "run-2", "run-3", "run-4"]) assert.equal((await server.runs.get(id)).state, "ended", `${id} ran to its end`);
});

test("with a drain, a close during a turn in flight lets the turn finish: its outcome journaled once, the run never claimed again", async (t) => {
  const { server, runner, turns, events, record } = await besideRunner(t, { drainTimeout: "60s" }, ["run-1"]);
  const loop = await until(() => turns.loops[0]?.claim && turns.loops[0], "run-1 claimed, its turn in flight");
  await settled();
  const closing = runner.close();
  await settled();
  assert.deepEqual(loop.stopCalls, [], "the close stops no loop while it drains");
  assert.equal(loop.deps.signal.aborted, false, "nor aborts its turn");
  loop.finishTurn();
  await closing;
  assert.deepEqual(loop.stopCalls, [], "the turn ended on its own");
  assert.deepEqual(events.filter((event) => event.type === "released").map((event) => event.end), ["ended"]);
  assert.equal(record.commits.filter((commit) => commit.runId === "run-1").length, 1, "the turn's outcome journaled once");
  assert.equal(record.claims.filter((claim) => claim.runId === "run-1").length, 1, "claimed once: nothing to resume, nothing sent again");
  assert.equal((await server.runs.get("run-1")).state, "ended");
});

test("with --drain-timeout 0s, a close stops the turn in flight at once for a shutdown, its run left to resume", async (t) => {
  const { server, runner, turns, events, record } = await besideRunner(t, { drainTimeout: "0s" }, ["run-1"]);
  const loop = await until(() => turns.loops[0]?.claim && turns.loops[0], "run-1 claimed, its turn in flight");
  await settled();
  await runner.close();
  assert.deepEqual(loop.stopCalls.map((reason) => reason.kind), ["shutdown"], "stopped at once for a shutdown");
  assert.deepEqual(events.filter((event) => event.type === "released").map((event) => event.end), ["interrupted"]);
  assert.ok(!record.ops.includes("ended run-1"), "no answer journaled");
  const row = await server.runs.get("run-1");
  assert.deepEqual([row.state, row.runner], ["running", null], "released still running, for the next claim to resume");
});
