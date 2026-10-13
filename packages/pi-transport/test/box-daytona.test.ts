import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Box, BoxSpec } from "../src/box/box.ts";
import { daytonaBoxes } from "../src/box/daytona.ts";
import { finish, readStream } from "../src/box/files.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const API_KEY = "test-key-0123456789";
const CANARY = "PI_TRANSPORT_HOST_CANARY";
const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type FakeSandbox = {
	id: string;
	state: string;
	labels: Record<string, string>;
	env: Record<string, string>;
	sandboxClass?: string;
};
type Failure = { match: (method: string, path: string) => boolean; status: number; body: string; times: number };

/**
 * A Daytona that runs every toolbox command in a real local shell, with the sandbox's env and nothing of this
 * process's, and keeps files on the local disk. It is as faithful as the shell scripts the provider sends.
 */
class FakeDaytona {
	readonly sandboxes = new Map<string, FakeSandbox>();
	readonly requests: { method: string; path: string; auth: string | undefined; body: string }[] = [];
	readonly failures: Failure[] = [];
	readonly root = mkdtempSync(join(tmpdir(), "pt-daytona-"));
	failExecuteContaining: string | undefined;
	/** Each new sandbox stays out of the label listing for this many list calls, as Daytona's does for a moment. */
	listLag = 0;
	readonly #hidden = new Map<string, number>();
	url = "";
	#server: Server | undefined;

