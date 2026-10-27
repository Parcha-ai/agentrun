// pi-git-remote's hostile-repository corpus, run through the checker. Each case's whole tree becomes one run's change
// (a commit over an empty root) in the repository the case built, with the hooks, attributes and drivers it planted and
// the operator config it names. The checker must refuse every path, and nothing planted may run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cases, envFor, run } from "../../pi-git-remote/test/hostile/corpus.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function cli(cwd, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}

describe("the hostile corpus through the checker", { concurrency: 4 }, () => {
  for (const c of cases) {
    test(`${c.id} [${c.expect}]`, { timeout: 300_000 }, async (t) => {
      const dir = await mkdtemp(path.join(tmpdir(), "agentrun-learn-hostile-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const built = await c.build(dir);
      const env = envFor(built.globalConfig);
      const repo = built.workdir ?? built.bare;
      const at = built.workdir ? { cwd: repo } : { gitDir: repo };
      const git = async (args, input) => (await run(env, args, { ...at, input })).toString().trim();
      const tree = await git(["rev-parse", "main^{tree}"]);
      const empty = await git(["hash-object", "-t", "tree", "-w", "--stdin"], "");
      const base = await git(["commit-tree", empty, "-m", "empty"]);
      const head = await git(["commit-tree", tree, "-p", base, "-m", "the case's tree as a run"]);
      const changed = (await git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", base, head])).split("\0").filter(Boolean);

      const out = await cli(repo, env, ["check", "--base", base, "--head", head, "--branch", "runs/hostile-1", "--json"]);
      assert.equal(out.status, 1, out.stderr);
      const report = JSON.parse(out.stdout);
      assert.equal(report.merge, "refused");
      assert.equal(existsSync(built.marker), false, "nothing planted ran");
      const named = new Set(report.problems.map((p) => p.path));
      if (report.problems.some((p) => p.rule === "too_many_files")) assert.ok(changed.length > 64);
      else for (const p of changed) assert.ok(named.has(p), `${JSON.stringify(p)} is refused (${report.problems.map((q) => q.rule).join(", ")})`);
      t.diagnostic(JSON.stringify({ id: c.id, changed: changed.length, rules: [...new Set(report.problems.map((p) => p.rule))] }));
    });
  }
});

test("positive control: the planted hook fires under plain git, so its absence above means the checker ran none", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentrun-learn-hostile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const built = await cases.find((c) => c.id === "host-hook-post-checkout").build(dir);
  const env = envFor(built.globalConfig);
  const head = (await run(env, ["rev-parse", "HEAD"], { cwd: built.workdir })).toString().trim();
  const out = await cli(built.workdir, env, ["check", "--base", "main", "--head", head, "--branch", "runs/hostile-1", "--json"]);
  assert.ok(out.status === 0 || out.status === 1, out.stderr);
  assert.equal(existsSync(built.marker), false);
  await run(env, ["checkout", "-q", "main"], { cwd: built.workdir });
  assert.equal(existsSync(built.marker), true, "plain git ran the planted post-checkout hook");
});
