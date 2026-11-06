// The runner: runs each case against a provider, one at a time, and deletes every computer it made.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { DaemonClient } from "../client.js";
import { sweep } from "../janitor.js";
import type { DaemonCapability, ExecRunParams, HelloResult } from "../protocol.js";
import type { ComputerConnection, ComputerProvider, ComputerRef, ComputerSpec } from "../provider.js";
import type { ComputerErrorCode, Result } from "../result.js";
import { conformanceCases } from "./cases/index.js";
import type { Capability, Case, CaseContext, CaseResult, ConformanceOptions, ConformanceReport, Ran } from "./types.js";

/** The label every computer of a run carries, with the run's id. */
export const RUN_LABEL = "agentrun.conformance";
const LIFETIME_MS = 30 * 60_000;
const DAEMON_CAPABILITIES: ReadonlySet<string> = new Set<DaemonCapability>(["exec", "files", "processes"]);
const CLOSE_MS = 10_000;

class Skip extends Error {}

const show = (value: unknown) => {
	const text = value === undefined ? "undefined" : JSON.stringify(value);
	return text.length > 300 ? `${text.slice(0, 300)}...` : text;
};
const words = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ");
const unwrap = <T>(result: Result<T>, what: string): T => {
	if (result.ok) return result.value;
	throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
};
/** Settles with promise, or after ms with undefined: a close that hangs does not hang the run. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	const stop = new AbortController();
	try {
		return await Promise.race([promise, sleep(ms, undefined, { signal: stop.signal }).catch(() => undefined)]);
	} finally {
		stop.abort();
	}
}

/** Rejects when the signal aborts, with the abort's reason. */
function whenAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("the run was aborted"));
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
}

/**
 * Runs the cases against the provider and reports each one. Every computer carries the run's label; each one a case
 * makes is deleted when the case ends, the shared one when the run ends, then a janitor provider is swept by the label
 * and the label is listed to show nothing is left.
 */
