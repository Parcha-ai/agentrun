// The host tools a run on another harness gets are pi's, each with the replay the kernel keeps: read,
// web_fetch and web_search, and monid's discover and inspect, may run again after a crash; write, edit and monid.run
// never (the faux harness does not consult it, so it is checked here, where it is set). Each goes to the harness under
// its wire name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { CLAUDE_AGENT_MAX_IMAGE_BYTES, claudeAgentAdapter, toolImageProblems } from "@parcha/agentrun-harness-claude";
import { codexAdapter } from "@parcha/agentrun-harness-codex";
import { codingSource, READ_IMAGE_MAX_BYTES } from "../dist/coding-tools.js";
import { hostTools, workspaceRelative } from "../dist/host-tools.js";
import { rowPaths } from "../dist/workspace-paths.js";
import { withEnv } from "./support.mjs";

/** The run a host tool is built for: only its work directory is read, and nothing here calls a tool. */
const RUN = { claim: { work: "/nonexistent/work" } };
const MONID = ["monid.discover", "monid.inspect", "monid.run"];

test("read, web_fetch and web_search are replay-safe; write and edit never replay; a name pi has no tool for, ask_person or browser, gives none", () => {
  const tools = hostTools(RUN, ["read", "write", "edit", "web_fetch", "web_search", "ask_person", "browser", "bash"], ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["web_fetch", "safe"], ["web_search", "safe"]]);
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object", `${tool.name} keeps pi's parameters`);
});

test("in a box the coding source gives read, write, edit and bash (never replayed); the network tools stay this machine's, and a source holding another tool is refused", async () => {
  const { codingSource } = await import("../dist/coding-tools.js");
  const source = codingSource({ mode: "sandbox", box: "docker" }, { env: async () => ({}) });
  const tools = hostTools({}, ["read", "write", "edit", "bash", "web_fetch"], ctx, new Map(), source.tools);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["bash", "never"], ["web_fetch", "safe"]]);
  assert.equal(tools.find((tool) => tool.name === "bash").inputSchema.properties.command.type, "string", "pi's bash schema");
  const stray = { ...source.tools[0], name: "web_fetch" };
  assert.throws(() => hostTools({}, ["web_fetch"], ctx, new Map(), [stray]), /holds web_fetch, which is no coding tool/);
});

test("a host tool's answer keeps the tail of a long output within pi's limits, then its diagnostics, also when the tool failed", async () => {
  const run = { env: async () => ({}) };
  const chatty = {
    name: "bash", description: "d", parameters: { type: "object" }, outputLimits: { retain: "tail" },
    async execute(args, api) {
      for (let i = 0; i < 5000; i++) api.output(`line ${i} ${"x".repeat(40)}\n`);
      api.diagnostic({ severity: "info", code: "full_output", message: "Full output: /tmp/full.txt" });
      if (args.fail) throw new Error("Command exited with code 3");
      return {};
    },
  };
  for (const fail of [false, true]) {
    const results = new Map();
    const [tool] = hostTools(run, ["bash"], ctx, results, [chatty]);
    const answer = await tool.call({ fail }, { callId: `c-${fail}`, signal: new AbortController().signal });
    assert.equal(answer.isError, fail);
    assert.ok(Buffer.byteLength(answer.text) < 52 * 1024, `bounded: ${Buffer.byteLength(answer.text)} bytes`);
    assert.match(answer.text, /^\[earlier output omitted\]\n/);
    assert.match(answer.text, /line 4999 x+\n/, "the tail is kept");
    assert.doesNotMatch(answer.text, /line 0 /);
    assert.ok(answer.text.endsWith(fail ? "\n\nCommand exited with code 3\n\nFull output: /tmp/full.txt" : "\n\nFull output: /tmp/full.txt"), answer.text.slice(-120));
    assert.equal(results.get(`c-${fail}`), answer);
  }
});

