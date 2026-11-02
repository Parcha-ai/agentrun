// The host tools a run on another harness gets are pi's, each with the replay the kernel keeps: read, fetch_page and
// web_fetch may run again after a crash, write and edit never (the faux harness does not consult it, so it is checked
// here, where it is set).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hostTools, workspaceRelative } from "../dist/host-tools.js";

test("read, fetch_page and web_fetch are replay-safe; write and edit never replay; a name pi has no tool for, ask_person or browser, gives none", () => {
  const tools = hostTools({}, ["read", "write", "edit", "fetch_page", "web_fetch", "ask_person", "browser", "bash"], ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["fetch_page", "safe"], ["web_fetch", "safe"]]);
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object", `${tool.name} keeps pi's parameters`);
});

test("an error, a refusal and a write's result name a path in the workspace relative to it; a path beside it by ../; no other path, and no file's text, is changed", () => {
  const work = "/data/runs/01a/work";
  const real = "/real/data/runs/01a/work";
  const cases = [
    [`${work}/../escape.md: outside the workspace ${work}`, "../escape.md: outside the workspace"],
    [`/data/runs/01a/escape.md: outside the workspace ${work}`, "../escape.md: outside the workspace"],
    [`link: outside the workspace ${real} (it resolves to /etc/passwd)`, "link: outside the workspace (it resolves to /etc/passwd)"],
    [`ENOENT: no such file or directory, open '${real}/notes/three.md'`, "ENOENT: no such file or directory, open 'notes/three.md'"],
    [`Successfully wrote to ${work}/hello.md`, "Successfully wrote to hello.md"],
    [`in ${work}`, "in ."],
    // Not the workspace: a longer name, the same name under another directory, and a path elsewhere.
    ["/data/runs/01a/workers/a", "/data/runs/01a/workers/a"],
    [`/x${work}/a`, `/x${work}/a`],
    ["/srv/other/x.md: outside the workspace", "/srv/other/x.md: outside the workspace"],
  ];
  for (const [given, said] of cases) assert.equal(workspaceRelative(given, [work, real]), said, given);
});
