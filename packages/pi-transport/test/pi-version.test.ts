import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const expected = process.env.PI_TRANSPORT_EXPECT_PI_DURABLE;
const require = createRequire(import.meta.url);

// A CI job that reruns the suite on another pi version sets the variable, so a run that resolved a different copy fails.
describe("the pi packages this run resolved", () => {
	it.skipIf(expected === undefined)("are the version the job asked for", () => {
		for (const name of ["@earendil-works/pi-durable", "@earendil-works/chord"]) {
			expect(require(`${name}/package.json`).version, name).toBe(expected);
		}
	});
});