test("a host tool reads snapshot, conversation and waitForTask from its own run's Harness, never another run's; memo and taskId stay refused by name", async () => {
  // Two runs, each with a Harness whose three members answer with that run's own value and say what they were asked.
  const harnessOf = (name) => {
    const asked = [];
    return {
      asked,
      harness: {
        snapshot(...args) { asked.push(["snapshot", args.slice(0, -1)]); return Promise.resolve({ doc: name }); },
        conversation(id) { asked.push(["conversation", [id]]); return Promise.resolve({ id, of: name }); },
        waitForTask(id) { asked.push(["waitForTask", [id]]); return Promise.resolve({ state: { status: "terminal" }, of: name }); },
      },
    };
  };
  const a = harnessOf("run-a");
  const b = harnessOf("run-b");
  const read = {
    name: "bash", description: "d", parameters: { type: "object" },
    async execute(_args, api) {
      const said = {
        snapshot: await api.snapshot("Doc", api.conversationId, ctx),
        conversation: await api.conversation(7, ctx),
        waitForTask: await api.waitForTask("task-1", ctx),
      };
      for (const member of ["memo", "taskId"]) {
        try {
          void api[member];
          said[member] = "given";
        } catch (error) {
          said[member] = error.message;
        }
      }
      api.output(JSON.stringify(said));
      return {};
    },
  };
  const [tool] = hostTools({ env: async () => ({}), harness: a.harness }, ["bash"], ctx, new Map(), [read]);
  hostTools({ env: async () => ({}), harness: b.harness }, ["bash"], ctx, new Map(), [read]);
  const said = JSON.parse((await tool.call({}, { callId: "c", signal: new AbortController().signal })).text);
  assert.deepEqual([said.snapshot, said.conversation, said.waitForTask], [{ doc: "run-a" }, { id: 7, of: "run-a" }, { state: { status: "terminal" }, of: "run-a" }], "each member answers with its own run's value");
  assert.deepEqual(a.asked, [["snapshot", ["Doc", 1]], ["conversation", [7]], ["waitForTask", ["task-1"]]], "asked of its own run's Harness, as the tool asked");
  assert.deepEqual(b.asked, [], "never of another run's");
  for (const member of ["memo", "taskId"]) assert.match(said[member], new RegExp(`a host tool's api has no ${member}`), `${member} is refused by name`);
});

test("a remote executor's api gives the members a host tool's does but those only a run's Harness has", async () => {
  const { HOST_API_MEMBERS, RUN_ONLY_MEMBERS } = await import("../dist/host-tools.js");
  const { piExecutor } = await import("../dist/workspace/executors.js");
  let keys;
  const tool = { name: "bash", description: "d", parameters: { type: "object" }, async execute(_args, api) { keys = Reflect.ownKeys(api); return {}; } };
  await piExecutor(tool, {}, ctx)({}, {});
  assert.deepEqual([...keys].sort(), HOST_API_MEMBERS.filter((member) => !RUN_ONLY_MEMBERS.includes(member)).sort());
});

test("a long output of multi-byte characters is cut at a character boundary, within maxBytes: its tail, its head, an exact boundary, and a character split across two chunks", async () => {
  const run = { env: async () => ({}) };
  /** The text a host tool answers when its tool writes `chunks` under `limits`. */
  const answer = async (limits, chunks) => {
    const tool = { name: "bash", description: "d", parameters: { type: "object" }, outputLimits: limits, async execute(_args, api) { for (const chunk of chunks) api.output(chunk); return {}; } };
    const [host] = hostTools(run, ["bash"], ctx, new Map(), [tool]);
    return (await host.call({}, { callId: "c", signal: new AbortController().signal })).text;
  };
  const kept = (text, marker) => text.replace(marker, "");
  // 400 bytes of "é" (2 bytes each), its tail cut at 101 bytes: the cut falls inside a character.
  const tail = await answer({ retain: "tail", maxBytes: 101 }, ["é".repeat(200)]);
  assert.ok(!tail.includes("\uFFFD"), JSON.stringify(tail.slice(0, 40)));
  assert.equal(kept(tail, "[earlier output omitted]\n"), "é".repeat(50), "the whole characters within 101 bytes");
  // "日本語" (3 bytes a character), its head cut at 101 bytes: inside the 34th character.
  const head = await answer({ retain: "head", maxBytes: 101 }, ["日本語".repeat(40)]);
  assert.ok(!head.includes("\uFFFD"), JSON.stringify(head.slice(-40)));
  const headKept = kept(head, "\n[later output omitted]");
  assert.ok(Buffer.byteLength(headKept) <= 101);
  assert.equal(headKept, "日本語".repeat(11), "33 characters, 99 bytes");
  // A limit on a character boundary keeps every byte it allows.
  assert.equal(kept(await answer({ retain: "head", maxBytes: 99 }, ["日本語".repeat(40)]), "\n[later output omitted]"), "日本語".repeat(11));
  assert.equal(kept(await answer({ retain: "tail", maxBytes: 99 }, ["日本語".repeat(40)]), "[earlier output omitted]\n"), "日本語".repeat(11));
  // A character whose bytes arrive in two chunks is one character.
  const bytes = Buffer.from("a日b");
  assert.equal(await answer({ retain: "tail" }, [bytes.subarray(0, 2), bytes.subarray(2)]), "a日b");
});

