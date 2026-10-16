// A runner for the box place's tests: a job of `STEPS` steps, each a commit of the session's progress, the way the
// reference entry's child drives its job. It writes what a supervisor carries across (a crossings log, a recording's
// spool lines and blobs), asks to be killed at `PARK_AT` and waits there, and prints its outcome when the job is done.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";
import type { App } from "../src/home/app.ts";
import { runMain } from "../src/home/main.ts";

const Progress = defineDocFamily<JsonObject, null>({
	kind: "fixture.progress",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({}),
});

const app: App = (ctx) => ({
	registry: createRegistry(),
	async onResumed(harness, context) {
		const { env } = ctx;
		const steps = Number(env.STEPS ?? "3");
		const parkAt = env.PARK_AT === undefined ? undefined : Number(env.PARK_AT);
		const read = (await harness.snapshot(Progress, "progress", context)) as { done?: number } | undefined;
		let done = Number(read?.done ?? 0);
		const resumedFrom = done;
		const record = env.RECORD_DIR;
		// The recording's clock comes in the order's environment; the runner writes it into its own directory.
		const started = env.RECORD_STARTED ?? null;
		if (record !== undefined) {
			mkdirSync(join(record, ".spool"), { recursive: true });
			const startedFile = join(record, ".spool", "started");
			if (started !== null && !existsSync(startedFile)) writeFileSync(startedFile, `${started}\n`);
		}
		while (done < steps) {
			done += 1;
			const step = done;
			await harness.commit(async (tx) => {
				const progress = await tx.doc(Progress, "progress", null);
				progress.done = step;
			}, context);
			if (env.CROSS_LOG !== undefined)
				appendFileSync(env.CROSS_LOG, `${JSON.stringify({ point: "fixture.step", n: step })}\n`);
			if (record !== undefined) {
				const text = `step ${step}`;
				const hash = createHash("sha256").update(text).digest("hex");
				mkdirSync(join(record, "blobs"), { recursive: true });
				if (!existsSync(join(record, "blobs", hash))) writeFileSync(join(record, "blobs", hash), text);
				appendFileSync(join(record, ".spool", `${process.pid}.jsonl`), `${JSON.stringify({ step, blob: hash })}\n`);
			}
			if (step === parkAt && env.KILL_REQUEST !== undefined) {
				const asked = JSON.stringify({ point: "fixture.step", n: step, nonce: env.KILL_NONCE });
				writeFileSync(`${env.KILL_REQUEST}.tmp`, asked);
				renameSync(`${env.KILL_REQUEST}.tmp`, env.KILL_REQUEST);
				// At rest until the supervisor kills it.
				await new Promise(() => {});
			}
		}
		if (record !== undefined && env.BAD_BLOB === "1") {
			// A blob whose name is not the hash of its bytes.
			const named = createHash("sha256").update("other bytes").digest("hex");
			writeFileSync(join(record, "blobs", named), "not the bytes the name says");
		}
		if (record !== undefined && env.PARTIAL === "1") {
			// A line the recorder was writing when the runner ended: no newline yet.
			appendFileSync(join(record, ".spool", `${process.pid}.jsonl`), '{"step":');
		}
		console.log(
			JSON.stringify({
				outcome: {
					status: "complete",
					generation: ctx.epoch,
					record: { done, resumedFrom, started, root: ctx.root },
				},
			}),
		);
	},
});

await runMain(app);
