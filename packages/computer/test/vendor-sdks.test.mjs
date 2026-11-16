// The vendor SDKs a provider imports at run time (the host's own package, never this one's dependency) are pinned exactly
// in the workspace's lockfile as root devDependencies, so a conformance or live run gets them from `npm ci` alone, with
// nothing installed outside the lock. packages/computer itself depends on none of them. The SDKs are read from the
// provider files themselves, so a new vendor's SDK is held to this with no line added here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));

/**
 * Each SDK a provider file in src/ imports at run time: `await import(NAME)` of a `const NAME: string = "<package>"` in
 * the same file (the string type keeps TypeScript from resolving a package this one does not depend on).
 */
function vendorSdks() {
	const found = [];
	for (const file of readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts")).sort()) {
		const source = read(`../src/${file}`);
		for (const [, constant] of source.matchAll(/await import\(([A-Z][A-Z0-9_]*)\)/g)) {
			const name = new RegExp(`const ${constant}: string = "([^"]+)"`).exec(source)?.[1];
			assert.ok(name, `src/${file} imports ${constant}, which it names with const ${constant}: string = "<package>"`);
			found.push({ file: `src/${file}`, name });
		}
	}
	return found;
}

test("the SDK scan finds the providers' SDKs", () => {
	// The built-in ones, so a scan that finds nothing fails here rather than passing the test below on an empty list.
	const names = vendorSdks().map(({ name }) => name);
	for (const name of ["e2b", "modal", "ssh2"]) assert.ok(names.includes(name), `${name} is found`);
});

test("each vendor SDK a provider imports is a root devDependency pinned exactly, at the same version in package-lock.json; packages/computer depends on none", () => {
	const root = json("../../../package.json");
	const lock = json("../../../package-lock.json");
	const computer = json("../package.json");
	for (const { file, name } of vendorSdks()) {
		const version = root.devDependencies?.[name];
		assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${file}: the root package.json pins ${name} exactly as a devDependency (no range), not ${version}`);
		assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version, `package-lock.json holds ${name} ${version}`);
		assert.equal(lock.packages?.[`node_modules/${name}`]?.dev, true, `${name} is a devDependency in the lock, never a runtime one`);
		for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
			assert.equal(computer[field]?.[name], undefined, `packages/computer has no ${field} entry for ${name}: it imports the host's own`);
		}
	}
});

test("the built provider modules import no vendor SDK at load: the SDKs' types are erased, and the one run-time import is a non-literal dynamic one", () => {
	for (const file of ["../dist/e2b.js", "../dist/modal.js"]) {
		const code = read(file);
		assert.doesNotMatch(code, /^import .* from ["'](e2b|modal)["']/m, `${file} has no static import of the SDK`);
		assert.doesNotMatch(code, /require\(/, `${file} has no require`);
		assert.doesNotMatch(code, /import\(["'](e2b|modal)["']\)/, `${file} names the SDK in no literal import, so no bundler resolves it`);
		// The published types name no SDK either: a consumer without it installed, and the package check, see no dependency.
		const types = read(file.replace(/\.js$/, ".d.ts"));
		assert.doesNotMatch(types, /from ["'](e2b|modal)["']|import\(["'](e2b|modal)["']\)/, `${file.replace(/\.js$/, ".d.ts")} names no SDK`);
	}
});
