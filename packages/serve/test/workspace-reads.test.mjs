// What this server reads out of a run's work/ (the console's file view and listing, a skill's SKILL.md) never goes
// through a link, and never reads a file hard-linked in: a link the agent plants, or one swapped in between a check and
// the open, cannot hand it this server's own files. Each forced swap goes in through the confinement's test seam, after
// the path is checked and before it is opened.
import assert from "node:assert/strict";
import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { confineTestHooks as confineHooks } from "@parcha/pi-durable-disk/internals";
import { promptOf } from "../dist/app.js";
import { assertHardlinkProtection, openWorkFile, walkWork, workspaceTestHooks } from "../dist/workspace.js";
import { agent, follow, serve } from "./support.mjs";

const CANARY = `not-a-secret-canary-${process.pid}`;

/** A server with one completed run, its work/, and a file of the server's own (outside work/) holding the canary. */
async function served(t) {
  const server = await serve(t);
  assert.equal((await server.api("POST", "/agents", agent("files"))).status, 201);
  const { body: run } = await server.api("POST", "/agents/files/runs", { input: { content: "hi" } });
  await follow(server.api, run.run_id, ["completed"], { deadlineMs: 55_000 });
  const work = join(server.data, "runs", run.run_id, "work");
  await mkdir(work, { recursive: true });
  const secret = join(server.data, "server-own.txt");
  await writeFile(secret, CANARY);
  return { ...server, runId: run.run_id, work, secret };
}

const get = (server, path) => server.api("GET", `/runs/${server.runId}/files${path}`);
const holds = (response) => JSON.stringify(response.body ?? "").includes(CANARY);

/** Swaps `name` (a path in work/) for a link to `target` the first time the confinement checks a path ending in it. */
function swapOnCheck(t, work, name, target) {
  let fired = 0;
  confineHooks.afterCheck = async (canonical) => {
    if (!canonical.endsWith(`/${name}`) || fired++) return;
    await rename(join(work, name), join(work, `${name}.moved`));
    await symlink(target, join(work, name));
  };
  t.after(() => void (confineHooks.afterCheck = undefined));
  return () => fired;
}

test("the file view refuses a link the agent planted, to a file or a directory of the server's, and lists neither", { timeout: 60_000 }, async (t) => {
  const server = await served(t);
  await symlink(server.secret, join(server.work, "x"));
  await symlink(server.data, join(server.work, "d"));
  await writeFile(join(server.work, "ok.txt"), "fine");
  for (const path of ["/x", "/d/server-own.txt"]) {
    const res = await get(server, path);
    assert.equal(res.status, 404, path);
    assert.ok(!holds(res), `no byte of the target: ${path}`);
  }
  const list = await get(server, "");
  assert.deepEqual(list.body.files.map((f) => f.path), ["ok.txt"], "only the regular file is listed");
});

test("the file view refuses a file hard-linked into work/, and does not list it", { timeout: 60_000 }, async (t) => {
  const server = await served(t);
  await link(server.secret, join(server.work, "h"));
  const res = await get(server, "/h");
  assert.equal(res.status, 404);
  assert.ok(!holds(res));
  assert.deepEqual((await get(server, "")).body.files.map((f) => f.path), []);
});

test("the file view reads through the confinement: a file swapped for a link after its check is refused, never followed", { timeout: 60_000 }, async (t) => {
  const server = await served(t);
  await writeFile(join(server.work, "a.txt"), "hello");
  const fired = swapOnCheck(t, server.work, "a.txt", server.secret);
  const res = await get(server, "/a.txt");
  assert.equal(fired(), 1, "the read was checked by the confinement");
  assert.equal(res.status, 404);
  assert.ok(!holds(res));
});

