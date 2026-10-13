import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import {
	type Box,
	BoxError,
	type BoxErrorCode,
	type BoxExecOptions,
	type BoxFacts,
	type BoxFile,
	type BoxProcess,
	type BoxProvider,
	type BoxRef,
	type BoxSpec,
	type BoxStatus,
	isReservedLabel,
} from "./box.ts";

const DEFAULT_API_URL = "https://app.daytona.io/api";
const DEFAULT_WORKSPACE = "/tmp/workspace";
const REQUEST_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 120_000;
const DESTROY_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;
const LISTED_TIMEOUT_MS = 15_000;
const LISTED_POLL_MS = 150;
const LISTED_STABLE_MS = 1_000;
const LISTED_ROUNDS = 2;
const EXEC_POLL_MS = 150;
const CLEANUP_TIMEOUT_S = 20;
const RETRY_ATTEMPTS = 3;
const DESTROY_ATTEMPTS = 4;
const DESTROY_RETRY_MS = 1_000;
const RETRY_BASE_MS = 500;
const POLL_FAILURES_MAX = 5;
const OUTPUT_CHUNK_BYTES = 256 * 1024;
/** What the host holds for a reader that is slow; the program writes on to its files, and polling waits. */
const OUTPUT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const INPUT_CHUNK_BYTES = 48 * 1024;
const BYTES_PER_GIB = 1024;
const MS_PER_MINUTE = 60_000;
const DEFAULT_SPOOL_DIR = "/tmp/pi-transport";

/** Every box carries this label, so `attach` and `list` never touch a sandbox this package did not start. */
const BOX_LABEL = "pi-transport";
const OWN_QUERY: Readonly<Record<string, string>> = { [BOX_LABEL]: "1" };
const WORKSPACE_LABEL = "pi-transport.workspace";
const LIFETIME_LABEL = "pi-transport.lifetime-ms";
const OWN_LABELS: ReadonlySet<string> = new Set([BOX_LABEL, WORKSPACE_LABEL, LIFETIME_LABEL]);
const ENDED_STATES: ReadonlySet<string> = new Set([
	"destroyed",
	"destroying",
	"stopped",
	"stopping",
	"archived",
	"archiving",
	"error",
	"build_failed",
]);
const QUOTA_PATTERN = /quota|capacity|limit exceeded|too many/i;

// Runs detached in the box. Input arrives as numbered spool files that a feeder copies into a fifo; output goes to
// files, so every byte and both streams survive. The exit code appears last, by rename, so a reader that sees it
// has seen all output.
const RUN_SCRIPT = [
	'd=$1; w=$2; shift 2; echo "$$" > "$d/pid"',
	'cd "$w" || { echo 126 > "$d/code.tmp"; mv "$d/code.tmp" "$d/code"; exit 0; }',
	'mkfifo "$d/fifo"',
	'( n=0; while :; do f=$(printf "%s/in/%08d" "$d" "$n")',
	'if [ -e "$f" ]; then cat "$f"; n=$((n+1))',
	'elif [ -e "$d/in/END" ] && [ ! -e "$f" ]; then break',
	'elif [ ! -d "$d" ]; then break',
	'else sleep 0.05; fi; done ) > "$d/fifo" &',
	"feeder=$!",
	'"$@" < "$d/fifo" > "$d/out" 2> "$d/err"',
	"rc=$?",
	'kill "$feeder" 2>/dev/null',
	'echo "$rc" > "$d/code.tmp" && mv "$d/code.tmp" "$d/code"',
].join("\n");

const LAUNCH_SCRIPT = [
	"r=$1; d=$2; w=$3; shift 3",
	'mkdir -p -m 700 "$(dirname -- "$d")" && mkdir -m 700 "$d" "$d/in" || exit 1',
	'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$r" sh "$d" "$w" "$@" >/dev/null 2>&1 </dev/null &',
	'else nohup sh -c "$r" sh "$d" "$w" "$@" >/dev/null 2>&1 </dev/null & fi',
].join("\n");

// Prints the exit code, then the new output and error bytes after the given offsets, base64. The code is read first:
// a code that is present means everything after it is the whole of the output.
const POLL_SCRIPT = [
	'd=$1; [ -d "$d" ] || { echo GONE; exit 0; }',
	'printf "C %s\\n" "$(cat "$d/code" 2>/dev/null)"',
	'printf "O %s\\n" "$(tail -c +$(($2 + 1)) "$d/out" 2>/dev/null | head -c "$4" | base64 | tr -d "\\n")"',
	'printf "E %s\\n" "$(tail -c +$(($3 + 1)) "$d/err" 2>/dev/null | head -c "$4" | base64 | tr -d "\\n")"',
].join("\n");

