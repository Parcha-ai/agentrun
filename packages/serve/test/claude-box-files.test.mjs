// A claude-agent run with a box (its agent's computer a sandbox): the file tools Claude uses act on the box's
// filesystem, through the box's own calls, and never on the runner's disk.
//
// The layer: the runner's real claim path for a CLI harness (startRunner over createDispatchLoop and cli-run-spec.ts
// cliRunSpecFromLaunch, as runner-cli-spec.test.mjs runs a claude-agent run), on the real pinned Agent SDK and Claude
// CLI, against a fake Anthropic endpoint on loopback (fakeAnthropic: no key, no network). The run is in Mode 2 (the
// server's Archil settings saved), its folder on the Archil fake (fixtures/archil-fake.mjs), as runner-mode2-*.test.mjs
// build one. The claim's computer is a sandbox that mounts that folder: a computerd client (workspace-fake-computer.mjs)
// whose /workspace is a folder of its own, the box's disk, holding what the run's folder held when the box started; it
// answers the mount check with the read-back of the Archil mount the claim minted (readBackOf, under the claim's epoch),
// so the run's Workspace attaches to it (attach.ts) as it does to a real box. The box's processes (bash) run here with
// /workspace mapped to its disk.
//
// Why Mode 2 and a disk of its own. In Mode 1 a Docker box's /workspace IS a bind of the run's folder under the data
// directory: the same bytes, and the attached Workspace fsyncs each path the box changed in that folder on this machine
// (attach.ts `synced`, local.ts syncUp), so a Mode 1 box's files are on the runner's disk by design. In Mode 2 the run's
// folder is on the Archil disk, which the box mounts at /workspace; nothing of it is on the runner's disk. The box's own
// disk here stands for that mount: a tool that acts through the box lands there, and one that acts on this machine (or
// on the disk's file API from the runner) would land in the run's folder under the data directory (or on the fake disk).
// What this does not cover: computerForClaim's provider path (workspace-computer-for-claim.test.mjs) and a real FUSE
// mount (paired-sandbox.test.mjs runs the real computerd).
//
// What is asserted: the CLI is offered no built-in of its own (Read, Write, Edit, Bash...), only the host's tools as
// mcp__hands__*; its write (relative, at the box's /workspace, and at the CLI's own working directory on the runner, an
// alias of the run's folder) lands in the box's disk through files.write on /workspace; its read and its bash (cat, ls,
// pwd) answer what the box holds; the runner's file API on the Archil disk wrote none of it; and nothing the model wrote
// is anywhere under the server's data directory, the CLI's own folders on the runner included.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { linkHarnesses } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { DATA_ENV } = await import("../dist/server-fs.js");
const { runKey, scratchFolder } = await import("../dist/workspace/paths.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");
const { fakeAnthropic } = await import("@parcha/agentrun-harness-claude/testing");

const RUN = "run-1";
const AGENT = "agent-1";
const KEY = runKey(AGENT, RUN);
const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-haiku-5-5";
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
/** The text of each file the model writes: a value nothing else in the run holds. */
const MARK = `box-marker-${process.pid}-${Date.now()}`;
const MARKERS = ["rel-marker.txt", "abs-marker.txt", "cwd-marker.txt"];
/** The CLI's own built-in tools, turned off for a run (harness.ts tools: [] and disallowedTools; facts.ts nativeTools). */
const BUILT_INS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "LS", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite"];

const until = async (done, what, ms = 150_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Every file and folder under `dir`, by absolute path. */
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(entry.parentPath ?? entry.path, entry.name);
  return entry.isDirectory() && !entry.isSymbolicLink() ? [path, ...walk(path)] : [path];
}) : []);

/** A box's process, run here as the box would run it: /workspace in its argv, cwd and env mapped to the box's disk, and
 *  back in what it prints. It runs to its end at start; process.read answers its output, process.wait its exit. */
function boxProcesses(computer, disk) {
  const procs = new Map();
  const mapped = (text) => String(text).replaceAll("/workspace", disk);
  computer.overrides["process.start"] = ({ argv, cwd, env = {} }) => {
    const id = `p${procs.size + 1}`;
    const ran = spawnSync(mapped(argv[0]), argv.slice(1).map(mapped), {
      cwd: mapped(cwd ?? "/workspace"),
      env: { PATH: process.env.PATH, ...Object.fromEntries(Object.entries(env).map(([name, value]) => [name, mapped(value)])) },
      timeout: 20_000,
    });
    const back = (bytes) => Buffer.from(String(bytes ?? "").replaceAll(disk, "/workspace"));
    procs.set(id, { stdout: back(ran.stdout), stderr: back(ran.stderr), code: ran.status ?? 1 });
    return { id, pid: 4242 };
  };
  computer.overrides["process.read"] = ({ id, stream, offset = 0 }) => {
    const part = (procs.get(id)?.[stream] ?? Buffer.alloc(0)).subarray(offset);
    return { data: part.toString("base64"), nextOffset: offset + part.length, dropped: 0, exited: true };
  };
  computer.overrides["process.wait"] = ({ id }) => ({ running: false, exitCode: procs.get(id)?.code ?? 0, signal: null });
}