export async function runConformance(provider: ComputerProvider, options: ConformanceOptions): Promise<ConformanceReport> {
	const { image, only, signal, cases = conformanceCases, drifted, onResult, caseTimeoutMs = 180_000, patience = 30_000 } = options;
	const run = randomBytes(6).toString("hex");
	const runLabels = { [RUN_LABEL]: run };
	const capabilities = provider.capabilities();
	const selected = only === undefined ? cases : cases.filter((c) => only.includes(c.group) || only.includes(c.id));
	const report: ConformanceReport = {
		provider: provider.id,
		providerVersion: provider.version,
		image,
		daemon: null,
		...(only === undefined ? {} : { only }),
		results: [],
		core: "fail",
		undeclared: [],
		cleanup: { deleted: [], left: [], errors: [] },
	};
	const deleted = new Set<string>();

	const spec = (extra: Partial<ComputerSpec> = {}): ComputerSpec => ({
		image,
		lifetimeMs: LIFETIME_MS,
		network: capabilities.network.includes("none") ? "none" : capabilities.network[0] === "allow" ? { allow: [] } : (capabilities.network[0] ?? "none"),
		...extra,
		labels: { ...extra.labels, ...runLabels },
	});
	const release = async (ref: ComputerRef) => {
		try {
			const released = await provider.release(ref, "delete");
			if (released.ok) deleted.add(ref.name);
			else report.cleanup.errors.push(`release ${ref.name}: ${released.error.code}: ${released.error.message}`);
		} catch (error) {
			report.cleanup.errors.push(`release ${ref.name} threw: ${words(error)}`);
		}
	};
	const createError = (result: Result<unknown>) =>
		result.ok ? "" : `create ${result.error.code === "refused" ? "was refused" : `failed (${result.error.code})`}: ${result.error.message}`;
	const sawHello = (hello: HelloResult) => {
		report.daemon ??= { version: hello.version, arch: hello.arch };
	};

	/** The run's shared computer, made the first time a case needs it or the daemon's hello. */
	let shared: Promise<{ ref: ComputerRef; hello: HelloResult } | { error: string }> | undefined;
	let sharedRef: ComputerRef | undefined;
	const getShared = () =>
		(shared ??= (async () => {
			const created = await provider.create(spec());
			if (!created.ok) return { error: createError(created) };
			sharedRef = created.value;
			const connected = await provider.connect(created.value);
			if (!connected.ok) return { error: `connect: ${connected.error.code}: ${connected.error.message}` };
			await bounded(connected.value.close(), CLOSE_MS);
			sawHello(connected.value.hello);
			return { ref: created.value, hello: connected.value.hello };
		})().catch((error: unknown) => ({ error: `the provider threw: ${words(error)}` })));

	/** Why a case cannot run here, or undefined when everything it needs is declared. */
	const missing = async (needs: Capability[]): Promise<string | undefined> => {
		for (const need of needs) {
			if (DAEMON_CAPABILITIES.has(need)) {
				if (!capabilities.daemon.includes(need as DaemonCapability)) return `the provider does not declare ${need}`;
				const got = await getShared();
				if ("hello" in got && !got.hello.capabilities.includes(need as DaemonCapability)) return `the daemon's hello does not declare ${need}`;
			} else if (need.startsWith("network:")) {
				if (!capabilities.network.includes(need.slice("network:".length) as "none")) return `the provider does not declare ${need}`;
			} else if (need === "lifetime:janitor" && capabilities.lifetime !== "janitor") {
				return `the provider declares lifetime "${capabilities.lifetime}", not ${need}`;
			}
		}
		return undefined;
	};

	const runCase = async (c: Case): Promise<CaseResult> => {
		const result = (status: CaseResult["status"], reason?: string): CaseResult => ({
			id: c.id,
			level: c.level,
			group: c.group,
			status,
			...(reason === undefined ? {} : { reason }),
		});
		if (signal?.aborted) return result("fail", "not run: the run was aborted");
		const why = await missing(c.needs);
		if (why !== undefined) {
			if (c.level === "full") {
				for (const need of c.needs) if (!report.undeclared.includes(need) && (await missing([need])) !== undefined) report.undeclared.push(need);
			}
			return result("skip", why);
		}
		const timeoutMs = c.timeoutMs ?? caseTimeoutMs;
		const timer = new AbortController();
		const timeout = setTimeout(() => timer.abort(new Error(`${c.id} did not finish within ${timeoutMs / 1000} s`)), timeoutMs);
		const caseSignal = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
		const refs: ComputerRef[] = [];
		const connections: ComputerConnection[] = [];
		let dirs = 0;

		const connect = async (ref: ComputerRef) => {
			const connected = unwrap(await provider.connect(ref), `connect to ${ref.name}`);
			let closing: Promise<void> | undefined;
			const once: ComputerConnection = { ...connected, close: () => (closing ??= connected.close()) };
			connections.push(once);
			sawHello(connected.hello);
			return once;
		};
		const create = async (extra?: Partial<ComputerSpec>) => {
			const created = await provider.create(spec(extra), { signal: caseSignal });
			if (!created.ok) throw new Error(createError(created));
			refs.push(created.value);
			return created.value;
		};

		const prepareAndRun = async () => {
			let computer: { ref: ComputerRef; connection: ComputerConnection } | undefined;
			if ((c.computer ?? "shared") === "shared") {
				const got = await getShared();
				if ("error" in got) throw new Error(`no computer: ${got.error}`);
				computer = { ref: got.ref, connection: await connect(got.ref) };
			} else if (c.computer === "fresh") {
				const ref = await create().catch((error: unknown) => {
					throw new Error(`no computer: ${words(error)}`);
				});
				computer = { ref, connection: await connect(ref) };
			}
			const needComputer = () => {
				if (computer === undefined) throw new Error(`${c.id} asked for a computer, but it runs with none`);
				return computer;
			};
			const t: CaseContext = {
				provider,
				image,
				signal: caseSignal,
				runLabels,
				patience,
				get ref() {
					return needComputer().ref;
				},
				get client() {
					return needComputer().connection.client;
				},
				get hello() {
					return needComputer().connection.hello;
				},
				spec,
				create,
				connect: (ref) => connect(ref ?? needComputer().ref),
				async dir() {
					const path = `/tmp/agentrun-conformance-${run}/${c.id.replace(/[^a-z0-9-]/gi, "-")}-${++dirs}`;
					await t.call("files.mkdir", { path, parents: true });
					return path;
				},
				async drifted() {
					if (drifted === undefined) return t.skip("no drifted provider was given: a provider module exports createDriftedProvider() for the drift cases");
					return await drifted();
				},
				async exec(argv: string[], extra: Partial<ExecRunParams> = {}, client: DaemonClient = t.client): Promise<Ran> {
					const ran = unwrap(await client.call("exec.run", { argv, timeoutMs: patience, ...extra }, { signal: caseSignal }), `exec.run ${show(argv)}`);
					const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");
					return {
						exitCode: ran.exitCode,
						...(ran.signal === undefined ? {} : { signal: ran.signal }),
						out: decode(ran.stdout),
						err: decode(ran.stderr),
						timedOut: ran.timedOut,
						truncated: ran.truncated,
					};
				},
				async call(method, params, client = t.client) {
					return unwrap(await client.call(method, params, { signal: caseSignal }), method);
				},
				ok: unwrap,
				refused(result: Result<unknown>, what: string, codes?: ComputerErrorCode[]) {
					if (result.ok) throw new Error(`${what}: expected an error${codes ? ` (${codes.join(" or ")})` : ""}, got ok ${show(result.value)}`);
					if (codes && !codes.includes(result.error.code)) {
						throw new Error(`${what}: expected ${codes.join(" or ")}, got ${result.error.code}: ${result.error.message}`);
					}
					return result.error;
				},
				equal(actual, expected, what) {
					if (!Object.is(actual, expected)) throw new Error(`${what}: expected ${show(expected)}, got ${show(actual)}`);
				},
				deepEqual(actual, expected, what) {
					if (!isDeepStrictEqual(actual, expected)) throw new Error(`${what}: expected ${show(expected)}, got ${show(actual)}`);
				},
				match(text, pattern, what) {
					if (typeof text !== "string" || !pattern.test(text)) throw new Error(`${what}: expected to match ${pattern}, got ${show(text)}`);
				},
				assert(condition: unknown, what: string) {
					if (!condition) throw new Error(what);
				},
				present<T>(value: T | undefined | null, what: string): T {
					if (value === undefined || value === null) throw new Error(what);
					return value;
				},
				async until(fn, what) {
					const end = Date.now() + patience;
					for (;;) {
						const value = await fn();
						if (value !== undefined && value !== false) return value;
						if (Date.now() > end) throw new Error(`${what}: still not so after ${patience / 1000} s`);
						if (caseSignal.aborted) throw caseSignal.reason;
						await sleep(200);
					}
				},
				skip(reason: string): never {
					throw new Skip(reason);
				},
			};
			await c.run(t);
		};

		try {
			await Promise.race([prepareAndRun(), whenAborted(caseSignal)]);
			return result("pass");
		} catch (error) {
			if (error instanceof Skip) return result("skip", error.message);
			if (signal?.aborted && !timer.signal.aborted) return result("fail", "the run was aborted");
			return result("fail", words(error));
		} finally {
			clearTimeout(timeout);
			for (const connection of connections) await bounded(connection.close().catch(() => {}), CLOSE_MS);
			for (const ref of refs) await release(ref);
		}
	};

	try {
		for (const c of selected) {
			const result = await runCase(c);
			report.results.push(result);
			onResult?.(result);
		}
	} finally {
		if (shared !== undefined) await shared;
		if (sharedRef !== undefined) await release(sharedRef);
		await cleanup(provider, capabilities.lifetime, runLabels, report, deleted);
	}
	const core = report.results.filter((r) => r.level === "core");
	const clean = report.cleanup.left.length === 0 && report.cleanup.errors.length === 0;
	report.core = core.length > 0 && core.every((r) => r.status === "pass") && clean ? "pass" : "fail";
	return report;
}

/** Sweeps a janitor provider by the run's label, past every deadline, and lists the label to show nothing is left. */
async function cleanup(
	provider: ComputerProvider,
	lifetime: "vendor" | "janitor",
	labels: Record<string, string>,
	report: ConformanceReport,
	deleted: Set<string>,
) {
	try {
		if (lifetime === "janitor") {
			const swept = await sweep(provider, { labels, now: new Date(Date.now() + 366 * 24 * 60 * 60_000) });
			if (swept.ok) for (const name of swept.value.deleted) deleted.add(name);
			else report.cleanup.errors.push(`sweep: ${swept.error.code}: ${swept.error.message}`);
		}
		const listed = await provider.list(labels);
		if (listed.ok) report.cleanup.left = listed.value.map((info) => info.ref.name).sort();
		else report.cleanup.errors.push(`list ${JSON.stringify(labels)}: ${listed.error.code}: ${listed.error.message}`);
	} catch (error) {
		report.cleanup.errors.push(`cleanup threw: ${words(error)}`);
	}
	report.cleanup.deleted = [...deleted];
}