	async start(): Promise<void> {
		chmodSync(this.root, 0o755);
		this.#server = createServer((request, response) => {
			void this.#handle(request, response).catch((error: Error) => {
				response.writeHead(500).end(error.message);
			});
		});
		await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
		rmSync(this.root, { recursive: true, force: true });
	}

	path(...names: string[]): string {
		return join(this.root, ...names);
	}

	#json(response: ServerResponse, status: number, value: unknown): void {
		response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
	}

	#info(sandbox: FakeSandbox) {
		return {
			id: sandbox.id,
			state: sandbox.state,
			labels: sandbox.labels,
			cpu: 1,
			memory: 1,
			sandboxClass: sandbox.sandboxClass,
		};
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks);
		const url = new URL(request.url ?? "/", this.url);
		const method = request.method ?? "GET";
		const type = request.headers["content-type"] ?? "";
		this.requests.push({
			method,
			path: url.pathname,
			auth: request.headers.authorization,
			body: type.startsWith("application/json") ? body.toString("utf8") : "",
		});
		if (request.headers.authorization !== `Bearer ${API_KEY}`)
			return this.#json(response, 401, { message: "bad key" });
		const failure = this.failures.find((f) => f.times > 0 && f.match(method, url.pathname));
		if (failure !== undefined) {
			failure.times -= 1;
			response.writeHead(failure.status).end(failure.body);
			return;
		}
		const parts = url.pathname.split("/").filter((part) => part !== "");
		if (parts[0] === "toolbox")
			return this.#toolbox(parts[1] ?? "", parts.slice(2).join("/"), url, body, type, response);
		const id = parts[2];
		const sandbox = id === undefined ? undefined : this.sandboxes.get(id);
		if (id === undefined && method === "POST") {
			const spec = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
			if ("cpu" in spec || "memory" in spec) {
				return this.#json(response, 400, { message: "Cannot specify Sandbox resources when using a snapshot" });
			}
			const created: FakeSandbox = {
				id: randomUUID(),
				state: "started",
				labels: (spec.labels ?? {}) as Record<string, string>,
				env: (spec.env ?? {}) as Record<string, string>,
				sandboxClass: String(spec.snapshot ?? "").includes("vm") ? "linux-vm" : "container",
			};
			this.sandboxes.set(created.id, created);
			if (this.listLag > 0) this.#hidden.set(created.id, this.listLag);
			return this.#json(response, 200, this.#info(created));
		}
		if (id === undefined) {
			const wanted = JSON.parse(url.searchParams.get("labels") ?? "{}") as Record<string, string>;
			const items = [...this.sandboxes.values()].filter((s) => {
				const left = this.#hidden.get(s.id) ?? 0;
				if (left > 0) this.#hidden.set(s.id, left - 1);
				return left === 0 && Object.entries(wanted).every(([key, value]) => s.labels[key] === value);
			});
			return this.#json(response, 200, { items: items.map((s) => this.#info(s)), nextCursor: null });
		}
		if (sandbox === undefined) return this.#json(response, 404, { message: "sandbox not found" });
		if (parts[3] === "toolbox-proxy-url") return this.#json(response, 200, { url: `${this.url}/toolbox` });
		if (parts[3] === "stop") return this.#json(response, 200, {});
		if (method === "DELETE") {
			this.sandboxes.delete(sandbox.id);
			return this.#json(response, 200, {});
		}
		return this.#json(response, 200, this.#info(sandbox));
	}

	async #toolbox(
		id: string,
		route: string,
		url: URL,
		body: Buffer,
		type: string,
		response: ServerResponse,
	): Promise<void> {
		const sandbox = this.sandboxes.get(id);
		if (sandbox === undefined) return this.#json(response, 404, { message: "sandbox not found" });
		const path = url.searchParams.get("path") ?? "";
		if (route === "process/execute") {
			const { command, timeout } = JSON.parse(body.toString("utf8")) as { command: string; timeout: number };
			if (this.failExecuteContaining !== undefined && command.includes(this.failExecuteContaining)) {
				return this.#json(response, 200, { exitCode: 1, result: "refused" });
			}
			return this.#json(response, 200, await this.#shell(command, sandbox.env, timeout));
		}
		if (route === "files/upload-v2") {
			const form = await new Response(body, { headers: { "content-type": type } }).formData();
			const file = form.get("file") as File;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, new Uint8Array(await file.arrayBuffer()));
			return this.#json(response, 200, { name: "file", path, type: "file" });
		}
		if (route === "files/download") {
			try {
				const bytes = readFileSync(path);
				return void response.writeHead(200).end(bytes);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return this.#json(response, 404, { code: "FILE_NOT_FOUND", message: "no such file" });
				}
				return this.#json(response, 400, { code: "BAD_REQUEST", message: "path must be a file" });
			}
		}
		if (route === "files/permissions") {
			chmodSync(path, Number.parseInt(url.searchParams.get("mode") ?? "0644", 8));
			return this.#json(response, 200, {});
		}
		return this.#json(response, 404, { message: "no route" });
	}

	#shell(
		command: string,
		env: Record<string, string>,
		timeoutS: number,
	): Promise<{ exitCode: number; result: string }> {
		return new Promise((resolve) => {
			const child = spawn("sh", ["-c", command], {
				cwd: this.root,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
				stdio: ["ignore", "pipe", "pipe"],
			});
			const parts: Buffer[] = [];
			child.stdout.on("data", (part: Buffer) => parts.push(part));
			child.stderr.on("data", (part: Buffer) => parts.push(part));
			const timer = setTimeout(() => child.kill("SIGKILL"), timeoutS * 1000);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ exitCode: code ?? -1, result: Buffer.concat(parts).toString("utf8") });
			});
		});
	}
}

const fake = new FakeDaytona();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

const provider = (spool = "spool") =>
	daytonaBoxes({
		apiKey: API_KEY,
		apiUrl: `${fake.url}/api`,
		spoolDir: fake.path(spool),
		workspace: fake.path("workspace"),
		pollMs: 10,
		execPollMs: 20,
	});

const spec = (extra: Partial<BoxSpec> = {}): BoxSpec => ({ maxLifetimeMs: 10 * 60_000, ...extra });

async function withBox(use: (box: Box) => Promise<void>, extra: Partial<BoxSpec> = {}, spool = "spool"): Promise<void> {
	const created = await provider(spool).create(spec(extra), context);
	if (!created.ok) throw created.error;
	try {
		await use(created.value);
	} finally {
		await created.value.destroy(context);
	}
}

