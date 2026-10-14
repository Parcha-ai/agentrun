import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { connectHome } from "../src/home/host.ts";
import { processLink } from "../src/home/link.ts";
import type { RecordSink } from "../src/home/records.ts";
import { storeHead } from "../src/home/store.ts";

const context = BACKGROUND_CONTEXT;
const ROUNDS = 4;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "home-runner.fixture.ts");

/** The host's models: a stateless faux model that calls `work` once a round, then says it is done. */
function hostModels() {
	const faux = fauxProvider({ api: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 50 }, () => (transcript: { messages: readonly { role: string }[] }) => {
			const done = transcript.messages.filter((message) => message.role === "toolResult").length;
			if (done >= ROUNDS) return fauxAssistantMessage("done");
			return fauxAssistantMessage(fauxToolCall("work", { n: done }), { stopReason: "toolUse" });
		}),
	);
	return models;
}

/** Start the runner program in `box` and hold it over the exec's own streams. */
async function startRunner(box: Box, epoch: number, models = hostModels(), records?: RecordSink) {
	const workspace = box.facts().workspace;
	const store = join(dirname(workspace), "session", "run.sqlite");
	const started = getOrThrow(
		await box.exec(
			[
				process.execPath,
				"--experimental-strip-types",
				"--no-warnings",
				FIXTURE,
				...["--session", "session-1", "--store", store, "--workspace", workspace],
				...["--environment", "box", "--provider", box.facts().provider],
			],
			undefined,
			context,
		),
	);
	let errors = "";
	void (async () => {
		for await (const chunk of started.stderr) errors += new TextDecoder().decode(chunk);
	})();
	const host = connectHome(processLink(started), { models, epoch, ...(records === undefined ? {} : { records }) });
	return { host, process: started, store, workspace, errors: () => errors };
}

describe("a runner program in a box, over the exec's own streams", () => {
	it("runs a session in the box, its model through the host, and ends when the host retires it", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-runner-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
		try {
			const runner = await startRunner(box, 1);
			expect(getOrThrow(await runner.host.ready)).toEqual({ session: "session-1", state: "closed" });
			getOrThrow(await runner.host.resume({ epoch: 1 }, context));
			getOrThrow(await runner.host.submit("go", undefined, context));
			getOrThrow(await runner.host.idle(context));
			const effects = readFileSync(join(runner.workspace, "effects.log"), "utf8").trim().split("\n");
			expect(effects).toEqual(Array.from({ length: ROUNDS }, (_, n) => String(n)));
			expect(runner.host.models.paid).toBe(ROUNDS + 1);
			// The app's console.log went to the error output, not into the link.
			expect(runner.errors()).toContain("did 0");

			runner.host.setEpoch(2);
			getOrThrow(await runner.host.retire(2, context));
			expect(getOrThrow(await runner.process.wait())).toBe(0);
			expect(existsSync(runner.store)).toBe(false);
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("ends with 75 when the host refuses its epoch, and closes the session in order when the link closes", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-runner-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
		try {
			const refused = await startRunner(box, 1);
			getOrThrow(await refused.host.ready);
			getOrThrow(await refused.host.resume({ epoch: 1 }, context));
			refused.host.setEpoch(2);
			getOrThrow(await refused.host.submit("go", undefined, context));
			expect(getOrThrow(await refused.process.wait())).toBe(75);
			expect(refused.host.models.paid).toBe(0);

			// A runner started again opens nothing by itself; its link closing ends it with the store closed.
			const again = await startRunner(box, 1);
			expect(getOrThrow(await again.host.ready).state).toBe("closed");
			getOrThrow(await again.host.resume({ epoch: 1 }, context));
			again.host.close("the host is done");
			expect(getOrThrow(await again.process.wait())).toBe(0);
			// Closed in order: no write-ahead log left with content.
			const wal = `${again.store}-wal`;
			expect(existsSync(wal) ? readFileSync(wal).length : 0).toBe(0);
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("ships every commit to a host that keeps the stream, and a process killed in the middle loses none", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-runner-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
		const log: number[] = [];
		const lines = new Set<number>();
		const snapshots: number[] = [];
		let after = 0;
		let linesAfter = 0;
		const records: RecordSink = {
			held: () => ({ after, linesAfter }),
			async append(commit) {
				log.push(commit);
				after = commit;
			},
			async lines(commit, _lines, snapshot) {
				if (snapshot) snapshots.push(commit);
				else {
					lines.add(commit);
					linesAfter = commit;
				}
			},
		};
		try {
			const models = hostModels();
			const first = await startRunner(box, 1, models, records);
			getOrThrow(await first.host.ready);
			getOrThrow(await first.host.resume({ epoch: 1 }, context));
			getOrThrow(await first.host.submit("go", undefined, context));
			for (let waited = 0; waited < 10_000 && log.length < 6; waited += 5)
				await new Promise((r) => setTimeout(r, 5));
			// The runner process dies at once, wherever it was.
			process.kill(Number(readFileSync(`${first.store}.pid`, "utf8")), "SIGKILL");
			await first.process.wait();
			first.host.close("the runner was killed");
			const again = await startRunner(box, 1, models, records);
			getOrThrow(await again.host.ready);
			getOrThrow(await again.host.resume({ epoch: 1 }, context));
			getOrThrow(await again.host.idle(context));
			again.host.close("done");
			expect(getOrThrow(await again.process.wait())).toBe(0);
			const head = getOrThrow(await storeHead(again.store));
			// Every commit of the store, once, in order: what the dead process had not sent came from its outbox.
			expect(log).toEqual(Array.from({ length: head - 1 }, (_, n) => n + 1));
			// Lines for every commit but at most the one in flight when the process died; a snapshot from each process.
			const missing = log.filter((commit) => !lines.has(commit));
			expect(missing.length, `commits without lines: ${missing.join(", ")}`).toBeLessThanOrEqual(1);
			expect(snapshots).toHaveLength(2);
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("refuses to start below the Node floor, and without its arguments", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-runner-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
		try {
			const started = getOrThrow(
				await box.exec(
					[process.execPath, "--experimental-strip-types", "--no-warnings", FIXTURE],
					undefined,
					context,
				),
			);
			const [code, stderr] = await Promise.all([
				started.wait(),
				(async () => {
					let text = "";
					for await (const chunk of started.stderr) text += new TextDecoder().decode(chunk);
					return text;
				})(),
				(async () => {
					for await (const _ of started.stdout);
				})(),
			]);
			expect(getOrThrow(code)).toBe(64);
			expect(stderr).toContain("--session, --store and --workspace are required");
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);
});
