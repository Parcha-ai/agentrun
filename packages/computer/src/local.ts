// The local browser as a computer of kind browser: this machine's own Chrome or Chromium, with no key and no vendor.
// Each computer is one Chrome with a fresh throwaway profile, started headless (or headed, for a person watching) with
// its DevTools socket on a port Chrome picks on 127.0.0.1; connect hands over that socket's ws:// URL, which a driver
// dials. Each runs under a supervisor of its own (local-supervisor.ts), a detached Node process that holds the browser's
// egress proxy and ends the browser at its deadline, at its release, or when Chrome exits, so a run that crashes leaves
// no Chrome behind.
//
// Its fence and its sandbox rule are PR #1718's: Chrome's own sandbox is always on (a start as root, or on a machine
// where Chrome cannot start its sandbox, is refused in words, never retried without it), and every request Chrome makes
// goes through the egress proxy, which reaches public addresses only, checked after its lookup: this machine's loopback
// and its other services, private networks, link-local and a cloud's metadata address are each refused (chrome.ts
// chromeFence). Chrome resolves no name itself, speaks no QUIC and sends WebRTC over no UDP.
//
// What it does not fence: the DevTools socket has no auth, so any process of this machine that finds its port can drive
// the browser; and the browser is a process of this machine, as the user AgentRun runs as, isolated by Chrome's sandbox
// alone. It is for local and development use.
//
// Files: one directory per browser under the root (default <tmpdir>/agentrun-local-browser-<uid>, 0700), named by the
// browser's id: browser.json (its labels and deadline, which list and attach read), supervisor.pid, state.json (Chrome's
// pid and port, once it answers), the profile, the proxy's socket and two logs. A release removes all of it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_IMAGE, browserClient, browserHello, carries, labelsProblem } from "./browser.js";
import { alive, answeringPath, CHROME_FLAGS, checkChrome, findChrome, killTree, NO_CHROME, AS_ROOT, runsWith, singletonDir } from "./chrome.js";
import type { KindCapabilities } from "./kinds.js";
import { BROWSER_FILE, type BrowserRecord, type BrowserState, CHROME_PID_FILE, EGRESS_SOCKET_FILE, PROFILE_DIR, READY_MS, STATE_FILE, SUPERVISOR_FILE, type SupervisorLine } from "./local-supervisor.js";
import type { MountKind } from "./mount.js";
import type {
	AttachedComputer,
	CallContext,
	ComputerCapabilities,
	ComputerConnection,
	ComputerInfo,
	ComputerProvider,
	ComputerRef,
	ComputerSpec,
	CreatedComputer,
	NetworkPolicy,
	NetworkSpec,
	Refusal,
} from "./provider.js";
import { checkLifetime } from "./provider.js";
import { fail, ok, type Result } from "./result.js";

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SUPERVISOR = fileURLToPath(new URL("./local-supervisor.js", import.meta.url));

/** The longest a local browser lives: a day, as pi-browser's local Chrome. */
export const LOCAL_MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** The window a local browser opens with. */
const WINDOW = "--window-size=1280,800";
/** A Unix socket's path holds 107 bytes; a root whose browsers' sockets would not fit is refused. */
const SOCKET_PATH_MAX = 107;
/** How long a release waits for the supervisor, then for Chrome, to end. */
const END_MS = 10_000;

/** A browser takes no mount. */
export const MOUNT: readonly MountKind[] = [];

/** The one configuration it offers: a browser with a CDP target. No live view: a person watching runs it headed. */
export const CAPABILITIES: readonly KindCapabilities[] = [{ kind: "browser", groups: ["cdp"] }];

export interface LocalBrowserOptions {
	/** The Chrome or Chromium to run; default the one findChrome finds in `env`, then in the usual places. */
	executablePath?: string;
	/**
	 * Where CHROME_PATH, PI_BROWSER_CHROME and PATH are read when no executablePath is given: the host's environment, which
	 * it passes (serve passes its own). The library reads none.
	 */
	env?: Readonly<Record<string, string | undefined>>;
	/** Shows the window, for a person watching on this machine; default headless. */
	headed?: boolean;
	/** Where the browsers' directories go; default <tmpdir>/agentrun-local-browser-<uid>. Made 0700, and refused when another user can write it. */
	root?: string;
	/** The user this process runs as: a test's seam. */
	uid?: number;
}

