// The runner: runs each case against a provider, one at a time, and deletes every computer it made.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { sweep } from "../janitor.js";
import type { MountKind } from "../mount.js";
import { type ComputerClient, type ExecRunParams, type Group, GROUPS, type HelloResult } from "../protocol.js";
import type { ComputerConnection, ComputerProvider, ComputerRef, ComputerSpec, CreatedComputer } from "../provider.js";
import { type ComputerErrorCode, fail, ok, type Result } from "../result.js";
import { conformanceCases } from "./cases/index.js";
import { type CdpSocket, dialCdp } from "./cdp.js";
import { type StartedFixture, startFixture } from "./fixture.js";
import { kindCases, kindRunProblem, kindVerdict } from "./kind.js";
import {
	type Capability,
	type Case,
	type Clock,
	type CaseContext,
	type CaseResult,
	type ConformanceOptions,
	type ConformanceReport,
	coreGroups,
	type Ran,
	type RunFolder,
} from "./types.js";

/** The label every computer of a run carries, with the run's id. */
export const RUN_LABEL = "agentrun.conformance";
/** The lifetime a run's computers ask for, at most the provider's own cap: a metered phone's cap is its hard stop. */
const LIFETIME_MS = 30 * 60_000;
const GROUP_NAMES: ReadonlySet<string> = new Set(GROUPS);
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

