// A stand-in for Groundbox's API, in memory: a fetch that records each call and answers what a route gives, and the
// commands of one sandbox as real processes on this machine. It keeps the API's own rules, so the host is held to
// them. The command stream (GET /v1/sandboxes/{id}/exec/stream, a WebSocket of JSON messages): the first message is
// `start` or `attach`; a resumable `start` runs `args` with no shell, in its own process group, answers `started` with
// its exec id, and keeps the command and its whole output when a socket goes; output comes as base64 with `seq`, the
// position just after each chunk; `attach` reads on from a position; a close with 1000 before the exit, and `kill`,
// end the command (as the image's user: here, whoever runs the tests); a message over 1 MiB closes the socket. The
// plain exec (POST /v1/sandboxes/{id}/exec): `args` with `stdin_base64` given whole, then its exit code and output.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** The API's bound on one message from the caller (MAX_FRAME_BYTES). */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * A fetch that records each call and answers what route(method, path, body, headers) gives: [status, json]. A route
 * that answers nothing is a 404 in the API's error shape.
 */
export function recorder(route) {
	const calls = [];
	const fetch = async (url, init) => {
		const { pathname, search } = new URL(url);
		const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : Buffer.from(init.body);
		const call = { method: init.method, path: `${pathname}${search}`, body, headers: init.headers };
		calls.push(call);
		const [status, json] = (await route(init.method, call.path, body, init.headers)) ?? [404, { error: { code: "not_found", message: "No such route" } }];
		return new Response(json === undefined ? null : JSON.stringify(json), { status });
	};
	return { calls, fetch };
}

/**
 * One sandbox's commands. webSocket is the factory the provider takes, and exec answers POST .../exec for a recorder's
 * route. opened lists what each socket was opened with and sent; commands holds each resumable command by its exec id.
 * drop() closes every open socket as a lost connection does (the commands run on). refuse, when set, refuses every
 * upgrade from then on: the socket errors and closes before it opens.
 */
export function fakeCommands() {
	const opened = [];
	const commands = new Map();
	const sockets = new Set();
	const state = { refuse: false };
	const killGroup = (command) => {
		if (command.exit !== undefined) return;
		try {
			process.kill(-command.child.pid, "SIGKILL");
		} catch {
			command.child.kill("SIGKILL");
		}
	};
	const begin = (message) => {
		const command = { id: `ex_${randomBytes(8).toString("hex")}`, args: message.args, records: [], total: 0, exit: undefined, followers: new Set() };
		command.child = spawn(message.args[0], message.args.slice(1), { detached: true, stdio: [message.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
		for (const stream of ["stdout", "stderr"]) {
			command.child[stream].on("data", (bytes) => {
				command.total += bytes.length;
				command.records.push({ stream, bytes, end: command.total });
				for (const follow of command.followers) follow();
			});
		}
		command.child.on("close", (code, signal) => {
			command.exit = code ?? 128 + (signal === "SIGKILL" ? 9 : 15);
			for (const follow of command.followers) follow();
		});
		commands.set(command.id, command);
		return command;
	};
	const webSocket = (url, init) => {
		const listeners = { open: [], message: [], close: [], error: [] };
		const emit = (type, event = {}) => {
			for (const listener of listeners[type]) listener(event);
		};
		const record = { url, headers: init.headers, sent: [], closed: undefined };
		opened.push(record);
		let readyState = 0;
		let command;
		let at = 0;
		const say = (message) => {
			if (readyState === 1) emit("message", { data: JSON.stringify(message) });
		};
		/** What the command has put out past `at`, then its exit: called again whenever there is more. */
		const follow = () => {
			if (readyState !== 1) return;
			for (const { stream, bytes, end } of command.records) {
				if (end <= at) continue;
				say({ type: stream, data: bytes.subarray(bytes.length - (end - at)).toString("base64"), seq: end });
				at = end;
			}
			if (command.exit !== undefined && at === command.total) {
				say({ type: "exit", exit_code: command.exit, duration_ms: 1, timed_out: false });
				close(1000, true);
			}
		};
		const close = (code, byServer = false) => {
			if (readyState === 3) return;
			readyState = 3;
			record.closed = code;
			sockets.delete(socket);
			command?.followers.delete(follow);
			// Closing on purpose ends the command; any other close leaves it running.
			if (!byServer && code === 1000 && command) killGroup(command);
			queueMicrotask(() => emit("close", { code }));
		};
		const socket = {
			get readyState() {
				return readyState;
			},
			bufferedAmount: 0,
			addEventListener: (type, listener) => listeners[type].push(listener),
			send(text) {
				if (readyState !== 1) throw new Error("the socket is not open");
				if (Buffer.byteLength(text) > MAX_FRAME_BYTES) return close(1009, true);
				const message = JSON.parse(text);
				record.sent.push(message);
				const refuse = (words, code = "bad_request") => {
					say({ type: "error", message: words, code });
					close(1000, true);
				};
				if (message.type === "start" || message.type === "attach") {
					if (command !== undefined) return refuse("The command was already started");
					if (message.type === "start") {
						if (!message.resumable || message.encoding !== "base64" || !Array.isArray(message.args)) return refuse("this stand-in runs resumable commands given as args, their output as base64");
						command = begin(message);
						queueMicrotask(() => {
							say({ type: "started", exec_id: command.id });
							command.followers.add(follow);
							follow();
						});
					} else {
						command = commands.get(message.exec_id);
						if (command === undefined) return refuse(`No command ${message.exec_id} in this sandbox`, "not_found");
						at = message.seq;
						command.followers.add(follow);
						queueMicrotask(follow);
					}
				} else if (command === undefined) refuse("Send start first");
				else if (message.type === "kill") killGroup(command);
			},
			close: (code) => close(code),
			drop: () => close(1006, true),
		};
		sockets.add(socket);
		queueMicrotask(() => {
			if (state.refuse) {
				emit("error", { message: "Received network error or non-101 status code." });
				return close(1006, true);
			}
			readyState = 1;
			emit("open");
		});
		return socket;
	};
	/** POST .../exec: args with stdin_base64 given whole; the answer once it has ended. */
	const exec = (body) =>
		new Promise((answer) => {
			const child = spawn(body.args[0], body.args.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
			const out = { stdout: [], stderr: [] };
			for (const stream of ["stdout", "stderr"]) child[stream].on("data", (bytes) => out[stream].push(bytes));
			child.stdin.on("error", () => {});
			child.stdin.end(Buffer.from(body.stdin_base64 ?? "", "base64"));
			child.on("close", (code) => answer([200, { exit_code: code ?? 137, stdout: Buffer.concat(out.stdout).toString(), stderr: Buffer.concat(out.stderr).toString(), duration_ms: 1, timed_out: false }]));
		});
	return {
		opened,
		commands,
		webSocket,
		exec,
		drop: () => {
			for (const socket of [...sockets]) socket.drop();
		},
		refuse: (on) => void (state.refuse = on),
		/** Ends every command still running: for a test's end. */
		stopAll: () => {
			for (const command of commands.values()) killGroup(command);
		},
	};
}
