// A stand-in for Maritime's virtual machines API: a fetch that answers the control plane (https://api.maritime.sh/v1,
// Bearer key) and each VM's data plane (its dataPlaneUrl, the VM's secret in X-Maritime-Token) in the shapes of Maritime's
// openapi.json and its SDK (maritime-sdk: SandboxData, Command, the {code, message} error body). The parts the docs
// leave open are this fake's guesses, each pinned as unverified in src/maritime.ts: a background command's env reaches
// its process; metadata holds the adapter's keys (dots) as they are; a listing by namePrefix answers VMs that are not
// ours and ended ones too (kept 7 days).
//
// A VM reads starting until `startReads` reads of it, then running. A background command runs until the test ends it
// (command(id).exit(code, output)), or start(sandbox, command) does something with it (a dial test boots the machine
// from command.env); a foreground one exits 0 at once. answer(method, url, body) answers a call first when it returns a
// Response: a test's refusal.
export const KEY = "fake-test-key-maritime";
export const API_URL = "https://api.maritime.sh";

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const refuse = (status, code, message) => json(status, { code, message, hint: "a hint", docUrl: "https://maritime.sh/docs/errors", requestId: "req_fake" });

export function fakeMaritime({ pageSize = 2, startReads = 1, start = () => undefined, answer = () => undefined } = {}) {
	/** id -> { sandbox, reads, commands: Map } */
	const sandboxes = new Map();
	const commands = new Map();
	const calls = [];
	let next = 0;

	const add = ({ name, metadata = {}, state = "running", from = "base", vcpu = 2, memoryMib = 4096 } = {}) => {
		const n = ++next;
		const id = `sbx-${String(n).padStart(12, "0")}`;
		const sandbox = {
			id,
			name: name ?? null,
			state,
			size: "custom",
			resources: { vcpu, memoryMib, diskGib: 10 },
			from,
			screen: "none",
			network: { egress: "all" },
			keepAwake: false,
			lifecycle: null,
			dataPlaneUrl: `https://api-${id}.sb.mtm.sh/v1`,
			secret: `fake-test-key-plane-${n}`,
			metadata,
			createdAt: new Date().toISOString(),
			endedAt: null,
			endedReason: null,
			pausedReason: null,
		};
		sandboxes.set(id, { sandbox, reads: 0, body: undefined });
		return sandbox;
	};

	const byIdOrName = (key) => sandboxes.get(key) ?? [...sandboxes.values()].find(({ sandbox }) => sandbox.name === key && sandbox.state !== "ended");

	const end = (one, reason) => {
		one.sandbox.state = "ended";
		one.sandbox.endedAt = new Date().toISOString();
		one.sandbox.endedReason = reason;
		one.sandbox.secret = null;
		for (const command of commands.values()) {
			if (command.sandboxId === one.sandbox.id && command.state === "running") Object.assign(command, { state: "killed", signal: "SIGKILL", endedAt: new Date().toISOString() });
		}
	};

	/** The data plane of the VM whose host the URL names: its record, or a refusal. */
	const planeOf = (url, headers) => {
		const id = /^api-(.+)\.sb\.mtm\.sh$/.exec(url.hostname)?.[1];
		const one = id && sandboxes.get(id);
		if (!one) return { refused: refuse(404, "sandbox_not_found", "Sandbox not found") };
		if (one.sandbox.state === "ended") return { refused: refuse(410, "sandbox_ended", "The sandbox has ended") };
		if (headers["X-Maritime-Token"] !== one.sandbox.secret) return { refused: refuse(401, "unauthenticated", "Missing or invalid data plane token") };
		return { one };
	};

	const fetch = async (input, init = {}) => {
		const url = new URL(input);
		const method = init.method ?? "GET";
		const headers = init.headers ?? {};
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, host: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers });
		const said = await answer(method, url, body);
		if (said instanceof Response) return said;

		if (url.hostname.endsWith(".sb.mtm.sh")) {
			const { one, refused } = planeOf(url, headers);
			if (refused) return refused;
			const run = /^\/v1\/commands\/([^/]+)$/.exec(url.pathname);
			const kill = /^\/v1\/commands\/([^/]+)\/kill$/.exec(url.pathname);
			if (method === "POST" && url.pathname === "/v1/commands") {
				const id = `cmd-${String(++next).padStart(8, "0")}`;
				const command = { id, sandboxId: one.sandbox.id, cmd: body.cmd, cwd: body.cwd ?? "/root", background: body.background === true, state: "running", exitCode: null, signal: null, startedAt: new Date().toISOString(), endedAt: null, stdout: "", stderr: "", truncated: false, env: body.env ?? {} };
				commands.set(id, command);
				if (!command.background) Object.assign(command, { state: "exited", exitCode: 0, endedAt: new Date().toISOString() });
				else await start(one.sandbox, command);
				const { env: _env, ...shown } = command;
				return json(command.background ? 202 : 200, shown);
			}
			if (method === "GET" && run) {
				const command = commands.get(run[1]);
				if (command === undefined || command.sandboxId !== one.sandbox.id) return refuse(404, "resource_not_found", "Command not found");
				const { env: _env, ...shown } = command;
				return json(200, shown);
			}
			if (method === "POST" && kill) {
				const command = commands.get(kill[1]);
				if (command === undefined || command.sandboxId !== one.sandbox.id) return refuse(404, "resource_not_found", "Command not found");
				if (command.state === "running") Object.assign(command, { state: "killed", signal: body?.signal ?? "SIGTERM", endedAt: new Date().toISOString() });
				return json(200, command);
			}
			return refuse(404, "resource_not_found", `no route ${method} ${url.pathname}`);
		}

		if (headers.Authorization !== `Bearer ${KEY}`) return refuse(401, "unauthenticated", "Missing or invalid API key");
		const named = /^\/v1\/sandboxes\/([^/]+)$/.exec(url.pathname);
		if (method === "POST" && url.pathname === "/v1/sandboxes") {
			const live = body.name ? byIdOrName(body.name) : undefined;
			// openapi Create Sandbox: 201 a new one; 200 "the live one with the same name".
			if (live) return json(200, live.sandbox);
			const sandbox = add({ name: body.name, metadata: body.metadata ?? {}, state: "starting", from: body.from, vcpu: body.vcpu ?? 2, memoryMib: body.memoryMib ?? 4096 });
			Object.assign(sandbox, { keepAwake: body.keepAwake === true, network: body.network ?? { egress: "all" }, lifecycle: { idleTimeoutSeconds: 300, onIdle: "pause", timeLimitSeconds: body.timeLimitSeconds ?? null } });
			sandboxes.get(sandbox.id).body = body;
			return json(201, sandbox);
		}
		if (method === "GET" && url.pathname === "/v1/sandboxes") {
			const prefix = url.searchParams.get("namePrefix") ?? "";
			const all = [...sandboxes.values()].map(({ sandbox }) => sandbox).filter((one) => (one.name ?? "").startsWith(prefix));
			const from = Number(url.searchParams.get("cursor") ?? 0);
			const size = Math.min(pageSize, Number(url.searchParams.get("limit") ?? 50));
			const more = from + size < all.length;
			return json(200, { data: all.slice(from, from + size), nextCursor: more ? String(from + size) : null });
		}
		if (named && method === "GET") {
			const one = byIdOrName(decodeURIComponent(named[1]));
			if (one === undefined) return refuse(404, "sandbox_not_found", "Sandbox not found");
			if (one.sandbox.state === "starting" && ++one.reads >= startReads) one.sandbox.state = "running";
			return json(200, one.sandbox);
		}
		if (named && method === "DELETE") {
			const one = sandboxes.get(decodeURIComponent(named[1]));
			if (one === undefined) return refuse(404, "sandbox_not_found", "Sandbox not found");
			if (one.sandbox.state !== "ended") end(one, "killed");
			return json(200, one.sandbox);
		}
		return refuse(404, "resource_not_found", `no route ${method} ${url.pathname}`);
	};

	return {
		fetch,
		calls,
		sandboxes,
		commands,
		add,
		/** The VMs not ended. */
		live: () => [...sandboxes.values()].filter(({ sandbox }) => sandbox.state !== "ended").map(({ sandbox }) => sandbox.id),
		/** A command's end, as its process ended it. */
		exit(id, exitCode, { stdout = "", stderr = "" } = {}) {
			Object.assign(commands.get(id), { state: "exited", exitCode, stdout, stderr, endedAt: new Date().toISOString() });
		},
		/** Output a running command wrote so far. */
		write(id, { stdout = "", stderr = "" } = {}) {
			const command = commands.get(id);
			command.stdout += stdout;
			command.stderr += stderr;
		},
	};
}
