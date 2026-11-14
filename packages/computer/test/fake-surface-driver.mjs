// A fake computer for the surface: a ComputerClient whose methods answer from one in-memory app (a Notes window with a
// title field, a body and a Save button), its screen a fixed PNG, its input recorded. Every call is logged.
import { Buffer } from "node:buffer";

/** A 2×1 PNG, base64: what the fake screen shows. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+Rq+X4QAAAAASUVORK5CYII=";

/**
 * hello: the groups to declare (default a Mac with ui), and a Linux desktop's display. split: how many bytes of the PNG
 * screen.shot sends before screen.read must fetch the rest.
 */
export function fakeComputer({ groups = ["exec", "files", "screen", "input.pointer", "input.keys", "apps", "ui"], features = { "ui.image": true, "apps.background": true }, os = "macos", kind = "desktop", display, split } = {}) {
	const calls = [];
	let seq = 1;
	let saved = false;
	let title = "";
	const files = new Map();
	const nodes = () => [
		{ ref: "@e1", role: "window", name: "Notes", bounds: [0, 0, 800, 600] },
		{ ref: "@e2", role: "textbox", name: "Title", value: title, bounds: [10, 10, 300, 24], parent: "@e1", flags: ["focused"] },
		{ ref: "@e3", role: "button", name: "Save", bounds: [700, 10, 80, 24], parent: "@e1" },
		...(saved ? [{ ref: "@e4", role: "text", name: "Saved", bounds: [10, 560, 100, 20], parent: "@e1" }] : []),
	];
	const png = Buffer.from(PNG, "base64");
	const handlers = {
		"ui.observe": (params) => ({
			state: `s${seq}`,
			app: { id: params.target?.app ?? "com.apple.Notes", name: "Notes" },
			window: { id: "w1", title: "Untitled", bounds: [100, 100, 800, 600] },
			nodes: nodes(),
			truncated: false,
			...(params.image ? { image: { format: "png", data: PNG, width: 2, height: 1 } } : {}),
		}),
		"ui.act": (params) => {
			const steps = [];
			for (const step of params.steps) {
				if ("press" in step && step.press === "@e3") {
					saved = true;
					steps.push({ route: "semantic", verified: true });
				} else if ("set" in step && step.set === "@e2") {
					title = step.value;
					steps.push({ route: "semantic", verified: true });
				} else if ("click" in step && Array.isArray(step.click)) {
					if (params.state !== `s${seq}`) {
						steps.push({ error: { kind: "stale", message: `the window changed since ${params.state ?? "no state"}` } });
						break;
					}
					steps.push({ route: "background", verified: false });
				} else if (Object.values(step).some((value) => typeof value === "string" && value.startsWith("@") && !["@e1", "@e2", "@e3", "@e4"].includes(value))) {
					steps.push({ error: { kind: "stale", message: "that element is gone" } });
					break;
				} else steps.push({ route: "background", verified: false });
			}
			seq += 1;
			const refused = steps.some((step) => "error" in step);
			const expect = params.expect && !refused ? (nodes().some((node) => node.name === params.expect.text) !== Boolean(params.expect.gone) ? "met" : "unmet") : undefined;
			return { steps, state: `s${seq}`, changed: params.steps.length > 0, ...(expect ? { expect } : {}) };
		},
		"screen.shot": () => {
			const first = split === undefined ? png : png.subarray(0, split);
			return { id: "shot1", size: png.length, data: first.toString("base64"), eof: split === undefined, width: 1440, height: 900, scale: 2 };
		},
		"screen.read": (params) => ({ data: png.subarray(params.offset).toString("base64"), eof: true }),
		"input.actions": (params) => {
			const bad = params.actions.findIndex((action) => action.type === "pinch");
			return bad >= 0 ? { done: bad, failed: { index: bad, kind: "unsupported", message: "no pinch here" } } : { done: params.actions.length };
		},
		"apps.list": () => ({ apps: [{ id: "com.apple.Notes", name: "Notes", version: "4" }], foreground: "com.apple.Notes" }),
		"apps.launch": () => ({}),
		"exec.run": (params) => ({ exitCode: 0, stdout: Buffer.from(params.argv.join(" ")).toString("base64"), stderr: "", timedOut: false, truncated: false }),
		"process.start": () => ({ id: "p1", pid: 4242 }),
		"files.write": (params) => {
			const bytes = Buffer.from(params.data, "base64");
			const before = params.offset ? files.get(params.path).subarray(0, params.offset) : Buffer.alloc(0);
			files.set(params.path, Buffer.concat([before, bytes]));
			return { size: files.get(params.path).length };
		},
		"files.read": (params) => {
			const bytes = files.get(params.path);
			if (!bytes) return { error: { code: "not_found", message: `${params.path} does not exist` } };
			const part = bytes.subarray(params.offset ?? 0, (params.offset ?? 0) + (params.length ?? bytes.length));
			return { data: part.toString("base64"), eof: (params.offset ?? 0) + part.length >= bytes.length, size: bytes.length };
		},
		"files.stat": (params) => (files.has(params.path) ? { type: "file", size: files.get(params.path).length, mode: 0o644, mtimeMs: 1, uid: 0, gid: 0 } : { error: { code: "not_found", message: `${params.path} does not exist` } }),
		"files.list": () => ({ entries: [...files.entries()].map(([path, bytes]) => ({ path, type: "file", size: bytes.length, mode: 0o644, mtimeMs: 1, uid: 0, gid: 0 })), truncated: false }),
	};
	const client = {
		async call(method, params, options = {}) {
			calls.push({ method, params });
			if (options.signal?.aborted) return { ok: false, error: { code: "aborted", message: `${method} was aborted` } };
			const handler = handlers[method];
			if (!handler) return { ok: false, error: { code: "unsupported", message: `the fake has no ${method}` } };
			const value = handler(params);
			return value && value.error ? { ok: false, error: value.error } : { ok: true, value };
		},
		close() {},
	};
	const hello = { protocol: "0.2", version: "fake", os, kind, arch: "arm64", groups, ...(display ? { display } : {}), screen: { width: 1440, height: 900, scale: 2 }, features };
	return { client, hello, calls, files };
}
