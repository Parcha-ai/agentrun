import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// The pi version this package pins (one whole family): a run that resolved a different copy fails.
const pinned = (require("../package.json") as { devDependencies: Record<string, string> }).devDependencies[
	"@earendil-works/pi-durable"
];

describe("the pi packages this run resolved", () => {
	it("are the version the package pins", () => {
		for (const name of ["@earendil-works/pi-durable", "@earendil-works/chord"]) {
			expect(require(`${name}/package.json`).version, name).toBe(pinned);
		}
	});
});
