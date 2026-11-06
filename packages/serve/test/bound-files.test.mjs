// A box that binds the run's work/ from this machine (Docker; the faux box stands in for it here): read, write and edit
// run on this machine's work/ (bound-files.ts), never as a command in the box, and bash runs in the box. A command in
// the box can plant a link, a hard link or a swapped directory, so the file tools here take none: a link anywhere on the
// way is refused (one to the data root's token included), a file with a second hard link is refused, and a directory
// swapped for a link between the check and the write is refused. Where this host reaches directories by path (no
// /proc/self/fd), or the box binds nothing, all four run in the box. run-box.test.mjs counts Docker's own commands.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { confineTestHooks as confineHooks } from "@parcha/pi-durable-disk/internals";
import { boundFiles } from "../dist/bound-files.js";
import { codingSource } from "../dist/coding-tools.js";
import { workspaceTestHooks, writesHeld } from "../dist/workspace.js";
import { fauxRoot } from "./fixtures/faux-box.mjs";
import { follow, runDir, scratch, serve } from "./support.mjs";

// The file tools run here only where the confinement holds directory handles (Linux's /proc/self/fd); elsewhere (macOS)
// all four run in the box, which the last test checks on every host.
const HELD = writesHeld();
const NEEDS_HELD = { skip: !HELD && "needs held directory handles (/proc/self/fd)" };
const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
const WORK = "/run/agentrun/run/work";
const harness = (message) => `<harness>\n[error] ${message}\n</harness>`;
const LINK = (path) => `${WORK}/${path}: refused: a link is on the way to it, or it is one, and read, write and edit follow no link in this run's work/ (bash, in the box, can)`;
const HARD = (path) => `${WORK}/${path}: refused: it has another hard link, and read, write and edit take only a file with one (bash, in the box, can)`;

/** Each tool call of run `runId` and its answer, in order, from its released store. */
function answers(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}
const execs = (data) => {
  const file = join(fauxRoot(data), "execs.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

/** A server with the faux box and an agent `boxed` in a Docker place with the four tools; `ran(plan)` runs the probe
 *  plan to its end and answers each call's answer. */
async function boxed(t) {
  const server = await serve(t, { faux: PROBE, fauxBox: FAUX_BOX });
  const made = await server.api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["read", "write", "edit", "bash"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const ran = async (plan) => {
    const run = await server.api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: plan }) } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(server.api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
    return { runId: run.body.run_id, said: answers(server.data, run.body.run_id), work: join(runDir(realpathSync(server.data), run.body.run_id), "work") };
  };
  return { ...server, ran };
}

test("a link bash plants in work/, to the data root's token, to a directory outside or to a file inside, is refused by read, write and edit here, and nothing outside work/ is read or written", { ...NEEDS_HELD, timeout: 90_000 }, async (t) => {
  const server = await boxed(t);
  const data = realpathSync(server.data);
  const token = join(data, ".token");
  const before = readFileSync(token, "utf8");
  const outside = join(realpathSync(await scratch(t)), "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "not for the agent");
  const edit = (path) => ({ tool: "edit", args: { path, edits: [{ oldText: "a", newText: "b" }] } });
  const plan = [
    { tool: "bash", args: { command: `ln -s ${token} tok && ln -s ${outside} out && printf inside > real.txt && ln -s real.txt alias.txt` } },
    { tool: "read", args: { path: "tok" } },
    { tool: "write", args: { path: "tok", content: "overwritten" } },
    edit("tok"),
    { tool: "read", args: { path: "out/secret.txt" } },
    { tool: "write", args: { path: "out/new.txt", content: "planted" } },
    edit("out/secret.txt"),
    { tool: "read", args: { path: "alias.txt" } },
    { tool: "read", args: { path: `${WORK}/tok` } },
    // A plain file is read and written here, and bash sees what was written.
    { tool: "write", args: { path: "note.txt", content: "written here" } },
    { tool: "read", args: { path: "real.txt" } },
    { tool: "bash", args: { command: "cat note.txt" } },
  ];
  const { said } = await server.ran(plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i >= 1 && i <= 8]), JSON.stringify(said));
  assert.equal(said[1].text, harness(LINK("tok")));
  assert.equal(said[2].text, harness(LINK("tok")));
  assert.equal(said[3].text, harness(`Could not edit file: tok. Error code: permission_denied. ${LINK("tok")}`));
  assert.equal(said[4].text, harness(LINK("out/secret.txt")));
  assert.equal(said[5].text, harness(LINK("out/new.txt")));
  assert.equal(said[6].text, harness(`Could not edit file: out/secret.txt. Error code: permission_denied. ${LINK("out/secret.txt")}`));
  assert.equal(said[7].text, harness(LINK("alias.txt")), "a link to a file inside work/ is refused too: bash can follow it");
  assert.equal(said[8].text, harness(LINK("tok")), "the box's own path is the same file");
  assert.equal(said[10].text, "inside");
  assert.equal(said[11].text, "written here", "bash, in the box, reads what was written here");
  for (const answer of said) {
    assert.ok(!answer.text.includes(before) && !answer.text.includes("not for the agent"), `nothing outside work/ was read: ${answer.text}`);
    assert.ok(!answer.text.includes(data), `no answer names the data root: ${answer.text}`);
  }
  assert.equal(readFileSync(token, "utf8"), before, "the token is untouched");
  assert.deepEqual(readdirSync(outside), ["secret.txt"], "nothing was written outside");
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "not for the agent");
  assert.equal(execs(server.data).length, 2, "the two bash calls ran in the box; read, write and edit ran nothing there");
});

