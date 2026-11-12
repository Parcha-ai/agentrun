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
