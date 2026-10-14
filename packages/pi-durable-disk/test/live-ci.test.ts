// The daily live job (.github/workflows/pi-durable-disk-live.yml) and its steps (test/live/ci.ts), with no disk: it refuses
// to start without the scratch disk's secrets, runs each suite under a deadline and names one that was cut, sweeps only
// the run directories and token users this run's ledgers left open, and summarizes nothing but timings. The workflow runs
// on a schedule or by hand, never for a pull request or in a fork, one run at a time.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openResources, preflight, runSuites, summarize, sweepWith, timings, type SweepDisk } from "./live/ci.ts";
import { scratchRoot } from "./_run-support.ts";

const CI = fileURLToPath(new URL("./live/ci.ts", import.meta.url));
const WORKFLOW = readFileSync(new URL("../../../.github/workflows/pi-durable-disk-live.yml", import.meta.url), "utf8");
const KEY = "archil-key-not-a-real-one-1234";

/** `node test/live/ci.ts <args>` with only `env` (and PATH) in its environment. */
function ci(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [CI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH!, ...env } });
}

describe("preflight", () => {
  it("refuses to start without the secrets, names each missing one, and says why it matters", () => {
    const r = ci(["preflight"], {});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^not ok: the live job cannot start: /);
    assert.match(r.stderr, /the repository secret ARCHIL_API_KEY is not set/);
    assert.match(r.stderr, /the repository secret ARCHIL_SCRATCH_DISK is not set/);
    assert.match(r.stderr, /PDA_STATE_DIR is not set/);
    assert.match(r.stderr, /every live suite skips, and the job would pass having checked nothing/);
  });

  it("refuses a disk that is not a disk id, without repeating the value", () => {
    const r = ci(["preflight"], { ARCHIL_API_KEY: KEY, ARCHIL_SCRATCH_DISK: "my-prod-disk", PDA_STATE_DIR: "/tmp/x" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ARCHIL_SCRATCH_DISK is not a disk id \(dsk-\.\.\.\)/);
    assert.doesNotMatch(r.stderr + r.stdout, /my-prod-disk/);
  });

  it("passes with the key and the disk, defaults the region, and never prints the key", () => {
    const r = ci(["preflight"], { ARCHIL_API_KEY: KEY, ARCHIL_SCRATCH_DISK: "dsk-0123abcd", PDA_STATE_DIR: "/tmp/x" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ok: the scratch disk's secrets are set (region aws-us-east-1)\n");
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY));
    assert.deepEqual(preflight({ ARCHIL_API_KEY: KEY, ARCHIL_SCRATCH_DISK: "dsk-1", ARCHIL_SCRATCH_REGION: "aws us east", PDA_STATE_DIR: "/x" }), ["ARCHIL_SCRATCH_REGION is not a region name (such as aws-us-east-1)"]);
  });

  it("the suites verb also refuses without the secrets, before running anything", () => {
    const r = ci(["suites", "claim"], {});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^not ok: the repository secret ARCHIL_API_KEY is not set/);
    assert.equal(ci(["suites", "claim", "everything"], {}).status, 2, "an unknown suite is a usage error");
  });
});