const WRITE_INPUT_SCRIPT = 'printf %s "$2" | base64 -d > "$1/in/tmp" && mv "$1/in/tmp" "$1/in/$3"';
const CLOSE_INPUT_SCRIPT = ': > "$1/in/END"';
const CLEANUP_SCRIPT =
	'p=$(cat "$1/pid" 2>/dev/null); if [ "$2" = kill ] && [ -n "$p" ]; then kill -9 -- "-$p" 2>/dev/null || kill -9 "$p" 2>/dev/null; fi; rm -rf -- "$1"';
const MKDIR_SCRIPT = 'mkdir -p -- "$1"';

export type DaytonaBoxesOptions = {
	/** The Daytona API key. The host passes it; the package never reads the environment and never puts it in a box. */
	readonly apiKey: string;
	/** Default `https://app.daytona.io/api`. */
	readonly apiUrl?: string;
	/** For tests and proxies. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Region for boxes whose spec names none. */
	readonly target?: string;
	/** Snapshot for boxes whose spec names none. Default the organization's default snapshot. */
	readonly snapshot?: string;
	/** User the programs run as, when the snapshot has more than one. */
	readonly user?: string;
	/** Workspace for boxes whose spec names none. Default `/tmp/workspace`, which any user can create. */
	readonly workspace?: string;
	/** From the create call to a started sandbox. Default 120 s. */
	readonly startTimeoutMs?: number;
	/** Pause between attempts to delete a sandbox. Default 1 s. */
	readonly destroyRetryMs?: number;
	/** How long the new box must show in the label listing without a miss before `create` returns. Default 1 s. */
	readonly listedStableMs?: number;
	/** How long `create` waits for that. Default 15 s. */
	readonly listedTimeoutMs?: number;
	/** Poll period while waiting for a sandbox to start. Default 1 s. */
	readonly pollMs?: number;
	/** Boxes are named `<namePrefix><random>`. Default `pt-`. */
	readonly namePrefix?: string;
	/** Directory in the box where running programs keep their input and output files. Default `/tmp/pi-transport`. */
	readonly spoolDir?: string;
	/** Poll period for a running program's output. Default 150 ms. */
	readonly execPollMs?: number;
};

/** What Daytona returns for a sandbox, as far as this provider reads it. */
type SandboxInfo = {
	readonly id: string;
	readonly state?: string;
	readonly labels?: Record<string, string>;
	readonly cpu?: number;
	readonly memory?: number;
	readonly gpuType?: string | string[];
	readonly toolboxProxyUrl?: string;
	readonly sandboxClass?: string;
	readonly errorReason?: string;
};

type Response = { readonly status: number; readonly bytes: Uint8Array };
type CallInit = {
	readonly json?: unknown;
	readonly form?: FormData;
	readonly timeoutMs?: number;
	/** Retry no response, 429 and 5xx. Only for calls that may run twice. */
	readonly retry?: boolean;
};
type Executed = { readonly exitCode: number; readonly result: string };

const decoder = new TextDecoder();

function quote(word: string): string {
	return `'${word.replaceAll("'", "'\\''")}'`;
}

function shellCommand(script: string, args: readonly string[]): string {
	return ["sh", "-c", quote(script), "sh", ...args.map(quote)].join(" ");
}

function statusCode(method: string, status: number, text: string): BoxErrorCode {
	if (status === 401) return "unauthorized";
	if ((status === 403 || status === 400 || status === 429 || status === 507) && QUOTA_PATTERN.test(text))
		return "capacity";
	if (status === 403) return "unauthorized";
	if (status === 404 || status === 410) return method === "DELETE" ? "gone" : "not_found";
	if (status === 408) return "timeout";
	if (status === 400 || status === 409 || status === 422) return "invalid";
	return "unknown";
}

function delay(ms: number, context: Context): Promise<void> {
	return new Promise((resolve) => {
		const signal = context.abortSignal;
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		if (signal?.aborted) done();
		else signal?.addEventListener("abort", done, { once: true });
	});
}

