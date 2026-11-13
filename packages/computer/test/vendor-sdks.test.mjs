// The vendor SDKs a provider imports at run time (the host's own package, never this one's dependency) are pinned exactly
// in the workspace's lockfile as root devDependencies, so a conformance or live run gets them from `npm ci` alone, with
// nothing installed outside the lock. packages/computer itself depends on none of them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));

/** Each provider file that imports a vendor SDK, the constant that names it, and the version its code was read against. */
const SDKS = [
	{ file: "../src/e2b.ts", constant: "E2B_PACKAGE", version: "2.63.0" },
	{ file: "../src/modal.ts", constant: "MODAL_PACKAGE", version: "0.11.1" },
];

test("each vendor SDK a provider imports is a root devDependency pinned exactly, at the same version in package-lock.json; packages/computer depends on none", () => {
	const root = json("../../../package.json");
	const lock = json("../../../package-lock.json");
	const computer = json("../package.json");
	for (const { file, constant, version } of SDKS) {
		const name = new RegExp(`const ${constant}: string = "([^"]+)"`).exec(read(file))?.[1];
		assert.ok(name, `${file} names its SDK in ${constant}`);
		assert.equal(root.devDependencies?.[name], version, `the root package.json pins ${name} exactly, at ${version}`);
		assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version, `package-lock.json holds ${name} ${version}`);
		assert.equal(lock.packages?.[`node_modules/${name}`]?.dev, true, `${name} is a devDependency in the lock, never a runtime one`);
		for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
			assert.equal(computer[field]?.[name], undefined, `packages/computer has no ${field} entry for ${name}: it imports the host's own`);
		}
	}
});
