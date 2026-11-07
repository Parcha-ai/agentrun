// `npm run conformance -- --provider docker` as a vendor runs it, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only),
// against alpine:3.20, so the suite also runs on a busybox image. Needs both builds, Go on PATH and alpine:3.20 pulled.
// The runner removes every computer it made, by its exact name.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const CLI = fileURLToPath(new URL("../../dist/conformance/cli.js", import.meta.url));

describe("the conformance CLI on Docker", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	it("prints the report and exits 0: Core passes", async () => {
		const { code, stdout, stderr } = await new Promise((resolve) => {
			execFile(process.execPath, [CLI, "--provider", "docker", "--image", "alpine:3.20"], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
				resolve({ code: error ? error.code : 0, stdout, stderr }),
			);
		});
		assert.equal(code, 0, `${stdout}\n${stderr}`);
		assert.match(stdout, /^computer conformance · docker · computerd \S+ linux\/(amd64|arm64)\n/);
		for (const group of ["health", "exec", "files", "process", "provider", "drift"]) assert.match(stdout, new RegExp(`^core ${group} `, "m"));
		assert.match(stdout, /^core PASS (\d+)\/\1 · full \d+\/\d+/m);
	});
});