const ID = /^lb-[0-9a-f]{16}$/;
const idProblem = (id: unknown) => (typeof id === "string" && ID.test(id) ? undefined : `${typeof id === "string" ? JSON.stringify(id) : String(id)} is not a local browser's id`);
const refOf = (id: string): ComputerRef => ({ id, name: id });
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels"]);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const readJson = async <T>(file: string): Promise<T | undefined> => {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};

/** Computers that are this machine's Chrome. */
export class LocalBrowserProvider implements ComputerProvider {
	readonly id = "local";
	readonly version = VERSION;
	readonly #executablePath: string | undefined;
	readonly #env: Readonly<Record<string, string | undefined>>;
	readonly #headed: boolean;
	readonly #uid: number | undefined;
	readonly root: string;

	constructor({ executablePath, env = {}, headed = false, root, uid = process.getuid?.() }: LocalBrowserOptions = {}) {
		this.#executablePath = executablePath === "" ? undefined : executablePath;
		this.#env = env;
		this.#headed = headed;
		this.#uid = uid;
		this.root = root ?? join(tmpdir(), `agentrun-local-browser-${uid ?? "user"}`);
	}

	/**
	 * A browser: our supervisor ends it at its deadline, and list reads that deadline, so the janitor sweeps one whose
	 * supervisor is gone (lifetime janitor); it reaches public addresses only, through its egress proxy (network open);
	 * it runs on this host, as this user, isolated by Chrome's sandbox alone (isolation host).
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "browser",
			lifetime: "janitor",
			network: ["open"],
			isolation: "host",
			os: "linux",
			daemon: "none",
			groups: [...(CAPABILITIES[0] as KindCapabilities).groups],
			maxLifetimeMs: LOCAL_MAX_LIFETIME_MS,
			release: ["delete"],
		};
	}

	/** The Chrome this provider runs: the option's, else one found; null when there is none. */
	executable(): string | null {
		return this.#executablePath ?? findChrome(this.#env);
	}

	/** Why no browser can start on this machine, in words; none when one can (before the sandbox check, which starts Chrome). */
	#machineRefusals(): Refusal[] {
		if (this.#uid === 0) return [{ field: "host", message: AS_ROOT }];
		const executable = this.executable();
		if (executable === null) return [{ field: "image", message: NO_CHROME }];
		if (!existsSync(executable)) return [{ field: "image", message: `the executablePath ${executable} does not exist: ${NO_CHROME}` }];
		return [];
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, labels } = given;
		if (image !== BROWSER_IMAGE) refusals.push({ field: "image", message: `a local browser is this machine's Chrome: image is "${BROWSER_IMAGE}", not ${JSON.stringify(image)}` });
		refusals.push(...checkLifetime(lifetimeMs, this.capabilities()));
		if (network !== "open") refusals.push({ field: "network", message: `a local browser reaches public addresses through its egress proxy: network is "open", not ${JSON.stringify(network)}` });
		if (labels !== undefined) {
			const problem = labelsProblem(labels);
			if (problem) refusals.push({ field: "labels", message: problem });
		}
		for (const [field, value] of Object.entries(given)) {
			if (!SPEC_FIELDS.has(field) && value !== undefined) refusals.push({ field, message: `a local browser does not take ${field}` });
		}
		return [...refusals, ...this.#machineRefusals()];
	}