function parseJson(bytes: Uint8Array): unknown {
	const text = decoder.decode(bytes);
	if (text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** An async iterable fed by `push` and closed by `end`; it holds what nobody has read yet. */
class Pipe implements AsyncIterable<Uint8Array> {
	readonly #queue: Uint8Array[] = [];
	readonly #waiters: { limit: number; resolve: () => void }[] = [];
	#wake: (() => void) | undefined;
	#ended = false;
	#bytes = 0;

	push(bytes: Uint8Array): void {
		if (this.#ended || bytes.length === 0) return;
		this.#queue.push(bytes);
		this.#bytes += bytes.length;
		this.#wake?.();
	}

	end(): void {
		this.#ended = true;
		this.#wake?.();
		this.#release();
	}

	/** Resolves once no more than `limit` bytes wait for a reader, or at once when the pipe has ended. */
	waitBelow(limit: number): Promise<void> {
		if (this.#ended || this.#bytes <= limit) return Promise.resolve();
		return new Promise((resolve) => this.#waiters.push({ limit, resolve }));
	}

	#release(): void {
		for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
			const waiter = this.#waiters[index];
			if (waiter !== undefined && (this.#ended || this.#bytes <= waiter.limit)) {
				this.#waiters.splice(index, 1);
				waiter.resolve();
			}
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
		for (;;) {
			const next = this.#queue.shift();
			if (next !== undefined) {
				this.#bytes -= next.length;
				this.#release();
				yield next;
			} else if (this.#ended) return;
			else {
				await new Promise<void>((resolve) => {
					this.#wake = resolve;
				});
				this.#wake = undefined;
			}
		}
	}
}

/** The Daytona REST API: the control plane (sandboxes) and the toolbox (programs and files) of one sandbox. */
class Rest {
	readonly #base: string;
	readonly #fetch: typeof fetch;
	readonly #headers: Record<string, string>;
	readonly #proxies = new Map<string, string>();

	constructor(options: DaytonaBoxesOptions) {
		this.#base = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
		this.#fetch = options.fetch ?? fetch;
		this.#headers = { Authorization: `Bearer ${options.apiKey}`, "X-Daytona-Source": "pi-transport" };
	}

	/** One request. A failure message names the method, path and status, never a header or a body this call sent. */
	async call(method: string, url: string, init: CallInit, context: Context): Promise<Result<Response, BoxError>> {
		const what = `${method} ${new URL(url).pathname}`;
		const attempts = init.retry === true ? RETRY_ATTEMPTS : 1;
		for (let attempt = 1; ; attempt += 1) {
			const signals = [AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS)];
			if (context.abortSignal !== undefined) signals.push(context.abortSignal);
			let failure: BoxError;
			let retryable = true;
			try {
				const response = await this.#fetch(url, {
					method,
					headers:
						init.json === undefined ? this.#headers : { ...this.#headers, "Content-Type": "application/json" },
					body: init.json === undefined ? init.form : JSON.stringify(init.json),
					signal: AbortSignal.any(signals),
				});
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (response.ok) return ok({ status: response.status, bytes });
				const text = decoder.decode(bytes).replace(/\s+/g, " ").slice(0, 300);
				retryable = response.status === 429 || response.status >= 500;
				failure = new BoxError(statusCode(method, response.status, text), `${what}: ${response.status} ${text}`);
				if (response.status === 404) return err(failure);
			} catch (cause) {
				if (context.abortSignal?.aborted === true)
					return err(new BoxError("aborted", `${what}: the call was aborted`, cause));
				failure = new BoxError("unknown", `${what}: ${(cause as Error).message}`, cause);
			}
			if (!retryable || attempt >= attempts) return err(failure);
			await delay(RETRY_BASE_MS * 2 ** (attempt - 1), context);
		}
	}

	async json(method: string, url: string, init: CallInit, context: Context): Promise<Result<unknown, BoxError>> {
		const response = await this.call(method, url, init, context);
		return response.ok ? ok(parseJson(response.value.bytes)) : response;
	}

	sandbox(idOrName = "", rest = ""): string {
		return `${this.#base}/sandbox${idOrName === "" ? "" : `/${encodeURIComponent(idOrName)}`}${rest}`;
	}

	async create(body: unknown, context: Context): Promise<Result<SandboxInfo, BoxError>> {
		const created = await this.json("POST", this.sandbox(), { json: body, timeoutMs: CREATE_TIMEOUT_MS }, context);
		if (!created.ok) return created;
		const info = created.value as SandboxInfo | null;
		if (typeof info?.id !== "string") return err(new BoxError("unknown", "POST /sandbox: no id in the answer"));
		return ok(info);
	}

	/** The sandbox, or `undefined` when it does not exist. */
	async get(id: string, context: Context): Promise<Result<SandboxInfo | undefined, BoxError>> {
		const found = await this.json("GET", this.sandbox(id), { retry: true }, context);
		if (!found.ok) return found.error.code === "not_found" ? ok(undefined) : found;
		return ok((found.value as SandboxInfo | null) ?? undefined);
	}

	async list(labels: Readonly<Record<string, string>>, context: Context): Promise<Result<SandboxInfo[], BoxError>> {
		const infos: SandboxInfo[] = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ labels: JSON.stringify(labels), limit: "100" });
			if (cursor !== undefined) query.set("cursor", cursor);
			const page = await this.json("GET", `${this.sandbox()}?${query}`, { retry: true }, context);
			if (!page.ok) return page;
			const value = page.value as { items?: SandboxInfo[]; nextCursor?: string | null } | SandboxInfo[] | null;
			if (Array.isArray(value)) return ok([...infos, ...value]);
			infos.push(...(value?.items ?? []));
			cursor = value?.nextCursor ?? undefined;
		} while (cursor !== undefined);
		return ok(infos);
	}

	/** Delete the sandbox. A sandbox that does not exist is not an error. */
	async remove(id: string, context: Context): Promise<Result<void, BoxError>> {
		const removed = await this.call(
			"DELETE",
			this.sandbox(id),
			{ timeoutMs: DESTROY_TIMEOUT_MS, retry: true },
			context,
		);
		if (removed.ok || removed.error.code === "gone") return ok(undefined);
		return removed;
	}

	async stop(id: string, context: Context): Promise<Result<void, BoxError>> {
		const stopped = await this.call(
			"POST",
			this.sandbox(id, "/stop?force=true"),
			{ timeoutMs: DESTROY_TIMEOUT_MS },
			context,
		);
		return stopped.ok ? ok(undefined) : stopped;
	}

	async toolbox(info: SandboxInfo, context: Context): Promise<Result<string, BoxError>> {
		let proxy = info.toolboxProxyUrl ?? this.#proxies.get(info.id);
		if (proxy === undefined) {
			const found = await this.json("GET", this.sandbox(info.id, "/toolbox-proxy-url"), { retry: true }, context);
			if (!found.ok)
				return found.error.code === "not_found"
					? err(new BoxError("gone", `box ${info.id} does not exist`))
					: found;
			const url = (found.value as { url?: string } | null)?.url;
			if (url === undefined) return err(new BoxError("unknown", `no toolbox url for box ${info.id}`));
			proxy = url;
			this.#proxies.set(info.id, proxy);
		}
		return ok(`${proxy.replace(/\/+$/, "")}/${encodeURIComponent(info.id)}`);
	}

	/** A shell command in the box, run to its end; stdout and stderr come back combined. */
	async execute(
		info: SandboxInfo,
		command: string,
		timeoutS: number,
		context: Context,
	): Promise<Result<Executed, BoxError>> {
		const base = await this.toolbox(info, context);
		if (!base.ok) return base;
		const url = `${base.value}/process/execute`;
		const answer = await this.json(
			"POST",
			url,
			{ json: { command, timeout: timeoutS }, timeoutMs: (timeoutS + 15) * 1000 },
			context,
		);
		if (!answer.ok)
			return answer.error.code === "not_found" ? err(new BoxError("gone", `box ${info.id} does not exist`)) : answer;
		const value = answer.value as Partial<Executed> | null;
		return ok({
			exitCode: typeof value?.exitCode === "number" ? value.exitCode : -1,
			result: typeof value?.result === "string" ? value.result : "",
		});
	}

	async upload(info: SandboxInfo, path: string, bytes: Uint8Array, context: Context): Promise<Result<void, BoxError>> {
		const base = await this.toolbox(info, context);
		if (!base.ok) return base;
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(bytes)]), "file");
		const uploaded = await this.call(
			"POST",
			`${base.value}/files/upload-v2?${new URLSearchParams({ path })}`,
			{ form, retry: true },
			context,
		);
		return uploaded.ok ? ok(undefined) : uploaded;
	}

	async setMode(info: SandboxInfo, path: string, mode: number, context: Context): Promise<Result<void, BoxError>> {
		const base = await this.toolbox(info, context);
		if (!base.ok) return base;
		const query = new URLSearchParams({ path, mode: mode.toString(8).padStart(4, "0") });
		const changed = await this.call("POST", `${base.value}/files/permissions?${query}`, { retry: true }, context);
		return changed.ok ? ok(undefined) : changed;
	}

	async download(info: SandboxInfo, path: string, context: Context): Promise<Result<Uint8Array, BoxError>> {
		const base = await this.toolbox(info, context);
		if (!base.ok) return base;
		const downloaded = await this.call(
			"GET",
			`${base.value}/files/download?${new URLSearchParams({ path })}`,
			{ retry: true },
			context,
		);
		if (downloaded.ok) return ok(downloaded.value.bytes);
		// A 404 without the file code means the sandbox or its toolbox is gone, which the box works out.
		const missing = downloaded.error.message.includes("FILE_NOT_FOUND");
		const code = missing ? "not_found" : downloaded.error.code === "not_found" ? "unknown" : downloaded.error.code;
		return err(new BoxError(code, downloaded.error.message, downloaded.error.cause));
	}
}

