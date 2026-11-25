// The vendor SDKs a provider loads at run time (e2b, modal, @boxd-sh/sdk, ssh2, Archil's disk) are this package's
// optionalDependencies, each pinned exactly at the version the workspace's lockfile holds, so a plain `npm install` of
// the package (or of serve, which depends on it) brings them, and `npm install --omit=optional` leaves them out. A
// provider loads its SDK only through vendorSdk (src/vendor-sdk.ts), which names it as a literal argument, never an import
// literal: so no type checker resolves the SDK's types, and with the SDK absent the error names the install step. The
// SDKs are read from the source files themselves, so a new vendor's SDK is held to this with no line added here.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const json = (path) => JSON.parse(readFileSync(here(path), "utf8"));
const PACKAGE = here("..");
const SRC = here("../src/");

/** Every .ts file under `dir`, recursively, as paths relative to the package. */
function sources(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith(".ts") ? [relative(PACKAGE, path)] : [];
	});
}

/**
 * Each SDK a source file loads at run time, read from its parse tree: `vendorSdk(vendor, "<package>")` (loads), and
 * every `import(NAME)` of an identifier outside src/vendor-sdk.ts (direct), NAME resolved where the file binds it with a
 * top-level `const NAME = "<package>"`, and every `import("<package>")` of a bare package literal (direct). A literal
 * that is relative, absolute or `node:` loads a file of this package or a builtin; an import of any other expression (a
 * file's URL) loads a file, not a package.
 */
function scan(files = sources(SRC).sort().map((file) => [file, readFileSync(join(PACKAGE, file), "utf8")])) {
	const loads = [];
	const direct = [];
	for (const [file, text] of files) {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const consts = new Map();
		for (const statement of source.statements) {
			if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) consts.set(declaration.name.text, declaration.initializer.text);
			}
		}
		const visit = (node) => {
			if (ts.isCallExpression(node)) {
				const [first, second] = node.arguments;
				if (ts.isIdentifier(node.expression) && node.expression.text === "vendorSdk") {
					assert.ok(second && ts.isStringLiteralLike(second), `${file}: vendorSdk names its package as a string literal`);
					loads.push({ file, name: second.text });
				} else if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first && ts.isIdentifier(first) && file !== "src/vendor-sdk.ts") {
					direct.push({ file, name: consts.get(first.text) ?? `(${first.text})` });
				} else if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first && ts.isStringLiteralLike(first) && !/^(\.{1,2}\/|\/|node:)/.test(first.text)) {
					direct.push({ file, name: first.text });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return { loads, direct };
}

const all = ({ loads, direct }) => [...loads, ...direct];

test("the SDK scan finds the providers' SDKs", () => {
	// The built-in ones, so a scan that finds nothing fails here rather than passing the tests below on an empty list.
	const names = all(scan()).map(({ name }) => name);
	for (const name of ["e2b", "modal", "@boxd-sh/sdk", "ssh2", "disk"]) assert.ok(names.includes(name), `${name} is found: ${JSON.stringify(names)}`);
});

test("a provider loads its SDK only through vendorSdk, never by an import of its own", () => {
	assert.deepEqual(scan().direct, [], "each of these imports a package by a name: load it with vendorSdk(vendor, name) instead, so a missing SDK names its install step");
});

test("the scan catches a package imported by a literal or by a const, and leaves a file's own modules and node's alone", () => {
	const fixture = [
		'const SDK = "named-sdk";',
		'export const a = () => import("another-sdk");',
		"export const b = () => import(`@scope/template-sdk`);",
		"export const c = () => import(SDK);",
		'export const d = () => import("./conformance/runner.js");',
		'export const e = () => import("../index.js");',
		'export const f = () => import("node:fs");',
		'export const g = () => import(new URL("./box.js", import.meta.url).href);',
	].join("\n");
	assert.deepEqual(scan([["src/fixture.ts", fixture]]).direct.map(({ name }) => name), ["another-sdk", "@scope/template-sdk", "named-sdk"]);
});

test("each SDK a provider loads is one of the packed package's optionalDependencies, pinned exactly at the version the lockfile holds; it lists no other", () => {
	// The manifest npm packs (verify-packages.mjs reads each package's package.json the same way): npm pack ships it as it is.
	const computer = json("../package.json");
	const root = json("../../../package.json");
	const lock = json("../../../package-lock.json");
	const names = [...new Set(all(scan()).map(({ name }) => name))].sort();
	for (const name of names) {
		const pin = computer.optionalDependencies?.[name];
		assert.match(pin ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `packages/computer/package.json pins ${name} exactly in optionalDependencies (no range), not ${pin}: a plain npm install then brings it`);
		assert.equal(lock.packages?.[`node_modules/${name}`]?.version, pin, `package-lock.json installs ${name} ${pin}`);
		assert.equal(lock.packages?.["packages/computer"]?.optionalDependencies?.[name], pin, `package-lock.json records ${name} ${pin} as packages/computer's optional dependency: run npm install --package-lock-only`);
		if (root.devDependencies?.[name] !== undefined) assert.equal(root.devDependencies[name], pin, `the root devDependency on ${name} is the same pin`);
		for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
			assert.equal(computer[field]?.[name], undefined, `packages/computer names ${name} only in optionalDependencies, not ${field}`);
		}
	}
	assert.deepEqual(Object.keys(computer.optionalDependencies ?? {}).sort(), names, "every optional dependency is an SDK a provider loads");
});