test("the file listing walks through the confinement: a directory swapped for a link after its check is not entered, and nothing under it is listed", { timeout: 60_000 }, async (t) => {
  const server = await served(t);
  await mkdir(join(server.work, "sub"));
  await writeFile(join(server.work, "sub", "f.txt"), "under");
  const fired = swapOnCheck(t, server.work, "sub", server.data);
  const list = await get(server, "");
  assert.ok(fired() >= 1, "the walk was checked by the confinement");
  const paths = list.body.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith("sub/")), `nothing under the swapped name: ${paths}`);
  assert.ok(!paths.some((p) => p.includes("server-own")), "none of the server's files");
});

test("a skill's SKILL.md is read through no link: a skill directory linked out of work/ is refused, and none of its text reaches the prompt", async (t) => {
  const server = await served(t);
  const outside = join(server.data, "elsewhere");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "SKILL.md"), CANARY);
  await mkdir(join(server.work, ".agents", "skills"), { recursive: true });
  await symlink(outside, join(server.work, ".agents", "skills", "linked"));
  await assert.rejects(promptOf("Answer.", ["linked/SKILL.md"], server.work), (error) => !String(error?.message).includes(CANARY));
});

test("a skill's SKILL.md swapped for a link after its check is refused", async (t) => {
  const server = await served(t);
  const dir = join(server.work, ".agents", "skills", "s");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "Be brief.");
  const fired = swapOnCheck(t, server.work, ".agents/skills/s/SKILL.md", server.secret);
  await assert.rejects(promptOf("Answer.", ["s/SKILL.md"], server.work), (error) => !String(error?.message).includes(CANARY));
  assert.equal(fired(), 1, "the read was checked by the confinement");
});

test("openWorkFile and walkWork read only regular files with one link, reached through no link", async (t) => {
  const server = await served(t);
  await writeFile(join(server.work, "one.txt"), "1");
  await mkdir(join(server.work, "in"));
  await symlink(join(server.work, "one.txt"), join(server.work, "in", "back"));
  const { handle } = await openWorkFile(server.work, "one.txt");
  await handle.close();
  await assert.rejects(openWorkFile(server.work, "in/back"), /in\/back/, "a link to a file inside work/ is still a link");
  const seen = [];
  await walkWork(server.work, (path) => void seen.push(path));
  assert.deepEqual(seen.sort(), ["in", "one.txt"]);
});

test("serve can require that the kernel refuses hard links to files the linker cannot write", () => {
  assert.doesNotThrow(() => assertHardlinkProtection(() => "1\n"));
  assert.throws(() => assertHardlinkProtection(() => "0\n"), /protected_hardlinks is 0/);
  assert.throws(() => assertHardlinkProtection(() => { throw new Error("no such file"); }), /cannot be read/);
});

test("each entry left out says why: a link, not a regular file, another hard link; and a read past its cap is refused", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { readWorkBytes } = await import("../dist/workspace.js");
  const server = await served(t);
  await writeFile(join(server.work, "small.txt"), "12345");
  await symlink(server.secret, join(server.work, "ln"));
  await link(server.secret, join(server.work, "hard"));
  execFileSync("mkfifo", [join(server.work, "pipe")]);
  const refused = [];
  const seen = [];
  await walkWork(server.work, (path) => void seen.push(path), { refused: (path, reason) => void refused.push([path, reason]) });
  assert.deepEqual(seen, ["small.txt"]);
  assert.deepEqual(refused.sort(), [["hard", "hard_link"], ["ln", "link"], ["pipe", "not_regular"]]);
  assert.equal((await readWorkBytes(server.work, "small.txt", { maxBytes: 5 })).toString(), "12345");
  await assert.rejects(readWorkBytes(server.work, "small.txt", { maxBytes: 4 }), (error) => error.reason === "over_cap");
  for (const [path, reason] of [["ln", "link"], ["hard", "hard_link"], ["pipe", "not_regular"], ["absent", "missing"]]) {
    await assert.rejects(openWorkFile(server.work, path), (error) => error.reason === reason, `${path}: ${reason}`);
  }
});

