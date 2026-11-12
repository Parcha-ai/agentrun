// The `computer` object's declarations a run's computer_script reads (computer-surface.generated.ts): a script typed
// against them compiles, and a computer's declarations hold only the members its groups offer.
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { computerDeclarations } from "@parcha/agentrun-kernel/kernel";

/** The type errors of `script` (an async function's body) against these declarations. */
function errorsOf(declarations, script) {
  const files = { "/computer.d.ts": declarations, "/script.ts": `export {};\nasync function main(): Promise<unknown> {\n${script}\n}\nvoid main;\n` };
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => (files[name] !== undefined ? ts.createSourceFile(name, files[name], version) : read(name, version));
  host.fileExists = (name) => files[name] !== undefined || ts.sys.fileExists(name);
  host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
  const program = ts.createProgram(Object.keys(files), options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

test("a computer's declarations offer only its groups' members, and each compiles alone", () => {
  const shellOnly = computerDeclarations(["exec", "files"]);
  assert.deepEqual(errorsOf(shellOnly, `return (await computer.shell.run("ls")).stdout + (await computer.files.read("/etc/hosts"));`), []);
  assert.match(errorsOf(shellOnly, `return computer.app("x");`).join("\n"), /Property 'app' does not exist/);
  assert.deepEqual(errorsOf(computerDeclarations(["screen", "input.touch"]), `return computer.input.act([{ type: "tap", at: [1, 2] }]);`), []);
  const mac = computerDeclarations(["ui", "screen", "apps", "exec", "files", "input.pointer", "input.keys"]);
  assert.deepEqual(errorsOf(mac, `await computer.apps.open("com.apple.Notes"); const notes = computer.app("com.apple.Notes"); await notes.observe(); return notes.find({ role: "button" }).map((node) => node.ref);`), []);
});

test("a computer's declarations hold only the types its members reach: no element types without the ui group", () => {
  const screenOnly = computerDeclarations(["screen", "input.pointer", "input.keys"]);
  assert.doesNotMatch(screenOnly, /interface UiNode|type UiStep|interface App /);
  assert.match(screenOnly, /type InputAction/);
  const mac = computerDeclarations(["ui", "screen", "input.pointer"]);
  assert.match(mac, /interface UiNode/);
  assert.match(mac, /type UiStep/);
});

test("a ui computer's declarations offer no raw input, and read compactly: no comments, one line each, steps named once by computer_act", () => {
  const mac = computerDeclarations(["ui", "screen", "apps", "input.pointer", "input.keys"]);
  assert.doesNotMatch(mac, /readonly input|type InputAction/, "a ui computer's steps reach what raw input would");
  assert.match(errorsOf(mac, `return computer.input.act([]);`).join("\n"), /Property 'input' does not exist/);
  assert.doesNotMatch(mac, /\/\*\*/, "no doc comments: the kind skill and the tools' words say them");
  assert.match(mac, /^type UiStep = object; \/\/ computer_act's steps$/m);
  assert.match(mac, /^interface App \{ [^\n]* \}$/m, "one line a declaration");
  assert.ok(mac.length < 3_000, `a Mac's declarations stay short: ${mac.length} characters`);
});
