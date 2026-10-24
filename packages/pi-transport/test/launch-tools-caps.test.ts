// The tools user's check reads each getcap line to the file it names (cap_runnable): several capability groups after the path,
// the older "path = caps" form, and a path that holds spaces are each read to their file, and a line that names no file is said
// to be one, never passed over. Run here in the box's own sh; the Docker live suite runs the same cases in BusyBox.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { capLineCases, capLineScript } from "./launch-tools-caps-support.ts";

const root = mkdtempSync(join(tmpdir(), "pi-transport-tools-caps-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the tools check's reading of a getcap line", () => {
	it("reads several groups, the older form and a path with spaces to their file, and names a line with no file as one", () => {
		const dir = join(root, "files");
		const ran = spawnSync("sh", ["-c", capLineScript(dir)], { encoding: "utf8" });
		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout.trim().split("\n").map(Number)).toEqual(capLineCases(dir).map(([, answer]) => answer));
	});
});
