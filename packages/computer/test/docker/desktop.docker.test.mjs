// The conformance suite on a Docker desktop (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): the X11 shim in computerd against
// Xvfb in test/fixtures/desktop/Dockerfile, with computerd-fixture (daemon/cmd/fixture) as the cases' fixture app. Needs
// `npm run build` and `npm run build:daemon` first, Go on PATH (for the fixture and the drift case's daemon), and
// alpine:3.20 pulled; the image is built from it with ensureImage, the provider's image path. The after hook removes
// any container with this run's label.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { conformanceCases, ensureImage, formatReport, runConformance } from "../../dist/index.js";
import { createDriftedProvider, createProvider } from "../../dist/conformance/docker.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const DOCKERFILE = fileURLToPath(new URL("../fixtures/desktop/Dockerfile", import.meta.url));
const DAEMON = fileURLToPath(new URL("../../daemon", import.meta.url));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const labelled = (run) => docker("ps", "-a", "--filter", `label=agentrun.conformance=${run}`, "--format", "{{.Names}}").split("\n").filter(Boolean);
const EXTENSION = ["screen", "input", "touch", "apps", "lifetime"];

describe("the conformance suite on a Docker desktop", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	let report;
	let run;
	let dir;
	const made = new Set();

	before(async () => {
		// The provider's own image path: the Dockerfile alone, built once and tagged with its hash.
		const built = await ensureImage({ recipe: readFileSync(DOCKERFILE, "utf8") });
		assert.ok(built.ok, built.ok || built.error.message);
		const image = built.value;
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		dir = mkdtempSync(join(tmpdir(), "computer-desktop-"));
		chmodSync(dir, 0o755);
		const fixture = join(dir, "computerd-fixture");
		execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", fixture, "./cmd/fixture"], {
			cwd: DAEMON,
			env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch },
			stdio: "inherit",
		});
		const provider = await createProvider({ desktop: {} });
		const drifted = () => createDriftedProvider({ desktop: {} });
		const create = provider.create.bind(provider);
		provider.create = async (spec, context) => {
			run ??= spec.labels?.["agentrun.conformance"];
			const created = await create(spec, context);
			if (created.ok) made.add(created.value.name);
			return created;
		};
		report = await runConformance(provider, { image, drifted, fixture });
		console.log(formatReport(report));
	});

	after(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		for (const name of new Set([...made, ...(run ? labelled(run) : [])])) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the runner.
			}
		}
	});

	for (const { id, level } of conformanceCases) {
		it(`${level} ${id}`, (t) => {
			const result = report.results.find((r) => r.id === id);
			assert.ok(result, `${id} did not run`);
			if (result.status === "skip") return t.skip(result.reason);
			assert.equal(result.status, "pass", result.reason);
		});
	}

	it("passes Core as a desktop with computerd as PID 1, daemon and provider of one version", () => {
		assert.deepEqual([report.kind, report.daemonMode], ["desktop", "pid1"]);
		assert.equal(report.core, "pass", formatReport(report));
		assert.equal(report.daemon?.version, report.providerVersion);
	});

	it("runs every screen and input case, and skips only what X11 has no group for, in words", () => {
		for (const r of report.results.filter((one) => EXTENSION.includes(one.group))) {
			if (r.group === "screen" || r.group === "input") {
				if (r.id === "screen.stream") assert.equal(r.status, "skip", `${r.id}: Docker has no stream()`);
				else assert.equal(r.status, "pass", `${r.id}: ${r.reason}`);
			} else {
				assert.equal(r.status, "skip", `${r.id}: ${r.reason}`);
				assert.match(r.reason, /^the provider (does not declare|has no) /, r.id);
			}
		}
	});

	it("leaves no computer behind", () => {
		assert.deepEqual(report.cleanup.left, []);
		assert.deepEqual(report.cleanup.errors, []);
		assert.ok(run, "the run labelled its computers");
		assert.deepEqual(labelled(run), []);
	});
});
