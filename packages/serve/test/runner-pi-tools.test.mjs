// A run's host tools as the pi loop's tools (runner/pi-tools.ts piToolsOf): the kernel registry's tools, bound to the run
// by runTools, each given to the pi loop as a PiTool whose run calls it. Read over a real local Workspace with no
// computer, so the run, its answer and its definitions are the registry's own.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { localWorkspace, runTools } from "../dist/workspace/index.js";
import { piToolsOf } from "../dist/runner/pi-tools.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-pi-tools-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}
const signal = () => new AbortController().signal;

test("the run's host tools become pi tools: the registry's names, schemas and replay", async () => {
  const run = await runTools(localWorkspace(scratch()), undefined, { mode: 1, context: ctx });
  after(() => run.end());
  const tools = piToolsOf(run, ["read", "write", "edit", "bash", "web_fetch", "bash_background"]);
  // web_fetch is no registry tool and bash_background needs a computer, so neither is bound; the rest keep their replay.
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replaySafe]), [["read", true], ["write", false], ["edit", false], ["bash", false]]);
  for (const tool of tools) assert.equal(typeof tool.parameters, "object");
});

test("a pi tool's run calls the host tool and gives its answer as the model reads it", async () => {
  const run = await runTools(localWorkspace(scratch()), undefined, { mode: 1, context: ctx });
  after(() => run.end());
  const tools = Object.fromEntries(piToolsOf(run, ["read", "write", "bash"]).map((tool) => [tool.name, tool]));
  // write's answer names the path in the run's folder (relative), as a host renders it.
  assert.equal(await tools.write.run({ path: "a.txt", content: "hi" }, signal()), "Successfully wrote to a.txt");
  assert.equal(await tools.read.run({ path: "a.txt" }, signal()), "hi");
  assert.equal(await tools.bash.run({ command: "cat a.txt" }, signal()), "hi");
});

test("the end sweeps the run's scratch after its tools ran", async () => {
  const root = scratch();
  const run = await runTools(localWorkspace(root), undefined, { mode: 1, context: ctx });
  const [bash] = piToolsOf(run, ["bash"]);
  await bash.run({ command: "echo hello" }, signal());
  await run.end();
  assert.ok(!existsSync(join(root, ".agentrun", "tmp")), "the end swept TMPDIR");
});
