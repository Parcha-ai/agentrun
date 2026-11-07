import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as testing from "../src/testing/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exportsMap = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports as Record<string, unknown>;

/** How Node resolves `specifier` for an importer in this package: its URL, or the error code it is refused with. */
const resolved = (specifier: string): string => {
	const ran = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`try { console.log(import.meta.resolve(${JSON.stringify(specifier)})) } catch (error) { console.log(error.code) }`,
		],
		{ cwd: root, encoding: "utf8" },
	);
	return ran.stdout.trim();
};

// The session home, the box place built on it, and the move and store checks of the home are gone. What serve and
// the harness use (the root, the boxes, `./hands`, `./sync`, `./launch`, `./testing`'s box checks) stays.
describe("the package's entries", () => {
	it("have no session home and no box place: importing either is refused by the exports map", () => {
		expect(Object.keys(exportsMap)).not.toContain("./home");
		expect(Object.keys(exportsMap)).not.toContain("./place");
		expect(resolved("@parcha/pi-transport/home")).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
		expect(resolved("@parcha/pi-transport/place")).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
		expect(existsSync(join(root, "src", "home"))).toBe(false);
	});

	it("keep the entries serve and the harness import", () => {
		for (const entry of ["@parcha/pi-transport", "@parcha/pi-transport/hands", "@parcha/pi-transport/sync", "@parcha/pi-transport/box/docker"]) {
			expect(resolved(entry)).toMatch(/^file:/);
		}
	});

	it("leave ./testing with its box checks and without the home's move, restore and store checks", () => {
		const names = Object.keys(testing);
		for (const gone of [
			"registerMoveConformance",
			"registerRestoreConformance",
			"moveConformanceApp",
			"registerStoreConformance",
			"createStoreConformance",
		]) {
			expect(names).not.toContain(gone);
		}
		expect(names).toContain("registerBoxConformance");
		expect(names).toContain("fakeBoxes");
	});
});
