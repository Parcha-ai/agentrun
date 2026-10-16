import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type StorageWrite } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import type { App } from "../src/home/app.ts";
import { connectHome, type HomeHandle } from "../src/home/host.ts";
import { linkPair } from "../src/home/link.ts";
import type { RecordSink } from "../src/home/records.ts";
import { createRunner, type Runner, type RunnerOptions } from "../src/home/runner.ts";
import { isPlacementRecord, PlacementsDoc } from "../src/place/log.ts";
import type { PlacementRecord } from "../src/place/placer.ts";

const context = BACKGROUND_CONTEXT;

function world() {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-placements-"));
	const faux = fauxProvider({ api: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("ok")));
	const app: App = (ctx) => ({
		registry: createRegistry(),
		root: { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: ctx.workspace } },
	});
	const workspace = join(directory, "work");
	mkdirSync(workspace, { recursive: true });
	const options: RunnerOptions = {
		app,
		session: "session-1",
		store: join(directory, "store", "run.sqlite"),
		workspace,
		where: { environment: "local", provider: "local" },
	};
	return { directory, models, options, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

async function hold(made: ReturnType<typeof world>, runner: Runner, records?: RecordSink): Promise<HomeHandle> {
	const [runnerEnd, hostEnd] = linkPair();
	runner.attach(runnerEnd);
	const host = connectHome(hostEnd, { models: made.models, epoch: 1, ...(records === undefined ? {} : { records }) });
	getOrThrow(await host.ready);
	getOrThrow(await host.resume({ epoch: 1 }, context));
	return host;
}

const decision = (more: Partial<PlacementRecord> = {}): PlacementRecord => ({
	v: 1,
	id: "placement-1",
	session: "session-1",
	at: "2026-10-14T13:00:00.000Z",
	phase: "message",
	what: "home",
	by: "jev",
	current: "local",
	target: "gpu",
	moved: true,
	reason: 'Moved to "gpu": Jev judged the step needs it (0.91).',
	latencyMs: 412,
	...more,
});

describe("the placement log", () => {
	it("keeps a decision in the session's store, in the runner's commit, once, and it outlives the process", async () => {
		const made = world();
		try {
			const runner = createRunner(made.options);
			const host = await hold(made, runner);
			getOrThrow(await host.recordPlacement(decision(), context));
			// The same decision sent again changes nothing.
			getOrThrow(await host.recordPlacement(decision({ reason: "another reason" }), context));
			const harness = runner.home?.harness;
			if (harness === undefined) throw new Error("the session does not run");
			expect(await harness.snapshot(PlacementsDoc, "placement-1", context)).toEqual(decision());
			await runner.home?.close(context);
			host.close("done");
			const again = await Harness.open(
				await openNodeSqliteStorage(made.options.store),
				{ models: made.models, registry: createRegistry() },
				context,
			);
			expect(await again.snapshot(PlacementsDoc, "placement-1", context)).toEqual(decision());
			await again.close(context);
		} finally {
			made.remove();
		}
	}, 30_000);

	it("refuses a decision that says anything but jev or config, and writes nothing", async () => {
		const made = world();
		try {
			const runner = createRunner(made.options);
			const host = await hold(made, runner);
			const scripted = { ...decision(), by: "scripted" } as unknown as PlacementRecord;
			const refused = await host.recordPlacement(scripted, context);
			expect(refused.ok ? "written" : refused.error.code).toBe("invalid");
			expect(await runner.home?.harness?.snapshot(PlacementsDoc, "placement-1", context)).toBeUndefined();
			await runner.home?.close(context);
			host.close("done");
		} finally {
			made.remove();
		}
	}, 30_000);

	it("refuses a decision without every field a reader needs, so the whole one can still be written under its id", async () => {
		for (const field of ["session", "at", "phase", "what", "reason", "latencyMs"] as const) {
			const { [field]: _gone, ...rest } = decision();
			expect(isPlacementRecord(rest), `without ${field}`).toBe(false);
		}
		expect(isPlacementRecord(decision({ phase: "lunch" as never }))).toBe(false);
		expect(isPlacementRecord(decision({ what: "everything" as never }))).toBe(false);
		expect(isPlacementRecord(decision({ latencyMs: -1 }))).toBe(false);
		expect(isPlacementRecord(decision())).toBe(true);
		const made = world();
		try {
			const runner = createRunner(made.options);
			const host = await hold(made, runner);
			const { session: _session, ...partial } = decision();
			const refused = await host.recordPlacement(partial as PlacementRecord, context);
			expect(refused.ok ? "written" : refused.error.code).toBe("invalid");
			// A store keeps the first decision under an id: the incomplete one never got there, so the whole one does.
			getOrThrow(await host.recordPlacement(decision(), context));
			expect(await runner.home?.harness?.snapshot(PlacementsDoc, "placement-1", context)).toEqual(decision());
			await runner.home?.close(context);
			host.close("done");
		} finally {
			made.remove();
		}
	}, 30_000);

	it("reaches the host's log with the record stream, as a commit of the session", async () => {
		const made = world();
		try {
			const log: { commit: number; writes: readonly StorageWrite[] }[] = [];
			let after = 0;
			const sink: RecordSink = {
				held: () => ({ after, linesAfter: 0 }),
				async append(commit, writes) {
					log.push({ commit, writes });
					after = commit;
				},
				async lines() {},
			};
			const runner = createRunner(made.options);
			const host = await hold(made, runner, sink);
			getOrThrow(await host.recordPlacement(decision(), context));
			const shipped = log.flatMap((one) => one.writes);
			expect(JSON.stringify(shipped)).toContain('"transport.placements"');
			expect(JSON.stringify(shipped)).toContain("Jev judged the step needs it");
			await runner.home?.close(context);
			host.close("done");
		} finally {
			made.remove();
		}
	}, 30_000);
});
