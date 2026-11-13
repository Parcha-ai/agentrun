// The generated surface: computer.d.ts and the kernel's tool schemas match api.ts (the generator's --check), and a
// script typed against the declarations compiles (the kernel's tests hold the declarations split by group).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const root = new URL("../../../", import.meta.url).pathname;

test("spec/computer/computer.d.ts and the kernel's computer-surface module match api.ts", async () => {
	const checked = await new Promise((resolve) => execFile(process.execPath, ["scripts/generate-computer-surface.mjs", "--check"], { cwd: root, timeout: 120_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
	assert.equal(checked.error, null, `${checked.stdout}${checked.stderr}`);
});

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

const SCRIPT = `
const notes = computer.app("com.apple.Notes");
const state = await notes.observe({ image: true });
const [field] = notes.find({ role: "textbox", text: /title/i });
await notes.act([{ set: field.ref, value: "Groceries" }, { key: "super+s" }], { state: state.id, expect: { text: "Saved" } });
await notes.click([10, 20], { count: 2 });
const shot = await computer.screen.shot({ region: [0, 0, 100, 100] });
const run = await computer.shell.run(["ls", "-la"]);
return { outline: state.outline, width: shot.width, code: run.exitCode, apps: (await computer.apps.list()).apps.length };
`;

test("a script typed against computer.d.ts compiles, and a wrong step does not", () => {
	const declarations = readFileSync(new URL("../../../spec/computer/computer.d.ts", import.meta.url), "utf8");
	assert.deepEqual(errorsOf(declarations, SCRIPT), []);
	assert.notDeepEqual(errorsOf(declarations, `await computer.app("x").act([{ tap: "@e1" }]);`), []);
});