test("the built provider modules import no vendor SDK at load, and the published types name none", () => {
	for (const file of ["../dist/e2b.js", "../dist/modal.js", "../dist/boxd.js", "../dist/agent37.js", "../dist/morph.js", "../dist/conformance/archil.js"]) {
		const code = readFileSync(here(file), "utf8");
		assert.doesNotMatch(code, /^import .* from ["'](e2b|modal|@boxd-sh\/sdk|ssh2|disk)["']/m, `${file} has no static import of an SDK`);
		assert.doesNotMatch(code, /require\(/, `${file} has no require`);
		assert.doesNotMatch(code, /import\(["'](e2b|modal|@boxd-sh\/sdk|ssh2|disk)["']\)/, `${file} names no SDK in a literal import`);
		// A consumer that installed without optional dependencies still type-checks against the published types.
		const types = readFileSync(here(file.replace(/\.js$/, ".d.ts")), "utf8");
		assert.doesNotMatch(types, /from ["'](e2b|modal|@boxd-sh\/sdk|ssh2|disk)["']|import\(["'](e2b|modal|@boxd-sh\/sdk|ssh2|disk)["']\)/, `${file.replace(/\.js$/, ".d.ts")} names no SDK`);
	}
});

/**
 * The package as `npm install --omit=optional` leaves it: its manifest, its built modules and its box files, copied to a
 * fresh directory with no node_modules above it, so no SDK resolves from there. `plant` writes packages into its own
 * node_modules. Removed when the test ends.
 */
function installedWithoutSdks(t, plant = {}) {
	const dir = mkdtempSync(join(tmpdir(), "agentrun-computer-no-sdks-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const copy = join(dir, "node_modules", "@parcha", "agentrun-computer");
	mkdirSync(copy, { recursive: true });
	cpSync(join(PACKAGE, "package.json"), join(copy, "package.json"));
	cpSync(join(PACKAGE, "box"), join(copy, "box"), { recursive: true });
	cpSync(join(PACKAGE, "dist"), join(copy, "dist"), { recursive: true, filter: (from) => !/computerd-linux-|\.jar$/.test(from) });
	for (const [name, files] of Object.entries(plant)) {
		for (const [file, text] of Object.entries(files)) {
			const path = join(dir, "node_modules", name, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
	}
	return { copy, load: (file) => import(pathToFileURL(join(copy, "dist", file)).href) };
}

test("with no SDK installed, each provider's create refuses naming its SDK and the npm install that brings it", async (t) => {
	const { copy, load } = installedWithoutSdks(t);
	const pins = JSON.parse(readFileSync(join(copy, "package.json"), "utf8")).optionalDependencies ?? {};
	const resolve = createRequire(join(copy, "package.json")).resolve;
	for (const name of ["e2b", "modal", "@boxd-sh/sdk", "ssh2", "disk"]) assert.throws(() => resolve(name), { code: "MODULE_NOT_FOUND" }, `${name} does not resolve from the copy`);
	const words = (vendor, name) => `${vendor} needs the ${name} package: npm install ${name}@${pins[name]}`;
	const KEY = "fake-test-key";
	const cases = [
		["E2B", "e2b", async () => (await load("e2b.js")).create({ apiKey: KEY })],
		["Modal", "modal", async () => (await load("modal.js")).create({ tokenId: KEY, tokenSecret: KEY, app: "agentrun" })],
		["boxd", "@boxd-sh/sdk", async () => (await load("boxd.js")).create({ apiKey: KEY })],
		["Agent37", "ssh2", async () => (await load("agent37.js")).create({ apiKey: KEY, sshKey: KEY })],
		["Morph", "ssh2", async () => (await load("morph.js")).create({ apiKey: KEY })],
		["Archil", "disk", async () => (await load("conformance/archil.js")).archilRunFolder({ disk: "dsk-00000000000baf76", region: "aws-us-east-1", token: KEY, apiKey: KEY, s3BaseUrl: "https://s3.green.us-east-1.aws.prod.archil.com" })],
	];
	for (const [vendor, name, make] of cases) {
		await assert.rejects(make(), (error) => {
			assert.equal(error.message, words(vendor, name), vendor);
			assert.equal(error.code, "sdk_missing", `${vendor}: the code serve's Settings reads`);
			return true;
		});
	}
});

test("an SDK that is installed but fails to load is that failure, not an install step", async (t) => {
	const { load } = installedWithoutSdks(t, { ssh2: { "package.json": JSON.stringify({ name: "ssh2", version: "1.17.0", main: "index.js" }), "index.js": 'throw new Error("ssh2 failed to load its binding");\n' } });
	await assert.rejects((await load("agent37.js")).create({ apiKey: "fake-test-key", sshKey: "fake-test-key" }), /ssh2 failed to load its binding/);
});

test("an installed SDK that imports a module that is not there is that module's error, never an install step for the SDK", async (t) => {
	const { load } = installedWithoutSdks(t, { e2b: { "package.json": JSON.stringify({ name: "e2b", version: "2.63.0", type: "module", main: "index.js" }), "index.js": 'import "e2b-missing-dependency";\nexport class Sandbox {}\n' } });
	await assert.rejects((await load("e2b.js")).create({ apiKey: "fake-test-key" }), (error) => {
		assert.equal(error.code, "ERR_MODULE_NOT_FOUND", "the module's own error");
		assert.match(error.message, /e2b-missing-dependency/, "it names the module that is missing");
		assert.doesNotMatch(error.message, /npm install/, "e2b is installed: no install step");
		return true;
	});
});
