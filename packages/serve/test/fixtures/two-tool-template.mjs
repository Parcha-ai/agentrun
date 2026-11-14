// A template package for the consent tests: it uses two tools of the MCP server `fake` (fake-mcp-server.mjs's add and
// delete_thing), asks the owner to allow add alone, and runs unattended (approvals never), so an apply that ticks add
// shows what happens to the tool left unticked.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The package written under `dir` as `name` (on `harness`, when given): its folder. */
export function twoToolPackage(dir, name, harness) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "agent.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: Uses two tools of the fake MCP server and runs unattended.\n${harness ? `harness: [${harness}]\n` : ""}mcp:\n  - source: url\n    toolkit: fake\n    tools: [add, delete_thing]\n    required: true\n    allow: [add]\napprovals: never\n---\nCall the tool you are asked to call.\n`);
  return join(dir, name);
}