function factsOf(info: SandboxInfo, provider: DaytonaBoxesOptions): BoxFacts {
	const gpu = Array.isArray(info.gpuType) ? info.gpuType[0] : info.gpuType;
	const lifetime = Number(info.labels?.[LIFETIME_LABEL]);
	return {
		provider: "daytona",
		// A default sandbox is a Linux container on the host kernel; a `linux-vm` snapshot is a VM. Nothing here is gVisor.
		isolation: info.sandboxClass === "linux-vm" ? "vm" : "container",
		cpus: info.cpu ?? null,
		memoryMb: info.memory === undefined ? null : info.memory * BYTES_PER_GIB,
		gpu: gpu ?? null,
		workspace: info.labels?.[WORKSPACE_LABEL] ?? provider.workspace ?? DEFAULT_WORKSPACE,
		maxLifetimeMs: Number.isFinite(lifetime) && lifetime > 0 ? lifetime : null,
		snapshot: null,
	};
}

/** A program running in a box: started detached, input and output spooled through files, polled with `execute`. */
function startProcess(
	box: DaytonaBox,
	rest: Rest,
	dir: string,
	options: BoxExecOptions | undefined,
	pollMs: number,
	context: Context,
): BoxProcess {
	const stdout = new Pipe();
	const stderr = new Pipe();
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	let resolveExit: (result: Result<number, BoxError>) => void = () => {};
	const exit = new Promise<Result<number, BoxError>>((resolve) => {
		resolveExit = resolve;
	});
	const signal = context.abortSignal;

	const finish = (result: Result<number, BoxError>, kill: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		stdout.end();
		stderr.end();
		resolveExit(result);
		// The cleanup must outlive an aborted context, so it runs on its own.
		void rest
			.execute(
				box.info,
				shellCommand(CLEANUP_SCRIPT, [dir, kill ? "kill" : "keep"]),
				CLEANUP_TIMEOUT_S,
				BACKGROUND_CONTEXT,
			)
			.catch(() => {});
	};
	const onAbort = () => finish(err(new BoxError("aborted", "the call was aborted")), true);
	if (options?.timeoutMs !== undefined) {
		const timeoutMs = options.timeoutMs;
		timer = setTimeout(
			() => finish(err(new BoxError("timeout", `the program did not exit in ${timeoutMs} ms`)), true),
			timeoutMs,
		);
	}
	if (signal?.aborted === true) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	void (async () => {
		let outOffset = 0;
		let errOffset = 0;
		let failures = 0;
		while (!settled) {
			// A reader that falls behind stops the polling, so the host never holds more than the bound for a program.
			await Promise.all([stdout.waitBelow(OUTPUT_BUFFER_MAX_BYTES), stderr.waitBelow(OUTPUT_BUFFER_MAX_BYTES)]);
			if (settled) return;
			const polled = await rest.execute(
				box.info,
				shellCommand(POLL_SCRIPT, [dir, String(outOffset), String(errOffset), String(OUTPUT_CHUNK_BYTES)]),
				CLEANUP_TIMEOUT_S,
				context,
			);
			if (settled) return;
			if (!polled.ok) {
				failures += 1;
				if (polled.error.code === "gone" || failures >= POLL_FAILURES_MAX) return finish(polled, false);
				await delay(pollMs, context);
				continue;
			}
			failures = 0;
			if (polled.value.result.trim() === "GONE")
				return finish(err(new BoxError("gone", `box ${box.id} lost the program`)), false);
			let code: number | undefined;
			let more = false;
			for (const line of polled.value.result.split("\n")) {
				const text = line.slice(2).trim();
				if (line.startsWith("C ") && /^\d+$/.test(text)) code = Number(text);
				if (line.startsWith("O ") || line.startsWith("E ")) {
					const bytes = new Uint8Array(Buffer.from(text, "base64"));
					if (line.startsWith("O ")) {
						stdout.push(bytes);
						outOffset += bytes.length;
					} else {
						stderr.push(bytes);
						errOffset += bytes.length;
					}
					if (bytes.length >= OUTPUT_CHUNK_BYTES) more = true;
				}
			}
			if (code !== undefined && !more) return finish(ok(code), false);
			if (!more) await delay(pollMs, context);
		}
	})();

	let inputs = 0;
	let closed = false;
	let queue: Promise<void> = Promise.resolve();
	const send = (script: string, args: readonly string[]): Promise<void> => {
		const sent = queue.then(async () => {
			if (settled) return;
			const ran = await rest.execute(box.info, shellCommand(script, [dir, ...args]), CLEANUP_TIMEOUT_S, context);
			// A program that exited while the write was in flight takes its spool with it; its input no longer matters.
			if (settled) return;
			if (!ran.ok) throw ran.error;
			if (ran.value.exitCode !== 0)
				throw new BoxError("unknown", `could not write input: ${ran.value.result.trim()}`);
		});
		queue = sent.catch(() => {});
		return sent;
	};
	return {
		stdin: {
			write: async (bytes) => {
				if (closed) throw new Error("stdin is closed");
				const sends: Promise<void>[] = [];
				for (let at = 0; at < bytes.length; at += INPUT_CHUNK_BYTES) {
					const chunk = Buffer.from(bytes.subarray(at, at + INPUT_CHUNK_BYTES)).toString("base64");
					sends.push(send(WRITE_INPUT_SCRIPT, [chunk, String(inputs).padStart(8, "0")]));
					inputs += 1;
				}
				await Promise.all(sends);
			},
			close: async () => {
				if (closed) return;
				closed = true;
				await send(CLOSE_INPUT_SCRIPT, []);
			},
		},
		stdout,
		stderr,
		wait: () => exit,
	};
}

