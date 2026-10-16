// Every after / afterEach / before / beforeEach hook of a test file that launches Chrome carries a timeout option. A node:test hook has no timeout of its own and
// `--test-timeout` does not bound one, so one that never settles (an upgraded socket server.close() waits for, a Chrome that never exits) holds the suite slot for
// hours. The check parses each file (the TypeScript parser, no regex over text) and names the file and line of every hook without one.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const HOOKS = new Set(["after", "afterEach", "before", "beforeEach"]);
const TEST_DIR = import.meta.dirname;

/** A file launches Chrome when it is named for a real Chrome, imports the local-Chrome fixture, or imports the cdp provider that starts one. */
export function launchesChrome(fileName, sourceFile) {
  if (/real_chrome/.test(path.basename(fileName))) return true;
  return sourceFile.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && /(?:^|\/)(?:fixtures\/local-chrome\.mjs|providers\/cdp\.js)$/.test(s.moduleSpecifier.text));
}

/** True when `options` is an object literal whose LAST property that sets `timeout` gives it a positive value (not 0, not Infinity), with nothing after that
 *  property that could set it again: a spread or a computed key after it can carry a `timeout` of its own, so a bound is not proven. */
function boundsTheHook(options) {
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const nameOf = (property) => {
    const name = property.name;
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
    return null; // a computed key that is not a literal: it can be any name
  };
  let last = null;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) { last = null; continue; }
    const name = nameOf(property);
    if (name === null) { last = null; continue; }
    if (name === "timeout") last = property;
  }
  if (!last) return false;
  if (ts.isShorthandPropertyAssignment(last)) return true;
  if (!ts.isPropertyAssignment(last)) return false;
  const value = last.initializer;
  if (ts.isNumericLiteral(value)) return Number(value.text.replaceAll("_", "")) > 0;
  return !(ts.isIdentifier(value) && value.text === "Infinity");
}

/** The hooks of a source text that have no timeout: `[{ line, hook }]`. */
export function unboundedHooks(text, fileName = "test.mjs") {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && HOOKS.has(name) && !boundsTheHook(node.arguments[1])) found.push({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1, hook: name });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { found, chrome: launchesChrome(fileName, sourceFile) };
}

test("the checker: a hook is bounded only by an object literal with a positive timeout, and a plain call named like a hook is the checker's business only in a Chrome file", () => {
  const lines = (text) => unboundedHooks(text).found.map((h) => `${h.line}:${h.hook}`);
  assert.deepEqual(lines("after(async () => {});"), ["1:after"]);
  assert.deepEqual(lines("t.afterEach(() => {});\ninner.before(() => {});\nctx.beforeEach(() => {});"), ["1:afterEach", "2:before", "3:beforeEach"]);
  assert.deepEqual(lines("after(fn, { timeout: 30_000 });\nt.after(fn, { timeout });\nafterEach(fn, { 'timeout': 5000, concurrency: 1 });"), [], "bounded");
  assert.deepEqual(lines("after(fn, { timeout: 0 });\nafter(fn, { timeout: Infinity });\nafter(fn, { concurrency: 1 });\nafter(fn, opts);\nafter(fn, { ...opts });"), ["1:after", "2:after", "3:after", "4:after", "5:after"], "no bound proven");
  assert.deepEqual(lines("after(fn, { timeout: 30_000, ...opts });\nafter(fn, { timeout: 30_000, timeout: Infinity });\nafter(fn, { timeout: 30_000, timeout: 0 });\nafter(fn, { timeout: 30_000, [k]: 1 });"), ["1:after", "2:after", "3:after", "4:after"], "a later property can undo the bound");
  assert.deepEqual(lines("after(fn, { ...opts, timeout: 30_000 });\nafter(fn, { timeout: 0, timeout: 30_000 });\nafter(fn, { [\"timeout\"]: 30_000 });"), [], "a spread or an earlier value before the last timeout is overridden by it");
  assert.deepEqual(lines("t.after(async () => {\n  await x();\n},\n{ timeout: 1000 });"), [], "a multi-line hook is read whole");
  assert.deepEqual(lines("t.after(async () => {\n  await x();\n});"), ["1:after"], "and its line is the call's first");
  assert.deepEqual(lines("observer.close(); after2(); const afterwards = 1;"), [], "other names are not hooks");
  assert.equal(unboundedHooks("import { x } from './fixtures/local-chrome.mjs';", "a.test.mjs").chrome, true);
  assert.equal(unboundedHooks("import { cdpProvider } from '../dist/providers/cdp.js';", "a.test.mjs").chrome, true);
  assert.equal(unboundedHooks("", "a_real_chrome.test.mjs").chrome, true);
  assert.equal(unboundedHooks("import { x } from './fixtures/ws-client.mjs';", "a.test.mjs").chrome, false);
});

test("every after/afterEach/before/beforeEach hook of every test file that launches Chrome has a timeout", () => {
  const problems = [];
  let scanned = 0;
  for (const name of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs")).sort()) {
    const { found, chrome } = unboundedHooks(fs.readFileSync(path.join(TEST_DIR, name), "utf8"), name);
    if (!chrome) continue;
    scanned += 1;
    for (const { line, hook } of found) problems.push(`${name}:${line}: ${hook}() has no timeout option`);
  }
  assert.ok(scanned >= 10, `the check found ${scanned} Chrome files: its test of what launches Chrome is broken`);
  assert.deepEqual(problems, [], `give each hook { timeout: 30_000 } (a hook with no timeout can hold the suite slot for hours):\n${problems.join("\n")}`);
});
