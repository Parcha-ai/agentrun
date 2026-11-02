// The host tools a run on another harness gets are pi's, each with the replay the kernel keeps: read, fetch_page and
// web_fetch may run again after a crash, write and edit never (the faux harness does not consult it, so it is checked
// here, where it is set).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hostTools } from "../dist/host-tools.js";

test("read, fetch_page and web_fetch are replay-safe; write and edit never replay; a name pi has no tool for, ask_person or browser, gives none", () => {
  const tools = hostTools({}, ["read", "write", "edit", "fetch_page", "web_fetch", "ask_person", "browser", "bash"], ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["fetch_page", "safe"], ["web_fetch", "safe"]]);
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object", `${tool.name} keeps pi's parameters`);
});

test("in a box the coding source gives read, write, edit and bash (never replayed); the network tools stay this machine's, and a source holding another tool is refused", async () => {
  const { codingSource } = await import("../dist/coding-tools.js");
  const source = codingSource({ mode: "sandbox", box: "docker" }, { env: async () => ({}) });
  const tools = hostTools({}, ["read", "write", "edit", "bash", "fetch_page", "web_fetch"], ctx, new Map(), source.tools);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["bash", "never"], ["fetch_page", "safe"], ["web_fetch", "safe"]]);
  assert.equal(tools.find((tool) => tool.name === "bash").inputSchema.properties.command.type, "string", "pi's bash schema");
  const stray = { ...source.tools[0], name: "fetch_page" };
  assert.throws(() => hostTools({}, ["fetch_page"], ctx, new Map(), [stray]), /holds fetch_page, which is no coding tool/);
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
