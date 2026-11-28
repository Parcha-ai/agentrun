// A stand-in for Vercel Sandbox's REST API (https://api.vercel.com), as a fetch that answers in the shapes of Vercel's
// own client (@vercel/sandbox 5.0.0, api-client/api-client.ts and validators.ts): sandboxes by name in one project of
// one team, each with the one session a non-persistent create starts; commands of a session, their output as an NDJSON
// log stream from the start ({stream, data} text lines, until the command ends), their stdin by offset, their kill, and
// the command read with its exitCode. The parts the docs leave open are this fake's guesses, each pinned as
// unverified in src/vercel.ts: a taken name answers 409; output is decoded as one UTF-8 stream per command, so a
// character the command writes in two pieces comes whole; a log stream holds silence for as long as the command runs.
//
// A command runs on backend.exec when a backend is given (fake-exec-host.mjs: real processes here, for the exec
// pre-check); else it is scripted: the test pushes its output and its exit (command(id).out / .exit).
export const TOKEN = "fake-test-key-vercel";
export const TEAM = "team_fake0123";
export const PROJECT = "prj_fake0123";
/** The most a session's timeout may reach: Pro's 24 hours (docs/sandbox/pricing). */
const CAP_MS = 24 * 60 * 60_000;

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status, code, message) => json(status, { error: { code, message } });

/**
 * The fake. split(bytes) cuts each log line's bytes into the body's chunks (default: one chunk a line); dropAfter ends
 * the first log stream with an error after that many lines, as a dropped connection does; pageSize is the listing's.
 */
