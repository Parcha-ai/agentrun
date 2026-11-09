// `npm run conformance -- --provider docker` as a vendor runs it, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only),
// against alpine:3.20, so the suite also runs on a busybox image. Needs both builds, Go on PATH and alpine:3.20 pulled.
// The runner removes every computer it made, by its exact name.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { conformanceCases, DockerProvider, GROUPS } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const CLI = fileURLToPath(new URL("../../dist/conformance/cli.js", import.meta.url));

/**
 * How many Core cases the report lists as optional for a Docker computer: those that need something Docker does not
 * declare, by the runner's own reading of each need. Derived from the suite and Docker's capabilities, so a new case
 * moves it with no edit here.
 */
function optionalForDocker() {
	const provider = new DockerProvider({ daemonPath: "/nonexistent/computerd" });
	const caps = provider.capabilities();
	const declared = (need) => {
		if (need === "extend" || need === "stream") return typeof provider[need] === "function";
		if (GROUPS.includes(need)) return caps.groups.includes(need);
		if (need.startsWith("mount:")) return (caps.mount ?? []).includes(need.slice("mount:".length));
		if (need.startsWith("network:")) return caps.network.includes(need.slice("network:".length));
		if (need === "lifetime:janitor") return caps.lifetime === "janitor";
		if (need.startsWith("user:")) return (caps.user ?? []).includes(need.slice("user:".length));
		if (need === "release:stop") return caps.release.includes("stop");
		if (need === "vendor-agent") return Array.isArray(caps.vendorAgentPorts);
		throw new Error(`a need this count does not read: ${need}`);
	};
	return conformanceCases.filter((c) => c.level === "core" && !c.needs.every(declared)).length;
}

describe("the conformance CLI on Docker", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	it("prints the report and exits 0: Core passes", async () => {
		const { code, stdout, stderr } = await new Promise((resolve) => {
			execFile(process.execPath, [CLI, "--provider", "docker", "--image", "alpine:3.20"], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
				resolve({ code: error ? error.code : 0, stdout, stderr }),
			);
		});
		assert.equal(code, 0, `${stdout}\n${stderr}`);
		assert.match(stdout, /^computer conformance · docker · linux, daemon pid1 · computerd \S+ linux\/(amd64|arm64)\n/);
		for (const group of ["health", "exec", "files", "process", "provider", "drift"]) assert.match(stdout, new RegExp(`^core ${group} `, "m"));
		// A linux computer is not held to screen, input, touch or apps: their cases are listed as optional, never as core.
		for (const group of ["screen", "input", "touch", "apps"]) {
			assert.match(stdout, new RegExp(`^optional ${group} `, "m"));
			assert.doesNotMatch(stdout, new RegExp(`^core ${group} `, "m"));
		}
		assert.match(stdout, /^full lifetime /m);
		// Docker declares no screen, input, touch or apps, and no vendor's agent (isolation.vendor-agent): those cases are
		// skipped, out of Core's count, and counted as optional.
		const optional = optionalForDocker();
		assert.ok(optional > 0, "Docker leaves some Core case undeclared");
		assert.match(stdout, new RegExp(`^core PASS (\\d+)/\\1 · ${optional} optional cases skipped, not declared · full \\d+/\\d+`, "m"));
	});
});