/** A box that is one Daytona sandbox. Programs run through the toolbox; the API key stays in the host. */
class DaytonaBox implements Box {
	readonly id: string;
	readonly info: SandboxInfo;
	readonly #rest: Rest;
	readonly #options: DaytonaBoxesOptions;
	readonly #facts: BoxFacts;

	constructor(rest: Rest, options: DaytonaBoxesOptions, info: SandboxInfo) {
		this.id = info.id;
		this.info = info;
		this.#rest = rest;
		this.#options = options;
		this.#facts = factsOf(info, options);
	}

	facts(): BoxFacts {
		return this.#facts;
	}

	async exec(
		command: readonly string[],
		options: BoxExecOptions | undefined,
		context: Context,
	): Promise<Result<BoxProcess, BoxError>> {
		if (command.length === 0) return err(new BoxError("invalid", "the command is empty"));
		const dir = `${this.#options.spoolDir ?? DEFAULT_SPOOL_DIR}/${randomUUID().replaceAll("-", "").slice(0, 16)}`;
		const launched = await this.#rest.execute(
			this.info,
			shellCommand(LAUNCH_SCRIPT, [RUN_SCRIPT, dir, this.#facts.workspace, ...command]),
			CLEANUP_TIMEOUT_S,
			context,
		);
		if (!launched.ok) return this.#gone(launched, context);
		if (launched.value.exitCode !== 0) {
			return err(
				new BoxError("spawn", `could not start the program: ${launched.value.result.trim().slice(0, 300)}`),
			);
		}
		return ok(startProcess(this, this.#rest, dir, options, this.#options.execPollMs ?? EXEC_POLL_MS, context));
	}

	async upload(files: readonly BoxFile[], context: Context): Promise<Result<void, BoxError>> {
		for (const file of files) {
			const path = this.#resolve(file.path);
			const uploaded = await this.#rest.upload(this.info, path, file.bytes, context);
			if (!uploaded.ok) return this.#gone(uploaded, context);
			if (file.mode !== undefined) {
				const changed = await this.#rest.setMode(this.info, path, file.mode, context);
				if (!changed.ok) return changed;
			}
		}
		return ok(undefined);
	}

	async download(paths: readonly string[], context: Context): Promise<Result<readonly BoxFile[], BoxError>> {
		const files: BoxFile[] = [];
		for (const path of paths) {
			const downloaded = await this.#rest.download(this.info, this.#resolve(path), context);
			if (!downloaded.ok) {
				if (downloaded.error.code === "not_found") return err(new BoxError("not_found", `${path} does not exist`));
				return this.#gone(downloaded, context);
			}
			files.push({ path, bytes: downloaded.value });
		}
		return ok(files);
	}

	async status(context: Context): Promise<Result<BoxStatus, BoxError>> {
		const found = await this.#rest.get(this.id, context);
		if (!found.ok) return found;
		if (found.value === undefined || ENDED_STATES.has(found.value.state ?? ""))
			return ok({ state: "ended", exitCode: null });
		return ok({ state: "running" });
	}

	destroy(context: Context): Promise<Result<void, BoxError>> {
		return deleteSandbox(this.#rest, this.id, this.#options.destroyRetryMs ?? DESTROY_RETRY_MS, context);
	}

	#resolve(path: string): string {
		return posix.resolve(this.#facts.workspace, path);
	}

	/** A failure on a box that has ended is `gone`, whatever the toolbox said. */
	async #gone<T>(failure: Result<T, BoxError> & { ok: false }, context: Context): Promise<Result<never, BoxError>> {
		const code = failure.error.code;
		if (code === "aborted" || code === "timeout" || code === "gone") return failure;
		const status = await this.status(context);
		if (status.ok && status.value.state === "ended")
			return err(new BoxError("gone", `box ${this.id} has ended`, failure.error));
		return failure;
	}
}

async function waitStarted(
	rest: Rest,
	info: SandboxInfo,
	options: DaytonaBoxesOptions,
	context: Context,
): Promise<Result<SandboxInfo, BoxError>> {
	const deadline = Date.now() + (options.startTimeoutMs ?? START_TIMEOUT_MS);
	for (let current: SandboxInfo | undefined = info; ; ) {
		if (current?.state === "started") return ok(current);
		if (current === undefined || ENDED_STATES.has(current.state ?? "")) {
			const reason = current?.errorReason === undefined ? "" : `: ${current.errorReason}`;
			return err(
				new BoxError("unknown", `box ${info.id} went to ${current?.state ?? "deleted"} while starting${reason}`),
			);
		}
		if (Date.now() >= deadline)
			return err(new BoxError("timeout", `box ${info.id} did not start (state ${current.state})`));
		await delay(options.pollMs ?? POLL_MS, context);
		if (context.abortSignal?.aborted === true) return err(new BoxError("aborted", "the call was aborted"));
		const next = await rest.get(info.id, context);
		if (!next.ok) return next;
		current = next.value;
	}
}

/** Whether a sandbox in this state is on its way out, or gone: the only states that tell a failed DELETE did not matter. */
const DELETED_STATES: ReadonlySet<string> = new Set(["destroyed", "destroying"]);

/**
 * Delete a sandbox and make sure it is going. A DELETE that fails is checked against the sandbox itself: only a sandbox that
 * no longer exists, or one being destroyed, counts as done. A stopped, archived or errored sandbox that refuses its DELETE is
 * still there with its files, so the last failure is returned, after a forced stop before the final attempt.
 */
async function deleteSandbox(
	rest: Rest,
	id: string,
	retryMs: number,
	context: Context,
): Promise<Result<void, BoxError>> {
	let failure: BoxError | undefined;
	for (let attempt = 1; attempt <= DESTROY_ATTEMPTS; attempt += 1) {
		const removed = await rest.remove(id, context);
		if (removed.ok) return removed;
		failure = removed.error;
		const found = await rest.get(id, context);
		if (found.ok && (found.value === undefined || DELETED_STATES.has(found.value.state ?? ""))) return ok(undefined);
		if (attempt === DESTROY_ATTEMPTS - 1) await rest.stop(id, context);
		await delay(retryMs, context);
	}
	return err(failure ?? new BoxError("unknown", `could not destroy box ${id}`));
}

/**
 * Daytona's label listing trails a create and flaps: measured on 20 boxes, the `pi-transport` query first showed a
 * box 0.7 to 1.6 s after the create answered, and went back to empty up to 0.35 s after that (5 flaps in one case),
 * so two hits in a row proved nothing. The provider asks Daytona one query only, `pi-transport` alone, and filters
 * the other labels itself. The `Box` contract says a box is listed once `create` returns, so `create` waits until
 * that query has shown the box without a miss for `listedStableMs`.
 */
async function waitListed(
	rest: Rest,
	id: string,
	options: DaytonaBoxesOptions,
	context: Context,
): Promise<Result<void, BoxError>> {
	const timeoutMs = options.listedTimeoutMs ?? LISTED_TIMEOUT_MS;
	const stableMs = options.listedStableMs ?? LISTED_STABLE_MS;
	const deadline = Date.now() + timeoutMs;
	let streakStart: number | undefined;
	for (let hits = 0; ; ) {
		const listed = await rest.list(OWN_QUERY, context);
		if (!listed.ok) return listed;
		if (listed.value.some((info) => info.id === id)) {
			streakStart ??= Date.now();
			hits += 1;
			if (hits >= LISTED_ROUNDS && Date.now() - streakStart >= stableMs) return ok(undefined);
		} else {
			streakStart = undefined;
			hits = 0;
		}
		if (Date.now() >= deadline) {
			return err(
				new BoxError("timeout", `box ${id} was not listed steadily within ${timeoutMs} ms of its creation`),
			);
		}
		await delay(LISTED_POLL_MS, context);
		if (context.abortSignal?.aborted === true) return err(new BoxError("aborted", "the call was aborted"));
	}
}

/**
 * Boxes that are Daytona sandboxes, through the REST API with `fetch`. No SDK; the key is the host's to pass.
 *
 * A spec that names an `image`, `cpus`, `memoryMb` or `gpu` is refused with `unsupported`: a Daytona box has the size
 * of its snapshot, so name a snapshot (the `snapshot` field or option) instead. An `isolation` other than `container`
 * is refused with `unsupported` unless the snapshot is a `linux-vm` and the spec asks for `vm`. A label key that is
 * `pi-transport` or starts with `pi-transport.` is refused with `invalid`; the provider keeps its records there.
 * `region` is the Daytona target. A box that outlives `maxLifetimeMs` is ended by Daytona (`ttlMinutes`, rounded up to
 * whole minutes).
 */
export function daytonaBoxes(options: DaytonaBoxesOptions): BoxProvider {
	if (options.apiKey === "") throw new Error("a Daytona API key is required");
	if (options.workspace !== undefined && !options.workspace.startsWith("/")) {
		throw new Error("the workspace option must be an absolute path in the box");
	}
	const rest = new Rest(options);
	const withWorkspace = (spec: BoxSpec) => spec.workspace ?? options.workspace ?? DEFAULT_WORKSPACE;

	return {
		name: "daytona",

		async create(spec: BoxSpec, context: Context): Promise<Result<Box, BoxError>> {
			if (!(spec.maxLifetimeMs > 0)) return err(new BoxError("invalid", "maxLifetimeMs must be positive"));
			if (spec.image !== undefined) return err(new BoxError("unsupported", "daytona boxes start from a snapshot"));
			if (spec.workspace !== undefined && !spec.workspace.startsWith("/")) {
				return err(new BoxError("invalid", `the workspace ${spec.workspace} is not an absolute path in the box`));
			}
			const reserved = Object.keys(spec.labels ?? {}).find(isReservedLabel);
			if (reserved !== undefined) {
				return err(new BoxError("invalid", `the label ${reserved} is in the providers' own namespace`));
			}
			if (spec.isolation === "none" || spec.isolation === "gvisor") {
				return err(
					new BoxError("unsupported", `a daytona box is a container or a VM, the spec asks for ${spec.isolation}`),
				);
			}
			if (spec.cpus !== undefined || spec.memoryMb !== undefined || spec.gpu !== undefined) {
				return err(
					new BoxError(
						"unsupported",
						"a daytona box has the size of its snapshot: choose cpus, memory and gpu by naming a snapshot (the `snapshot` option or spec field), not in the spec",
					),
				);
			}
			const workspace = withWorkspace(spec);
			const body = {
				name: `${options.namePrefix ?? "pt-"}${randomUUID().replaceAll("-", "").slice(0, 20)}`,
				labels: {
					...spec.labels,
					[BOX_LABEL]: "1",
					[WORKSPACE_LABEL]: workspace,
					[LIFETIME_LABEL]: String(spec.maxLifetimeMs),
				},
				...(spec.env === undefined ? {} : { env: spec.env }),
				...((spec.snapshot ?? options.snapshot) === undefined
					? {}
					: { snapshot: spec.snapshot ?? options.snapshot }),
				...((spec.region ?? options.target) === undefined ? {} : { target: spec.region ?? options.target }),
				...(options.user === undefined ? {} : { user: options.user }),
				ttlMinutes: Math.max(1, Math.ceil(spec.maxLifetimeMs / MS_PER_MINUTE)),
				autoStopInterval: 0,
				autoDeleteInterval: 0,
			};
			const created = await rest.create(body, context);
			if (!created.ok) return created;
			// From here the sandbox exists: every failure removes it before it is returned.
			const abandon = async (failure: BoxError): Promise<Result<Box, BoxError>> => {
				const deleted = await deleteSandbox(
					rest,
					created.value.id,
					options.destroyRetryMs ?? DESTROY_RETRY_MS,
					BACKGROUND_CONTEXT,
				);
				if (deleted.ok) return err(failure);
				// The caller gets no box to destroy, so the failure names the sandbox that is left.
				return err(
					new BoxError(
						failure.code,
						`${failure.message}; sandbox ${created.value.id} could not be deleted either (${deleted.error.message}) and lives until its lifetime ends`,
						failure,
					),
				);
			};
			const started = await waitStarted(rest, created.value, options, context);
			if (!started.ok) return abandon(started.error);
			const box = new DaytonaBox(rest, options, started.value);
			if (spec.isolation !== undefined && box.facts().isolation !== spec.isolation) {
				return abandon(
					new BoxError(
						"unsupported",
						`the snapshot gives a ${box.facts().isolation}, the spec asks for ${spec.isolation}: choose a snapshot of that class`,
					),
				);
			}
			const made = await rest.execute(
				started.value,
				shellCommand(MKDIR_SCRIPT, [workspace]),
				CLEANUP_TIMEOUT_S,
				context,
			);
			if (!made.ok) return abandon(made.error);
			if (made.value.exitCode !== 0) {
				return abandon(
					new BoxError("unknown", `could not create ${workspace}: ${made.value.result.trim().slice(0, 300)}`),
				);
			}
			const listed = await waitListed(rest, started.value.id, options, context);
			if (!listed.ok) return abandon(listed.error);
			return ok(box);
		},

		async attach(id: string, context: Context): Promise<Result<Box | undefined, BoxError>> {
			const found = await rest.get(id, context);
			if (!found.ok) return found;
			const info = found.value;
			if (info?.labels?.[BOX_LABEL] === undefined || info.state !== "started") return ok(undefined);
			// A workspace label this package did not write is not a box it can use.
			const workspace = info.labels[WORKSPACE_LABEL];
			if (workspace !== undefined && !workspace.startsWith("/")) return ok(undefined);
			return ok(new DaytonaBox(rest, options, info));
		},

		async list(labels, context: Context): Promise<Result<readonly BoxRef[], BoxError>> {
			// One query to Daytona, whatever the host asks: its label index answers each query shape on its own schedule.
			const listed = await rest.list(OWN_QUERY, context);
			if (!listed.ok) return listed;
			const refs: BoxRef[] = [];
			for (const info of listed.value) {
				if (ENDED_STATES.has(info.state ?? "")) continue;
				if (!Object.entries(labels).every(([key, value]) => info.labels?.[key] === value)) continue;
				const own = Object.entries(info.labels ?? {}).filter(([key]) => !OWN_LABELS.has(key));
				refs.push({ id: info.id, labels: Object.fromEntries(own) });
			}
			return ok(refs);
		},
	};
}
