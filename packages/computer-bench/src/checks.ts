// Stage 1: the task's checks, run through the protocol against the computer's real state, before it is released. Each
// check passes, fails, or could not run (error): a call the computer could not answer, so the run's state is unknown.
// A check that could not run makes the run an infra outcome (run again, never scored), never a fail.
import type { Check, Match, UiQuery } from "./task.js";
import { clip } from "./record.js";
import { fromBase64, type Wire, type WireError } from "./wire.js";

export interface CheckResult {
	id: string;
	kind: Check["kind"];
	why: string;
	/** pass, fail, or error: it could not run. */
	status: "pass" | "fail" | "error";
	/** What it read, short: the grader and a person read it. */
	output: string;
	/** Why it failed or could not run, in words. */
	reason?: string;
	ms: number;
}

/** stage 1 as a whole: pass when every check passed; error when any could not run; else fail. */
export type Stage1 = "pass" | "fail" | "error";

export function stage1Of(results: readonly CheckResult[]): Stage1 {
	if (results.some((one) => one.status === "error")) return "error";
	return results.every((one) => one.status === "pass") ? "pass" : "fail";
}

/** Whether a text matches, as task.schema.json's match says. */
export function matches(text: string, match: Match): boolean {
	const prepare = (one: string) => {
		const trimmed = match.trim === false ? one : one.trim();
		return match.caseless ? trimmed.toLowerCase() : trimmed;
	};
	const value = prepare(text);
	let hit: boolean;
	if (match.equals !== undefined) hit = value === prepare(match.equals);
	else if (match.contains !== undefined) hit = value.includes(prepare(match.contains));
	else if (match.matches !== undefined) hit = new RegExp(match.matches, `${match.flags ?? ""}${match.caseless && !(match.flags ?? "").includes("i") ? "i" : ""}`).test(match.trim === false ? text : text.trim());
	else if (match.oneOf !== undefined) hit = match.oneOf.map(prepare).includes(value);
	else hit = value === "";
	return match.not ? !hit : hit;
}

/** A match in words, for a failure's reason. */
export function describe(match: Match): string {
	const what =
		match.equals !== undefined
			? `equal ${JSON.stringify(match.equals)}`
			: match.contains !== undefined
				? `contain ${JSON.stringify(match.contains)}`
				: match.matches !== undefined
					? `match /${match.matches}/${match.flags ?? ""}`
					: match.oneOf !== undefined
						? `be one of ${JSON.stringify(match.oneOf)}`
						: "be empty";
	return `${match.not ? "not " : ""}${what}${match.caseless ? " (any case)" : ""}`;
}

/** The error kinds that mean the state was read and the thing is not there (a fail), not that reading failed. */
const ABSENT = new Set(["not_found", "not_dir", "is_dir"]);
/** The most a file check reads: a task's file is text it can match, never a disk image. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** One node of ui.observe, as the bench reads it. */
export interface ObservedNode {
	ref?: string;
	role?: string;
	name?: string;
	value?: string;
	flags?: string[];
}

/** Whether a node is what a query names: its role, and its name, value and flags as far as the query says. */
export function nodeMatches(node: ObservedNode, query: UiQuery): boolean {
	if (query.role !== undefined && (node.role ?? "").toLowerCase() !== query.role.toLowerCase()) return false;
	if (query.name !== undefined && !matches(node.name ?? "", query.name)) return false;
	if (query.value !== undefined && !matches(node.value ?? "", query.value)) return false;
	if (query.flags !== undefined && !query.flags.every((flag) => (node.flags ?? []).includes(flag))) return false;
	return true;
}

/** A node in one line: `@e4 button "Save" = "x" [focused]`. */
export const nodeLine = (node: ObservedNode): string =>
	`${node.ref ?? "?"} ${node.role ?? "?"}${node.name ? ` ${JSON.stringify(node.name)}` : ""}${node.value ? ` = ${JSON.stringify(clip(node.value, 80))}` : ""}${node.flags?.length ? ` [${node.flags.join(", ")}]` : ""}`;

const errorText = (error: WireError) => `${error.code}: ${error.message}`;

export interface CheckContext {
	wire: Wire;
	/** The agent's final answer, for answer checks. */
	answer?: string;
	signal?: AbortSignal;
}