test("a tool answering as pi 1.2's bash does (its retained output asked for, its exit a result diagnostic) answers with that output and the diagnostic", async () => {
  const run = { env: async () => ({}) };
  const bash12 = {
    name: "bash", description: "d", parameters: { type: "object" }, outputLimits: { retain: "tail" },
    async execute(_args, api) {
      api.output("first line\nlast line\n");
      const retained = api.retainedOutput();
      return { structuredOutput: { output: retained.text, truncated: retained.truncated, exitCode: 2 }, isError: true, diagnostics: [{ severity: "error", code: "exit_code", message: "Command exited with code 2" }] };
    },
  };
  const [tool] = hostTools(run, ["bash"], ctx, new Map(), [bash12]);
  assert.deepEqual(await tool.call({}, { callId: "c", signal: new AbortController().signal }), { text: "first line\nlast line\n\n\nCommand exited with code 2", isError: true });
});

test("a run naming no monid tool never reads its claim: the other tools are built from a run with none", () => {
  assert.deepEqual(hostTools({}, ["read", "web_fetch"], ctx, new Map()).map((tool) => tool.name), ["read", "web_fetch"]);
});

test("monid's three go under their wire names: discover and inspect replay-safe, run never; a wire name is not a catalog name", () => {
  const tools = hostTools(RUN, MONID, ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["monid_discover", "safe"], ["monid_inspect", "safe"], ["monid_run", "never"]]);
  assert.deepEqual(tools.map((tool) => tool.inputSchema.required), [["query"], ["provider", "endpoint"], ["provider", "endpoint"]], "monid's own parameters");
  assert.deepEqual(hostTools(RUN, ["monid_run", "monid"], ctx, new Map()), [], "a revision names the catalog name, never the wire name");
});

test("both CLI adapters take the three as they are: names in their alphabet, schemas their own checks pass", (t) => {
  withEnv(t, { AGENTRUN_CLAUDE_AGENT_STANDIN: "1" });
  const spec = { key: "run:x", label: "x", system: ["x"], context: "fresh", tools: hostTools(RUN, ["read", ...MONID], ctx, new Map()) };
  const provider = { origin: "https://api.example", credential: () => "" };
  assert.deepEqual(codexAdapter({ model: "gpt-5.4-mini", provider, standIn: { command: "true" } }).check(spec), []);
  assert.deepEqual(claudeAgentAdapter({ model: "claude-haiku-4-5", provider, standIn: { command: "true" }, sdk: {} }).check(spec), []);
});

test("an error, a refusal and a write's result name a path in the run's directory relative to the workspace (../ beside it); a path outside the run's directory stays as given", () => {
  const work = "/data/runs/01a/work";
  const real = "/real/data/runs/01a/work";
  const cases = [
    [`${work}/../escape.md: outside the workspace ${work}`, "../escape.md: outside the workspace"],
    [`/data/runs/01a/escape.md: outside the workspace ${work}`, "../escape.md: outside the workspace"],
    [`link: outside the workspace ${real} (it resolves to /etc/passwd)`, "link: outside the workspace (it resolves to /etc/passwd)"],
    [`ENOENT: no such file or directory, open '${real}/notes/three.md'`, "ENOENT: no such file or directory, open 'notes/three.md'"],
    [`Successfully wrote to ${work}/hello.md`, "Successfully wrote to hello.md"],
    [`in ${work}`, "in ."],
    // In the run's directory beside the workspace, a longer name than work/ among them: relative to the workspace.
    ["/data/runs/01a/workers/a", "../workers/a"],
    ["/data/runs/01a/store/run.sqlite: outside the workspace", "../store/run.sqlite: outside the workspace"],
    // Outside the run's directory: another run's, a longer name than the run's own, the same path under another
    // directory, and a path elsewhere, each exactly as given.
    ["/data/runs/01b/work/a.md: outside the workspace", "/data/runs/01b/work/a.md: outside the workspace"],
    ["/data/runs/01ab/x", "/data/runs/01ab/x"],
    [`/x${work}/a`, `/x${work}/a`],
    ["/elsewhere/x.md: outside the workspace", "/elsewhere/x.md: outside the workspace"],
  ];
  for (const [given, said] of cases) assert.equal(workspaceRelative(given, [work, real]), said, given);
});

