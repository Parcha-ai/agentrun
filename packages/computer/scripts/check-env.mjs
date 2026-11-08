// The library reads no environment: every setting of a provider, its key included, is an option of create(options). Only
// src/conformance/ (the conformance CLI, its per-provider modules and the sweeps) reads names from an environment, its own
// COMPUTER_* names, and passes them in. Two lines are the exception, each a vendor SDK's own reading of the environment
// that the library guards against (README, Settings): Modal's MODAL_SERVER_URL in modalClient, which the SDK reads
// for its server, refused when set and pinned around the client's construction; and E2B's E2B_SANDBOX_URL in
// ambientProblem, which the SDK would send every sandbox call to, refused when set. GUARDS names each by file, function
// and variable, and nothing else is allowed.
//
// Source is read by TypeScript's parser, as scripts/check-direction.mjs reads it, so a comment, a string or a regular
// expression is never a read, and no spelling of one gets past: process.env, process["env"], `const { env } = process`,
// globalThis.process, an alias of process or globalThis, a parameter or binding that shadows process, and an import or
// require of the process module are all reads. Any use of process but a named member other than env is one, so a new
// spelling fails closed. test/providers.test.mjs runs checkEnv() on src/, and scan() on fixtures of every evasion.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The only reads allowed: the file under src/, the function that holds the read, and the one variable it names. */
export const GUARDS = [
	{ file: "modal.ts", fn: "modalClient", name: "MODAL_SERVER_URL", why: "the Modal SDK reads MODAL_SERVER_URL for its server: refused while set, and set only around the client's construction" },
	{ file: "e2b.ts", fn: "ambientProblem", name: "E2B_SANDBOX_URL", why: "the E2B SDK sends every sandbox call to E2B_SANDBOX_URL when it is set, and no option clears it: refused while set" },
];

/** The directory under src/ whose files may read the environment: the conformance CLI's side. */
export const READER = "conformance";

const GLOBALS = new Set(["globalThis", "global", "window", "self"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);

/** The node under any parentheses, type assertions, non-null assertions and satisfies. */
function outer(node) {
	let at = node;
	while (at.parent && (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isTypeAssertionExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isSatisfiesExpression(at.parent))) at = at.parent;
	return at;
}

/** The member a property or element access names, as written: a literal name, or undefined when it is computed. */
function memberName(access) {
	if (ts.isPropertyAccessExpression(access)) return access.name.text;
	const argument = access.argumentExpression;
	return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument) ? argument.text : undefined;
}

const isAccess = (node) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

/** The access whose object is node (under parentheses and assertions), or undefined when node is used another way. */
function accessOf(node) {
	const at = outer(node);
	return at.parent && isAccess(at.parent) && at.parent.expression === at ? at.parent : undefined;
}

/** Whether this identifier is a name being declared, or a property's name, rather than a reference to a value. */
function isNameOnly(id) {
	const parent = id.parent;
	if (!parent) return true;
	if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
	if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isEnumMember(parent)) && parent.name === id) return true;
	if (ts.isBindingElement(parent) && parent.propertyName === id) return true;
	if ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && parent.propertyName === id) return true;
	if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
	return false;
}

/** Whether this identifier declares a binding: a variable, parameter, function, class or import of that name. */
function declares(id) {
	const parent = id.parent;
	if (!parent || parent.name !== id) return false;
	return ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
}

/** The name of the nearest named function around node: a declaration, a method, or a function bound to a name. */
function functionOf(node) {
	for (let at = node.parent; at; at = at.parent) {
		if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isFunctionExpression(at)) && at.name) return at.name.text;
		if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && at.parent && ts.isVariableDeclaration(at.parent) && ts.isIdentifier(at.parent.name)) return at.parent.name.text;
	}
	return undefined;
}

/**
 * Every read of the environment in one file's source: { line, what }, and the guards it holds, { line, name }. `file` is
 * the path under src/, posix, which a guard is matched against.
 */
export function scan(file, text, guards = GUARDS) {
	const kind = /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const reads = [];
	const guarded = [];
	const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const read = (node, what) => reads.push({ line: lineOf(node), what });

	/** process.env, at node: allowed only as one guard's variable, in that guard's file and function. */
	function env(node) {
		const access = accessOf(node);
		const name = access === undefined ? undefined : memberName(access);
		if (name === undefined) return read(node, "reads process.env whole, or a member it computes");
		const fn = functionOf(node);
		if (guards.some((guard) => guard.file === file && guard.fn === fn && guard.name === name)) return guarded.push({ line: lineOf(node), name });
		read(node, `reads process.env.${name}${fn ? ` in ${fn}` : ""}`);
	}

	/** A reference to the process object, at node: only a named member other than env is not a read. */
	function processAt(node) {
		const access = accessOf(node);
		if (access === undefined) return read(node, "uses process other than through a named member (an alias, a destructuring or an argument)");
		const name = memberName(access);
		if (name === undefined) return read(node, "reads a computed member of process");
		if (name === "env") return env(access);
	}

	const visit = (node) => {
		if (ts.isIdentifier(node)) {
			if (node.text === "process") {
				if (declares(node)) read(node, "declares a binding named process, which would hide a read");
				else if (!isNameOnly(node)) processAt(node);
			} else if (GLOBALS.has(node.text) && !isNameOnly(node) && !declares(node)) {
				const access = accessOf(node);
				const name = access === undefined ? undefined : memberName(access);
				if (access === undefined) read(node, `uses ${node.text} other than through a named member`);
				else if (name === undefined) read(node, `reads a computed member of ${node.text}`);
				else if (name === "process") processAt(access);
			}
		} else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			const from = node.moduleSpecifier;
			if (from && ts.isStringLiteralLike(from) && PROCESS_MODULES.has(from.text)) read(node, `imports ${from.text}`);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			const from = node.moduleReference.expression;
			if (ts.isStringLiteralLike(from) && PROCESS_MODULES.has(from.text)) read(node, `imports ${from.text}`);
		} else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
			const [from] = node.arguments;
			if (from && ts.isStringLiteralLike(from) && PROCESS_MODULES.has(from.text)) read(node, `loads ${from.text}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { reads, guarded };
}

/** The reads alone, for a file's source: { line, what }. */
export const envReads = (file, text, guards = GUARDS) => scan(file, text, guards).reads;

async function sourceFiles(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
		else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

/**
 * Every read under src (default this package's src/) outside src/conformance/: { problems: [{ file, line, what }],
 * guards: [{ file, line, name }] }, the guards being the allowed reads it found.
 */
export async function checkEnv(src = fileURLToPath(new URL("../src/", import.meta.url))) {
	const problems = [];
	const guards = [];
	for (const path of await sourceFiles(src)) {
		const file = relative(src, path).split(sep).join("/");
		if (file === READER || file.startsWith(`${READER}/`)) continue;
		const { reads, guarded } = scan(file, await readFile(path, "utf8"));
		problems.push(...reads.map((r) => ({ file, ...r })));
		guards.push(...guarded.map((g) => ({ file, ...g })));
	}
	return { problems, guards };
}
