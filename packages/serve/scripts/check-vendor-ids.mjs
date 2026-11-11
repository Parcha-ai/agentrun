// Serve knows no computer vendor: the computer package's descriptors say what each provider takes (its keys and the
// option each fills, its settings, a ledger, a local host, prepareImage), and serve reads them, never a provider's id.
// This finds every string literal in serve/src that is a provider id of the computer package (its built-ins), read by
// TypeScript's parser, so a comment or a word in a longer string is never one. Two things are not:
//  - the command a child process runs (the first argument of execFile, execFileSync, spawn or spawnSync): `docker` the
//    CLI, not the provider;
//  - the literals BASELINE counts in a file today: the old stacks a named sprint item removes (S6 is CP-4: the browser
//    tool and sign-ins on pi-browser; S7 is DEL-03: the box stack on pi-transport), and named false positives. Never a
//    whole file: a file that gains one more of an id than its baseline fails, and one with fewer fails too, asking for
//    its baseline to be lowered, so the count only goes down. Any file not in it fails on its first.
// test/no-vendor-ids.test.mjs runs baselineProblems() on src/.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The provider id literals each file under src/ holds today, by id, and why: the sprint item that removes them, or why
 * one is not a provider at all. Lower a count when its item removes some; never raise one.
 */
export const BASELINE = {
	// S7, DEL-03: the old box stack (pi-transport's Docker, Daytona and Modal boxes, and bwrap), its ids in the API.
	"boxes.ts": { ids: { docker: 9, daytona: 7, modal: 1 }, why: "DEL-03 (S7): the old box stack" },
	"place.ts": { ids: { docker: 4, daytona: 2 }, why: "DEL-03 (S7): the old box stack's places" },
	"box-egress-vm.ts": { ids: { kernel: 2 }, why: "a false positive: the OS's kernel (vmDocker's `kernel` option), not the provider" },
	"box-settings.ts": { ids: { kernel: 1 }, why: "a false positive: the OS's kernel (vmDocker's `kernel` option, passed on), not the provider" },
	"openapi.ts": { ids: { kernel: 2 }, why: "CP-4 (S6): the browser plane's provider enum in the API" },
	"server.ts": { ids: { docker: 9, daytona: 3, browserbase: 4, kernel: 4 }, why: "DEL-03 (S7) and CP-4 (S6): the box stack's wiring, and the browser tool's default provider" },
	// S6, CP-4: the browser tool and sign-in profiles on pi-browser, beside the computer package's browser kind.
	"tool-plane.ts": { ids: { browserbase: 11, kernel: 14 }, why: "CP-4 (S6): the browser tool's providers on pi-browser" },
	"tools.ts": { ids: { browserbase: 1, kernel: 1 }, why: "CP-4 (S6): the browser tool on pi-browser" },
	"sign-ins.ts": { ids: { kernel: 3 }, why: "CP-4 (S6): sign-in profiles over the browser vendors' REST" },
	"handed-values.ts": { ids: { browserbase: 1, kernel: 1 }, why: "CP-4 (S6): the browser vendors that keep a sign-in, for a learning read's cut" },
	"sign-ins-store.ts": { ids: { browserbase: 4, kernel: 3 }, why: "CP-4 (S6): sign-in profiles over the browser vendors' REST" },
	"key-words.ts": { ids: { browserbase: 1, kernel: 1 }, why: "CP-4 (S6): the browser tool's keys on pi-browser" },
	"key-check.ts": { ids: { browserbase: 1, kernel: 1 }, why: "CP-4 (S6): the browser tool's key checks on pi-browser" },
	"browser-cost.ts": { ids: { browserbase: 1, kernel: 1 }, why: "CP-4 (S6): the browser tool's list prices by pi-browser provider" },
	"run-reads-over-store.ts": { ids: { browserbase: 1 }, why: "CP-4 (S6): a run's browser plane, Browserbase by default" },
};

/** The calls whose first argument is a command a child process runs, not an id. */
const COMMANDS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);

/** Whether `node` is the first argument of a call to one of COMMANDS (by name, or as a member: child.execFile). */
function isCommand(node) {
	const call = node.parent;
	if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) return false;
	const callee = call.expression;
	const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
	return name !== undefined && COMMANDS.has(name);
}

/** Every literal in `source` (the file's text, `file` its path for the report) that is one of `ids`. */
export function scan(source, file, ids) {
	const found = [];
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const hit = (node, id) => {
		const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		found.push({ file, line: line + 1, id });
	};
	const visit = (node) => {
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ids.includes(node.text) && !isCommand(node)) hit(node, node.text);
		// A key of an object literal written as a bare name (`{ docker: [...] }`) names the provider as well as a string does.
		else if (ts.isIdentifier(node) && ids.includes(node.text) && node.parent && (ts.isPropertyAssignment(node.parent) || ts.isShorthandPropertyAssignment(node.parent)) && node.parent.name === node) hit(node, node.text);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

/** Every provider id literal in the .ts files under `root` (serve's src/); paths relative to `root`. */
export async function vendorIdLiterals(root, ids) {
	const found = [];
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
				found.push(...scan(await readFile(path, "utf8"), relative(root, path).split(sep).join("/"), ids));
			}
		}
	};
	await walk(root);
	return found;
}

/**
 * How the literals found differ from `baseline` (BASELINE), one sentence each: a file or an id with more than its
 * baseline (naming each line), or with fewer (lower the baseline), or a baseline file that is gone. [] when they match.
 */
export function baselineProblems(found, baseline = BASELINE) {
	const counts = {};
	for (const { file, id } of found) ((counts[file] ??= {})[id] = (counts[file]?.[id] ?? 0) + 1);
	const problems = [];
	for (const file of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
		const have = counts[file] ?? {};
		const allowed = baseline[file]?.ids ?? {};
		for (const id of new Set([...Object.keys(have), ...Object.keys(allowed)])) {
			const n = have[id] ?? 0;
			const base = allowed[id] ?? 0;
			if (n > base) {
				const lines = found.filter((one) => one.file === file && one.id === id).map((one) => one.line).join(", ");
				problems.push(`${file} names the provider "${id}" ${n} time${n === 1 ? "" : "s"} (lines ${lines}), ${base === 0 ? "and may name none" : `above its baseline of ${base}`}: read what it needs from the provider's descriptor instead`);
			} else if (n < base) {
				problems.push(`${file} names "${id}" ${n} time${n === 1 ? "" : "s"}, below its baseline of ${base} (${baseline[file].why}): lower BASELINE in scripts/check-vendor-ids.mjs to ${n}`);
			}
		}
	}
	return problems;
}

/** serve's src/. */
export const SRC = fileURLToPath(new URL("../src", import.meta.url));
