// The run record: one JSONL file per run, whose lines are entries shaped like serve's journal entries ({kind, at, run,
// data}), so they can move into a run's journal as they are once serve writes computer steps itself. Kinds:
//   agentrun.bench.run      the header: task (id, version, sha256, seed, params), arm, budgets, tool and prompt shas,
//                           and the computer's identity from its hello
//   agentrun.computer.step  one protocol call: method, params without bytes, timings, route, verified, changed, state
//                           ids, and the images it carried or followed, as content-addressed blobs (sha256)
//   agentrun.bench.checks   stage 1's results
//   agentrun.bench.grade    stage 2's verdict, when the grader ran
//   agentrun.bench.verdict  how the run ended and how it counts
//   agentrun.bench.cleanup  a teardown or release that failed after the verdict (recorded, never scored)
// Images are kept once each under blobs/<sha256>.png; an entry names them by hash.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hello, Json, JsonObject } from "./wire.js";

export const ENTRY = {
	run: "agentrun.bench.run",
	step: "agentrun.computer.step",
	checks: "agentrun.bench.checks",
	grade: "agentrun.bench.grade",
	verdict: "agentrun.bench.verdict",
	cleanup: "agentrun.bench.cleanup",
} as const;

/** Who made a call: the bench reading the task's preconditions (apps, capability probes), setting up, the agent, the
 *  bench's frame after an act, the bench's ping after the agent's turn, a check, teardown, or the oracle. */
export type Phase = "precondition" | "setup" | "agent" | "frame" | "ping" | "check" | "observe" | "teardown" | "oracle";

/** One protocol call, as the record keeps it. */
export interface Step {
	n: number;
	phase: Phase;
	method: string;
	/** The params, with every byte field replaced by its size and sha256. */
	params: Json;
	/** Milliseconds from the run's start to the call's send, and the call's length as the bench saw it. */
	t_ms: number;
	ms: number;
	/** The daemon's own time for it, when its answer says (elapsedMs). */
	daemon_ms?: number;
	ok: boolean;
	error?: { code: string; message: string };
	/** ui.act: each step tried, by its route ("semantic", "page", "background", "foreground"), or "error" for the refused one. */
	routes?: string[];
	/** ui.act: how many of its steps a readback verified, of how many ran. */
	verified?: number;
	ran?: number;
	/** Whether the screen changed: ui.act's own answer, else the frames before and after differ. */
	changed?: boolean;
	expect?: "met" | "unmet";
	/** The state the call acted on, and the state it left (ui.observe, ui.act). */
	state?: { before?: string; after?: string };
	/** Images by sha256: one the call returned (got), and the frames before and after an act (pre, post). */
	image?: { got?: string; pre?: string; post?: string };
	/** Errors of kind stale this call met (a refused call, or ui.act steps). */
	stale?: number;
	/** A short text of the answer, for the grader and a reader (an exec's output, an observe's outline). */
	note?: string;
}

/** The computer, as the run record names it. */
export interface ComputerIdentity {
	provider: string;
	ref?: string;
	region?: string;
	image?: string;
	hello: Hello;
}

export interface RunHeader {
	bench: { version: string; run: string };
	task: { id: string; version: number; sha256: string; split: string; seed: number; nonce: string; params: Record<string, Json>; instruction: string; source?: string };
	arm: { id: string; harness: string; surface: string; model: string; effort?: string };
	attempt: number;
	budget: { steps: number; usd: number; wall_s: number };
	/** sha256 of what the agent was given: its tool schemas, its system prompt, the kind skill. */
	given?: { tools_sha256?: string; system_sha256?: string; skill_sha256?: string };
	computer: ComputerIdentity;
	started_at: string;
}

/** Where a bench run writes: its folder, the blobs, one record per run. */
export class Store {
	readonly blobs: string;
	readonly runs: string;
	constructor(readonly dir: string) {
		this.blobs = join(dir, "blobs");
		this.runs = join(dir, "runs");
		mkdirSync(this.blobs, { recursive: true });
		mkdirSync(this.runs, { recursive: true });
	}

	/** Keeps an image (PNG or JPEG) once, named by its sha256 alone; returns the sha256. imageType says which it is. */
	blob(bytes: Buffer): string {
		const sha = createHash("sha256").update(bytes).digest("hex");
		const path = this.blobPath(sha);
		if (!existsSync(path)) writeFileSync(path, bytes);
		return sha;
	}

	blobPath(sha: string): string {
		return join(this.blobs, sha);
	}

	/** A run's record: entries appended as they happen, so a run that dies leaves what it did. */
	record(run: string): RunRecord {
		return new RunRecord(run, join(this.runs, `${run}.jsonl`));
	}

	/** One line to a file of the bench run's folder (results.jsonl, human-queue.jsonl). */
	append(name: string, value: unknown): void {
		appendFileSync(join(this.dir, name), `${JSON.stringify(value)}\n`);
	}

	write(name: string, text: string): void {
		writeFileSync(join(this.dir, name), text);
	}
}

export class RunRecord {
	constructor(
		readonly run: string,
		readonly path: string,
	) {}

	entry(kind: (typeof ENTRY)[keyof typeof ENTRY], data: unknown): void {
		appendFileSync(this.path, `${JSON.stringify({ kind, at: new Date().toISOString(), run: this.run, data })}\n`);
	}
}

/** Fields that carry bytes as base64, by where they are. Their values are kept as {bytes, sha256}, never as data. */
const BYTE_FIELDS = new Set(["data", "stdout", "stderr", "png", "bytes"]);

/** A params or result object with its bytes taken out: each base64 field becomes its size and hash. */
export function withoutBytes(value: unknown): Json {
	if (Array.isArray(value)) return value.map(withoutBytes);
	if (value && typeof value === "object") {
		const out: JsonObject = {};
		for (const [key, one] of Object.entries(value)) {
			if (BYTE_FIELDS.has(key) && typeof one === "string") {
				const bytes = Buffer.from(one, "base64");
				out[key] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
			} else out[key] = withoutBytes(one);
		}
		return out;
	}
	return (value ?? null) as Json;
}

/** Short text, at most `n` characters. */
/** An image's media type from its first bytes: screen.shot sends PNG, ui.observe PNG or JPEG. */
export function imageType(bytes: Buffer): "image/png" | "image/jpeg" | undefined {
	if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	return undefined;
}

export const clip =(text: string, n = 600): string => (text.length > n ? `${text.slice(0, n)}…` : text);
