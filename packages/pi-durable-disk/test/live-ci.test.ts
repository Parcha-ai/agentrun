// The live disk check (test/live/ci.ts) with no disk: preflight refuses a run without the key or a scratch disk; `all` runs
// every suite, kills one at its deadline, always sweeps (after a failed suite, a failed preflight or an interrupt), and ends
// on one line, `ok: live disk check passed (...)` or `not ok: <step>: <reason>`; the sweep removes only what this run's
// ledgers left open, through the package's own run-tree delete; and the summary carries nothing but timings.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_SUITES, openResources, preflight, runAll, runSuites, SUITES, summarize, summaryOf, sweepWith, timings, type SweepReport } from "./live/ci.ts";
import { alive, scratchRoot } from "./_run-support.ts";

const CI = fileURLToPath(new URL("./live/ci.ts", import.meta.url));
const KEY = "archil-key-not-a-real-one-1234";
const DISK = "dsk-0123abcd";
const SUITE_COUNT = HOST_SUITES.length + 1;

/** `node test/live/ci.ts <args>` with only `env` (and PATH) in its environment. */
function ci(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [CI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH!, ...env }, timeout: 60_000 });
}

const lastLine = (lines: string[]) => lines.at(-1)!;

/** `runAll` with each suite's commands scripted (`node -e <script>`, a pass by default) and a sweep that reports `left`. */
async function all(options: { env?: Record<string, string>; scripts?: Record<string, string>; deadlineMs?: number; left?: [number, number]; sweepThrows?: boolean; abortDuring?: string; slow?: boolean }) {
  const dir = scratchRoot("live-ci-all");
  const lines: string[] = [];
  const ran: string[] = [];
  let swept = 0;
  const stop = new AbortController();
  try {
    const code = await runAll({ ARCHIL_API_KEY: KEY, PDA_LIVE_DISK: DISK, PATH: process.env.PATH, ...options.env, PDA_STATE_DIR: dir.root }, {
      out: (line) => lines.push(line),
      signal: stop.signal,
      slow: options.slow,
      deadlineMs: () => options.deadlineMs ?? 30_000,
      steps: (suite) => {
        ran.push(suite);
        if (suite === options.abortDuring) setTimeout(() => stop.abort("SIGINT"), 300);
        return [[process.execPath, ["-e", options.scripts?.[suite] ?? (suite === options.abortDuring ? "setInterval(() => {}, 1000)" : "process.exit(0)")]]];
      },
      sweep: async (): Promise<SweepReport> => {
        swept++;
        if (options.sweepThrows) throw new Error("the disk did not answer");
        const [directoriesLeft, tokensLeft] = options.left ?? [0, 0];
        return { lines: [`fake sweep: ${directoriesLeft} + ${tokensLeft} left`], directoriesLeft, tokensLeft };
      },
    });
    return { code, lines, ran, swept };
  } finally {
    dir.remove();
  }
}

describe("preflight", () => {
  it("refuses a run without the key or the disk, and names each", () => {
    assert.deepEqual(preflight({}), ["ARCHIL_API_KEY is not set", "PDA_LIVE_DISK is not set"]);
    assert.deepEqual(preflight({ ARCHIL_API_KEY: KEY, PDA_LIVE_DISK: "my-prod-disk" }), ["PDA_LIVE_DISK is not a disk id (dsk-...)"]);
    assert.deepEqual(preflight({ ARCHIL_API_KEY: KEY, PDA_LIVE_DISK: DISK, PDA_LIVE_REGION: "aws us east" }), ["PDA_LIVE_REGION is not a region name (such as aws-us-east-1)"]);
    assert.deepEqual(preflight({ ARCHIL_API_KEY: KEY, PDA_LIVE_DISK: DISK }), []);
  });

  it("as a command: not ok without the key, ok with it, and never prints a value", () => {
    const refused = ci(["preflight"], { PDA_LIVE_DISK: "my-prod-disk" });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "not ok: preflight: ARCHIL_API_KEY is not set; PDA_LIVE_DISK is not a disk id (dsk-...)\n");
    const passed = ci(["preflight"], { ARCHIL_API_KEY: KEY, PDA_LIVE_DISK: DISK });
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout, "ok: the key and a disk id are set (region aws-us-east-1)\n");
    for (const value of [KEY, DISK, "my-prod-disk"]) assert.ok(!(refused.stdout + refused.stderr + passed.stdout + passed.stderr).includes(value), value);
    assert.equal(ci(["suites", "everything"], {}).status, 2, "an unknown suite is a usage error");
    assert.equal(ci(["nonsense"], {}).status, 2);
  });
});