describe("runSuites", () => {
  it("runs each suite whatever the last one did, kills one at its deadline with its group, and logs each start and end", async () => {
    const dir = scratchRoot("live-ci-suites");
    try {
      const scripts: Record<string, string> = {
        claim: "process.exit(0)",
        env: "process.exit(3)",
        // the stuck suite's own child, in its group: the deadline kills both
        run: `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(process.env.PIDFILE, String(c.pid)); setInterval(() => {}, 1000)`,
        store: "process.exit(0)",
      };
      const results = await runSuites(Object.keys(scripts), {
        env: { PATH: process.env.PATH, PIDFILE: join(dir.root, "stuck-child.pid") },
        stateDir: dir.root,
        deadlineMs: 1500,
        command: (suite) => [process.execPath, ["-e", scripts[suite]!]],
      });
      assert.deepEqual(results.map((r) => [r.suite, r.result]), [["claim", "pass"], ["env", "fail"], ["run", "deadline"], ["store", "pass"]]);
      const stuckChild = Number(readFileSync(join(dir.root, "stuck-child.pid"), "utf8"));
      const gone = () => { try { process.kill(stuckChild, 0); return false; } catch { return true; } };
      for (let i = 0; i < 200 && !gone(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(gone(), "the stuck suite's own child went with its group");
      const log = readFileSync(join(dir.root, "suites.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { suite: string; event: string });
      assert.deepEqual(log.map((e) => `${e.event} ${e.suite}`), ["start claim", "end claim", "start env", "end env", "start run", "end run", "start store", "end store"]);
    } finally {
      dir.remove();
    }
  });
});

describe("openResources", () => {
  it("finds every run directory and token user a ledger left open, in each suite's ledger shape", () => {
    const ledgers = [
      // claim and run (P1, P4): deletedAt and removedAt
      { lane: "P1", tokenUsers: [{ identifier: "t1", removedAt: "x" }, { identifier: "t2" }], subdirectories: [{ key: "runs/p1-a/", deletedAt: "x" }, { key: "runs/p1-b/" }] },
      // store (P2): the marker goes last
      { lane: "P2", tokenUsers: [{ identifier: "t3" }], runDirectories: [{ key: "runs/p2-a/", dataRemovedAt: "x" }, { key: "runs/p2-b/", dataRemovedAt: "x", markerRemovedAt: "y" }] },
      // env (P3): a path with no trailing slash
      { lane: "P3", tokenUsers: [], subpaths: [{ path: "runs/p3-a" }] },
      // supervise and lifecycle (P5, P8): closedAt
      { lane: "P5", tokenUsers: [{ identifier: "t4", closedAt: "x" }], subdirectories: [{ key: "runs/p5-a/", closedAt: "x" }, { key: "runs/p5-b/" }] },
      // docker: nested under archil
      { archil: { tokens: [{ identifier: "t5" }], subdirs: [{ key: "runs/live-a/" }, { key: "runs/live-b/", deletedAt: "x" }] }, containers: [{ name: "pda-live-1" }] },
    ];
    assert.deepEqual(openResources(ledgers), {
      directories: ["runs/live-a/", "runs/p1-b/", "runs/p2-a/", "runs/p3-a/", "runs/p5-b/"],
      tokens: ["t2", "t3", "t5"],
      refused: [],
    });
  });

  it("never sweeps anything but a plain runs/<name>/: the rest is reported", () => {
    const ledger = { subdirectories: [{ key: "runs/../important/" }, { key: ".stray/p1-x/" }, { key: "runs/a/b/" }, { key: "runs/" }, { key: "runs/ok/" }] };
    assert.deepEqual(openResources([ledger]), { directories: ["runs/ok/"], tokens: [], refused: [".stray/p1-x/", "runs/", "runs/../important/", "runs/a/b/"] });
  });
});

describe("sweepWith", () => {
  /** A disk's objects, where a directory marker with children refuses deletion, and `held` keys refuse it too. */
  function fakeDisk(keys: string[], held: string[] = []): SweepDisk & { keys: Set<string>; removed: string[] } {
    const all = new Set(keys);
    const removed: string[] = [];
    return {
      keys: all,
      removed,
      listObjects: async (prefix) => ({ objects: [...all].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
      deleteObjects: async (batch) => {
        for (const key of batch) if (!held.includes(key) && ![...all].some((k) => k !== key && k.startsWith(key))) all.delete(key);
        return { errors: [] };
      },
      removeUser: async (_type, identifier) => {
        if (identifier === "gone") throw new Error("no such user");
        removed.push(identifier);
      },
    };
  }

  it("deletes a run directory's files, then its markers deepest first, and removes each token user", async () => {
    const disk = fakeDisk(["runs/a/", "runs/a/x", "runs/a/sub/", "runs/a/sub/deeper/", "runs/a/sub/deeper/y", "runs/other/z"]);
    const report = await sweepWith(disk, { directories: ["runs/a/"], tokens: ["t1"] });
    assert.deepEqual(report, { lines: ["swept runs/a/: 5 objects, 0 left", "token user t1: removed"], left: 0 });
    assert.deepEqual([...disk.keys], ["runs/other/z"], "nothing outside the swept directory");
    assert.deepEqual(disk.removed, ["t1"]);
  });

  it("reports what it could not remove, and counts it", async () => {
    const disk = fakeDisk(["runs/b/", "runs/b/held"], ["runs/b/held"]);
    const report = await sweepWith(disk, { directories: ["runs/b/"], tokens: ["gone"] });
    assert.deepEqual(report, { lines: ["swept runs/b/: 2 objects, 2 left", "token user gone: not removed (no such user)"], left: 2 });
  });
});

describe("the summary", () => {
  const results = {
    at: "2026-10-14T06:00:00Z",
    client: "Archil Client: v0.8.42-1790378297, 842, abc",
    disk: "dsk-secret0001",
    host: "runner-host-1",
    heldRefusalMs: 166.29,
    createRunDirMs: [20, 22, 21, 90],
    barrier: { clean: { n: 20, p50: 55.39, p95: 59.59, max: 60.4, min: 45.6, mean: 54 } },
    t4: { revokeMs: 36.3, executed: [{ writer: "A", pid: 680090, t: 1791390943911 }] },
    cleanup: { tokens: [{ identifier: "6903af98d2f8c6760c6876570cc80477", r: "removed" }], items: 3 },
  };

  it("keeps only timings: no disk, host, identifier, pid or timestamp", () => {
    assert.deepEqual(timings(results), [
      ["heldRefusalMs", "166.3 ms"],
      ["createRunDirMs", "median 21, max 90 ms (n 4)"],
      ["barrier.clean", "p50 55.4, p95 59.6, max 60.4 ms (n 20)"],
      ["t4.revokeMs", "36.3 ms"],
    ]);
    const md = summarize([{ suite: "claim", result: "pass", seconds: 312 }], [{ name: "P1-live-results.json", data: results }]);
    for (const leak of ["dsk-secret0001", "runner-host-1", "6903af98", "680090", "1791390943911"]) assert.ok(!md.includes(leak), leak);
    assert.match(md, /^\| claim \| pass \| 312 s \|$/m);
    assert.match(md, /^Archil Client: v0\.8\.42-1790378297$/m);
    assert.match(md, /^### claim \(P1-live-results\.json\)$/m);
    assert.match(md, /^\| barrier\.clean \| p50 55\.4, p95 59\.6, max 60\.4 ms \(n 20\) \|$/m);
  });

  it("from the state directory: a suite that started and never ended is reported cut at its deadline", () => {
    const dir = scratchRoot("live-ci-summary");
    try {
      mkdirSync(dir.root, { recursive: true });
      const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
      writeFileSync(join(dir.root, "suites.jsonl"), [
        { at: at(900), suite: "claim", event: "start" },
        { at: at(600), suite: "claim", event: "end", result: "pass", seconds: 300 },
        { at: at(600), suite: "env", event: "start" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n");
      writeFileSync(join(dir.root, "P1-live-results.json"), JSON.stringify(results));
      writeFileSync(join(dir.root, "P1-STATE.json"), JSON.stringify({ disk: "dsk-secret0001" }));
      const r = ci(["summary"], { PDA_STATE_DIR: dir.root });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^\| claim \| pass \| 300 s \|$/m);
      assert.match(r.stdout, /^\| env \| deadline \| 6\d\d s \|$/m);
      assert.ok(!r.stdout.includes("dsk-secret0001"));
      assert.equal(ci(["summary"], { PDA_STATE_DIR: join(dir.root, "none") }).stdout, "## pi-durable-disk live\n\nNo suite ran.\n");
    } finally {
      dir.remove();
    }
  });

  it("sweep with no state directory has nothing to do and touches no disk", () => {
    const r = ci(["sweep"], { PDA_STATE_DIR: "/nonexistent/pda-live-state" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "nothing to sweep: no suite ran\n");
  });
});

describe("the workflow", () => {
  const jobs = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"));
  const job = (name: string) => {
    const start = jobs.indexOf(`\n  ${name}:\n`);
    const next = jobs.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return jobs.slice(start, next < 0 ? undefined : start + 1 + next);
  };

  it("runs on a schedule or by hand: never for a pull request or a push", () => {
    const on = WORKFLOW.slice(WORKFLOW.indexOf("\non:\n"), WORKFLOW.indexOf("\npermissions:"));
    assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ["schedule", "workflow_dispatch"]);
    assert.doesNotMatch(WORKFLOW, /pull_request|push:/);
  });

  it("one run at a time, a waiting run never cancelled, and read-only", () => {
    assert.match(WORKFLOW, /\nconcurrency:\n {2}group: pi-durable-disk-live\n {2}cancel-in-progress: false\n/);
    assert.match(WORKFLOW, /\npermissions:\n {2}contents: read\n/);
  });

  for (const name of ["host", "docker"]) {
    it(`${name}: never in a fork; the preflight before any install; the sweep and summary always; the suites' deadline inside the job's`, () => {
      const text = job(name);
      assert.match(text, /\n {4}if: (always\(\) && )?github\.repository == 'Parcha-ai\/agentrun'\n/);
      const steps = text.split("\n      - ").slice(1);
      const at = (pattern: RegExp) => steps.findIndex((s) => pattern.test(s));
      assert.ok(at(/run: node test\/live\/ci\.ts preflight/) >= 0 && at(/run: node test\/live\/ci\.ts preflight/) < at(/npm ci/), "preflight runs before the install");
      for (const verb of ["sweep", "summary"]) assert.match(steps[at(new RegExp(`ci\\.ts ${verb}`))]!, /\n {8}if: always\(\)\n/, `${verb} always runs`);
      const jobMinutes = Number(/\n {4}timeout-minutes: (\d+)/.exec(text)![1]);
      const suites = steps[at(/ci\.ts suites /)]!;
      assert.ok(Number(/timeout-minutes: (\d+)/.exec(suites)![1]) + 15 <= jobMinutes, "the suites step ends with room for the sweep and summary");
      // The secrets reach the job as these three variables and nowhere else.
      assert.deepEqual([...text.matchAll(/\$\{\{ secrets\.(\w+) \}\}/g)].map((m) => m[1]), ["ARCHIL_API_KEY", "ARCHIL_SCRATCH_DISK", "ARCHIL_SCRATCH_REGION"]);
    });
  }

  it("host runs the six host suites; docker runs after it, so the two never share the disk", () => {
    assert.match(job("host"), /run: node test\/live\/ci\.ts suites claim env run store supervise lifecycle\n/);
    assert.match(job("docker"), /\n {4}needs: host\n/);
    assert.match(job("docker"), /run: node test\/live\/ci\.ts suites docker\n/);
  });
});
