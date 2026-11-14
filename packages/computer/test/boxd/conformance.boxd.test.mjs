// The conformance suite on a real boxd machine, one test per case. It is skipped unless AGENTRUN_COMPUTER_LIVE_BOXD=1 and
// COMPUTER_BOXD_API_KEY is in the environment: a key the lead has OKed by name, never set by a test or a script.
// BOXD_API_KEY never counts, and the provider never reads it. It also needs the @boxd-sh/sdk package installed where
// Node finds it (a root devDependency), `npm run build` and `npm run build:daemon` (the daemon is uploaded into each
// machine), and Go on PATH: the drift case builds a daemon of another version, and the screen and input cases a
// computerd-fixture for linux/amd64. COMPUTER_BOXD_KIND=desktop runs it on a desktop; the default is a linux sandbox.
// The runner deletes every computer it made and sweeps the run's label; the after hook deletes any machine still made by
// this run, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";

/** Presence only: no key is read here. The live switch is checked first, so without it nothing else is. */
const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_BOXD === "1" && "COMPUTER_BOXD_API_KEY" in process.env;
const DAEMON = fileURLToPath(new URL("../../daemon", import.meta.url));

describe(
	`the conformance suite on a boxd ${process.env.COMPUTER_BOXD_KIND === "desktop" ? "desktop" : "sandbox"}`,
	{ skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_BOXD=1 with COMPUTER_BOXD_API_KEY (a key the lead OKed) to run on real boxd" },
	() => {
		let report;
		let provider;
		let dir;
		const made = new Map();

		before(async () => {
			dir = mkdtempSync(join(tmpdir(), "computer-boxd-"));
			chmodSync(dir, 0o755);
			const fixture = join(dir, "computerd-fixture");
			execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", fixture, "./cmd/fixture"], {
				cwd: DAEMON,
				// Go's own settings and the target, and nothing else of this process's environment: never the key.
				env: {
					...Object.fromEntries(["PATH", "HOME", "TMPDIR", "GOPATH", "GOCACHE", "GOMODCACHE", "GOFLAGS", "GOPROXY", "GOTOOLCHAIN"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
					CGO_ENABLED: "0",
					GOOS: "linux",
					GOARCH: "amd64",
				},
				stdio: "inherit",
			});
			const { conformanceImage, conformanceNotes, createDriftedProvider, createProvider } = await import("../../dist/conformance/boxd.js");
			provider = await createProvider();
			const create = provider.create.bind(provider);
			provider.create = async (spec, context) => {
				const created = await create(spec, context);
				if (created.ok) made.set(created.value.id, created.value);
				return created;
			};
			// Release waits up to 120 s for boxd to read a deleted machine gone; cleanup gives it more.
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

		it("passes Core with computerd as a child, daemon and provider of one version", () => {
			assert.deepEqual([report.kind, report.daemonMode], [process.env.COMPUTER_BOXD_KIND === "desktop" ? "desktop" : "linux", "child"]);
			assert.equal(report.core, "pass", formatReport(report));
			assert.ok(report.daemons.length > 0 && report.daemons.every((daemon) => daemon.version === report.providerVersion), JSON.stringify(report.daemons));
		});

		it("leaves no computer behind", () => {
			assert.deepEqual(report.cleanup.left, []);
			assert.deepEqual(report.cleanup.errors, []);
		});
	},
);
