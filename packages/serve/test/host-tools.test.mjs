// The host tools a run on another harness gets are pi's, each with the replay the kernel keeps: read, fetch_page and
// web_fetch may run again after a crash, write and edit never (the faux harness does not consult it, so it is checked
// here, where it is set).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hostTools, workspaceRelative } from "../dist/host-tools.js";
import { rowPaths } from "../dist/workspace-paths.js";

test("read, fetch_page and web_fetch are replay-safe; write and edit never replay; a name pi has no tool for, ask_person or browser, gives none", () => {
  const tools = hostTools({}, ["read", "write", "edit", "fetch_page", "web_fetch", "ask_person", "browser", "bash"], ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["fetch_page", "safe"], ["web_fetch", "safe"]]);
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object", `${tool.name} keeps pi's parameters`);
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