/** The claim's computer (deps.computerForClaim): a sandbox that mounts the run's folder from Archil, as a mounting
 *  provider's start does (the folder's mount spec asked, its credential minted), over `disk`, its own /workspace, given
 *  what the run's folder held on the Archil disk at its start. It answers the mount check with that mount's read-back
 *  under the claim's epoch, and lets the credential go at its release. */
function archilBox(disk, archil) {
  const made = [];
  const forClaim = async (launch, _store, given) => {
    const spec = await given.workspace.mountSpec();
    for (const [key, bytes] of archil.files) {
      if (!key.startsWith(`${KEY}/`) || key.endsWith("/")) continue;
      const path = join(disk, key.slice(KEY.length + 1));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const computer = fakeComputer(disk, { readBack: readBackOf(spec, launch.epoch) });
    boxProcesses(computer, disk);
    made.push({ spec, computer });
    return { computer: { kind: "sandbox", computer, check: { readBackOf, epoch: launch.epoch } }, made: "sandbox", release: async () => void (await given.revokeMount?.()) };
  };
  return { forClaim, made };
}

/** The text of each tool result the model was sent back, in order (the last request repeats the earlier ones). */
const toldOf = (fake) => {
  const last = fake.messages().at(-1);
  return (last?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").map((b) => (Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("") : String(b.content)));
};

test("a claude-agent run with a box: Claude's file tools are the host's (mcp__hands__*), and its write, read and bash act on the box's filesystem, never on the runner's disk", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claude-box-files-"));
  // The box's disk: its /workspace. Apart from the data directory, so a file in it is not under the runner's run folder.
  const disk = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claude-box-disk-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    rmSync(disk, { recursive: true, force: true });
  });
  await linkHarnesses(dir);
  // The CLI's own working directory on the runner, which its prompt names: the run's scratch folder.
  const scratch = scratchFolder(dir, AGENT, RUN);
  const steps = [
    { name: "mcp__hands__write", input: { path: "rel-marker.txt", content: `${MARK} relative\n` } },
    { name: "mcp__hands__write", input: { path: "/workspace/abs-marker.txt", content: `${MARK} absolute\n` } },
    // An absolute path Claude builds from its working directory: an alias of the run's folder (runTools' aliases), so in
    // a box the box's /workspace.
    { name: "mcp__hands__write", input: { path: `${scratch}/cwd-marker.txt`, content: `${MARK} cwd\n` } },
    { name: "mcp__hands__read", input: { path: "rel-marker.txt" } },
    { name: "mcp__hands__read", input: { path: "/workspace/abs-marker.txt" } },
    { name: "mcp__hands__bash", input: { command: "cat rel-marker.txt /workspace/cwd-marker.txt && ls /workspace && pwd" } },
  ];
  const fake = await fakeAnthropic({
    reply: (r) => {
      if (!r.tools.includes("mcp__hands__write")) return { text: "ok" };
      const done = r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").length;
      return done < steps.length ? { tool: steps[done] } : { text: "Wrote the markers." };
    },
  });
  t.after(() => fake.close());

  await server.agents.create({ id: AGENT, name: "Box" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", harness: "claude-agent", tools: ["read", "write", "edit", "bash"], computer: { kind: "sandbox", provider: "e2b" } } });
  const launch = { input: { content: "Write the marker files, read them back and list the folder." }, title: "t", place: { mode: "runner" }, harness: "claude-agent", model: { provider: "anthropic", modelId: MODEL } };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  // Mode 2: the server's Archil settings, the agent's own disk, and the account key sealed under the runner's seal key,
  // as the server saves them (runner-mode2-root-reads.test.mjs).
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  await storeAgentDisk(server, AGENT, { diskId: ARCHIL_SETTINGS.diskId });
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  const archil = new FakeArchilDisk();
  const control = archilControlFetch();
  const box = archilBox(disk, archil);
  const env = { [DATA_ENV]: dir, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url };
  const deps = {
    env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY,
    routeOf: async () => assert.fail("a CLI run takes no pi route"),
    makeArchilDisk: () => archil,
    mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
    computerForClaim: box.forClaim,
  };
  runner = startRunner({
    store,
    name: "runner-a",
    ...CONFORMANCE_TIMING,
    leaseMs: 60_000,
    stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === "claude-agent" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const told = toldOf(fake);
  const timeline = await runTimeline(server, RUN, ctx);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)} ${JSON.stringify(messagesOf(entries))} ${told.join(" | ")}`);

  // 1. One box, for this claim, mounting the run's folder from Archil (Mode 2).
  assert.equal(box.made.length, 1, "one box for the claim");
  const [{ spec, computer }] = box.made;
  assert.equal(spec.kind, "archil", `the box mounts the run's folder from Archil: ${spec.kind}`);

  // 2. Only the host's tools were offered: no CLI built-in, every file tool the host's, as mcp__hands__<tool>.
  const offered = [...new Set(fake.messages().flatMap((m) => m.tools))];
  assert.deepEqual(offered.filter((name) => BUILT_INS.includes(name)), [], `no CLI built-in is offered: ${offered.join(", ")}`);
  for (const tool of ["read", "write", "edit", "bash"]) assert.ok(offered.includes(`mcp__hands__${tool}`), `${tool} is the host's: ${offered.join(", ")}`);
  assert.match(fake.messages()[0]?.text ?? "", /your working directory, \/workspace, and file paths are relative to it\. Only files under \/workspace are the run's files/, "the system prompt names the box's folder by its absolute name");

  // 3. Every call succeeded, and each answered from the box.
  const results = timeline.filter((r) => r.kind === "tool_result").map((r) => [r.tool_name, r.tool_status]);
  assert.deepEqual(results, [["write", "success"], ["write", "success"], ["write", "success"], ["read", "success"], ["read", "success"], ["bash", "success"]], JSON.stringify(told));
  assert.ok(told[3]?.includes(`${MARK} relative`), `the relative read answers the box's file: ${told[3]}`);
  assert.ok(told[4]?.includes(`${MARK} absolute`), `the read at the box's /workspace answers its file: ${told[4]}`);
  const bash = told[5] ?? "";
  assert.ok(bash.includes(`${MARK} relative`) && bash.includes(`${MARK} cwd`), `bash's cat prints the box's files: ${bash}`);
  for (const name of MARKERS) assert.ok(bash.includes(name), `bash's ls lists ${name} in the box: ${bash}`);
  assert.match(bash, /^\/workspace$/m, `bash runs in the box's /workspace: ${bash}`);

  // 4. The files are in the box's disk, written and read through the box's own calls on /workspace; bash was its process.
  assert.equal(readFileSync(join(disk, "rel-marker.txt"), "utf8"), `${MARK} relative\n`);
  assert.equal(readFileSync(join(disk, "abs-marker.txt"), "utf8"), `${MARK} absolute\n`);
  assert.equal(readFileSync(join(disk, "cwd-marker.txt"), "utf8"), `${MARK} cwd\n`, "the CLI's working directory is an alias of the box's /workspace");
  // A write is the box's files.write of a temporary file in /workspace, then its files.move onto the name (attach.ts).
  const writes = computer.calls.filter(([method]) => method === "files.write").map(([, params]) => params.path);
  const moves = computer.calls.filter(([method]) => method === "files.move").map(([, params]) => [params.from, params.to]);
  for (const name of MARKERS) {
    const move = moves.find(([, to]) => to === `/workspace/${name}`);
    assert.ok(move && writes.includes(move[0]) && move[0].startsWith("/workspace/"), `the write went through the box's files.write and files.move onto /workspace/${name}: ${JSON.stringify({ writes, moves })}`);
  }
  const reads = computer.calls.filter(([method]) => method === "files.read").map(([, params]) => params.path);
  assert.ok(reads.includes("/workspace/rel-marker.txt") && reads.includes("/workspace/abs-marker.txt"), `the reads went through the box's files.read: ${JSON.stringify(reads)}`);
  assert.ok(computer.calls.some(([method, params]) => method === "process.start" && params.argv.join(" ").includes("cat rel-marker.txt")), "bash ran as the box's process");

  // 5. Not through the runner's own file API on the Archil disk either: no marker key on the disk.
  assert.deepEqual([...archil.files.keys()].filter((key) => MARKERS.some((name) => key.endsWith(name))), [], "the runner wrote no marker to the Archil disk");

  // 6. None of it is on the runner's disk: no marker file, and no file holding what the model wrote, anywhere under the
  // data directory: the run's folder path, its scratch folder and the CLI's own folders there (its home, its session)
  // included.
  const onRunner = walk(dir);
  assert.deepEqual(onRunner.filter((path) => MARKERS.some((name) => path.endsWith(name))), [], "no marker file under the data directory");
  const holding = onRunner.filter((path) => {
    try {
      return readFileSync(path, "utf8").includes(`${MARK} `);
    } catch {
      return false;
    }
  });
  // The run's own record (its journal, in the store's database) keeps each call and its result, as every run's does: the
  // record of what was said, not a file a tool made. Every other file is free of the marker's text.
  assert.deepEqual(holding.filter((path) => !/\.(db|sqlite\d?)(-wal|-shm|-journal)?$/.test(path)), [], `no file on the runner holds what the model wrote: ${holding.join(", ")}`);
});
