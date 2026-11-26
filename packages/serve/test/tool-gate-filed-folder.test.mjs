// The folder a tool's file setting files its answers in (filed-tool.ts) is kept from the agent's own file tools: the tool
// gate refuses a call of read, write or edit (pi's and the kernel's `path`, claude-agent's Read, Write and Edit
// `file_path`, a computer script's files ops held as read or write, a screenshot's save_as) whose path is at or under a
// folder the revision's own `mcp:<server>/<tool>` setting names, in that run, in words that name the setting. The check is
// lexical, against the run's folder by both its names (this machine's path, the computer's /workspace): `..` and `./`
// spellings that land inside are refused; a sibling, a folder whose name only starts the same, an ancestor, and a skill
// file (read_skill_file reads the agent's skill, not the run's files) are not. No file is read, so a link is not followed.
// bash is not gated by path (no word check on shell text holds: a glob, cd, a variable or a link gets around one).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runnerGate, verdictOf } from "./gate-support.mjs";

const RUN = "/nonexistent/run";
const KEY = "mcp:stripe/list_charges";
/** The agent's own settings: list_charges files its answers in stripe/pages. */
const FILED = { [KEY]: { file: { folder: "stripe/pages", show: ["has_more"] } } };
const ALLOW = { read: { permission: "allow" }, write: { permission: "allow" }, edit: { permission: "allow" }, bash: { permission: "allow" }, desktop: { permission: "allow" } };
const NOT_RUN = "It was not run: nothing was sent and nothing was charged.";
/** The refusal of `tool` at `given`. */
const refusal = (tool, given) => `${tool} can't be called: ${given} is in stripe/pages/, the folder this agent's setting for ${KEY} files that tool's answers in (its file setting), so the agent's own file tools are refused there. ${NOT_RUN}`;

const gateOn = (harness, overrides = FILED) => runnerGate({ settings: ALLOW, overrides, harness, root: RUN, tools: ["read", "write", "edit", "bash"] });

test("read, write and edit (path) are refused at or under a filed folder, in words that name the setting; `..`, ./ and absolute spellings that land inside are refused", async () => {
  const gate = gateOn("pi");
  for (const given of ["stripe/pages/list_charges-1.json", "stripe/pages", "stripe/pages/", "./stripe/pages/a.json", "notes/../stripe/pages/a.json", "stripe/./pages/sub/a.json", `${RUN}/stripe/pages/a.json`, "/workspace/stripe/pages/a.json", "/workspace/notes/../stripe/pages"]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), refusal("read", given), `read ${given}`);
  }
  assert.equal(await verdictOf(gate, "edit", { path: "stripe/pages/a.json", edits: [] }), refusal("edit", "stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "write", { path: "./stripe/pages/a.json", content: "x" }), refusal("write", "./stripe/pages/a.json"));
});

test("claude-agent's Read, Write and Edit (file_path) are refused alike", async () => {
  const gate = gateOn("claude-agent");
  assert.equal(await verdictOf(gate, "Read", { file_path: "/workspace/stripe/pages/a.json" }), refusal("read", "/workspace/stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "Edit", { file_path: "stripe/pages/a.json", old_string: "a", new_string: "b" }), refusal("edit", "stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "Write", { file_path: `${RUN}/stripe/pages/b.json`, content: "x" }), refusal("write", `${RUN}/stripe/pages/b.json`));
});

test("a computer script's files ops held as read or write, and a screenshot's save_as, are refused in the folder; a listing of an ancestor is not", async () => {
  const gate = gateOn("pi");
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.read", args: { path: "stripe/pages/a.json" } }), refusal("read", "stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.list", args: { path: "/workspace/stripe/pages" } }), refusal("read", "/workspace/stripe/pages"));
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.list", args: { path: "stripe" } }), "allow", "an ancestor's listing names files, never their text");
  const shot = await verdictOf(gate, "computer_screenshot", { save_as: "stripe/pages/shot.png" });
  assert.ok(shot.startsWith(refusal("write", "stripe/pages/shot.png")), shot);
});

test("a sibling, a folder whose name only starts the same, an ancestor, the rest of the run's files, a path outside the run's folder and a skill file are not refused", async () => {
  const gate = gateOn("pi");
  for (const given of ["stripe/other.json", "stripe/pages-old/a.json", "stripe/pagesX", "stripe", ".", "notes.md", "stripe/pages/../summary.json", "/tmp/stripe/pages/a.json", `${RUN}/stripe/notes.md`]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), "allow", `read ${given}`);
  }
  assert.equal(await verdictOf(gate, "read_skill_file", { path: "stripe/pages/SKILL.md" }), "allow", "a skill file is the agent's, not the run's files");
});

test("with no file setting, or one on the server's settings alone, nothing is refused for a folder; bash is not gated by path", async () => {
  const plain = gateOn("pi", {});
  assert.equal(await verdictOf(plain, "read", { path: "stripe/pages/a.json" }), "allow");
  const serverOnly = runnerGate({ settings: { ...ALLOW, [KEY]: { permission: "allow" } }, overrides: {}, harness: "pi", root: RUN });
  assert.equal(await verdictOf(serverOnly, "read", { path: "stripe/pages/a.json" }), "allow");
  assert.equal(await verdictOf(gateOn("pi"), "bash", { command: "cat stripe/pages/a.json" }), "allow", "bash is held to its permission alone");
});

test("two filed tools: each folder is refused, and the words name the setting whose folder it is", async () => {
  const gate = gateOn("pi", { ...FILED, "mcp:stripe/list_customers": { file: { folder: "customers", show: [] } } });
  assert.equal(await verdictOf(gate, "read", { path: "customers/a.json" }), `read can't be called: customers/a.json is in customers/, the folder this agent's setting for mcp:stripe/list_customers files that tool's answers in (its file setting), so the agent's own file tools are refused there. ${NOT_RUN}`);
  assert.equal(await verdictOf(gate, "read", { path: "stripe/pages/a.json" }), refusal("read", "stripe/pages/a.json"));
});
