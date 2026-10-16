import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	E2bCommandHandle,
	E2bCreateOptions,
	E2bRunOptions,
	E2bSandbox,
	E2bSandboxInfo,
	E2bSdk,
} from "../src/box/e2b.ts";

/** Named like the SDK's classes: the provider reads `constructor.name`. */
export class SandboxNotFoundError extends Error {}
export class InvalidArgumentError extends Error {}
export class RateLimitError extends Error {}
export class AuthenticationError extends Error {}
export class CommandExitError extends Error {
	readonly exitCode: number;
	constructor(exitCode: number) {
		super(`the command exited with ${exitCode}`);
		this.exitCode = exitCode;
	}
}

/** One E2B sandbox, played by local processes in the host's own directories. Output reaches the callbacks as text, as the SDK's does. */
class FakeSandbox implements E2bSandbox {
	readonly sandboxId: string;
	readonly options: E2bCreateOptions;
	readonly runs: { command: string; options: E2bRunOptions }[] = [];
	readonly writes: string[] = [];
	running = true;
	#children = new Set<ChildProcess>();
	readonly commands: E2bSandbox["commands"];
	readonly files: E2bSandbox["files"];

	constructor(sandboxId: string, options: E2bCreateOptions) {
		this.sandboxId = sandboxId;
		this.options = options;
		this.commands = { run: (command, runOptions) => this.#run(command, runOptions) };
		this.files = {
			write: async (path, data) => {
				this.#alive();
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, new Uint8Array(data));
				this.writes.push(path);
			},
			read: async (path) => {
				this.#alive();
				try {
					return new Uint8Array(readFileSync(path));
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code === "ENOENT")
						throw new SandboxNotFoundError(`${path} is not found`);
					throw cause;
				}
			},
		};
	}

	#alive() {
		if (!this.running) throw new SandboxNotFoundError("the sandbox is not running anymore");
	}

	async #run(command: string, options: E2bRunOptions): Promise<E2bCommandHandle> {
		this.#alive();
		this.runs.push({ command, options });
		const child = spawn("sh", ["-c", command], {
			cwd: options.cwd,
			env: { PATH: process.env.PATH ?? "", ...this.options.envs, ...options.envs },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#children.add(child);
		child.stdin.on("error", () => {});
		const out = new StringDecoder("utf8");
		const errors = new StringDecoder("utf8");
		child.stdout.on("data", (chunk: Buffer) => options.onStdout(out.write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => options.onStderr(errors.write(chunk)));
		const exited = new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				this.#children.delete(child);
				resolve(code ?? (signal === null ? 0 : 137));
			});
		});
		exited.catch(() => {});
		return {
			wait: async () => {
				const code = await exited;
				if (code !== 0) throw new CommandExitError(code);
				return { exitCode: 0 };
			},
			kill: async () => child.kill("SIGKILL"),
			sendStdin: (data) =>
				new Promise<void>((resolve, reject) => {
					child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
				}),
			closeStdin: () => new Promise<void>((resolve) => child.stdin.end(resolve)),
		};
	}

	async isRunning(): Promise<boolean> {
		return this.running;
	}

	async kill(): Promise<boolean> {
		if (!this.running) return false;
		this.running = false;
		for (const child of this.#children) child.kill("SIGKILL");
		return true;
	}

	async getInfo(): Promise<E2bSandboxInfo> {
		this.#alive();
		return { sandboxId: this.sandboxId, metadata: this.options.metadata, cpuCount: 2, memoryMB: 512 };
	}
}

/** An E2B SDK in this process: sandboxes are local processes, the way the vendor's are remote ones. */
export class FakeE2b implements E2bSdk {
	readonly sandboxes: FakeSandbox[] = [];
	/** A failure the next `create` answers with. */
	createFailure: Error | undefined;
	#next = 1;

	async create(options: E2bCreateOptions): Promise<E2bSandbox> {
		if (this.createFailure !== undefined) {
			const failure = this.createFailure;
			this.createFailure = undefined;
			throw failure;
		}
		const sandbox = new FakeSandbox(`fake-e2b-${this.#next++}`, options);
		this.sandboxes.push(sandbox);
		return sandbox;
	}

	async connect(sandboxId: string): Promise<E2bSandbox> {
		const found = this.sandboxes.find((sandbox) => sandbox.sandboxId === sandboxId);
		if (found === undefined || !found.running) throw new SandboxNotFoundError(`sandbox ${sandboxId} is not found`);
		return found;
	}

	list(options: { query: { metadata: Record<string, string> } }) {
		const matching = this.sandboxes.filter(
			(sandbox) =>
				sandbox.running &&
				Object.entries(options.query.metadata).every(([key, value]) => sandbox.options.metadata[key] === value),
		);
		// Two pages, so that a host that reads only the first misses boxes.
		const pages = [matching.slice(0, 1), matching.slice(1)];
		let at = 0;
		return {
			get hasNext() {
				return at < pages.length;
			},
			async nextItems(): Promise<readonly E2bSandboxInfo[]> {
				const page = pages[at] ?? [];
				at += 1;
				return page.map((sandbox) => ({ sandboxId: sandbox.sandboxId, metadata: sandbox.options.metadata }));
			},
		};
	}
}