export function fakeVercel({ backend, split = (bytes) => [bytes], dropAfter, pageSize = 2 } = {}) {
	const sandboxes = new Map();
	const commands = new Map();
	const calls = [];
	let next = 0;
	let drops = dropAfter === undefined ? 0 : 1;

	/** A command's record: its lines from the start, and whoever waits for the next one. */
	const recordOf = () => {
		const record = { lines: [], exitCode: null, written: 0, wake: () => {}, stdin: [], closed: false, killed: undefined };
		const add = (line) => {
			record.lines.push(line);
			record.wake();
		};
		record.out = (stream, data) => add({ stream, data });
		record.exit = (code) => {
			record.exitCode = code;
			record.wake();
		};
		return record;
	};
	// A command's process exists once its POST answers, as Vercel's does: stdin and kill wait on record.started.
	const run = async (record, name, argv) => {
		record.started = backend.exec(name, argv, { timeoutMs: 10_000 });
		const proc = await record.started;
		record.proc = proc;
		const pump = async (stream, name) => {
			const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
			for await (const chunk of stream) {
				const text = decoder.decode(chunk, { stream: true });
				if (text !== "") record.out(name, text);
			}
			const rest = decoder.decode();
			if (rest !== "") record.out(name, rest);
		};
		await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
		record.exit(await proc.wait());
	};
	/** The log stream from the start, until the command ends; a signal that aborts errors it, as a dropped fetch does. */
	const logs = (record, signal) => {
		const drop = drops-- > 0 ? dropAfter : Number.POSITIVE_INFINITY;
		const encoder = new TextEncoder();
		return ReadableStream.from(
			(async function* () {
				for (let at = 0; ; ) {
					while (at < record.lines.length) {
						if (at === drop) throw new Error("the connection dropped");
						yield* split(encoder.encode(`${JSON.stringify(record.lines[at++])}\n`));
					}
					if (record.exitCode !== null) return;
					await new Promise((wake, fail) => {
						record.wake = wake;
						signal?.addEventListener("abort", () => fail(signal.reason), { once: true });
					});
				}
			})(),
		);
	};

	const fetch = async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const query = Object.fromEntries(searchParams);
		calls.push({ method: init.method ?? "GET", path: pathname, query, body });
		if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return refuse(403, "forbidden", "Not authorized");
		if (query.teamId !== TEAM) return refuse(403, "forbidden", "Not a member of this team");
		const method = init.method ?? "GET";
		const named = /^\/v2\/sandboxes\/([^/]+)$/.exec(pathname);
		const cmd = /^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd(?:\/([^/]+)(\/logs|\/stdin|\/kill)?)?$/.exec(pathname);
		const extend = /^\/v2\/sandboxes\/sessions\/([^/]+)\/extend-timeout$/.exec(pathname);
		const bySession = (id) => [...sandboxes.values()].find((one) => one.session.id === id);
		if (method === "POST" && pathname === "/v3/sandboxes") {
			if (body.projectId !== PROJECT) return refuse(404, "not_found", "Project not found");
			if (sandboxes.has(body.name)) return refuse(409, "sandbox_already_exists", `A sandbox named ${body.name} already exists`);
			const tags = Object.entries(body.tags ?? {});
			if (tags.length > 5 || tags.some(([key, value]) => !/^[A-Za-z0-9._/-]{1,128}$/.test(key) || value.length > 256)) return refuse(400, "bad_request", "Invalid tags");
			const now = Date.now();
			const session = { id: `sbx_${++next}`, status: "running", timeout: body.timeout, requestedAt: now, startedAt: now, createdAt: now, memory: 2048 * body.resources.vcpus, vcpus: body.resources.vcpus, region: "iad1", cwd: "/", updatedAt: now };
			const sandbox = { name: body.name, persistent: body.persistent, status: "running", createdAt: now, updatedAt: now, currentSessionId: session.id, tags: body.tags, image: body.image };
			sandboxes.set(body.name, { sandbox, session, body });
			return json(200, { sandbox, session, routes: [] });
		}
		if (method === "GET" && pathname === "/v2/sandboxes") {
			const tag = query.tags?.split(":");
			const all = [...sandboxes.values()].map(({ sandbox }) => sandbox).filter((one) => one.name.startsWith(query.namePrefix ?? "") && (tag === undefined || one.tags?.[tag[0]] === tag.slice(1).join(":")));
			const from = Number(query.cursor ?? 0);
			const more = from + pageSize < all.length;
			return json(200, { sandboxes: all.slice(from, from + pageSize), pagination: { count: all.length, next: more ? String(from + pageSize) : null } });
		}
		if (named && (method === "GET" || method === "DELETE")) {
			const one = sandboxes.get(decodeURIComponent(named[1]));
			if (one === undefined) return refuse(404, "not_found", "Sandbox not found");
			if (method === "DELETE") sandboxes.delete(one.sandbox.name);
			return json(200, { sandbox: one.sandbox, ...(method === "GET" ? { session: one.session, routes: [] } : {}) });
		}
		if (extend && method === "POST") {
			const one = bySession(extend[1]);
			if (one === undefined) return refuse(404, "not_found", "Session not found");
			if (one.session.timeout + body.duration > CAP_MS) return refuse(400, "bad_request", "The timeout exceeds your plan's maximum");
			one.session.timeout += body.duration;
			return json(200, { session: one.session });
		}
		if (cmd) {
			const one = bySession(cmd[1]);
			if (one === undefined) return refuse(404, "not_found", "Session not found");
			if (method === "POST" && cmd[2] === undefined) {
				const id = `cmd_${++next}`;
				const record = recordOf();
				record.argv = [body.command, ...body.args];
				record.sudo = body.sudo;
				commands.set(id, record);
				if (backend) void run(record, one.sandbox.name, record.argv);
				return json(200, { command: { id, name: body.command, args: body.args, cwd: "/", sessionId: cmd[1], exitCode: null, startedAt: Date.now() } });
			}
			const record = commands.get(cmd[2]);
			if (record === undefined) return refuse(404, "not_found", "Command not found");
			const command = { id: cmd[2], name: record.argv[0], args: record.argv.slice(1), cwd: "/", sessionId: cmd[1], exitCode: record.exitCode, startedAt: 0 };
			if (method === "GET" && cmd[3] === undefined) return json(200, { command });
			if (method === "GET" && cmd[3] === "/logs") return new Response(logs(record, init.signal), { status: 200, headers: { "content-type": "application/x-ndjson" } });
			if (method === "POST" && cmd[3] === "/kill") {
				record.killed = body.signal;
				await record.started;
				await record.proc?.kill();
				if (!record.proc) record.exit(128 + body.signal);
				return json(200, { command });
			}
			if (method === "POST" && cmd[3] === "/stdin") {
				await record.started;
				if (record.exitCode !== null) return refuse(410, "command_finished", "The command has finished");
				const bytes = Buffer.from(body.data ?? "", "base64");
				// The offset makes a resend safe: bytes Vercel already has are skipped.
				const fresh = bytes.subarray(Math.max(0, record.written - body.offset));
				record.written += fresh.length;
				record.stdin.push(fresh);
				if (fresh.length > 0) await record.proc?.write(new Uint8Array(fresh));
				if (body.close) {
					record.closed = true;
					await record.proc?.end();
				}
				return json(200, { command, bytesWritten: record.written });
			}
		}
		return refuse(404, "not_found", `no route ${method} ${pathname}`);
	};
	return { fetch, calls, sandboxes, commands, command: (id) => commands.get(id) };
}
