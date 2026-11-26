// A template package for the consent tests: it uses two tools of the MCP server `fake` (fake-mcp-server.mjs's add, a read,
// and delete_thing, a destructive write), asks the owner to allow add alone, and runs unattended (approvals never) unless
// told otherwise, so an apply that ticks one shows what happens to the tool ticked and the tool left unticked.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The package written under `dir` as `name` (on `harness`, when given; its approvals `approvals`): its folder. It names
 *  its tools (none: the ticked MCP tools are its own), unless `bare`: one that names none is given Docker's box, and is
 *  refused where a server has none and its runner no shell. */
export function twoToolPackage(dir, name, harness, approvals = "never", { bare = false } = {}) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "agent.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: Uses two tools of the fake MCP server.\n${bare ? "" : "tools: []\n"}${harness ? `harness: [${harness}]\n` : ""}mcp:\n  - source: url\n    toolkit: fake\n    tools: [add, delete_thing]\n    required: true\n    allow: [add]\napprovals: ${approvals}\n---\nCall the tool you are asked to call.\n`);
  return join(dir, name);
}