/** Runs one check. Never throws: a check that throws is an error result. */
export async function runCheck(check: Check, context: CheckContext): Promise<CheckResult> {
	const started = Date.now();
	const done = (status: CheckResult["status"], output: string, reason?: string): CheckResult => ({
		id: check.id,
		kind: check.kind,
		why: check.why,
		status,
		output: clip(output, 1200),
		...(reason === undefined ? {} : { reason }),
		ms: Date.now() - started,
	});
	const { wire, signal } = context;
	try {
		switch (check.kind) {
			case "exec": {
				const ran = await wire.call("exec.run", { argv: check.argv, timeoutMs: check.timeoutMs ?? 30_000 }, { signal });
				if (!ran.ok) return done("error", "", `exec.run could not run: ${errorText(ran.error)}`);
				const value = ran.value as { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
				const stdout = fromBase64(value.stdout);
				const stderr = fromBase64(value.stderr);
				const output = `exit ${value.exitCode}${value.timedOut ? " (timed out)" : ""}\nstdout: ${stdout.trim()}${stderr.trim() ? `\nstderr: ${stderr.trim()}` : ""}`;
				if (value.timedOut) return done("error", output, `the program ran past ${check.timeoutMs ?? 30_000} ms`);
				const exit = check.exit ?? 0;
				if (value.exitCode !== exit) return done("fail", output, `exited ${value.exitCode}, not ${exit}`);
				if (check.stdout && !matches(stdout, check.stdout)) return done("fail", output, `stdout does not ${describe(check.stdout)}`);
				if (check.stderr && !matches(stderr, check.stderr)) return done("fail", output, `stderr does not ${describe(check.stderr)}`);
				return done("pass", output);
			}
			case "file": {
				const want = check.exists ?? true;
				const read = await wire.call("files.read", { path: check.path }, { signal });
				if (!read.ok) {
					if (!ABSENT.has(read.error.code)) return done("error", "", `files.read could not run: ${errorText(read.error)}`);
					return want ? done("fail", read.error.message, `${check.path} is not there`) : done("pass", `${check.path} is not there`);
				}
				if (!want) return done("fail", `${check.path} is there`, `${check.path} must not be there`);
				// The first read proved it is there: only a text match needs the rest.
				if (!check.text) return done("pass", `${check.path} is there`);
				// One files.read answers a chunk: read on by offset to the end, so a match sees the whole file.
				const chunks: Buffer[] = [];
				let value = read.value as { data: string; eof?: boolean };
				let offset = 0;
				for (;;) {
					const chunk = Buffer.from(value.data ?? "", "base64");
					chunks.push(chunk);
					offset += chunk.length;
					if (value.eof !== false) break;
					if (chunk.length === 0 || offset > MAX_FILE_BYTES) return done("error", "", `${check.path} did not end within ${MAX_FILE_BYTES} bytes`);
					const more = await wire.call("files.read", { path: check.path, offset }, { signal });
					if (!more.ok) return done("error", "", `files.read at ${offset} could not run: ${errorText(more.error)}`);
					value = more.value as { data: string; eof?: boolean };
				}
				const text = Buffer.concat(chunks).toString("utf8");
				if (check.text && !matches(text, check.text)) return done("fail", text, `its text does not ${describe(check.text)}`);
				return done("pass", text);
			}
			case "ui": {
				const observed = await wire.call("ui.observe", { ...(check.app ? { target: { app: check.app } } : {}), full: true }, { signal });
				if (!observed.ok) {
					// An app that isn't running has no tree: what was looked for isn't there.
					if (observed.error.code === "not_found") return (check.min ?? 1) === 0 ? done("pass", observed.error.message) : done("fail", observed.error.message, `no tree: ${observed.error.message}`);
					return done("error", "", `ui.observe could not run: ${errorText(observed.error)}`);
				}
				const nodes = ((observed.value as { nodes?: ObservedNode[] }).nodes ?? []).filter((node) => nodeMatches(node, check.find));
				const min = check.min ?? 1;
				const max = check.max;
				const output = nodes.length === 0 ? "no node matched" : nodes.slice(0, 12).map(nodeLine).join("\n");
				if (nodes.length < min) return done("fail", output, `${nodes.length} nodes matched, fewer than ${min}`);
				if (max !== undefined && nodes.length > max) return done("fail", output, `${nodes.length} nodes matched, more than ${max}`);
				return done("pass", output);
			}
			case "app": {
				const listed = await wire.call("apps.list", {}, { signal });
				if (!listed.ok) return done("error", "", `apps.list could not run: ${errorText(listed.error)}`);
				const value = listed.value as { apps: { id: string }[]; foreground: string | null };
				const output = `front: ${value.foreground ?? "none"}; ${value.apps.length} apps`;
				if (check.front !== undefined && value.foreground !== check.front) return done("fail", output, `${check.front} is not in front`);
				if (check.installed !== undefined && !value.apps.some((app) => app.id === check.installed)) return done("fail", output, `${check.installed} is not installed`);
				return done("pass", output);
			}
			case "answer": {
				const answer = context.answer;
				if (answer === undefined) return done("fail", "", "the agent gave no final answer");
				if (!matches(answer, check.text)) return done("fail", answer, `the answer does not ${describe(check.text)}`);
				return done("pass", answer);
			}
		}
	} catch (error) {
		return done("error", "", `the check threw: ${(error as Error).message}`);
	}
}

/** Runs every check, one after another (a check may read what another's program left). */
export async function runChecks(checks: readonly Check[], context: CheckContext): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) results.push(await runCheck(check, context));
	return results;
}