test("a row's file path is named as a whole path: in the run's directory relative to its work/ (spaces, punctuation, a sibling whose name starts with work's, ..), and anywhere else exactly as given", () => {
  const named = rowPaths("/data/runs/r1");
  const cases = [
    ["/data/runs/r1/work/hello.md", "hello.md"],
    ["/data/runs/r1/work/notes/a b, c (1).md", "notes/a b, c (1).md"],
    ["/data/runs/r1/work", "."],
    ["/data/runs/r1/work/", "."],
    // Siblings of work/ in the run's directory, whose names start with work's: never read as work/ itself.
    ["/data/runs/r1/work 2024/a.md", "../work 2024/a.md"],
    ["/data/runs/r1/work2/a.md", "../work2/a.md"],
    ["/data/runs/r1/work.bak", "../work.bak"],
    // .. resolved, in and out of the run's directory.
    ["/data/runs/r1/work/../escape.md", "../escape.md"],
    ["/data/runs/r1/work/sub/../a.md", "a.md"],
    ["/data/runs/r1", ".."],
    ["/data/runs/r1/work/../../r2/work/a.md", "/data/runs/r1/work/../../r2/work/a.md"],
    // Outside the run's directory, or not absolute: as given.
    ["/data/runs/r10/work/a.md", "/data/runs/r10/work/a.md"],
    ["/data/runs/r1x", "/data/runs/r1x"],
    ["/elsewhere/x.md", "/elsewhere/x.md"],
    ["hello.md", "hello.md"],
    ["../outside.md", "../outside.md"],
  ];
  for (const [given, shown] of cases) assert.equal(named(given), shown, given);
  // A run directory that is not absolute names nothing differently.
  assert.equal(rowPaths("runs/r1")("/data/runs/r1/work/a.md"), "/data/runs/r1/work/a.md");
});

test("on another harness (claude-agent), read of a PNG the model rendered in the box's /tmp reaches the model as an image, and one at read's bound fits the strictest platform's", async () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
  // The box runs read's bounded command (`head -c "$2" -- "$1" | base64`) on the one file it holds.
  const env = {
    cwd: "/run/agentrun/run/work",
    exec: async (command, options) => {
      const [, , , , path, limit] = command;
      if (path !== "/tmp/view/frame.png") return { ok: true, value: { exitCode: 1 } };
      options.onOutput?.(PNG.subarray(0, Number(limit)).toString("base64"), {}, { stream: "stdout" });
      return { ok: true, value: { exitCode: 0 } };
    },
  };
  const source = codingSource({ mode: "sandbox", box: "docker" }, { env: async () => env });
  const [read] = hostTools({ env: async () => ({}) }, ["read"], ctx, new Map(), source.tools);
  const answer = await read.call({ path: "/tmp/view/frame.png" }, { callId: "c1", signal: new AbortController().signal });
  assert.equal(answer.isError, false, answer.text);
  assert.deepEqual(answer.images, [{ mimeType: "image/png", data: PNG.toString("base64") }], "the image, not an empty answer");
  assert.match(answer.text, /\/tmp\/view\/frame\.png.*image\/png/);
  // What the claude-agent adapter sends the model with the text (adapter.ts toolImageProblems): accepted.
  assert.equal(toolImageProblems("read", answer.images), undefined);
  // The largest image read answers is still one the adapter sends: its base64 within the adapter's cap.
  assert.ok(Math.ceil(READ_IMAGE_MAX_BYTES / 3) * 4 <= CLAUDE_AGENT_MAX_IMAGE_BYTES, `${READ_IMAGE_MAX_BYTES} bytes is over ${CLAUDE_AGENT_MAX_IMAGE_BYTES} as base64`);
});
