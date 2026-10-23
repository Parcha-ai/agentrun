import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNotRulesLocked, ENTRY_TYPES, inboxPath, inboxWorkflowDir, isRulesLocked, LAYOUT, LEARN_TYPES, LearnError, learningPath, RULES_LOCKED, runBranch, tierOf, usesPath,
} from "../dist/index.js";

test("RULES_LOCKED is agent.json and AGENTS.md, frozen: push, assignment and splice all throw", () => {
  assert.deepEqual([...RULES_LOCKED], ["agent.json", "AGENTS.md"]);
  assert.ok(Object.isFrozen(RULES_LOCKED));
  assert.throws(() => RULES_LOCKED.push("README.md"), TypeError);
  assert.throws(() => { RULES_LOCKED[0] = "notes.md"; }, TypeError);
  assert.throws(() => RULES_LOCKED.splice(0, 1), TypeError);
  assert.deepEqual([...RULES_LOCKED], ["agent.json", "AGENTS.md"]);
  assert.ok(Object.isFrozen(LAYOUT));
  assert.throws(() => LEARN_TYPES.push("note"), TypeError);
  assert.throws(() => ENTRY_TYPES.push("used"), TypeError);
});

test("a rules-tier file is locked at any depth and in any spelling a file system or git could treat as the same name", () => {
  for (const path of [
    "AGENTS.md", "agent.json", "agents.md", "AGENT.JSON", "AGENTS.md.", "AGENTS.md ", "agent.json::$DATA", ".agents/skills/cite/AGENTS.md", "learnings/../AGENTS.md",
    "learnings/agent.json", "learnings\\AGENTS.md", "AGENTS\u200B.md", "\uFF21\uFF27\uFF25\uFF2E\uFF34\uFF33.md", "agent\uFF0Ejson", "AGENT~1.JSO",
  ]) {
    assert.equal(isRulesLocked(path), true, path);
    assert.throws(() => assertNotRulesLocked(["learnings/L-000000000000.md", path]), (e) => e instanceof LearnError && e.code === "rules_locked", path);
  }
  for (const path of ["learnings/L-0123456789ab.md", "AGENTS.markdown", "agents.json", "docs/agent-json.md", ".agents/skills/cite/SKILL.md", "inbox/run-1.md"]) {
    assert.equal(isRulesLocked(path), false, path);
  }
  assert.doesNotThrow(() => assertNotRulesLocked(["learnings/L-0123456789ab.md", "inbox/run-1.md"]));
});

test("tiers and paths: rules, learned, a run's own files, and ids checked before a path is built", () => {
  assert.equal(tierOf("agent.json"), "rules");
  assert.equal(tierOf(".agents/skills/x/AGENTS.md"), "rules");
  assert.equal(tierOf("learnings/L-0123456789ab.md"), "learned");
  assert.equal(tierOf(".agents/skills/cite/SKILL.md"), "learned");
  assert.equal(tierOf(".pi/agentrun/workflows/kyb/latest"), "learned");
  assert.equal(tierOf("inbox/run-1.md"), "run");
  assert.equal(tierOf("uses/run-1.json"), "run");
  assert.equal(tierOf("README.md"), "other");
  assert.equal(runBranch("run-1"), "runs/run-1");
  assert.equal(inboxPath("run-1"), "inbox/run-1.md");
  assert.equal(usesPath("run-1"), "uses/run-1.json");
  assert.equal(learningPath("L-0123456789ab"), "learnings/L-0123456789ab.md");
  assert.equal(inboxWorkflowDir("run-1", "kyb-us-registry"), "inbox/run-1/workflows/kyb-us-registry/");
  for (const bad of ["", "KYB", "a.b", "../x", "-x", "x".repeat(65)]) assert.throws(() => inboxWorkflowDir("run-1", bad), { code: "invalid" }, JSON.stringify(bad));
  for (const bad of ["", "../x", "a/b", "-x", "x".repeat(129), "run 1", "a..b", "run.", "run.lock", ".run"]) {
    assert.throws(() => inboxPath(bad), (e) => e instanceof LearnError && e.code === "invalid", JSON.stringify(bad));
    assert.throws(() => runBranch(bad), { code: "invalid" }, JSON.stringify(bad));
  }
  for (const bad of ["L-0123", "L-0123456789AB", "x-0123456789ab", "L-0123456789ab/../x"]) assert.throws(() => learningPath(bad), { code: "invalid" });
});

test("the package's source and tests are plain ASCII: every other character is written as an escape", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = [];
  for (const dir of ["src", "test", "test/fixtures"]) for (const name of await readdir(`${root}${dir}`)) if (/\.(ts|mjs)$/.test(name)) files.push(`${dir}/${name}`);
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = await readFile(`${root}${file}`, "utf8");
    const at = text.search(/[^\t\n\r\x20-\x7E]/);
    assert.equal(at, -1, `${file} holds U+${at < 0 ? "" : text.codePointAt(at).toString(16).toUpperCase()} at offset ${at}`);
  }
});