describe("all", () => {
  it("passes when every suite passes and the sweep leaves nothing: the host suites, then docker, then the sweep", async () => {
    const r = await all({});
    assert.equal(r.code, 0);
    assert.deepEqual(r.ran, [...HOST_SUITES, "docker"]);
    assert.ok(!r.ran.includes("supervise-slow"), "the default check never runs the slow tier");
    assert.equal(r.swept, 1);
    assert.equal(lastLine(r.lines), `ok: live disk check passed (${SUITE_COUNT} suites, sweep left 0)`);
    assert.ok(r.lines.some((l) => /^\| claim \| pass \| \d+ s \|$/m.test(l)), "the summary lists each suite");
  });

  it("--slow adds supervise-slow after supervise, and the pass line names the tier", async () => {
    const r = await all({ slow: true });
    assert.equal(r.code, 0);
    assert.deepEqual(r.ran, ["claim", "env", "run", "store", "supervise", "supervise-slow", "lifecycle", "docker"]);
    assert.equal(lastLine(r.lines), `ok: live disk check passed (${SUITE_COUNT + 1} suites incl. slow, sweep left 0)`);
  });

  it("a failed suite: the rest still run, the sweep runs, and the last line names the first failure", async () => {
    const r = await all({ scripts: { store: "process.exit(3)", lifecycle: "process.exit(4)" } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.ran, [...HOST_SUITES, "docker"]);
    assert.equal(r.swept, 1);
    assert.match(lastLine(r.lines), /^not ok: suite store: fail: \S+ -e process\.exit\(3\) exited 3$/);
  });

  it("a stuck suite is killed at its deadline, with its own children, and the run goes on", async () => {
    const dir = scratchRoot("live-ci-stuck");
    try {
      const pidFile = join(dir.root, "child.pid");
      const stuck = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`;
      const r = await all({ scripts: { run: stuck }, deadlineMs: 1500 });
      assert.equal(r.code, 1);
      assert.deepEqual(r.ran, [...HOST_SUITES, "docker"]);
      assert.equal(r.swept, 1);
      assert.equal(lastLine(r.lines), "not ok: suite run: deadline: killed at its deadline of 1.5 s");
      const child = Number(readFileSync(pidFile, "utf8"));
      for (let i = 0; i < 200 && alive(child); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(alive(child), false, "the stuck suite's own child went with its group");
    } finally {
      dir.remove();
    }
  });

  it("without the key: preflight refuses, no suite runs, and the sweep still runs", async () => {
    const r = await all({ env: { ARCHIL_API_KEY: "" } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.ran, []);
    assert.equal(r.swept, 1);
    assert.equal(lastLine(r.lines), "not ok: preflight: ARCHIL_API_KEY is not set");
    assert.ok(r.lines.some((l) => l.includes("No suite ran.")));
  });

  it("an interrupt stops the running suite, runs no other, and still sweeps", async () => {
    const r = await all({ abortDuring: "env" });
    assert.equal(r.code, 1);
    assert.deepEqual(r.ran, ["claim", "env"]);
    assert.equal(r.swept, 1);
    assert.equal(lastLine(r.lines), "not ok: interrupted: stopped by SIGINT during suite env");
  });

  it("a sweep that leaves something, or cannot finish, fails the check", async () => {
    assert.equal(lastLine((await all({ left: [1, 0] })).lines), "not ok: sweep: 1 run directory and 0 token users left");
    assert.equal(lastLine((await all({ left: [2, 1] })).lines), "not ok: sweep: 2 run directories and 1 token user left");
    const thrown = await all({ sweepThrows: true });
    assert.equal(thrown.code, 1);
    assert.ok(thrown.lines.includes("sweep failed: the disk did not answer"));
    assert.equal(lastLine(thrown.lines), "not ok: sweep: it did not finish, so what is left on the disk is unknown");
  });

  it("as a command: without the key the last line is the preflight refusal, and a held lock refuses a second run", async () => {
    const dir = scratchRoot("live-ci-command");
    try {
      const lock = join(dir.root, "pda-live.lock");
      const r = ci(["all"], { PDA_STATE_DIR: join(dir.root, "state"), PDA_LIVE_LOCK: lock });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(lastLine(r.stdout.trimEnd().split("\n")), "not ok: preflight: ARCHIL_API_KEY is not set; PDA_LIVE_DISK is not set");
      // Another run holds the lock: this one refuses before anything else.
      const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore" });
      try {
        for (let i = 0; i < 100 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
        const held = ci(["all"], { PDA_STATE_DIR: join(dir.root, "state"), PDA_LIVE_LOCK: lock });
        assert.equal(held.status, 1);
        assert.equal(held.stdout, `not ok: lock: another live run on this host holds ${lock}\n`);
      } finally {
        holder.kill("SIGKILL");
      }
    } finally {
      dir.remove();
    }
  });
});

describe("the suites and their files", () => {
  it("--list names each tier's suites in order and runs nothing; an unknown flag is a usage error", () => {
    const suitesOf = (out: string) => [...new Set(out.trim().split("\n").map((l) => l.split(":")[0]))];
    const plain = ci(["all", "--list"], {});
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(suitesOf(plain.stdout), [...HOST_SUITES, "docker"]);
    const slow = ci(["all", "--slow", "--list"], {});
    assert.deepEqual(suitesOf(slow.stdout), ["claim", "env", "run", "store", "supervise", "supervise-slow", "lifecycle", "docker"]);
    assert.match(slow.stdout, /^supervise-slow: npm run test:live:supervise-slow$/m);
    assert.equal(ci(["all", "--fast"], {}).status, 2);
  });

  it("every live test file is run by exactly one suite's script, so a test cannot fall out of the check by moving", () => {
    const scripts = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;
    const named = new Map<string, string[]>();
    for (const suite of SUITES) {
      const script = scripts[`test:live:${suite}`];
      assert.ok(script, `a test:live:${suite} script`);
      for (const file of script.match(/test\/live\/[\w-]+\.live\.test\.ts/g) ?? []) named.set(file, [...(named.get(file) ?? []), suite]);
    }
    // Daytona's suite needs a Daytona account and runs on its own; every other live file is in the check.
    const files = readdirSync(new URL("./live/", import.meta.url)).filter((f) => f.endsWith(".live.test.ts") && f !== "daytona.live.test.ts").map((f) => `test/live/${f}`).sort();
    assert.deepEqual([...named.keys()].sort(), files);
    for (const [file, suites] of named) assert.equal(suites.length, 1, `${file} is run by ${suites.join(", ")}`);
    assert.deepEqual(named.get("test/live/supervise-slow.live.test.ts"), ["supervise-slow"]);
  });
});

describe("runSuites", () => {
  it("a suite's commands run in order and stop at the first that fails; every start and end is logged", async () => {
    const dir = scratchRoot("live-ci-suites");
    try {
      const pass = [process.execPath, ["-e", "process.exit(0)"]] as const;
      const results = await runSuites(["claim", "docker"], {
        env: { PATH: process.env.PATH },
        stateDir: dir.root,
        deadlineMs: () => 30_000,
        steps: (suite) => (suite === "docker" ? [pass, [process.execPath, ["-e", "process.exit(5)"]], [process.execPath, ["-e", "throw new Error('never runs')"]]] : [pass]),
      });
      assert.deepEqual(results.map((r) => [r.suite, r.result]), [["claim", "pass"], ["docker", "fail"]]);
      assert.match(results[1]!.detail!, / -e process\.exit\(5\) exited 5$/);
      const log = readFileSync(join(dir.root, "suites.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { suite: string; event: string });
      assert.deepEqual(log.map((e) => `${e.event} ${e.suite}`), ["start claim", "end claim", "start docker", "end docker"]);
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
  it("deletes each run directory by its run id through the run-tree delete (which revokes delegations first), and removes each token user", async () => {
    const deleted: string[] = [];
    const removed: string[] = [];
    const report = await sweepWith({
      deleteRunTree: async (id) => {
        deleted.push(id);
        return { objects: 7, revoked: 1 };
      },
      removeUser: async (identifier) => removed.push(identifier),
    }, { directories: ["runs/p1-a/", "runs/live-b/"], tokens: ["t1"] });
    assert.deepEqual(deleted, ["p1-a", "live-b"]);
    assert.deepEqual(removed, ["t1"]);
    assert.deepEqual(report, { lines: ["swept runs/p1-a/: 7 objects, 1 delegations revoked", "swept runs/live-b/: 7 objects, 1 delegations revoked", "token user t1: removed"], directoriesLeft: 0, tokensLeft: 0 });
  });

  it("counts and reports what it could not remove", async () => {
    const report = await sweepWith({
      deleteRunTree: async () => {
        throw new Error("runs/p1-a/ still holds 2 objects");
      },
      removeUser: async () => {
        throw new Error("no such user");
      },
    }, { directories: ["runs/p1-a/"], tokens: ["gone"] });
    assert.deepEqual(report, { lines: ["not swept runs/p1-a/: runs/p1-a/ still holds 2 objects", "token user gone: not removed (no such user)"], directoriesLeft: 1, tokensLeft: 1 });
  });
});

describe("the summary", () => {
  const results = {
    at: "2026-10-14T06:00:00Z",
    client: "Archil Client: v0.8.42-1790378297, 842, abc",
    disk: "dsk-secret0001",
    host: "some-host-1",
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
    for (const leak of ["dsk-secret0001", "some-host-1", "6903af98", "680090", "1791390943911"]) assert.ok(!md.includes(leak), leak);
    assert.match(md, /^\| claim \| pass \| 312 s \|$/m);
    assert.match(md, /^Archil Client: v0\.8\.42-1790378297$/m);
    assert.match(md, /^### claim \(P1-live-results\.json\)$/m);
  });

  it("reads every results file the suites write, the Docker suites' included, and names a suite that never ended", () => {
    const dir = scratchRoot("live-ci-summary");
    try {
      const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
      writeFileSync(join(dir.root, "suites.jsonl"), [
        { at: at(900), suite: "claim", event: "start" },
        { at: at(600), suite: "claim", event: "end", result: "pass", seconds: 300 },
        { at: at(600), suite: "env", event: "start" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n");
      writeFileSync(join(dir.root, "P1-live-results.json"), JSON.stringify(results));
      writeFileSync(join(dir.root, "docker-T13.json"), JSON.stringify({ takeoverMs: 4200 }));
      writeFileSync(join(dir.root, "docker-park.json"), JSON.stringify({ wakeMs: 181000 }));
      writeFileSync(join(dir.root, "P1-STATE.json"), JSON.stringify({ disk: "dsk-secret0001" }));
      const md = summaryOf(dir.root);
      assert.match(md, /^\| claim \| pass \| 300 s \|$/m);
      assert.match(md, /^\| env \| interrupted: started and never ended \| 6\d\d s \|$/m);
      assert.match(md, /^### docker \(docker-T13\.json\)\n\n\| Measurement \| Value \|\n\|---\|---\|\n\| takeoverMs \| 4200 ms \|$/m);
      assert.match(md, /^### docker \(docker-park\.json\)$/m);
      assert.ok(!md.includes("dsk-secret0001"));
      assert.equal(summaryOf(join(dir.root, "none")), "## Live disk check\n\nNo suite ran.\n");
    } finally {
      dir.remove();
    }
  });
});
