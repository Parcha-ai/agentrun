// The conformance suite on a real E2B desktop, one test per case. It is skipped unless AGENTRUN_COMPUTER_LIVE_E2B=1 and
// COMPUTER_E2B_API_KEY is in the environment: a key the lead has OKed by name, never set by a test or a script.
// E2B_API_KEY never counts, and the provider never reads it. It also needs the e2b package installed where Node finds
// it, `npm run build` and `npm run build:daemon` (the daemon is uploaded into each sandbox), and Go on PATH: the drift
// case builds a daemon of another version, and the screen and input cases a computerd-fixture for linux/amd64 (E2B's
// architecture). Every computer lives at most 30 minutes (E2B's timeout is its lifetime; the conformance module caps
// it). The runner deletes every computer it made; the after hook kills any sandbox still made by this run, pass or
// fail; wrap the run in dist/conformance/e2b-sweep.js --before and --after for the rest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";

/** Presence only: no key is read here. The live switch is checked first, so without it nothing else is. */
const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_E2B === "1" && "COMPUTER_E2B_API_KEY" in process.env;
const DAEMON = fileURLToPath(new URL("../../daemon", import.meta.url));

describe(
	"the conformance suite on an E2B desktop",
	{ skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_E2B=1 with COMPUTER_E2B_API_KEY (a key the lead OKed) to run on real E2B" },
	() => {
		let report;
		let provider;
		let dir;
		const made = new Map();

		before(async () => {
			dir = mkdtempSync(join(tmpdir(), "computer-e2b-"));
			chmodSync(dir, 0o755);
			const fixture = join(dir, "computerd-fixture");
			execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", fixture, "./cmd/fixture"], {
				cwd: DAEMON,
				env: { PATH: process.env.PATH, HOME: process.env.HOME, GOCACHE: process.env.GOCACHE, GOPATH: process.env.GOPATH, CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" },
				stdio: "inherit",
			});
			const { conformanceImage, conformanceNotes, createDriftedProvider, createProvider } = await import("../../dist/conformance/e2b.js");
			provider = await createProvider();
			const create = provider.create.bind(provider);
			provider.create = async (spec, context) => {
				const created = await create(spec, context);
				if (created.ok) made.set(created.value.id, created.value);
				return created;
			};
			// Release waits up to 120 s for E2B to read a killed sandbox gone; cleanup gives it more.
			report = await runConformance(provider, { image: conformanceImage(), cleanupTimeoutMs: 150_000, notes: conformanceNotes, drifted: createDriftedProvider, fixture });
			console.log(formatReport(report));
		});

		after(async () => {
			for (const ref of made.values()) await provider?.release(ref, "delete");
			if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		});

		for (const { id, level } of conformanceCases) {
			it(`${level} ${id}`, (t) => {
				const result = report.results.find((r) => r.id === id);
				assert.ok(result, `${id} did not run`);
				if (result.status === "skip") return t.skip(result.reason);
				assert.equal(result.status, "pass", result.reason);
			});
		}

		it("passes Core as a desktop with computerd as a child, daemon and provider of one version", () => {
			assert.deepEqual([report.kind, report.daemonMode], ["desktop", "child"]);
			assert.equal(report.core, "pass", formatReport(report));
			assert.equal(report.daemon?.version, report.providerVersion);
		});

		it("leaves no computer behind", () => {
			assert.deepEqual(report.cleanup.left, []);
			assert.deepEqual(report.cleanup.errors, []);
		});
	},
);
