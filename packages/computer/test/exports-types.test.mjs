// The package's type exports, held by TypeScript itself: a small module that imports types from the built index
// (dist/index.d.ts) as a caller would must compile with no diagnostic. serve names a phone ledger as PhoneLedger, not as
// ProviderOptions<"phone-harness">["ledger"].
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import ts from "typescript";

const INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));
/** Node's types, as the package's own tsconfig takes them ("types": ["node"]), from the workspace's node_modules. */
const TYPE_ROOTS = [fileURLToPath(new URL("../../../node_modules/@types", import.meta.url))];
const dir = mkdtempSync(join(tmpdir(), "computer-types-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** TypeScript's diagnostics for source, a module importing the package's index, in words. */
function diagnostics(source) {
	const file = join(dir, "caller.ts");
	writeFileSync(file, source.replaceAll("<index>", INDEX));
	const program = ts.createProgram([file], { strict: true, noEmit: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, types: ["node"], typeRoots: TYPE_ROOTS });
	return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("the index exports the phone ledger's types: a store-backed ledger is written against PhoneLedger and PhoneLedgerEntry", () => {
	const found = diagnostics(`
import type { PhoneLedger, PhoneLedgerEntry, ProviderOptions } from "<index>";
const entries = new Map<string, PhoneLedgerEntry>();
export const ledger: PhoneLedger = {
	put: async (entry) => void entries.set(entry.id, entry),
	get: async (id) => entries.get(id),
	list: async () => [...entries.values()],
	remove: async (id) => void entries.delete(id),
};
// The same type the provider's options take.
export const same: ProviderOptions<"phone-harness">["ledger"] = ledger;
export const back: PhoneLedger | undefined = same;
`);
	assert.deepEqual(found, []);
});
