import { type ChildProcess, spawn } from "node:child_process";
import type { ModalCreateParams, ModalProcess, ModalSandbox, ModalSdk } from "../src/box/modal.ts";

/** Named like the SDK's classes: the provider reads `constructor.name`. */
export class NotFoundError extends Error {}
export class InvalidError extends Error {}
export class ResourceExhaustedError extends Error {}

type ExecParams = Parameters<ModalSandbox["exec"]>[1];

/** One Modal sandbox, played by local processes in the host's own directories. */
class FakeSandbox implements ModalSandbox {
	readonly sandboxId: string;
	readonly params: ModalCreateParams;
	readonly execs: { command: string[]; params: ExecParams }[] = [];
	readonly writes: number[] = [];
	exitCode: number | null = null;
	#children = new Set<ChildProcess>();

	constructor(sandboxId: string, params: ModalCreateParams) {
		this.sandboxId = sandboxId;
		this.params = params;
	}

	async exec(command: string[], params: ExecParams): Promise<ModalProcess> {
		if (this.exitCode !== null) throw new Error("the sandbox has been terminated");
		this.execs.push({ command, params });
		const child = spawn(command[0] ?? "", command.slice(1), {
			cwd: params.workdir,
			env: { PATH: process.env.PATH ?? "", ...params.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#children.add(child);
		child.stdin.on("error", () => {});
		const exited = new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				this.#children.delete(child);
				resolve(code ?? (signal === null ? 0 : 137));
			});
		});
		exited.catch(() => {});
		return {
			stdin: {
				writeBytes: (bytes) =>
					new Promise<void>((resolve, reject) => {
						this.writes.push(bytes.length);
						child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
					}),
				close: () => new Promise<void>((resolve) => child.stdin.end(resolve)),
			},
			stdout: child.stdout,
			stderr: child.stderr,
			wait: () => exited,
		};
	}

	async poll(): Promise<number | null> {
		return this.exitCode;
	}

	async terminate(): Promise<void> {
		for (const child of this.#children) child.kill("SIGKILL");
		this.exitCode ??= 0;
	}

	async getTags(): Promise<Record<string, string>> {
		return { ...this.params.tags };
	}
}

/** A Modal client that runs each sandbox as local processes. `fail` makes a named call throw the given error. */
export class FakeModal implements ModalSdk {
	readonly sandboxList: FakeSandbox[] = [];
	readonly appNames: string[] = [];
	readonly images: ModalSdk["images"] = {
		fromRegistry: (tag) => ({ registry: tag }),
		fromId: async (id) => ({ id }),
	};
	readonly fail: { create?: Error; fromId?: Error } = {};

	readonly apps: ModalSdk["apps"] = {
		fromName: async (name) => {
			this.appNames.push(name);
			return { appId: `ap-${name}` };
		},
	};

	readonly sandboxes: ModalSdk["sandboxes"] = {
		create: async (_app, _image, params) => {
			if (this.fail.create) throw this.fail.create;
			const sandbox = new FakeSandbox(`sb-${this.sandboxList.length + 1}`, params);
			this.sandboxList.push(sandbox);
			return sandbox;
		},
		fromId: async (id) => {
			if (this.fail.fromId) throw this.fail.fromId;
			const found = this.sandboxList.find((sandbox) => sandbox.sandboxId === id);
			if (!found) throw new NotFoundError(`no sandbox ${id}`);
			return found;
		},
		list: ({ tags }) => {
			const matching = this.sandboxList.filter(
				(sandbox) =>
					sandbox.exitCode === null && Object.entries(tags).every(([k, v]) => sandbox.params.tags[k] === v),
			);
			return (async function* () {
				yield* matching;
			})();
		},
	};

	/** Sandboxes that are still running, as Modal would list them. */
	running(): FakeSandbox[] {
		return this.sandboxList.filter((sandbox) => sandbox.exitCode === null);
	}
}
