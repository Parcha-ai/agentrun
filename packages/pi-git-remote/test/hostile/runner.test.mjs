// Every case of the hostile corpus, run through this package: the hooks and drivers a case planted in its own clone go
// into the host repository the package writes to, and the remote is the case's bare repository. Nothing planted may run,
// every refused entry is skipped or refused, and the limit cases are pinned.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { GitRemoteError, local, MAIN, openRepo } from "../../dist/index.js";
import { rawGit, scratch } from "../support.mjs";
import { cases } from "./corpus.mjs";

/** The entries checkout must skip, by case. */
const SKIPPED = {
  "symlink-absolute-outside": ["escape"],
  "symlink-relative-escape": ["up"],
  "submodule-ext-url": ["evil"],
  "submodule-file-url": ["evil"],
  "tree-dotdot": ["../hooks/post-checkout"],
  "tree-dot-git-hooks": [".git/hooks/post-checkout"],
  "tree-dot-GIT-config": [".GIT/config"],
  "tree-dot-git-config": [".git/config"],
  "tree-dot-git-dot-x": [".git./x"],
  "tree-dot-Git-space-x": [".Git /x"],
  "tree-ntfs-short-name": ["GIT~1/hooks/post-checkout"],
  "tree-lookalike-fullwidth": ["\uff0egit/hooks/post-checkout"],
  "tree-lookalike-dotless-i": [".g\u0131t/hooks/post-checkout"],
  "collide-case-fold": [".HUSKY/pre-commit", ".husky/pre-commit"],
  "file-over-50mib": ["hooks/post-checkout"],
  "path-newline": ["notes.md\nhook"],
};
/** Cases whose whole tree checkout refuses. */
const CHECKOUT_REFUSED = new Set(["tree-100k-entries"]);
/** Cases git's own index refuses to build on, so commitTo on main is refused. */
const BUILD_REFUSED = new Set(["tree-dotdot", "tree-dot-git-hooks", "tree-dot-GIT-config", "tree-dot-git-config", "tree-dot-git-dot-x", "tree-dot-Git-space-x", "tree-ntfs-short-name"]);

/** The hooks and the merge or filter drivers a case planted in its clone, moved into the package's host repository. */
async function adoptClone(workdir, hostDir) {
  const hooks = path.join(workdir, ".git", "hooks");
  if (existsSync(hooks)) {
    await mkdir(path.join(hostDir, "hooks"), { recursive: true });
    for (const name of await readdir(hooks)) {
      await copyFile(path.join(hooks, name), path.join(hostDir, "hooks", name));
      await chmod(path.join(hostDir, "hooks", name), 0o755);
    }
  }
  const drivers = await rawGit(["config", "--file", path.join(workdir, ".git", "config"), "--get-regexp", "^(merge|filter)\\."]).catch(() => Buffer.alloc(0));
  for (const line of drivers.toString().split("\n").filter(Boolean)) {
    const space = line.indexOf(" ");
    await rawGit(["config", line.slice(0, space), line.slice(space + 1)], { gitDir: hostDir });
  }
}

/** Every operation, each refusal or conflict recorded by name; any other failure fails the case. */
async function exercise(repo, dir) {
  const seen = { checkout: "ok", build: "ok", skipped: [] };
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof GitRemoteError) || (error.code !== "refused" && error.code !== "conflict")) throw error;
      seen[name] = error.code;
      return undefined;
    }
  };
  const out = await step("checkout", () => repo.checkout(MAIN, { into: path.join(dir, "package-work") }));
  if (out) seen.skipped = out.skipped.map((s) => s.path);
  const main = await repo.resolve(MAIN);
  await repo.list("", main);
  await step("read", () => repo.read("--output=marker-dash", main));
  await repo.log({ path: "--output=marker-dash" });
  const notes = (await step("read", () => repo.read("notes.txt", main))) ?? "line 3\n";
  const probe = await step("build", () => repo.commitTo("probe", {
    files: { "probe.md": "probe\n", "notes.txt": notes.replace("line 3", "line 3 (probe)") },
    message: "probe",
    trailers: { "Run-Id": "probe" },
  }));
  if (probe) {
    await repo.push(probe.sha, "probe");
    const merged = await step("merge", () => repo.merge("probe", MAIN));
    if (merged?.changed) await repo.push(merged.sha, MAIN);
    const reverted = await step("revert", () => repo.revert(probe.sha, MAIN));
    if (reverted?.changed) await repo.push(reverted.sha, MAIN);
  }
  if (await repo.resolve("side")) {
    const merged = await step("side", () => repo.merge("side", MAIN));
    if (merged?.changed) await repo.push(merged.sha, MAIN);
  }
  return seen;
}

