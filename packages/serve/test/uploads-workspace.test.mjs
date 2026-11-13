// A run's files go into its work/inputs/ through the run's Workspace: every byte by the Workspace's write, nothing by a
// path, so a run whose folder is on a disk the server never mounts gets its files the same way. Names taken get the
// next free suffix, in order, as before.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Uploads } from "../dist/uploads.js";
import { localWorkspace } from "../dist/workspace/index.js";

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-uploads-ws-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Uploads under `dir`, and a function that uploads `text` as `path` and answers its file. */
function uploadsIn(dir) {
  const uploads = new Uploads(join(dir, "files"));
  const send = async (path, text) => {
    const received = await uploads.take(new URLSearchParams({ path }), "text/plain", [Buffer.from(text)]);
    return (await received.commit()).file;
  };
  return { uploads, send };
}

/** `workspace`, every call it takes recorded by name and path. */
function recorded(workspace) {
  const calls = [];
  return {
    calls,
    workspace: new Proxy(workspace, {
      get(target, name) {
        const value = target[name];
        if (typeof value !== "function") return value;
        return (...args) => {
          calls.push([name, args[0]]);
          return value.apply(target, args);
        };
      },
    }),
  };
}

test("a run's files are written into inputs/ through its Workspace, a taken name suffixed in order", async (t) => {
  const dir = await scratch(t);
  const { uploads, send } = uploadsIn(dir);
  const files = [await send("notes.txt", "one"), await send("notes.txt", "two"), await send("docs/a.md", "# A"), await send("docs", "a file named like the folder")];
  const work = join(dir, "work");
  const { workspace, calls } = recorded(localWorkspace(work));
  await localWorkspace(dir).mkdir("work");
  await uploads.copyInto(workspace, files);
  assert.deepEqual(calls.filter(([name]) => name === "write").map(([, path]) => path), ["inputs/notes.txt", "inputs/notes-2.txt", "inputs/docs/a.md", "inputs/docs-2"]);
  assert.equal(await readFile(join(work, "inputs", "notes-2.txt"), "utf8"), "two");
  assert.equal(await readFile(join(work, "inputs", "docs", "a.md"), "utf8"), "# A");
  assert.equal(await readFile(join(work, "inputs", "docs-2"), "utf8"), "a file named like the folder");
});

test("a name already in the run's inputs/ is kept, and the new file takes the next suffix", async (t) => {
  const dir = await scratch(t);
  const { uploads, send } = uploadsIn(dir);
  const workspace = localWorkspace(join(dir, "work"));
  await localWorkspace(dir).mkdir("work");
  await workspace.write("inputs/plan.md", "the run's own");
  await workspace.mkdir("inputs/data.csv");
  await uploads.copyInto(workspace, [await send("plan.md", "uploaded"), await send("data.csv", "a,b")]);
  assert.equal(new TextDecoder().decode(await workspace.read("inputs/plan.md")), "the run's own");
  assert.equal(new TextDecoder().decode(await workspace.read("inputs/plan-2.md")), "uploaded");
  assert.equal(new TextDecoder().decode(await workspace.read("inputs/data-2.csv")), "a,b");
});

test("a link at inputs/ is never written through: the copy fails ESCAPE", async (t) => {
  const dir = await scratch(t);
  const { uploads, send } = uploadsIn(dir);
  const { symlink, mkdir, readdir } = await import("node:fs/promises");
  await mkdir(join(dir, "work"));
  await mkdir(join(dir, "elsewhere"));
  await symlink(join(dir, "elsewhere"), join(dir, "work", "inputs"));
  await assert.rejects(uploads.copyInto(localWorkspace(join(dir, "work")), [await send("x.txt", "x")]), (error) => error?.code === "ESCAPE");
  assert.deepEqual(await readdir(join(dir, "elsewhere")), []);
});
