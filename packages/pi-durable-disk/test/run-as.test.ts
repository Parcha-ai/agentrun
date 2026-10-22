// archilEnv's `runAs` and `run --run-as` (an instance that runs as root in a container, its commands as the image's run
// user): the setpriv prefix every command gets, and the ownership of `work/` and of what pi's in-process file tools create
// under it. Ownership is tested without root by handing entries to this user and one of its supplementary groups, which
// chown allows.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { appWritableReason, main, runUser, toolsUserCheck } from "../src/cli.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  it("refuse uid 0: the agent's commands would run as root, the owner of run.json, the store and the daemon's /proc", async () => {
    await withRun(async ({ root, work }) => {
      for (const runAs of [{ uid: 0, gid: 0 }, { uid: 0, gid: 1000 }]) {
        assert.throws(() => archilEnv({ root, work }, { runAs }), (e: unknown) => e instanceof EnvError && e.code === "INVALID_RUN_AS" && /root/.test((e as Error).message));
      }
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

test("run --run-as never puts the agent's commands in group root: a gid of 0, given or from passwd, is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pda-passwd-"));
  try {
    const passwd = join(dir, "passwd");
    writeFileSync(passwd, "root:x:0:0:root:/root:/bin/bash\nrootgroup:x:1600:0::/home/rg:/bin/bash\n");
    for (const spec of ["1500:0", "1500:000", "rootgroup"]) {
      assert.throws(() => runUser(spec, passwd), (e: unknown) => e instanceof PdaError && e.exitCode === 2 && /group root|gid 0/.test((e as Error).message), spec);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tools user the launcher verified (PI_TRANSPORT_TOOLS_USER/UID) must be --run-as: a different one, or none, is refused; without a declaration nothing changes", () => {
  const pda = { uid: 1500, gid: 1500, home: "/home/pda", name: "pda" };
  const verified = { PI_TRANSPORT_TOOLS_USER: "pda", PI_TRANSPORT_TOOLS_UID: "1500" };
  assert.doesNotThrow(() => toolsUserCheck(pda, verified), "the same user");
  assert.doesNotThrow(() => toolsUserCheck(pda, {}), "no declaration: --run-as as before");
  assert.doesNotThrow(() => toolsUserCheck(undefined, {}), "neither");
  const refused = (runAs: typeof pda | undefined, env: Record<string, string>, why: string, re: RegExp) =>
    assert.throws(() => toolsUserCheck(runAs, env), (e: unknown) => e instanceof PdaError && e.exitCode === 2 && re.test((e as Error).message), why);
  refused(undefined, verified, "a verified tools user and no --run-as: the commands would run as this (root) process", /--run-as/);
  refused({ ...pda, uid: 1501, name: "pdb" }, verified, "another uid", /1500/);
  assert.doesNotThrow(() => toolsUserCheck({ ...pda, name: "alias" }, verified), "the same uid under another name is the same user: the uid decides");
  refused(pda, { PI_TRANSPORT_TOOLS_USER: "pda" }, "a name with no uid: the declaration is malformed", /PI_TRANSPORT_TOOLS_UID/);
  refused(pda, { PI_TRANSPORT_TOOLS_USER: "pda", PI_TRANSPORT_TOOLS_UID: "15x0" }, "a uid that is not a number", /PI_TRANSPORT_TOOLS_UID/);
});

test("the launcher's secrets descriptor (PI_TRANSPORT_SECRETS_FD) never reaches a command: Node marks inherited descriptors close-on-exec at its start, and the instance closes it and drops its number before anything runs", () => {
  const child = fileURLToPath(new URL("./fixtures/secrets-fd-child.ts", import.meta.url));
  const run = (close: boolean) =>
    spawnSync(process.execPath, [child], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...process.env, PI_TRANSPORT_SECRETS_FD: "3", CLOSE: close ? "1" : "0" } });
  const fds = (out: string) => out.split("\n").filter((l) => /^[0-9]+$/.test(l)).map(Number);
  const open = run(false);
  assert.equal(open.status, 0, open.stderr);
  // Measured: Node's start (libuv's uv_disable_stdio_inheritance) makes an inherited fd 3 close-on-exec, so even without
  // the instance's close no command holds it. Pinned, so a runtime that changes this shows here.
  assert.ok(!fds(open.stdout).includes(3), `Node's own guard: ${open.stdout}`);
  assert.match(open.stdout, /SECRETS_FD=3/, "but without the instance's close, a command sees the descriptor's number");
  const closed = run(true);
  assert.equal(closed.status, 0, closed.stderr);
  assert.ok(!fds(closed.stdout).includes(3), `closed: ${closed.stdout}`);
  assert.match(closed.stdout, /SECRETS_FD=unset/, "and the variable is gone from the commands' environment");
});

