// The "./mount" subpath: a host that checks a run folder's mount (serve, at a computer's start) imports
// @parcha/agentrun-computer/mount and loads src/mount.ts alone, with node's built-ins: no provider, no vendor SDK and no
// conformance code. A host reads a provider's MOUNT through providerModule(id), which loads that one provider's file.
// The package is published, and its tarball holds dist, the README, LICENSE and NOTICE, and nothing else.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as index from "../dist/index.js";

const exec = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
const MOUNT_NAMES = ["MOUNT_KINDS", "WORKSPACE", "checkMount", "readBackOf"];
/** The files the egress proxy container runs, from dist/docker (src/docker/egress.ts, CODE_FILES). */
const EGRESS_CODE = ["egress-main.js", "egress-proxy.js", "egress-table.js"];

test("the package is published, and its manifest exports ./mount beside the root, each with its types", () => {
	assert.equal(manifest.private, undefined, "no private flag: a release publishes it");
	assert.deepEqual(manifest.exports["."], { types: "./dist/index.d.ts", default: "./dist/index.js" });
	assert.deepEqual(manifest.exports["./mount"], { types: "./dist/mount.d.ts", default: "./dist/mount.js" });
	assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE", "NOTICE"]);
	assert.deepEqual(manifest.dependencies ?? {}, {}, "no dependency: a vendor SDK is the host's, imported only when its provider is built");
});

test("dist/mount.js imports node's built-ins only", () => {
	const source = readFileSync(join(PACKAGE, "dist/mount.js"), "utf8");
	const specifiers = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
	assert.ok(specifiers.length > 0, "it reads the file system");
	for (const specifier of specifiers) assert.match(specifier, /^node:/, `dist/mount.js imports ${specifier}`);
});

test("importing @parcha/agentrun-computer/mount in a fresh process loads dist/mount.js and node's built-ins, nothing else", async () => {
	// Every module the import loads, as the loader loads it: a provider, a vendor SDK or the conformance code would be here.
	const script = `import { registerHooks } from "node:module";
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
const mount = await import("@parcha/agentrun-computer/mount");
console.log(JSON.stringify({ loaded, names: Object.keys(mount).sort(), resolved: import.meta.resolve("@parcha/agentrun-computer/mount") }));`;
	const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: PACKAGE });
	const { loaded, names, resolved } = JSON.parse(stdout);
	assert.equal(resolved, new URL("../dist/mount.js", import.meta.url).href, "the subpath is dist/mount.js");
	assert.deepEqual(loaded.filter((url) => !url.startsWith("node:")), [resolved], "no other module of this package, and no package beside it");
	assert.deepEqual(names, MOUNT_NAMES);
});

test("the subpath's names are the root's: one module, so the mount rule a provider checks is the one a host checks", async () => {
	const mount = await import("@parcha/agentrun-computer/mount");
	for (const name of MOUNT_NAMES) assert.equal(mount[name], index[name], name);
	assert.equal(mount.WORKSPACE, "/workspace");
	assert.deepEqual(mount.checkMount({ kind: "bind", path: "relative" }, ["bind"]), [{ field: "mount", message: 'mount.path must be absolute, not "relative"' }]);
});

test("a TypeScript host reads MountSpec, MountReadBack and MountKind from the subpath, with the values", async () => {
	const tsc = join(createRequire(import.meta.url).resolve("typescript/package.json"), "..", "bin", "tsc");
	const fixture = join(PACKAGE, "test/fixtures/mount-subpath.ts");
	const args = ["--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", fixture];
	const result = await exec(process.execPath, [tsc, ...args], { cwd: PACKAGE }).catch((error) => error);
	assert.equal(result.code ?? 0, 0, `tsc: ${result.stdout ?? ""}${result.stderr ?? ""}`);
});

test("a pack holds dist, the README, LICENSE and NOTICE, the egress proxy's code, and the daemon binaries the build made, executable", async () => {
	const { stdout } = await exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: PACKAGE, maxBuffer: 16 * 1024 * 1024 });
	const [{ files }] = JSON.parse(stdout);
	const paths = files.map((file) => file.path);
	for (const path of paths) assert.match(path, /^(?:package\.json|README\.md|LICENSE|NOTICE|dist\/.+)$/, `${path} is outside dist, the README, LICENSE and NOTICE`);
	for (const path of paths) assert.doesNotMatch(path, /\.(?:map|tsbuildinfo)$/, path);
	for (const path of ["README.md", "LICENSE", "NOTICE", "dist/index.js", "dist/index.d.ts", "dist/mount.js", "dist/mount.d.ts"]) assert.ok(paths.includes(path), `the pack holds ${path}`);
	// The Docker provider binds dist/docker and package.json into each egress proxy container, which runs these with Node
	// alone: no other module of the package is there.
	for (const file of EGRESS_CODE) assert.ok(paths.includes(`dist/docker/${file}`), `the pack holds the egress proxy's dist/docker/${file}`);
	// `npm run build:daemon` writes them into dist, so a pack carries them when the build made them; the release's package
	// check (scripts/verify-packages.mjs) requires them.
	for (const arch of ["amd64", "arm64"]) {
		const path = `dist/computerd-linux-${arch}`;
		const packed = files.find((file) => file.path === path);
		assert.equal(packed !== undefined, existsSync(join(PACKAGE, path)), `${path}: packed exactly when the build made it`);
		if (packed) assert.equal(packed.mode & 0o777, 0o755, `${path} is packed executable by everyone`);
	}
});