	/** The root, made 0700 if it is not there; refused when it is not a directory of this user's that no one else can write. */
	async #ensureRoot(): Promise<Result<void>> {
		try {
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			const info = await lstat(this.root);
			if (!info.isDirectory()) return fail("invalid", `the local browser's root ${this.root} is not a directory`);
			if (process.platform !== "win32") {
				if (this.#uid !== undefined && info.uid !== this.#uid) return fail("refused", `the local browser's root ${this.root} belongs to another user: set the root option to a directory of your own`);
				if ((info.mode & 0o022) !== 0) return fail("refused", `the local browser's root ${this.root} is writable by other users: make it 0700, or set the root option to another directory`);
			}
			return ok(undefined);
		} catch (error) {
			return fail("invalid", `the local browser's root ${this.root} could not be made (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
		}
	}

	/** Starts Chrome under a supervisor of its own, waits until its DevTools socket answers, and hands back its ref. */
	async create(spec: ComputerSpec, { signal }: { signal?: AbortSignal } = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail(refusals.some((r) => r.field === "image" && r.message.endsWith(NO_CHROME)) ? "not_found" : "refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		if (signal?.aborted) return fail("aborted", "create was aborted before Chrome was started");
		const rooted = await this.#ensureRoot();
		if (!rooted.ok) return rooted;
		const id = `lb-${randomBytes(8).toString("hex")}`;
		const dir = join(this.root, id);
		if (Buffer.byteLength(join(dir, EGRESS_SOCKET_FILE)) > SOCKET_PATH_MAX) return fail("invalid", `the local browser's root ${this.root} is too long for a Unix socket under it: set the root option to a shorter directory`);
		const now = Date.now();
		const record: BrowserRecord = {
			provider: "local",
			id,
			labels: { ...spec.labels },
			created: new Date(now).toISOString(),
			deadline: new Date(now + spec.lifetimeMs).toISOString(),
			executablePath: this.executable() as string,
			args: [...CHROME_FLAGS, ...(this.#headed ? [] : ["--headless=new"]), WINDOW],
		};
		try {
			await mkdir(join(dir, PROFILE_DIR), { recursive: true, mode: 0o700 });
			await writeFile(join(dir, BROWSER_FILE), JSON.stringify(record), { mode: 0o600, flag: "wx" });
		} catch (error) {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			return fail("invalid", `the local browser's directory could not be made under ${this.root} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
		}
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, [SUPERVISOR, dir], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
		} catch (error) {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			return fail("invalid", `the local browser's supervisor could not be started (${(error as Error).message})`);
		}
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		const line = await new Promise<SupervisorLine | "exited" | "timeout" | "aborted">((done) => {
			let text = "";
			const timer = setTimeout(() => finish("timeout"), READY_MS + 10_000);
			const abort = () => finish("aborted");
			const finish = (value: SupervisorLine | "exited" | "timeout" | "aborted") => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				done(value);
			};
			signal?.addEventListener("abort", abort, { once: true });
			child.once("error", () => finish("exited"));
			child.once("exit", () => finish("exited"));
			child.stdout?.on("data", (chunk: Buffer) => {
				text += chunk.toString("utf8");
				const at = text.indexOf("\n");
				if (at < 0) return;
				try {
					finish(JSON.parse(text.slice(0, at)) as SupervisorLine);
				} catch {
					finish("exited");
				}
			});
		});
		child.stdout?.destroy();
		if (typeof line === "object" && "ready" in line) {
			child.unref();
			return ok(refOf(id));
		}
		// Not ready: the supervisor ends what it started; a release makes sure, and nothing of this browser is left.
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([exited, new Promise<void>((done) => (timer = setTimeout(done, END_MS)))]);
		clearTimeout(timer);
		const released = await this.release(refOf(id), "delete");
		child.unref();
		const left = released.ok ? "" : `; ${released.error.message}`;
		if (line === "aborted") return fail("aborted", `create was aborted while Chrome started; it was ended${left}`);
		if (line === "timeout") return fail("timeout", `the local browser's supervisor did not answer within ${(READY_MS + 10_000) / 1000} s; it was ended${left}`);
		if (line === "exited") return fail("gone", `the local browser's supervisor ended before Chrome answered${left}`);
		const code = line.sandbox ? "refused" : /did not open its debugging port within/.test(line.failed) ? "timeout" : "gone";
		return fail(code, `${line.failed}${left}`);
	}

	/**
	 * Settings' test: finds the Chrome and starts it once, headless, on a blank page, with its sandbox on (chrome.ts
	 * checkChrome), with a proxy that reaches nothing. No browser is kept and no key is read; no Chrome, root, or a Chrome
	 * that cannot start its sandbox is said in words.
	 */
	async testConnection(_context: CallContext = {}): Promise<Result<{ detail: string }>> {
		const refused = this.#machineRefusals();
		if (refused.length > 0) return fail(refused[0]?.field === "host" ? "refused" : "not_found", (refused[0] as Refusal).message);
		// A Chrome found or named is started once with its sandbox on: what a create would do, with nothing kept.
		const checked = await checkChrome(this.executable() as string, this.#uid === undefined ? {} : { uid: this.#uid });
		if (!checked.ok) return checked;
		return ok({ detail: `${checked.value} starts here with its sandbox on: no key is needed` });
	}

	#dir(id: string): string {
		return join(this.root, id);
	}

	async #record(id: string): Promise<BrowserRecord | undefined> {
		const record = await readJson<BrowserRecord>(join(this.#dir(id), BROWSER_FILE));
		return record?.provider === "local" && record.id === id ? record : undefined;
	}

	/** Chrome's state, when the Chrome it names still runs on this browser's profile. */
	async #live(id: string): Promise<BrowserState | undefined> {
		const state = await readJson<BrowserState>(join(this.#dir(id), STATE_FILE));
		if (!state || !Number.isInteger(state.pid) || !Number.isInteger(state.port) || typeof state.path !== "string") return undefined;
		return runsWith(state.pid, `--user-data-dir=${join(this.#dir(id), PROFILE_DIR)}`) ? state : undefined;
	}

	/** Every browser of this provider's root with these labels, each with whether its Chrome still runs. */
	async #browsers(labels: Record<string, string>): Promise<Result<Array<{ record: BrowserRecord; running: boolean }>>> {
		const problem = labelsProblem(labels);
		if (problem) return fail("invalid", problem);
		let names: string[];
		try {
			names = await readdir(this.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
			return fail("invalid", `the local browser's root ${this.root} could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
		}
		const found: Array<{ record: BrowserRecord; running: boolean }> = [];
		for (const name of names.filter((one) => ID.test(one)).sort()) {
			const record = await this.#record(name);
			if (!record || !carries(record.labels, labels)) continue;
			found.push({ record, running: (await this.#live(name)) !== undefined });
		}
		return ok(found);
	}

	/** Every browser with these labels: running while its Chrome runs, stopped once it does not (its files not yet removed). */
	async list(labels: Record<string, string>, _context: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const found = await this.#browsers(labels);
		if (!found.ok) return found;
		return ok(
			found.value.map(({ record, running }) => {
				const deadline = new Date(record.deadline);
				return { ref: refOf(record.id), labels: { ...record.labels }, deadline: Number.isNaN(deadline.getTime()) ? undefined : deadline, state: running ? "running" : "stopped", network: "open" };
			}),
		);
	}

	#attached(record: BrowserRecord): AttachedComputer {
		const deadline = new Date(record.deadline);
		const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
		return { ...refOf(record.id), spec: { image: BROWSER_IMAGE, user, network: "open", kind: "browser", ...(Number.isNaN(deadline.getTime()) ? {} : { deadline }) } };
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, _context: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const problem = idProblem(given.id);
			if (problem) return fail("invalid", problem);
			const id = given.id as string;
			const record = await this.#record(id);
			if (!record) return fail("not_found", `no local browser has the id ${id}`);
			if (!(await this.#live(id))) return fail("gone", `the local browser ${id} no longer runs: only a running browser is attached to`);
			return ok(this.#attached(record));
		}
		const labels = given.labels as Record<string, string>;
		const found = await this.#browsers(labels);
		if (!found.ok) return found;
		const running = found.value.filter((one) => one.running);
		const words = JSON.stringify(labels);
		if (running.length === 0) return fail("not_found", `no running local browser has the labels ${words}`);
		if (running.length > 1) return fail("invalid", `${running.length} local browsers have the labels ${words}: ${running.map((one) => one.record.id).join(", ")}`);
		return ok(this.#attached((running[0] as { record: BrowserRecord }).record));
	}

	/** Always open: public addresses through the proxy, and a change is refused in words. */
	async network(ref: ComputerRef, policy?: NetworkSpec, _context: CallContext = {}): Promise<Result<NetworkPolicy>> {
		if (policy !== undefined && policy !== "open") return fail("refused", `a local browser reaches public addresses through its egress proxy; its network cannot be set to ${JSON.stringify(policy)}`);
		const problem = idProblem(ref?.id);
		if (problem) return fail("invalid", problem);
		if (!(await this.#record(ref.id))) return fail("not_found", `no local browser has the id ${ref.id}`);
		return (await this.#live(ref.id)) ? ok("open") : fail("gone", `the local browser ${ref.id} no longer runs`);
	}

	/**
	 * The browser's DevTools URL, ws://127.0.0.1:<port>/devtools/browser/<id>, once the socket on that port answers with
	 * the path this browser's Chrome wrote; and a client that answers hello and ping. The URL bears no secret, but the
	 * socket takes any local client: it is the browser.
	 */
	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const id = ref?.id;
		const problem = idProblem(id);
		if (problem) return fail("invalid", problem);
		if (!(await this.#record(id))) return fail("not_found", `no local browser has the id ${id}`);
		const state = await this.#live(id);
		if (!state) return fail("gone", `the local browser ${id} no longer runs`);
		if ((await answeringPath(state.port)) !== state.path) return fail("gone", `the local browser ${id}'s DevTools socket on port ${state.port} does not answer as its Chrome`);
		const url = `ws://127.0.0.1:${state.port}${state.path}`; // key-gate: loopback-rule the local Chrome's own DevTools socket
		const hello = browserHello(VERSION, this.capabilities().groups);
		const client = browserClient(hello, async () => ok((await this.#live(id)) !== undefined));
		return ok({ client, hello, cdp: { url }, close: async () => client.close() });
	}

	/**
	 * Ends the browser and removes its files: its supervisor is asked to end it (SIGTERM), and whatever is left once it
	 * has gone (a supervisor already gone, a Chrome it did not end) is ended and removed here. A browser already gone is
	 * released; done means its directory is gone.
	 */
	async release(ref: ComputerRef, how: "stop" | "delete", _context: CallContext = {}): Promise<Result<void>> {
		if (how !== "delete") return fail("refused", `a local browser is released with "delete"; it cannot be stopped and kept, so ${String(how)} is refused and the browser is left as it is`);
		const id = ref?.id;
		const problem = idProblem(id);
		if (problem) return fail("invalid", problem);
		const dir = this.#dir(id);
		if (!(await lstat(dir).then(() => true, () => false))) return ok(undefined);
		const supervisor = Number((await readFile(join(dir, SUPERVISOR_FILE), "utf8").catch(() => "")).trim());
		if (runsWith(supervisor, dir)) {
			try {
				process.kill(supervisor, "SIGTERM");
			} catch {
				/* gone already */
			}
			for (const until = Date.now() + END_MS; runsWith(supervisor, dir) && Date.now() < until; ) await sleep(50);
		}
		// Chrome's pid as the supervisor wrote it at the spawn (chrome.pid), and once Chrome answered (state.json): a
		// supervisor killed before Chrome answered leaves only the first.
		const state = await readJson<BrowserState>(join(dir, STATE_FILE));
		const spawned = Number((await readFile(join(dir, CHROME_PID_FILE), "utf8").catch(() => "")).trim());
		const marker = `--user-data-dir=${join(dir, PROFILE_DIR)}`;
		for (const pid of new Set([state?.pid, spawned].filter((one): one is number => Number.isInteger(one) && (one as number) > 0))) {
			if (!runsWith(pid, marker)) continue;
			killTree(pid);
			for (const until = Date.now() + END_MS; runsWith(pid, marker) && alive(pid) && Date.now() < until; ) await sleep(50);
		}
		const socketDir = await singletonDir(join(dir, PROFILE_DIR));
		if (socketDir) await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
		let error: unknown;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await rm(dir, { recursive: true, force: true });
				return ok(undefined);
			} catch (caught) {
				error = caught;
				await sleep(100 * (attempt + 1));
			}
		}
		return fail("invalid", `the local browser ${id} was ended but its directory ${dir} could not be removed (${(error as NodeJS.ErrnoException).code ?? String(error)}): it may hold the session's cookies, so remove it by hand`);
	}
}

/** The provider, built from its options alone: no key, and no environment read but the `env` it is given. */
export function create(options: LocalBrowserOptions = {}): LocalBrowserProvider {
	return new LocalBrowserProvider(options ?? {});
}

/** The conformance CLI's module for the local browser: its live switch, its image and its notes. */
export const conformance = () => import("./conformance/local.js");
