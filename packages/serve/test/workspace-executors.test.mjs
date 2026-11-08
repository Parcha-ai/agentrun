// pi's tools as the kernel registry's executors (serve/src/workspace/executors.ts): the answer a host renders from one
// (answerText) is the text a host tool gives today for the same call on the same files: the output kept within the
// tool's limits, the failure's words, then the diagnostics. A failure is the answer's `error`, its output kept, never
// thrown; an abort throws.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hostTools, workspaceRelative } from "../dist/host-tools.js";
import { localWorkspace, shellEnv } from "../dist/workspace/index.js";
import { answerText, piExecutor } from "../dist/workspace/executors.js";
import { bashTool, fileTools, piEnv } from "../dist/workspace/pi-env.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-executors-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  writeFileSync(join(root, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"));
  return root;
}
const tools = () => Object.fromEntries([...fileTools(), bashTool()].map((tool) => [tool.name, tool]));

const CASES = [
  ["read", { path: "a.txt" }], ["read", { path: "big.txt" }], ["read", { path: "nope.txt" }], ["read", { path: "../x" }],
  ["write", { path: "w.txt", content: "w" }], ["edit", { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] }], ["edit", { path: "a.txt", edits: [{ oldText: "zzz", newText: "2" }] }],
  ["bash", { command: "echo hi" }], ["bash", { command: "echo out; exit 3" }], ["bash", { command: "seq 1 5000" }],
  ["bash", { command: "echo before; sleep 30", timeout: 1 }], ["bash", { command: "printf 'é%.0s' $(seq 1 30000)" }],
];

test("an executor's answer, rendered, is a host tool's text for the same call on the same files", async () => {
  const [left, right] = [scratch(), scratch()];
  const envOf = (root) => piEnv(localWorkspace(root), { cwd: "/workspace", env: shellEnv(), defaultTimeoutS: 120 });
  const [leftEnv, rightEnv] = [envOf(left), envOf(right)];
  const host = Object.fromEntries(hostTools({ env: async () => leftEnv }, ["read", "write", "edit", "bash"], ctx, new Map(), Object.values(tools())).map((tool) => [tool.name, tool]));
  const ours = tools();
  for (const [name, args] of CASES) {
    const expected = await host[name].call(args, { callId: `c-${name}`, signal: new AbortController().signal });
    const answer = await piExecutor(ours[name], rightEnv, ctx)(args, {});
    // The spill's file name is random: the two runs name two files.
    const same = (text) => text.replace(/\.agentrun\/output\/[0-9a-f]+\.log/g, ".agentrun/output/<id>.log");
    const text = answer.isError || name === "write" || name === "edit" ? workspaceRelative(answerText(answer), ["/workspace"]) : answerText(answer);
    assert.equal(same(text), same(expected.text), `${name} ${JSON.stringify(args)}`);
    assert.equal(answer.isError === true, expected.isError, `${name} ${JSON.stringify(args)}: isError`);
  }
});

test("an executor keeps a failure's output and says its words apart; streamed output goes to the call's output as it comes; an abort throws", async () => {
  const root = scratch();
  const env = piEnv(localWorkspace(root), { cwd: "/workspace", env: shellEnv(), defaultTimeoutS: 120 });
  const bash = piExecutor(bashTool(), env, ctx);
  const timed = await bash({ command: "echo before; sleep 30", timeout: 1 }, {});
  assert.deepEqual([timed.text, timed.error, timed.isError], ["before\n", "Command timed out after 1 seconds", true]);
  const streamed = [];
  await bash({ command: "echo first; sleep 0.5; echo second" }, { output: (chunk) => streamed.push(chunk) });
  assert.deepEqual(streamed.join(""), "first\nsecond\n");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(bash({ command: "sleep 30" }, { signal: controller.signal }));
});