// The suite runs on a fake that keeps every sandbox's files on this disk, so each box needs a workspace of its own.
let workspaces = 0;
registerBoxConformance(
	{ describe, expect, it },
	"daytona boxes on a fake daytona",
	async (use) => {
		process.env[CANARY] = "the host's environment reached a box";
		const inner = provider();
		await use({
			name: inner.name,
			create: (box, ctx) => {
				workspaces += 1;
				return inner.create({ ...box, workspace: fake.path("workspace", `box${workspaces}`) }, ctx);
			},
			attach: inner.attach,
			list: inner.list,
		});
	},
	{ absentEnv: [CANARY] },
);

describe("daytona boxes", () => {
	it("sends the key as a bearer token on every request and never in a box", async () => {
		fake.requests.length = 0;
		await withBox(async (box) => {
			const started = await box.exec(["env"], undefined, context);
			if (!started.ok) throw started.error;
			const finished = await finish(started.value);
			if (!finished.ok) throw finished.error;
			expect(decoder.decode(finished.value.stdout)).not.toContain(API_KEY);
		});
		expect(fake.requests.length).toBeGreaterThan(0);
		expect(fake.requests.every((r) => r.auth === `Bearer ${API_KEY}`)).toBe(true);
		expect(fake.requests.some((r) => r.body.includes(API_KEY))).toBe(false);
	});

	it("labels the box, bounds its life and sets no resources", async () => {
		await withBox(
			async () => {
				const posted = fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").at(-1);
				const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
				expect(body.labels).toMatchObject({ "pi-transport": "1", suite: "unit" });
				// The provider, not the host, ends a box that outlives its lifetime: measured live, ttl 1 minute ends it in 67 s.
				expect(body).toMatchObject({ ttlMinutes: 10, autoStopInterval: 0, autoDeleteInterval: 0 });
				expect(body.name).toMatch(/^pt-/);
				expect("cpu" in body || "memory" in body || "gpu" in body).toBe(false);
			},
			{ labels: { suite: "unit" } },
		);
	});

	it("rounds a lifetime up to whole minutes", async () => {
		await withBox(
			async () => {
				const posted = fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").at(-1);
				expect((JSON.parse(posted?.body ?? "{}") as { ttlMinutes: number }).ttlMinutes).toBe(2);
			},
			{ maxLifetimeMs: 61_000 },
		);
	});

	it("refuses a spec that sizes the box, names an image or has no lifetime", async () => {
		for (const bad of [{ cpus: 2 }, { memoryMb: 512 }, { gpu: "T4" }]) {
			const created = await provider().create(spec(bad), context);
			expect(created.ok ? "ok" : created.error.code).toBe("invalid");
			expect(created.ok ? "" : created.error.message).toContain("snapshot");
		}
		const image = await provider().create(spec({ image: "debian" }), context);
		expect(image.ok ? "ok" : image.error.code).toBe("unsupported");
		const none = await provider().create({ maxLifetimeMs: 0 }, context);
		expect(none.ok ? "ok" : none.error.code).toBe("invalid");
		expect(fake.sandboxes.size).toBe(0);
	});

	it("removes a sandbox it could not make ready", async () => {
		fake.failExecuteContaining = "mkdir";
		try {
			const created = await provider().create(spec(), context);
			expect(created.ok).toBe(false);
			expect(fake.sandboxes.size).toBe(0);
		} finally {
			fake.failExecuteContaining = undefined;
		}
	});

	it("treats a destroy that meets a delete already under way as done", async () => {
		await withBox(async (box) => {
			const sandbox = fake.sandboxes.get(box.id);
			if (sandbox === undefined) throw new Error("the sandbox is missing");
			sandbox.state = "destroying";
			fake.failures.push({
				match: (method, path) => method === "DELETE" && path === `/api/sandbox/${box.id}`,
				status: 409,
				body: "Sandbox state change in progress",
				times: 1,
			});
			expect(await box.destroy(context)).toEqual({ ok: true, value: undefined });
		});
	});

	it("returns from create only once the box shows in its own label listing", async () => {
		fake.listLag = 4;
		try {
			await withBox(
				async (box) => {
					const listed = await provider().list({ suite: "unit" }, context);
					expect(listed.ok && listed.value.some((ref) => ref.id === box.id)).toBe(true);
				},
				{ labels: { suite: "unit" } },
			);
		} finally {
			fake.listLag = 0;
		}
	});

	it("fails create with a timeout and removes the box when the listing never shows it", async () => {
		fake.listLag = 1_000_000;
		try {
			const slow = daytonaBoxes({
				apiKey: API_KEY,
				apiUrl: `${fake.url}/api`,
				spoolDir: fake.path("spool"),
				workspace: fake.path("workspace"),
				pollMs: 10,
				listedTimeoutMs: 300,
			});
			const created = await slow.create(spec(), context);
			expect(created.ok ? "ok" : created.error.code).toBe("timeout");
			expect(fake.sandboxes.size).toBe(0);
		} finally {
			fake.listLag = 0;
		}
	});

	it("reports a default sandbox as a container and refuses an isolation it cannot give", async () => {
		await withBox(async (box) => expect(box.facts().isolation).toBe("container"), { isolation: "container" });
		for (const isolation of ["none", "gvisor", "vm"] as const) {
			const created = await provider().create(spec({ isolation }), context);
			expect(created.ok ? "ok" : created.error.code).toBe("unsupported");
		}
		expect(fake.sandboxes.size).toBe(0);
		const vm = daytonaBoxes({
			apiKey: API_KEY,
			apiUrl: `${fake.url}/api`,
			snapshot: "daytona-vm-small",
			spoolDir: fake.path("spool"),
			workspace: fake.path("workspace"),
			pollMs: 10,
		});
		const made = await vm.create(spec({ isolation: "vm" }), context);
		if (!made.ok) throw made.error;
		expect(made.value.facts().isolation).toBe("vm");
		await made.value.destroy(context);
	});

	it("refuses an empty key", () => {
		expect(() => daytonaBoxes({ apiKey: "" })).toThrow();
	});

	it("maps a bad key to unauthorized and a quota answer to capacity", async () => {
		const wrong = await daytonaBoxes({ apiKey: "wrong", apiUrl: `${fake.url}/api` }).create(spec(), context);
		expect(wrong.ok ? "ok" : wrong.error.code).toBe("unauthorized");
		fake.failures.push({
			match: (method, path) => method === "POST" && path === "/api/sandbox",
			status: 403,
			body: "Total CPU quota exceeded",
			times: 1,
		});
		const full = await provider().create(spec(), context);
		expect(full.ok ? "ok" : full.error.code).toBe("capacity");
	});

	it("retries a read that fails with a 503 and reports the box", async () => {
		await withBox(async (box) => {
			fake.failures.push({
				match: (method, path) => method === "GET" && path === `/api/sandbox/${box.id}`,
				status: 503,
				body: "busy",
				times: 2,
			});
			const status = await box.status(context);
			expect(status).toEqual({ ok: true, value: { state: "running" } });
		});
	});

	it("attaches only to a sandbox this package made, and lists without its own labels", async () => {
		await withBox(
			async (box) => {
				const foreign: FakeSandbox = { id: "foreign-1", state: "started", labels: { suite: "unit" }, env: {} };
				fake.sandboxes.set(foreign.id, foreign);
				try {
					const attached = await provider().attach(foreign.id, context);
					expect(attached).toEqual({ ok: true, value: undefined });
					const listed = await provider().list({ suite: "unit" }, context);
					expect(listed).toEqual({ ok: true, value: [{ id: box.id, labels: { suite: "unit" } }] });
				} finally {
					fake.sandboxes.delete(foreign.id);
				}
			},
			{ labels: { suite: "unit" } },
		);
	});

	it("reports a box that was deleted from outside as ended and gone", async () => {
		await withBox(async (box) => {
			fake.sandboxes.delete(box.id);
			expect(await box.status(context)).toEqual({ ok: true, value: { state: "ended", exitCode: null } });
			const started = await box.exec(["true"], undefined, context);
			expect(started.ok ? "ok" : started.error.code).toBe("gone");
			const files = await box.download(["x"], context);
			expect(files.ok ? "ok" : files.error.code).toBe("gone");
		});
	});

	it("keeps every byte of a large output and keeps stderr apart", async () => {
		await withBox(async (box) => {
			const started = await box.exec(
				["sh", "-c", "head -c 700000 /dev/zero | tr '\\0' 'x'; printf oops >&2"],
				undefined,
				context,
			);
			if (!started.ok) throw started.error;
			const finished = await finish(started.value);
			if (!finished.ok) throw finished.error;
			expect(finished.value.exitCode).toBe(0);
			expect(finished.value.stdout.length).toBe(700_000);
			expect(finished.value.stderr).toBe("oops");
		});
	});

	it("carries input larger than one spool chunk", async () => {
		await withBox(async (box) => {
			const bytes = Uint8Array.from({ length: 150_000 }, (_, index) => (index * 7) % 256);
			const started = await box.exec(["cat"], undefined, context);
			if (!started.ok) throw started.error;
			const finished = await finish(started.value, bytes);
			if (!finished.ok) throw finished.error;
			expect(Buffer.from(finished.value.stdout).equals(Buffer.from(bytes))).toBe(true);
		});
	});

	it("reports a program that is killed by a signal as 128 plus the number", async () => {
		await withBox(async (box) => {
			const started = await box.exec(["sh", "-c", "kill -9 $$"], undefined, context);
			if (!started.ok) throw started.error;
			const finished = await finish(started.value);
			expect(finished.ok && finished.value.exitCode).toBe(137);
		});
	});

	it("reports a missing program as exit 127", async () => {
		await withBox(async (box) => {
			const started = await box.exec(["no-such-program-pt"], undefined, context);
			if (!started.ok) throw started.error;
			const finished = await finish(started.value);
			expect(finished.ok && finished.value.exitCode).toBe(127);
		});
	});

	it("leaves no spool directory after a program ends, times out or is aborted", async () => {
		await withBox(
			async (box) => {
				const quick = await box.exec(["true"], undefined, context);
				if (!quick.ok) throw quick.error;
				await finish(quick.value);
				const slow = await box.exec(["sleep", "30"], { timeoutMs: 200 }, context);
				if (!slow.ok) throw slow.error;
				void readStream(slow.value.stdout);
				await slow.value.wait();
				// The cleanup runs after the wait resolves.
				for (let waited = 0; waited < 3000 && readdirSync(fake.path("spool-clean")).length > 0; waited += 50) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				expect(readdirSync(fake.path("spool-clean"))).toEqual([]);
			},
			{},
			"spool-clean",
		);
	});

	it("resolves relative paths against the workspace and sets a file's mode", async () => {
		await withBox(async (box) => {
			const uploaded = await box.upload(
				[{ path: "a/b.sh", bytes: encoder.encode("#!/bin/sh\n"), mode: 0o750 }],
				context,
			);
			expect(uploaded.ok).toBe(true);
			const real = join(box.facts().workspace, "a", "b.sh");
			expect(decoder.decode(readFileSync(real))).toBe("#!/bin/sh\n");
			const down = await box.download(["a/b.sh"], context);
			expect(down.ok && down.value[0]?.path).toBe("a/b.sh");
			const dir = await box.download(["a"], context);
			expect(dir.ok ? "ok" : dir.error.code).toBe("invalid");
		});
	});

	it("never reads the process environment", () => {
		const source = readFileSync(new URL("../src/box/daytona.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/process\.env/);
	});
});