test("a file this server cannot read (created private in the box) is listed, flagged, beside the rest, and reading it is a named 403, never a 500", { timeout: 60_000, skip: process.getuid?.() === 0 && "root reads every file" }, async (t) => {
  const { chmod } = await import("node:fs/promises");
  const server = await served(t);
  await writeFile(join(server.work, "open.txt"), "fine");
  await writeFile(join(server.work, "private.txt"), "mine");
  // Owner-only for someone else: this server's uid is the owner here, so no mode at all stands in for a mask of none.
  await chmod(join(server.work, "private.txt"), 0o000);
  t.after(() => chmod(join(server.work, "private.txt"), 0o600).catch(() => {}));
  const list = await get(server, "");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.files.map((f) => [f.path, f.unreadable ?? false]), [["open.txt", false], ["private.txt", true]]);
  const res = await get(server, "/private.txt");
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "system_file_forbidden");
  assert.equal(res.body.error.details?.reason, "unreadable");
  assert.match(res.body.error.message, /created private by a tool in the run's box/);
});

test("a directory the walk cannot read is reported refused, never read as empty, so no caller infers its files are gone", { skip: process.getuid?.() === 0 && "root reads every directory" }, async (t) => {
  const { chmod } = await import("node:fs/promises");
  const server = await served(t);
  await mkdir(join(server.work, "locked"));
  await writeFile(join(server.work, "locked", "kept.txt"), "still here");
  await chmod(join(server.work, "locked"), 0o000);
  const refused = [];
  const seen = [];
  // The mode goes back before the test ends: the server's own cleanup, registered first, removes the directory.
  try {
    await walkWork(server.work, (path) => void seen.push(path), { refused: (path, reason) => void refused.push([path, reason]) });
  } finally {
    await chmod(join(server.work, "locked"), 0o700);
  }
  assert.deepEqual(refused, [["locked", "unreadable"]], "the directory itself is reported");
  assert.ok(!seen.some((p) => p.startsWith("locked/")), "and nothing is said of what is in it");
});

test("a directory swapped for a link after the walk listed it, and before it enters, is reported as a link, and not entered", async (t) => {
  const server = await served(t);
  await mkdir(join(server.work, "inner"));
  await writeFile(join(server.work, "inner", "f.txt"), "in");
  await mkdir(join(server.work, "other"));
  await writeFile(join(server.work, "other", "g.txt"), "other");
  // Swapped for a link to a directory INSIDE work/: still a link, and refused as one.
  workspaceTestHooks.beforeEnter = async (path) => {
    if (path !== "inner") return;
    workspaceTestHooks.beforeEnter = undefined;
    await rename(join(server.work, "inner"), join(server.work, "inner.moved"));
    await symlink(join(server.work, "other"), join(server.work, "inner"));
  };
  t.after(() => void (workspaceTestHooks.beforeEnter = undefined));
  const refused = [];
  const seen = [];
  await walkWork(server.work, (path) => void seen.push(path), { refused: (path, reason) => void refused.push([path, reason]) });
  assert.deepEqual(refused.filter(([path]) => path === "inner"), [["inner", "link"]]);
  assert.ok(!seen.includes("inner/g.txt"), "nothing listed through the link");
});

test("work/ itself unreadable is no working copy: the walk throws, never reads as empty", { skip: process.getuid?.() === 0 && "root reads every directory" }, async (t) => {
  const { chmod } = await import("node:fs/promises");
  const server = await served(t);
  await chmod(server.work, 0o000);
  try {
    await assert.rejects(walkWork(server.work, () => {}), (error) => error.path === "." && error.reason === "unreadable");
  } finally {
    await chmod(server.work, 0o700);
  }
});

test("a capped read refuses a file grown past its cap without reading it whole", async (t) => {
  const { readWorkBytes } = await import("../dist/workspace.js");
  const server = await served(t);
  await writeFile(join(server.work, "big.bin"), Buffer.alloc(64, 1));
  await assert.rejects(readWorkBytes(server.work, "big.bin", { maxBytes: 63 }), (error) => error.reason === "over_cap");
  assert.equal((await readWorkBytes(server.work, "big.bin", { maxBytes: 64 })).length, 64);
});

