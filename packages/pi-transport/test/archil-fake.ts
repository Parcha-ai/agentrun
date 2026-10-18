import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArchilExecClient, ArchilExecDisk, ArchilExecMount } from "../src/box/archil-exec.ts";

/** What the real SDK throws for a 404 on an object, and for a refused call. */
export class FakeArchilError extends Error {
	readonly status: number;

	constructor(name: string, message: string, status: number) {
		super(message);
		this.name = name;
		this.status = status;
	}
}

export type ArchilCall = { readonly mount: string; readonly command: string; readonly spec: ArchilExecMount };

/**
 * The part of the Archil SDK `archilExecBoxes` calls, over a directory on this machine. Every `exec` runs `sh -c` with
 * the mount's `/mnt/archil/<key>` rewritten to that directory, like the real call: one request that answers when the
 * command ends, stdout and stderr as text (bytes that are not UTF-8 come back as U+FFFD), no stdin. A path named in
 * `checkoutPaths` is held for the call: a second call for it waits `queueMs`, and with none fails at once with the
 * 400 the real service returns. `close()` kills what still runs, so a test that abandons a call leaves nothing.
 */
export class FakeArchil {
	readonly root = mkdtempSync(join(tmpdir(), "pi-transport-archil-fake-"));
	readonly calls: ArchilCall[] = [];
	readonly disk: ArchilExecDisk;
	readonly client: ArchilExecClient;
	/** Calls running now, by path held. */
	readonly held = new Map<string, Promise<void>>();
	/** Longest number of calls that ran at once on one held path. */
	maxOverlap = 0;
	/** Make the next `exec` fail with this error. */
	failNext: Error | undefined;
	readonly #children = new Set<number>();
	#running = 0;

	/** False: the service ignores `checkoutPaths`, as one that did not honour the request would. */
	enforceCheckout = true;

	constructor(id = "disk-fake") {
		this.disk = {
			id,
			getObject: async (key) => {
				const path = join(this.root, key);
				if (!existsSync(path)) {
					throw new FakeArchilError("ArchilS3Error", "S3 GetObject failed: 404 NoSuchKey", 404);
				}
				return new Uint8Array(readFileSync(path));
			},
			putObject: async (key, body, options) => {
				this.#refuseWriteUnderHold(key);
				const path = join(this.root, key);
				if (key.endsWith("/")) {
					mkdirSync(path, { recursive: true });
					return;
				}
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, typeof body === "string" ? body : body);
				const mode = typeof options === "object" && options !== null ? options.mode : undefined;
				if (mode !== undefined) chmodSync(path, mode);
			},
			deleteObject: async (key) => {
				this.#refuseWriteUnderHold(key);
				rmSync(join(this.root, key), { recursive: true, force: true });
			},
		};
		this.client = {
			exec: async ({ disks, command }) => {
				const [mount, spec] = Object.entries(disks)[0] as [string, ArchilExecMount];
				this.calls.push({ mount, command, spec });
				if (this.failNext !== undefined) {
					const error = this.failNext;
					this.failNext = undefined;
					throw error;
				}
				const paths = this.enforceCheckout ? (spec.checkoutPaths ?? []) : [];
				const release = await this.#checkout(paths, spec.queueMs);
				try {
					return await this.#run(mount, command);
				} finally {
					release();
				}
			},
		};
	}

	/** The service refuses an object write to a path another client holds a write delegation of, as it does a command's. */
	#refuseWriteUnderHold(key: string): void {
		const path = key.replace(/\/$/, "");
		for (const held of this.held.keys()) {
			if (path === held || path.startsWith(`${held}/`) || held.startsWith(`${path}/`)) {
				throw new FakeArchilError(
					"ArchilS3Error",
					`S3 PutObject failed: 409 OperationAborted: the path /${held} cannot be written because another client holds a write delegation`,
					409,
				);
			}
		}
	}

	async #checkout(paths: readonly string[], queueMs: number | undefined): Promise<() => void> {
		const deadline = Date.now() + (queueMs ?? 0);
		// Checkouts are hierarchical, as the service's are: a path conflicts with itself, its parents and its children.
		const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
		for (const path of paths) {
			for (;;) {
				const holder = [...this.held].find(([other]) => overlaps(other, path))?.[1];
				if (holder === undefined) break;
				if (queueMs === undefined || Date.now() >= deadline) {
					throw new FakeArchilError(
						"ArchilApiError",
						"Exec failed: Delegation checkout conflicts with another client",
						400,
					);
				}
				await Promise.race([holder, new Promise((resolve) => setTimeout(resolve, deadline - Date.now()))]);
			}
		}
		let done: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			done = resolve;
		});
		for (const path of paths) this.held.set(path, held);
		return () => {
			for (const path of paths) if (this.held.get(path) === held) this.held.delete(path);
			done();
		};
	}

	#run(mount: string, command: string) {
		const rewritten = command.split(`/mnt/archil/${mount}`).join(this.root);
		return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
			this.#running += 1;
			this.maxOverlap = Math.max(this.maxOverlap, this.#running);
			const child = spawn("sh", ["-c", rewritten], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.root },
			});
			if (child.pid !== undefined) this.#children.add(child.pid);
			const out: Buffer[] = [];
			const errors: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
			child.on("close", (code, signal) => {
				this.#running -= 1;
				if (child.pid !== undefined) this.#children.delete(child.pid);
				resolve({
					stdout: Buffer.concat(out).toString("utf8").split(this.root).join(`/mnt/archil/${mount}`),
					stderr: Buffer.concat(errors).toString("utf8").split(this.root).join(`/mnt/archil/${mount}`),
					exitCode: code ?? (signal === null ? 1 : 128 + (signal === "SIGKILL" ? 9 : 15)),
				});
			});
		});
	}

	/** Kill what still runs and remove the disk's directory. */
	close(): void {
		for (const pid of this.#children) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		rmSync(this.root, { recursive: true, force: true });
	}
}