/** Two edits of notes.txt on main and on a side branch, merged here. */
async function trueMerge(repo, tag) {
  const base = await repo.resolve(MAIN);
  const notes = await repo.read("notes.txt", base);
  await repo.commitTo(`side-${tag}`, { files: { "notes.txt": notes.replace("line 6", `line 6 (${tag})`) }, message: `side ${tag}`, parent: base });
  await repo.commitTo(MAIN, { files: { "notes.txt": notes.replace("line 1", `line 1 (${tag})`) }, message: `main ${tag}` });
  return repo.merge(`side-${tag}`, MAIN).catch((error) => error);
}

describe("the hostile corpus through pi-git-remote", { concurrency: 4 }, () => {
  for (const c of cases) {
    test(`${c.id} [${c.expect}]`, { timeout: 300_000 }, async (t) => {
      const dir = await scratch();
      const built = await c.build(dir);
      const repo = await openRepo({ dir: path.join(dir, "package-host"), remote: local(built.bare) });
      if (built.workdir) await adoptClone(built.workdir, repo.dir);
      const seen = await exercise(repo, dir);
      t.diagnostic(JSON.stringify({ id: c.id, expect: c.expect, ...seen, skipped: seen.skipped.filter((p) => !p.startsWith("f0")).slice(0, 4) }));

      assert.equal(existsSync(built.marker), false, "nothing planted ran");
      assert.ok(!existsSync(path.join(repo.dir, "pi-git-remote", "home", "marker-dash")), "no path was read as an option");
      if (SKIPPED[c.id]) for (const p of SKIPPED[c.id]) assert.ok(seen.skipped.includes(p), `checkout skipped ${JSON.stringify(p)} (${seen.skipped.join(", ")})`);
      assert.equal(seen.checkout, CHECKOUT_REFUSED.has(c.id) ? "refused" : "ok");
      assert.equal(seen.build, BUILD_REFUSED.has(c.id) ? "refused" : "ok");
      if (c.expect === "no-marker" && !SKIPPED[c.id]) assert.deepEqual(seen.skipped, [], "a case with nothing to refuse loses no file");

      if (c.id === "limit-git-config-merge-driver") {
        assert.equal((await trueMerge(repo, "as-built")).changed, true, "the tree's .gitattributes is never read, so the driver is never named");
        assert.equal(existsSync(built.marker), false);
        await mkdir(path.join(repo.dir, "info"), { recursive: true });
        await writeFile(path.join(repo.dir, "info", "attributes"), "* merge=evil\n");
        await trueMerge(repo, "info-attributes");
        assert.equal(existsSync(built.marker), true, "limit, pinned: a writable host repository names and defines its own driver");
      }
      if (c.id === "limit-git-config-filter") {
        await mkdir(path.join(repo.dir, "info"), { recursive: true });
        await writeFile(path.join(repo.dir, "info", "attributes"), "* filter=evil\n");
        const { sha } = await repo.commitTo(MAIN, { files: { "notes.txt": "filtered?\n" }, message: "filter" });
        await repo.checkout(sha, { into: path.join(dir, "package-work-2") });
        assert.equal(existsSync(built.marker), false, "hash-object --no-filters and cat-file never run a filter, even one the host repository names");
      }
    });
  }
});
