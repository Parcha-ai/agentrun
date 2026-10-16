import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localBoxes } from "../src/box/local.ts";
import { registerBoxPlaceCases } from "./place-box-cases.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "place-box-runner.fixture.ts");
const AGENT = join(dirname(fileURLToPath(import.meta.url)), "place-box-agent.fixture.ts");
const POOL = join(dirname(fileURLToPath(import.meta.url)), "place-box-pool.fixture.ts");

registerBoxPlaceCases("a session's place in a local box", {
	provider: (root) => localBoxes({ root: join(root, "boxes") }),
	spec: { maxLifetimeMs: 10 * 60_000 },
	program: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", FIXTURE] },
	hostFiles: true,
	agentProgram: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", AGENT] },
	poolProgram: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", POOL] },
});
