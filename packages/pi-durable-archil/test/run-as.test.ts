// archilEnv's `runAs` and `run --run-as` (an instance that runs as root in a container, its commands as the image's run
// user): the setpriv prefix every command gets, and the ownership of `work/` and of what pi's in-process file tools create
// under it. Ownership is tested without root by handing entries to this user and one of its supplementary groups, which
// chown allows.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { main, runUser } from "../src/cli.ts";
import { archilEnv, EnvError } from "../src/env.ts";
import { PdaError } from "../src/errors.ts";

const context = BACKGROUND_CONTEXT;

async function withRun<T>(use: (run: { root: string; work: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pda-runas-"));
  const work = join(root, "work");
  await mkdir(work);
  try {
    return await use({ root, work });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A setpriv that records its arguments, then runs what follows `--`. */
async function fakeSetpriv(root: string): Promise<{ path: string; log: string }> {
  const path = join(root, "setpriv");
  const log = join(root, "setpriv.log");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  return { path, log };
}

describe("runAs: commands", () => {
  it("run through setpriv as the user and group, with no supplementary groups, no capabilities and under no_new_privs", async () => {
    await withRun(async ({ root, work }) => {
      const fake = await fakeSetpriv(root);
      const env = archilEnv({ root, work }, { runAs: { uid: 1500, gid: 1501 }, setprivPath: fake.path })({});
      assert.equal(getOrThrow(await env.exec("echo hi", undefined, context)).exitCode, 0);
      assert.equal(getOrThrow(await env.exec(["true"], undefined, context)).exitCode, 0);
      const lines = (await readFile(fake.log, "utf8")).trim().split("\n");
      assert.match(lines[0], /^--reuid=1500 --regid=1501 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- \S*sh -c echo hi$/);
      assert.equal(lines[1], "--reuid=1500 --regid=1501 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- true");
    });
  });

  it("switch user even with noNewPrivs off, so setpriv stays required", async () => {
    await withRun(async ({ root, work }) => {
      const fake = await fakeSetpriv(root);
      const env = archilEnv({ root, work }, { runAs: { uid: 7, gid: 8 }, noNewPrivs: false, setprivPath: fake.path })({});
      await env.exec(["true"], undefined, context);
      assert.equal((await readFile(fake.log, "utf8")).trim(), "--reuid=7 --regid=8 --clear-groups --inh-caps=-all --bounding-set=-all -- true");
      assert.throws(() => archilEnv({ root, work }, { runAs: { uid: 7, gid: 8 }, noNewPrivs: false, setprivPath: "/nonexistent/setpriv" }), (e: unknown) => e instanceof EnvError && e.code === "SETPRIV_UNAVAILABLE");
    });
  });

  it("refuse a uid or gid that is not a non-negative integer", async () => {
    await withRun(async ({ root, work }) => {
      for (const runAs of [{ uid: -1, gid: 1 }, { uid: 1.5, gid: 1 }, { uid: 1, gid: Number.NaN }]) {
        assert.throws(() => archilEnv({ root, work }, { runAs }), (e: unknown) => e instanceof EnvError && e.code === "INVALID_RUN_AS");
      }
    });
  });
});

const uid = process.getuid?.() ?? 0;
const primary = process.getgid?.() ?? 0;
const other = (process.getgroups?.() ?? []).find((g) => g !== primary);

describe("runAs: what the in-process file tools create under work/", { skip: other === undefined && "this user has no supplementary group to hand files to" }, () => {
  const owner = { uid, gid: other! };
  const gidOf = async (p: string) => (await lstat(p)).gid;

  it("work/ itself, and every file and directory a write, an append or a mkdir creates, with its missing parents", async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work }, { runAs: owner })({});
      getOrThrow(await env.writeFile("a/b/c.txt", "x", context));
      assert.equal(await gidOf(work), other, "work/ is handed over at first use");
      for (const p of ["a", "a/b", "a/b/c.txt"]) assert.equal(await gidOf(join(work, p)), other, p);
      getOrThrow(await env.appendFile("log/one.txt", "x", context));
      for (const p of ["log", "log/one.txt"]) assert.equal(await gidOf(join(work, p)), other, p);
      getOrThrow(await env.createDir("d/e/f", undefined, context));
      for (const p of ["d", "d/e", "d/e/f"]) assert.equal(await gidOf(join(work, p)), other, p);
    });
  });

  it("an entry that existed keeps its owner; a path outside work/, or reached through a symlink out of it, is never chowned", async () => {
    for (const confineFiles of [true, false]) {
      await withRun(async ({ root, work }) => {
        await writeFile(join(work, "kept.txt"), "before");
        await mkdir(join(root, "outside"));
        await symlink(join(root, "outside"), join(work, "link"));
        const env = archilEnv({ root, work }, { runAs: owner, confineFiles })({});
        getOrThrow(await env.writeFile("kept.txt", "after", context));
        assert.equal(await gidOf(join(work, "kept.txt")), primary, "an overwritten file keeps its owner");
        // With the confinement (the default) these writes are refused; without it they happen and are not handed over.
        const outside = await env.writeFile(join(root, "elsewhere.txt"), "x", context);
        const through = await env.writeFile("link/through.txt", "x", context);
        assert.equal(outside.ok, !confineFiles);
        assert.equal(through.ok, !confineFiles);
        if (!confineFiles) {
          assert.equal(await gidOf(join(root, "elsewhere.txt")), primary, "outside work/");
          assert.equal(await gidOf(join(root, "outside", "through.txt")), primary, "through a symlink that leaves work/");
        }
      });
    }
  });

  it("without the confinement too, what the tools create under work/ is handed over", async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work }, { runAs: owner, confineFiles: false })({});
      getOrThrow(await env.writeFile("x/y.txt", "x", context));
      for (const p of ["x", "x/y.txt"]) assert.equal(await gidOf(join(work, p)), other, p);
    });
  });
});

test("run --run-as: a name from passwd with its group and home, or uid[:gid]; root and unknown names are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pda-passwd-"));
  try {
    const passwd = join(dir, "passwd");
    writeFileSync(passwd, "root:x:0:0:root:/root:/bin/bash\npda:x:1500:1500::/home/pda:/bin/bash\n");
    assert.deepEqual(runUser("pda", passwd), { uid: 1500, gid: 1500, home: "/home/pda", name: "pda" });
    assert.deepEqual(runUser("1500", passwd), { uid: 1500, gid: 1500, home: "/home/pda", name: "pda" });
    assert.deepEqual(runUser("2000:3000", passwd), { uid: 2000, gid: 3000, home: "/", name: "2000" });
    assert.throws(() => runUser("nobody-here", passwd), (e: unknown) => e instanceof PdaError && e.exitCode === 2);
    assert.throws(() => runUser("root", passwd), (e: unknown) => e instanceof PdaError && /root/.test((e as Error).message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run --run-as needs an instance running as root", { skip: process.getuid?.() === 0 && "running as root" }, async () => {
  const quiet = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x", "--app", "/nope.ts", "--run-as", "1500"]), 2);
  } finally {
    process.stderr.write = quiet;
  }
});