/** Settles with promise, or rejects in words when it has not answered within ms, or at once when signal aborts. */
async function within<T>(promise: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
	const stop = new AbortController();
	// The abort's listener goes when this settles, so a later abort rejects nothing left unhandled.
	let off = () => {};
	const aborted = new Promise<never>((_, reject) => {
		if (signal === undefined) return;
		const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error(`${what}: the run was aborted`));
		if (signal.aborted) return fail();
		signal.addEventListener("abort", fail, { once: true });
		off = () => signal.removeEventListener("abort", fail);
	});
	try {
		return await Promise.race([
			promise,
			sleep(ms, undefined, { signal: stop.signal }).then(() => {
				throw new Error(`${what} did not answer within ${ms / 1000} s`);
			}),
			aborted,
		]);
	} finally {
		stop.abort();
		off();
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
 * and the label is listed to show nothing is left. Every provider call is bounded: one that never answers fails its case
 * or is named in the cleanup, and a computer that arrives after its case ended is deleted when it arrives.
 */
export async function runConformance(provider: ComputerProvider, options: ConformanceOptions): Promise<ConformanceReport> {
	const { image, only, kind, signal, cases = conformanceCases, drifted, mountFor, onResult, notes, caseTimeoutMs = 180_000, patience = 30_000, cleanupTimeoutMs = 60_000, fixture } = options;
	if (kind !== undefined && only !== undefined) throw new TypeError("a run takes kind and only apart: a kind runs its own cases");
	const kindProblem = kind === undefined ? undefined : kindRunProblem(kind);
	if (kindProblem !== undefined) throw new TypeError(kindProblem);
	const fetcher = options.fetch ?? ((url: string, init?: { signal?: AbortSignal; method?: string }) => fetch(url, init));
	const dialer = options.cdp ?? dialCdp;
	const clock: Clock = options.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
	const run = randomBytes(6).toString("hex");
	const runLabels = { [RUN_LABEL]: run };
	const capabilities = provider.capabilities();
	// A provider of the shape before groups declares none, so its kind-consistent case fails in words, not the run.
	const groups: Group[] = Array.isArray(capabilities.groups) ? capabilities.groups : [];
	/** What this kind of computer must declare: a case missing one fails, where a case missing an optional one skips. */
	const required: ReadonlySet<Capability> = new Set(coreGroups(capabilities.kind, capabilities.daemon));
	const selected = kind !== undefined ? kindCases(kind, cases) : only === undefined ? cases : cases.filter((c) => only.includes(c.group) || only.includes(c.id));
	const report: ConformanceReport = {
		provider: provider.id,
		providerVersion: provider.version,
		kind: capabilities.kind,
		daemonMode: capabilities.daemon,
		image,
		daemon: null,
		...(only === undefined ? {} : { only }),
		...(only === undefined && kind === undefined ? {} : { coreNotRun: cases.filter((c) => c.level === "core" && !selected.includes(c)).map((c) => c.id) }),
		results: [],
		core: "fail",
		undeclared: [],
		cleanup: { deleted: [], left: [], errors: [], late: [] },
		...(notes !== undefined && notes.length > 0 ? { notes: [...notes] } : {}),
	};
	const deleted = new Set<string>();
	/**
	 * Provider calls a run stopped waiting for, each with what it is; the cleanup waits for them, bounded, so what they
	 * make is deleted, and names each one still pending after that in cleanup.errors.
	 */
	const pending = new Map<Promise<unknown>, string>();
	const keep = (promise: Promise<unknown>, what: string) => {
		pending.set(promise, what);
		// Both branches handled: a rejection is the caller's to report, never an unhandled one here.
		const done = () => pending.delete(promise);
		void promise.then(done, done);
	};

	// Network none, never wider, wherever the kind requires it: a provider without it fails Core rather than being tested
	// on an open network. A phone, whose kind does not require none, is tested on none when it declares it, else open.
	const network = required.has("network:none") || capabilities.network.includes("none") ? "none" : "open";
	const spec = (extra: Partial<ComputerSpec> = {}): ComputerSpec => ({
		image,
		lifetimeMs: Number.isSafeInteger(capabilities.maxLifetimeMs) && capabilities.maxLifetimeMs > 0 ? Math.min(LIFETIME_MS, capabilities.maxLifetimeMs) : LIFETIME_MS,
		network,
		...extra,
		labels: { ...extra.labels, ...runLabels },
	});
	const release = async (ref: ComputerRef, by: ComputerProvider = provider) => {
		try {
			const released = await within(by.release(ref, "delete"), cleanupTimeoutMs, `release ${ref.name}`);
			if (released.ok) deleted.add(ref.name);
			else report.cleanup.errors.push(`release ${ref.name}: ${released.error.code}: ${released.error.message}`);
		} catch (error) {
			report.cleanup.errors.push(words(error).startsWith(`release ${ref.name}`) ? words(error) : `release ${ref.name} threw: ${words(error)}`);
		}
	};
	/** Records the notes a create returned beside its ref, each naming the computer: never dropped with the ref. */
	const noteCreated = (created: Result<CreatedComputer>) => {
		if (!created.ok || !Array.isArray(created.value.notes)) return;
		for (const note of created.value.notes) (report.computerNotes ??= []).push({ computer: created.value.name, note: String(note) });
	};
	/** Deletes the computer a create gives after nobody waits for it any more, and names it in the report. */
	const lateCreate = (creating: Promise<Result<CreatedComputer>>, what: string, by: ComputerProvider = provider) =>
		keep(
			creating.then(
				async (created) => {
					noteCreated(created);
					if (!created.ok) return;
					report.cleanup.late.push(created.value.name);
					await release(created.value, by);
				},
				() => {},
			),
			what,
		);
	const createError = (result: Result<unknown>) =>
		result.ok ? "" : `create ${result.error.code === "refused" ? "was refused" : `failed (${result.error.code})`}: ${result.error.message}`;
	const sawHello = (hello: HelloResult) => {
		report.daemon ??= { version: hello.version, os: hello.os, arch: hello.arch };
	};

	/** The run's shared computer, made the first time a case needs it or the daemon's hello. */
	let shared: Promise<{ ref: ComputerRef; hello: HelloResult } | { error: string }> | undefined;
	let sharedRef: ComputerRef | undefined;
	const getShared = () =>
		(shared ??= (async () => {
			// The run's signal ends the wait at once (Ctrl-C during setup) and reaches the create; a computer that arrives
			// after it is deleted as it lands (lateCreate).
			const stop = new AbortController();
			const creating = provider.create(spec(), { signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal });
			let created: Result<CreatedComputer>;
			try {
				created = await within(creating, caseTimeoutMs, "create", signal);
			} catch (error) {
				stop.abort();
				lateCreate(creating, "create (the run's computer)");
				return { error: words(error) };
			}
			noteCreated(created);
			if (!created.ok) return { error: createError(created) };
			sharedRef = created.value;
			const connecting = provider.connect(created.value);
			let connected: Result<ComputerConnection>;
			try {
				connected = await within(connecting, caseTimeoutMs, "connect", signal);
			} catch (error) {
				keep(
					connecting.then((late) => (late.ok ? bounded(late.value.close(), CLOSE_MS) : undefined), () => {}),
					`connect to ${created.value.name} (the run's computer)`,
				);
				return { error: words(error) };
			}
			if (!connected.ok) return { error: `connect: ${connected.error.code}: ${connected.error.message}` };
			await bounded(connected.value.close(), CLOSE_MS);
			sawHello(connected.value.hello);
			return { ref: created.value, hello: connected.value.hello };
		})().catch((error: unknown) => ({ error: `the provider threw: ${words(error)}` })));

	/** Why a case cannot run here, or undefined when everything it needs is declared. */
	const missing = async (needs: Capability[]): Promise<string | undefined> => {
		for (const need of needs) {
			// stream is a group (a live view, the provider's) and a provider method: a case that needs it needs stream().
			if (need === "extend" || need === "stream") {
				if (typeof provider[need] !== "function") return `the provider has no ${need}()`;
			} else if (GROUP_NAMES.has(need)) {
				if (!groups.includes(need as Group)) return `the provider does not declare ${need}`;
				const got = await getShared();
				if ("hello" in got && !(Array.isArray(got.hello.groups) && got.hello.groups.includes(need as Group))) {
					return `the ${capabilities.daemon === "none" ? "computer's" : "daemon's"} hello does not declare ${need}`;
				}
			} else if (need.startsWith("mount:")) {
				if (!capabilities.mount?.includes(need.slice("mount:".length) as MountKind)) return `the provider does not declare ${need}`;
			} else if (need.startsWith("network:")) {
				if (!capabilities.network.includes(need.slice("network:".length) as "none")) return `the provider does not declare ${need}`;
			} else if (need === "lifetime:janitor" && capabilities.lifetime !== "janitor") {
				return `the provider declares lifetime "${capabilities.lifetime}", not ${need}`;
			} else if (need.startsWith("user:") && !capabilities.user?.includes(need.slice("user:".length) as "root")) {
				return `the provider does not declare ${need}`;
			} else if (need === "release:stop" && !(Array.isArray(capabilities.release) && capabilities.release.includes("stop"))) {
				return `the provider does not declare ${need}`;
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
			const lacking: Capability[] = [];
			for (const need of c.needs) if ((await missing([need])) !== undefined) lacking.push(need);
			// A Core case fails when its kind requires what is missing ("a desktop computer must declare screen"); a case
			// whose missing needs are all optional is skipped and named in undeclared.
			const owed = c.level === "core" ? lacking.find((need) => required.has(need)) : undefined;
			if (owed !== undefined) {
				const who = capabilities.daemon === "none" ? `a ${capabilities.kind} computer` : `a ${capabilities.kind} computer with daemon ${capabilities.daemon}`;
				return result("fail", `${who} must declare ${owed}: ${(await missing([owed])) ?? why}`);
			}
			for (const need of lacking) if (!report.undeclared.includes(need)) report.undeclared.push(need);
			return { ...result("skip", why), undeclared: lacking };
		}
		// The shared computer is made, bounded on its own, before the case's time starts.
		const sharedComputer = (c.computer ?? "shared") === "shared" ? await getShared() : undefined;
		const timeoutMs = c.timeoutMs ?? caseTimeoutMs;
		const timer = new AbortController();
		const timeout = setTimeout(() => timer.abort(new Error(`${c.id} did not finish within ${timeoutMs / 1000} s`)), timeoutMs);
		const caseSignal = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
		const refs: Array<{ ref: ComputerRef; by: ComputerProvider }> = [];
		const connections: ComputerConnection[] = [];
		const sockets: CdpSocket[] = [];
		let started: Promise<StartedFixture> | undefined;
		/** The fixture's stop, set as soon as it is launched: one that never logs ready is stopped as well. */
		let stopFixture: (() => Promise<void>) | undefined;
		let dirs = 0;
		/** The run folders the case asked for: each is closed when the case ends, after its computers are deleted. */
		const folders: RunFolder[] = [];
		// Set when the case ends: what a provider call gives after that is ended at once, not left to the case.
		let ended = false;

		const track = (ref: ComputerRef, by: ComputerProvider = provider) => {
			if (!ended) refs.push({ ref, by });
			else {
				report.cleanup.late.push(ref.name);
				keep(release(ref, by), `release ${ref.name}`);
			}
		};
		const connect = async (ref: ComputerRef) => {
			const connecting = provider.connect(ref).then((connected) => {
				if (!connected.ok) return connected;
				let closing: Promise<void> | undefined;
				const once: ComputerConnection = { ...connected.value, close: () => (closing ??= connected.value.close()) };
				if (ended) keep(bounded(once.close(), CLOSE_MS), `close of a connection to ${ref.name} (${c.id})`);
				else connections.push(once);
				return ok(once);
			});
			keep(connecting, `connect to ${ref.name} (${c.id})`);
			const once = unwrap(await connecting, `connect to ${ref.name}`);
			sawHello(once.hello);
			return once;
		};
		/** create through by, kept: what it gives is deleted when the case ends, or as it comes after that. */
		const attempt = (whole: ComputerSpec, by: ComputerProvider = provider) => {
			const creating = by.create(whole, { signal: caseSignal }).then((created) => {
				noteCreated(created);
				if (created.ok) track(created.value, by);
				return created;
			});
			keep(creating, `create (${c.id})`);
			return creating;
		};
		const create = async (extra?: Partial<ComputerSpec>) => {
			const created = await attempt(spec(extra));
			if (!created.ok) throw new Error(createError(created));
			return created.value;
		};

		const prepareAndRun = async () => {
			let computer: { ref: ComputerRef; connection: ComputerConnection } | undefined;
			if (sharedComputer !== undefined) {
				const got = sharedComputer;
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
				attempt,
				track,
				connect: (ref) => connect(ref ?? needComputer().ref),
				async home() {
					const env = await t.exec(["env"]);
					const home = /^HOME=(.*)$/m.exec(env.out)?.[1];
					if (home === undefined || !home.startsWith("/")) throw new Error(`HOME in the computer is ${show(home)}, not an absolute path`);
					return home.replace(/\/+$/, "") || "/";
				},
				async dir() {
					const path = `${await t.home()}/agentrun-conformance-${run}/${c.id.replace(/[^a-z0-9-]/gi, "-")}-${++dirs}`;
					await t.call("files.mkdir", { path, parents: true });
					return path;
				},
				fixture() {
					if (fixture === undefined) {
						return t.skip("no fixture was given: --fixture names computerd-fixture for a desktop, or the fixture APK for an Android phone");
					}
					started ??= startFixture(t, fixture, (stop) => {
						stopFixture = stop;
					});
					return started;
				},
				fetch: (url, init) => fetcher(url, { ...init, signal: init?.signal ?? caseSignal }),
				async cdp(url) {
					const socket = await dialer(url, { signal: caseSignal });
					if (ended) socket.close();
					else sockets.push(socket);
					return socket;
				},
				clock,
				async drifted() {
					if (drifted === undefined) return t.skip("no drifted provider was given: a provider module exports createDriftedProvider() for the drift cases");
					return await drifted();
				},
				async runFolder(kind) {
					const none = `the run was given no run folder for mount kind ${kind}`;
					if (mountFor === undefined) return t.skip(`${none}: a provider's conformance module exports mountFor(kind)`);
					const folder = await mountFor(kind);
					if (folder === undefined) return t.skip(`${none}: mountFor(${JSON.stringify(kind)}) made none`);
					if (ended) keep(bounded(folder.close().catch(() => {}), CLOSE_MS), `close of a run folder (${c.id})`);
					else folders.push(folder);
					return folder;
				},
				async exec(argv: string[], extra: Partial<ExecRunParams> = {}, client: ComputerClient = t.client): Promise<Ran> {
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
				async until(fn, what, ms = patience) {
					const end = Date.now() + ms;
					for (;;) {
						const value = await fn();
						if (value !== undefined && value !== false) return value;
						if (Date.now() > end) throw new Error(`${what}: still not so after ${ms / 1000} s`);
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
			ended = true;
			clearTimeout(timeout);
			// The fixture is stopped while the case's connection is still open, whether or not it logged ready; a start still
			// launching is given CLOSE_MS to launch or fail first. A stop that fails is not the case's verdict.
			if (started !== undefined) {
				if (stopFixture === undefined) await bounded(started.catch(() => {}), CLOSE_MS);
				if (stopFixture !== undefined) await bounded(stopFixture().catch(() => {}), CLOSE_MS);
			}
			for (const socket of sockets) socket.close();
			for (const connection of connections) await bounded(connection.close().catch(() => {}), CLOSE_MS);
			for (const { ref, by } of refs) await release(ref, by);
			// A folder that cannot be removed is left, as a fixture that cannot be stopped is: it is not the case's verdict.
			for (const folder of folders) await bounded(folder.close().catch(() => {}), CLOSE_MS);
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
		// A kept call may keep another as it settles (a late create, then its release): wait until none is left.
		await bounded(
			(async () => {
				while (pending.size > 0) await Promise.allSettled([...pending.keys()]);
			})(),
			cleanupTimeoutMs,
		);
		// The bound kept: a call still pending may yet make a computer, so the cleanup is incomplete and Core fails.
		for (const what of pending.values()) {
			report.cleanup.errors.push(`${what} did not settle within ${cleanupTimeoutMs / 1000} s of the run's end: what it makes may be left`);
		}
		await cleanup(provider, capabilities.lifetime, runLabels, report, deleted, cleanupTimeoutMs);
	}
	// A Core case skipped for an optional group the computer does not declare is not part of Core's verdict.
	const core = report.results.filter((r) => r.level === "core" && !(r.status === "skip" && r.undeclared !== undefined));
	const clean = report.cleanup.left.length === 0 && report.cleanup.errors.length === 0;
	const corePassed = core.every((r) => r.status === "pass") && clean;
	if ((report.coreNotRun ?? []).length === 0) report.core = core.length > 0 && corePassed ? "pass" : "fail";
	else report.core = corePassed && report.results.every((r) => r.status !== "fail") ? "partial" : "fail";
	if (kind !== undefined) report.kindVerdict = kindVerdict(kind, capabilities, report, selected);
	return report;
}

/** Sweeps a janitor provider by the run's label, past every deadline, and lists the label to show nothing is left. */
async function cleanup(
	provider: ComputerProvider,
	lifetime: "vendor" | "janitor",
	labels: Record<string, string>,
	report: ConformanceReport,
	deleted: Set<string>,
	ms: number,
) {
	try {
		if (lifetime === "janitor") {
			const stop = new AbortController();
			const swept = await within(sweep(provider, { labels, now: new Date(Date.now() + 366 * 24 * 60 * 60_000), signal: stop.signal }), ms, "the sweep").catch(
				(error: unknown) => {
					stop.abort();
					return fail("timeout", words(error));
				},
			);
			if (swept.ok) for (const name of swept.value.deleted) deleted.add(name);
			else report.cleanup.errors.push(`sweep: ${swept.error.code}: ${swept.error.message}`);
		}
		const listed = await within(provider.list(labels), ms, `list ${JSON.stringify(labels)}`);
		if (listed.ok) report.cleanup.left = listed.value.map((info) => info.ref.name).sort();
		else report.cleanup.errors.push(`list ${JSON.stringify(labels)}: ${listed.error.code}: ${listed.error.message}`);
	} catch (error) {
		report.cleanup.errors.push(words(error));
	}
	report.cleanup.deleted = [...deleted];
}