test("a hard link bash makes in work/ is refused by read, write and edit here; a file's mode is kept by an edit, and a new one is 0644", { ...NEEDS_HELD, timeout: 90_000 }, async (t) => {
  const server = await boxed(t);
  const plan = [
    { tool: "bash", args: { command: "printf one > a.txt && ln a.txt b.txt && printf 'echo hi\\n' > run.sh && chmod 755 run.sh" } },
    { tool: "read", args: { path: "b.txt" } },
    { tool: "write", args: { path: "b.txt", content: "two" } },
    { tool: "edit", args: { path: "b.txt", edits: [{ oldText: "one", newText: "two" }] } },
    { tool: "read", args: { path: "a.txt" } },
    { tool: "edit", args: { path: "run.sh", edits: [{ oldText: "hi", newText: "there" }] } },
    { tool: "write", args: { path: "made/new.txt", content: "new" } },
    { tool: "bash", args: { command: "./run.sh" } },
  ];
  const { said, work } = await server.ran(plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i >= 1 && i <= 4]), JSON.stringify(said));
  assert.equal(said[1].text, harness(HARD("b.txt")));
  assert.equal(said[2].text, harness(HARD("b.txt")));
  assert.equal(said[3].text, harness(`Could not edit file: b.txt. Error code: permission_denied. ${HARD("b.txt")}`));
  assert.equal(said[4].text, harness(HARD("a.txt")), "either name of the file");
  assert.equal(readFileSync(join(work, "a.txt"), "utf8"), "one");
  assert.equal(statSync(join(work, "b.txt")).ino, statSync(join(work, "a.txt")).ino, "the link is as bash made it");
  assert.equal(statSync(join(work, "run.sh")).mode & 0o777, 0o755, "the edit kept the script's mode");
  assert.equal(said[7].text.trim(), "there", "and bash runs the edited script");
  assert.equal(statSync(join(work, "made", "new.txt")).mode & 0o777, 0o644, "as a command in the box makes one");
  assert.equal(statSync(join(work, "made", "new.txt")).uid, process.getuid());
});

test("a directory of work/ swapped for a link between the check and the use is refused, held: nothing is written or read through it", NEEDS_HELD, async (t) => {
  const work = realpathSync(await scratch(t));
  const elsewhere = realpathSync(await scratch(t));
  await mkdir(join(work, "sub"));
  await writeFile(join(work, "sub", "kept.txt"), "inside");
  await writeFile(join(elsewhere, "kept.txt"), "outside");
  const files = boundFiles(work);
  let fired = 0;
  confineHooks.afterCheck = async (canonical) => {
    if (!canonical.startsWith(join(work, "sub")) || fired++) return;
    await rename(join(work, "sub"), join(work, "sub.moved"));
    await symlink(elsewhere, join(work, "sub"));
  };
  t.after(() => void (confineHooks.afterCheck = undefined));
  const written = await files.writeFile(`${WORK}/sub/new.txt`, "planted", BACKGROUND_CONTEXT);
  assert.equal(fired, 1, "the swap happened");
  assert.deepEqual([written.ok, written.error?.code, written.error?.message], [false, "permission_denied", LINK("sub/new.txt")]);
  assert.deepEqual(await readdir(elsewhere), ["kept.txt"], "nothing was written through the link");
  // Put back, and swapped again on the read.
  await rm(join(work, "sub"));
  await rename(join(work, "sub.moved"), join(work, "sub"));
  fired = 0;
  const read = await files.readTextFile(`${WORK}/sub/kept.txt`, BACKGROUND_CONTEXT);
  assert.equal(fired, 1);
  assert.deepEqual([read.ok, read.error?.message], [false, LINK("sub/kept.txt")]);
  assert.equal(await readFile(join(elsewhere, "kept.txt"), "utf8"), "outside");
});