test("under --run-as the root instance refuses an --app the agent's commands could change: not root's, writable by group or others anywhere on its path, a link they could replace, or inside the run's root", () => {
  type Node = { uid: number; mode: number; link?: string };
  const tree = (nodes: Record<string, Node>) => {
    const lstatSync = (p: string) => {
      const n = nodes[p];
      if (!n) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return { uid: n.uid, mode: n.mode };
    };
    const readlinkSync = (p: string) => {
      const n = nodes[p];
      if (!n?.link) throw Object.assign(new Error(`EINVAL ${p}`), { code: "EINVAL" });
      return n.link;
    };
    // As the kernel resolves: element by element, a link's target spliced in where the link was.
    const realpathSync = (p: string) => {
      const rest = p.split("/").filter(Boolean);
      let at = "/";
      for (let hops = 0; rest.length > 0; ) {
        const next = rest.shift()!;
        const q = next === "." ? at : next === ".." ? dirname(at) : at === "/" ? `/${next}` : `${at}/${next}`;
        const n = nodes[q];
        if (!n) throw Object.assign(new Error(`ENOENT ${q}`), { code: "ENOENT" });
        if (n.link === undefined) {
          at = q;
          continue;
        }
        if (++hops > 40) throw Object.assign(new Error(`ELOOP ${p}`), { code: "ELOOP" });
        rest.unshift(...n.link.split("/").filter(Boolean));
        if (n.link.startsWith("/")) at = "/";
      }
      return at;
    };
    return { lstatSync, readlinkSync, realpathSync };
  };
  const dir = (uid = 0, mode = 0o40755) => ({ uid, mode });
  const file = (uid = 0, mode = 0o100644) => ({ uid, mode });
  const base = { "/": dir(), "/opt": dir(), "/opt/app": dir(), "/opt/app/app.mjs": file(), "/mnt": dir(), "/mnt/archil": dir(), "/mnt/archil/runs": dir(), "/mnt/archil/runs/r1": dir(1500), "/mnt/archil/runs/r1/work": dir(1500), "/mnt/archil/runs/r1/work/app.mjs": file(1500) };
  const link = (to: string, uid = 0) => ({ uid, mode: 0o120777, link: to });
  const home = { ...base, "/home": dir(), "/home/pda": dir(1500) };
  assert.equal(appWritableReason("/opt/app/app.mjs", "/mnt/archil/runs/r1", tree(base)), null, "root's, 0755/0644 all the way up");
  const rootLinks = { ...base, "/opt/lib": dir(), "/opt/lib/app.mjs": file(), "/opt/app/abs.mjs": link("/opt/lib/app.mjs"), "/opt/app/rel.mjs": link("../lib/app.mjs"), "/srv": link("opt") };
  for (const app of ["/opt/app/abs.mjs", "/opt/app/rel.mjs", "/srv/app/rel.mjs"]) {
    assert.equal(appWritableReason(app, "/mnt/archil/runs/r1", tree(rootLinks)), null, `root's links in root's directories: ${app}`);
  }
  const refused: [string, Record<string, Node>, string, RegExp][] = [
    ["a module pda owns", { ...base, "/opt/app/app.mjs": file(1500) }, "/opt/app/app.mjs", /uid 1500/],
    ["a group-writable module", { ...base, "/opt/app/app.mjs": file(0, 0o100664) }, "/opt/app/app.mjs", /writable/],
    ["a world-writable directory on the way", { ...base, "/opt": dir(0, 0o40777) }, "/opt/app/app.mjs", /\/opt\b.*writable/],
    ["a sticky world-writable directory, as /tmp", { ...base, "/opt/app": dir(0, 0o41777) }, "/opt/app/app.mjs", /writable/],
    ["a directory pda owns", { ...base, "/opt/app": dir(1500) }, "/opt/app/app.mjs", /uid 1500/],
    ["a module inside the run's root", base, "/mnt/archil/runs/r1/work/app.mjs", /inside the run/],
    ["a link to a module pda owns", { ...base, "/opt/app/link.mjs": link("/opt/app/real.mjs"), "/opt/app/real.mjs": file(1500) }, "/opt/app/link.mjs", /uid 1500/],
    ["a module that is not there", base, "/opt/app/missing.mjs", /cannot be read|ENOENT/],
    // The loader opens the path as given, so the kernel follows each link again at load: one the tools could replace
    // would swap the module after this check, even when it points at root's.
    ["root's module through a link in a directory pda owns", { ...home, "/home/pda/app.mjs": link("/opt/app/app.mjs", 1500) }, "/home/pda/app.mjs", /\/home\/pda is owned by uid 1500/],
    ["root's directory through a link in a directory pda owns", { ...home, "/home/pda/app": link("/opt/app", 1500) }, "/home/pda/app/app.mjs", /\/home\/pda is owned by uid 1500/],
    ["a relative link in a directory pda owns", { ...home, "/home/pda/app.mjs": link("../../opt/app/app.mjs", 1500) }, "/home/pda/app.mjs", /\/home\/pda is owned by uid 1500/],
    ["a link pda owns, in root's directory", { ...base, "/opt/app/link.mjs": link("/opt/app/app.mjs", 1500) }, "/opt/app/link.mjs", /\/opt\/app\/link\.mjs is owned by uid 1500/],
    ["root's relative link into a directory pda owns", { ...base, "/opt/pda": dir(1500), "/opt/pda/app.mjs": file(), "/opt/app/link.mjs": link("../pda/app.mjs") }, "/opt/app/link.mjs", /\/opt\/pda is owned by uid 1500/],
    ["root's link into the run's root", { ...base, "/opt/app/link.mjs": link("/mnt/archil/runs/r1/work/app.mjs") }, "/opt/app/link.mjs", /inside the run/],
    ["links in a loop", { ...base, "/opt/app/a.mjs": link("/opt/app/b.mjs"), "/opt/app/b.mjs": link("a.mjs") }, "/opt/app/a.mjs", /ELOOP|too many links/],
  ];
  for (const [why, nodes, app, re] of refused) {
    const reason = appWritableReason(app, "/mnt/archil/runs/r1", tree(nodes));
    assert.ok(reason !== null && re.test(reason), `${why}: ${reason}`);
  }
  // On this machine's own files: a root-owned binary passes, through root's own link too (/bin on a merged /usr); a file
  // this user owns does not, nor root's binary through a link in a directory this user can write.
  assert.equal(appWritableReason("/usr/bin/true", "/mnt/archil/runs/r1"), null);
  if (lstatSync("/bin").isSymbolicLink()) assert.equal(appWritableReason("/bin/true", "/mnt/archil/runs/r1"), null);
  const mine = mkdtempSync(join(tmpdir(), "pda-app-"));
  try {
    writeFileSync(join(mine, "app.mjs"), "export default {};\n");
    assert.match(appWritableReason(join(mine, "app.mjs"), "/mnt/archil/runs/r1") ?? "", /uid|writable/);
    symlinkSync("/usr/bin/true", join(mine, "true"));
    symlinkSync("/usr/bin", join(mine, "bin"));
    assert.match(appWritableReason(join(mine, "true"), "/mnt/archil/runs/r1") ?? "", /uid|writable/, "a link here to root's binary");
    assert.match(appWritableReason(join(mine, "bin", "true"), "/mnt/archil/runs/r1") ?? "", /uid|writable/, "a link here to root's directory");
  } finally {
    rmSync(mine, { recursive: true, force: true });
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
