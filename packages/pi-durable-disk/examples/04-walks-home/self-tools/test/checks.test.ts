// The checks decide what counts as done and what enters training, so their edges are tested here. Nothing in these
// tests runs a script: checks that would are outside the sandbox guard's reach only through pure helpers.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { missingCommands } from "../commands.ts";
import { checkInstance, ranScript, type Instance } from "../tasks.ts";

const dirWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "self-tools-check-"));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
};
const inst = (template: string, params: Record<string, unknown>, prompt = "", files: Record<string, string> = {}): Instance =>
  ({ id: "t", template, split: "train", prompt, files, params });
const bash = (command: string) => ({ name: "bash", arguments: { command } });

test("a script counts as run only when the model ran it with node", () => {
  assert.equal(ranScript({ dir: "", answer: "", calls: [bash("node say.js")] }, "say.js"), null);
  assert.equal(ranScript({ dir: "", answer: "", calls: [bash("node ./say.js && echo ok")] }, "say.js"), null);
  assert.match(ranScript({ dir: "", answer: "", calls: [bash("node -e 'console.log(1)'"), bash("cat say.js")] }, "say.js")!, /never run/);
  assert.match(ranScript({ dir: "", answer: "", calls: [bash("node say.jsx")] }, "say.js")!, /never run/);
});

test("the biggest file is the biggest by bytes, not by lines", () => {
  const files = { "d/many.txt": "a\nb\nc\nd\n", "d/long.txt": "one rather long line of text\n" };
  const i = inst("find-largest", { big: "many.txt" }, "Which file in d is the biggest?", files);
  assert.equal(checkInstance(i, { dir: dirWith({}), answer: "long.txt is the biggest." }), null);
  assert.match(checkInstance(i, { dir: dirWith({}), answer: "many.txt is the biggest." })!, /long\.txt/);
});

test("near-miss text must be the whole requested text", () => {
  const i = inst("near-miss", { t: "text" }, `Create online.txt saying "back at 9 o'clock".`);
  assert.match(checkInstance(i, { dir: dirWith({ "online.txt": "back at\n" }), answer: "" })!, /online\.txt/);
  assert.equal(checkInstance(i, { dir: dirWith({ "online.txt": "back at 9 o'clock\n" }), answer: "" }), null);
});

test("adding a todo must keep every old item as it was", () => {
  const todos = [{ title: "pay rent", done: true }, { title: "walk the dog", done: false }];
  const i = inst("json-add-todo", { todos, t: "buy a gift" });
  const ok = [...todos, { title: "buy a gift", done: false }];
  assert.equal(checkInstance(i, { dir: dirWith({ "todos.json": JSON.stringify(ok) }), answer: "" }), null);
  const reordered = [{ done: true, title: "pay rent" }, { done: false, title: "walk the dog" }, { done: false, title: "buy a gift" }];
  assert.equal(checkInstance(i, { dir: dirWith({ "todos.json": JSON.stringify(reordered) }), answer: "" }), null);
  const damaged = [{ title: "pay rent", done: false }, todos[1], { title: "buy a gift", done: false }];
  assert.match(checkInstance(i, { dir: dirWith({ "todos.json": JSON.stringify(damaged) }), answer: "" })!, /todos\.json/);
});

test("missing commands are found inside $(...), backticks and bash -c, not inside single quotes", () => {
  assert.deepEqual(missingCommands(`echo "$(grep -c apples notes.txt)"`), ["grep"]);
  assert.deepEqual(missingCommands("echo `find . -name x`"), ["find"]);
  assert.deepEqual(missingCommands(`bash -c "sed -n 2p f"`), ["sed"]);
  assert.deepEqual(missingCommands(`echo '$(grep x)'`), []);
  assert.deepEqual(missingCommands(`echo 'bash -c "grep x"'`), []);
  assert.deepEqual(missingCommands(`echo "run: bash -c 'find .'"`), []);
  // An escaped backslash closes the quote before a real bash -c (bash's own escape rules). An escaped quote outside
  // quotes opens nothing, so the bash -c after it counts; the check is conservative there (it may drop a run that only
  // prints the words, never keep one that runs a missing command).
  assert.deepEqual(missingCommands(String.raw`echo "\\"; bash -c "grep -c apples notes.txt"`), ["grep"]);
  assert.deepEqual(missingCommands(String.raw`echo \"bash -c 'sed 2p f'`), ["sed"]);
  assert.deepEqual(missingCommands(`wc -l "$(ls -1 | head -n 1)"`), []);
});