test("the environment names the box's paths: one outside work/ is refused, a missing file names its box path, and it runs no command and offers nothing else", NEEDS_HELD, async (t) => {
  const work = realpathSync(await scratch(t));
  await writeFile(join(work, "a.txt"), "a");
  const files = boundFiles(work);
  assert.deepEqual(await files.absolutePath("a.txt", BACKGROUND_CONTEXT), { ok: true, value: `${WORK}/a.txt` });
  assert.equal(files.cwd, WORK);
  const outside = await files.readTextFile("/etc/hostname", BACKGROUND_CONTEXT);
  // The confinement's typed refusal, naming no path: the tools name it by the path the call gave (asGivenRefusals).
  assert.deepEqual([outside.error.name, outside.error.reason, outside.error.message], ["PathOutsideWorkError", "outside_work", "outside the workspace"]);
  const missing = await files.readTextFile("missing.md", BACKGROUND_CONTEXT);
  assert.deepEqual([missing.error.code, missing.error.message], ["not_found", `ENOENT: no such file or directory, open '${WORK}/missing.md'`]);
  assert.deepEqual(await files.exists("missing.md", BACKGROUND_CONTEXT), { ok: true, value: false });
  assert.deepEqual(await files.exists("a.txt", BACKGROUND_CONTEXT), { ok: true, value: true });
  const info = await files.fileInfo("a.txt", BACKGROUND_CONTEXT);
  assert.deepEqual([info.value.path, info.value.name, info.value.kind, info.value.size], [`${WORK}/a.txt`, "a.txt", "file", 1]);
  assert.equal((await files.exec("id", undefined, BACKGROUND_CONTEXT)).error.code, "shell_unavailable");
  for (const name of ["listDir", "remove", "renameFile", "createDir", "createTempDir"]) assert.equal((await files[name](`${WORK}/a.txt`, undefined, BACKGROUND_CONTEXT)).error.code, "not_supported", name);
  for (const answer of [outside, missing, info]) assert.ok(!JSON.stringify(answer).includes(work), "never this machine's work/");
});

test("where the confinement reaches directories by path (the test hook), or the box binds nothing, all four tools run in the box; else only bash does", async (t) => {
  const work = realpathSync(await scratch(t));
  await writeFile(join(work, "a.txt"), "a");
  const box = (bound) => ({ hostWork: work, bound: async () => bound, env: async () => { throw new Error("in the box"); } });
  const call = async (source, tool, args) => {
    const registered = source.tools.find((each) => each.name === tool);
    return registered.execute(args, {}, BACKGROUND_CONTEXT).then(() => "here", (error) => (error.message === "in the box" ? "box" : error.message));
  };
  const where = async (source) => [
    await call(source, "read", { path: "a.txt" }),
    await call(source, "write", { path: "b.txt", content: "b" }),
    await call(source, "edit", { path: "b.txt", edits: [{ oldText: "b", newText: "c" }] }),
    await call(source, "bash", { command: "true" }),
  ];
  if (HELD) {
    assert.deepEqual(await where(codingSource(SANDBOX, box(true))), ["here", "here", "here", "box"]);
    assert.equal(await readFile(join(work, "b.txt"), "utf8"), "c");
  }
  assert.deepEqual(await where(codingSource(SANDBOX, box(false))), ["box", "box", "box", "box"], "a box that binds nothing");
  workspaceTestHooks.byPath = true;
  t.after(() => void (workspaceTestHooks.byPath = undefined));
  assert.deepEqual(await where(codingSource(SANDBOX, box(true))), ["box", "box", "box", "box"], "by path");
});