/** Sets one test seam for this test only. */
function seam(t, name, hook) {
  workspaceTestHooks[name] = hook;
  t.after(() => void delete workspaceTestHooks[name]);
}

test("a link INSIDE work/ on the way to a file is refused too: the path must be work/ joined with its own names", { timeout: 60_000 }, async (t) => {
  const server = await served(t);
  await mkdir(join(server.work, "real"));
  await writeFile(join(server.work, "real", "f.txt"), "through a link");
  await symlink(join(server.work, "real"), join(server.work, "alias"));
  await assert.rejects(openWorkFile(server.work, "alias/f.txt"), (error) => error.reason === "link");
  assert.equal((await get(server, "/alias/f.txt")).status, 404);
  assert.equal((await get(server, "/real/f.txt")).status, 200, "the file itself, by its own path, reads");
});

test("the file view streams the bytes it opened: a swap after the open, before the read, still serves the file, never the link's target", { timeout: 60_000 }, async (t) => {
  const server = await served(t);
  await writeFile(join(server.work, "a.txt"), "the original bytes");
  seam(t, "afterOpen", async (rel) => {
    if (rel !== "a.txt") return;
    await rename(join(server.work, "a.txt"), join(server.work, "a.moved"));
    await symlink(server.secret, join(server.work, "a.txt"));
  });
  const res = await server.api("GET", `/runs/${server.runId}/files/a.txt`);
  assert.equal(res.status, 200);
  assert.ok(!holds(res), "no byte of the link's target");
  assert.match(String(res.text ?? res.body), /the original bytes/);
});

test("a directory that becomes unreadable between its pin and its read is reported refused, not read as empty", { skip: process.getuid?.() === 0 && "root reads every directory" }, async (t) => {
  const { chmod } = await import("node:fs/promises");
  const server = await served(t);
  await mkdir(join(server.work, "late"));
  await writeFile(join(server.work, "late", "kept.txt"), "x");
  seam(t, "afterPin", async (rel) => {
    if (rel === "late") await chmod(join(server.work, "late"), 0o000);
  });
  const refused = [];
  try {
    await walkWork(server.work, () => {}, { refused: (path, reason) => void refused.push([path, reason]) });
  } finally {
    await chmod(join(server.work, "late"), 0o700);
  }
  assert.deepEqual(refused, [["late", "unreadable"]]);
});

test("work/ itself made unreadable between its pin and its read is no working copy: the walk throws, never lists nothing", { skip: process.getuid?.() === 0 && "root reads every directory" }, async (t) => {
  const { chmod } = await import("node:fs/promises");
  const server = await served(t);
  await writeFile(join(server.work, "kept.txt"), "x");
  seam(t, "afterPin", async (rel) => {
    if (rel === ".") await chmod(server.work, 0o000);
  });
  const refused = [];
  try {
    await assert.rejects(walkWork(server.work, () => {}, { refused: (path, reason) => void refused.push([path, reason]) }), (error) => error.path === "." && error.reason === "unreadable");
  } finally {
    await chmod(server.work, 0o700);
  }
  assert.deepEqual(refused, []);
});

test("a capped read refuses a file that grows past its cap between its size check and its read", async (t) => {
  const { appendFile } = await import("node:fs/promises");
  const { readWorkBytes } = await import("../dist/workspace.js");
  const server = await served(t);
  await writeFile(join(server.work, "grows.bin"), Buffer.alloc(8, 1));
  seam(t, "afterSizeCheck", (rel) => appendFile(join(server.work, rel), Buffer.alloc(8, 2)));
  await assert.rejects(readWorkBytes(server.work, "grows.bin", { maxBytes: 10 }), (error) => error.reason === "over_cap");
});
