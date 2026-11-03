// The host tools a run on another harness gets are pi's, each with the replay the kernel keeps: read, fetch_page and
// web_fetch, and monid's discover and inspect, may run again after a crash; write, edit and monid.run never (the faux
// harness does not consult it, so it is checked here, where it is set). Each goes to the harness under its wire name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { claudeAgentAdapter } from "@parcha/agentrun-harness-claude";
import { codexAdapter } from "@parcha/agentrun-harness-codex";
import { hostTools, workspaceRelative } from "../dist/host-tools.js";
import { withEnv } from "./support.mjs";

/** The run a host tool is built for: only its work directory is read, and nothing here calls a tool. */
const RUN = { claim: { work: "/nonexistent/work" } };
const MONID = ["monid.discover", "monid.inspect", "monid.run"];

test("read, fetch_page and web_fetch are replay-safe; write and edit never replay; a name pi has no tool for, ask_person or browser, gives none", () => {
  const tools = hostTools(RUN, ["read", "write", "edit", "fetch_page", "web_fetch", "ask_person", "browser", "bash"], ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["fetch_page", "safe"], ["web_fetch", "safe"]]);
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object", `${tool.name} keeps pi's parameters`);
});

test("a run naming no monid tool never reads its claim: the other tools are built from a run with none", () => {
  assert.deepEqual(hostTools({}, ["read", "fetch_page", "web_fetch"], ctx, new Map()).map((tool) => tool.name), ["read", "fetch_page", "web_fetch"]);
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
