import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOCKED } from "../dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRINCIPLE = "A workflow draft uses DSL model, judge and tool-call nodes with the host's tools only: never a harness's built-in tool, and never a code, shell or executor node.";
const LOCKED_NAMES = ["AGENTS.md", "agent.json", ".agents/skills/reflect/", ".agents/skills/review/", ".agentrun/", ".githooks/", ".husky/", ".github/", "package.json", "SPEC.md"];

/** The skill's text, or "" when the file is missing (the test that reads it then fails on its assertion). */
const skill = (name) => {
  const path = join(ROOT, "skills", name, "SKILL.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const frontMatter = (text) => Object.fromEntries((/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "").split("\n").map((line) => /^([a-z-]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));

for (const name of ["reflect", "review"]) {
  test(`the ${name} skill parses: front matter with its name and a description`, () => {
    const text = skill(name);
    assert.ok(text, `skills/${name}/SKILL.md exists`);
    const head = frontMatter(text);
    assert.equal(head.name, name);
    assert.ok((head.description ?? "").length > 20, "a description that says when to use it");
  });

  test(`the ${name} skill names every locked path and the checker`, () => {
    const text = skill(name);
    for (const locked of LOCKED_NAMES) assert.ok(text.includes(`\`${locked}\``), `${name} names ${locked}`);
    for (const locked of [...LOCKED.names, ...LOCKED.prefixes]) assert.ok(text.includes(locked), `${name} names ${locked}, a path the checker locks`);
    assert.match(text, /agentrun-learn check --base /);
  });

  test(`the ${name} skill carries the principle line and names no harness's built-in tool`, () => {
    const text = skill(name);
    assert.ok(text.includes(PRINCIPLE), `${name} carries the principle line verbatim`);
    for (const tool of ["Bash", "Read", "Edit", "Write", "WebFetch", "apply_patch", "exec_command", "shell_command", "read_file"]) {
      assert.ok(!new RegExp(`\\b${tool}\\b`).test(text.replace(PRINCIPLE, "")), `${name} names no built-in tool such as ${tool}`);
    }
  });
}

test("reflect writes the memo's four sections on runs/<run id>, and fills front matter from git only outside a host", () => {
  const text = skill("reflect");
  for (const section of ["## What happened", "## What I learned", "## What could be better", "## Proposed changes"]) assert.ok(text.includes(section), section);
  assert.match(text, /runs\/<run id>/);
  assert.match(text, /git rev-parse/);
  assert.match(text, /cost_usd/);
  assert.match(text, /never (?:guess|estimate)/i);
});

test("review runs the checker, needs the injection screen, asks the curator's questions and merges with a merge commit", () => {
  const text = skill("review");
  assert.match(text, /injection screen/i);
  assert.match(text, /not merged: no injection screen/);
  for (const question of ["General", "Narrows the rules", "From content", "Duplicate", "Supersedes", "Contradicts", "Workflow case"]) assert.ok(text.includes(`**${question}**`), question);
  assert.match(text, /git merge --no-ff/);
  assert.match(text, /never force-push/i);
  assert.match(text, /## Review/);
});

test("the package ships both skills", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("skills"), "package.json files holds skills");
});
