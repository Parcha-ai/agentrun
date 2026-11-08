// A fake provider of desktops and phones whose computers are records in memory, each answered in process by a
// ComputerClient, as a provider with daemon none answers: files in a map, a screen that paints the desktop fixture's
// window, input.actions that log to the running fixture's log as the fixture would, apps, a UI tree, extend and stream.
// `broken` names one behavior that is wrong, so each case of the extension is seen to fail. No Docker, no daemon, no X
// server, no phone.
import { deflateSync } from "node:zlib";
import { checkActions, checkLifetime, FIXTURE_APP_ID, FIXTURE_BUTTON, FIXTURE_COLORS, FIXTURE_WINDOW, fixtureAppLog } from "../dist/index.js";

const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message } });

const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
const ANDROID_GROUPS = ["files", "screen", "input.touch", "apps", "apps.install", "apps.ui_tree"];
const BACKGROUND = [40, 40, 40];
/** A phone's stock Settings app, and the color its screen is while it is in front. */
const SETTINGS_APP = "com.android.settings";
const SETTINGS_BACKGROUND = [30, 60, 90];

const chunk = (type, body) => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
};

/**
 * A PNG of the IHDR fields given, with idat as its one IDAT chunk's body (no IDAT when undefined). It need not decode:
 * the tests build broken and hostile images with it.
 */
export function pngOf({ width, height, depth = 8, colorType = 2, interlace = 0, idat }) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = depth;
	ihdr[9] = colorType;
	ihdr[12] = interlace;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		...(idat === undefined ? [] : [chunk("IDAT", idat)]),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** An RGB PNG of width x height, each pixel from color(x, y); odd rows use the Sub filter, so a reader must undo it. */
export function png(width, height, color) {
	const raw = Buffer.alloc(height * (width * 3 + 1));
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		const filter = y % 2;
		raw[row] = filter;
		for (let x = 0; x < width; x++) {
			const rgb = color(x, y);
			const left = x > 0 ? color(x - 1, y) : [0, 0, 0];
			for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = filter === 1 ? (rgb[c] - left[c]) & 0xff : rgb[c];
		}
	}
	return pngOf({ width, height, idat: deflateSync(raw) });
}

/** The shot a fake broken in its pixels gives: a valid IHDR for width x height, and no IDAT or one that is not zlib. */
const undecodable = (width, height, broken) => pngOf({ width, height, idat: broken === "screen-no-idat" ? undefined : Buffer.from("these bytes are not zlib") });

const inside = ([x, y], [rx, ry, rw, rh]) => x >= rx && y >= ry && x < rx + rw && y < ry + rh;
const shift = ([x, y], dx, dy = 0) => [x + dx, y + dy];

/**
 * The provider, and `made` (each computer's name and spec). Options: `kind` (desktop or android), `mode` (its daemon),
 * `groups`, `network`, `hello` (merged over the hello), `extend` and `stream` (whether those methods are there),
 * `maxLifetimeMs`, `chunk` (bytes a screen.shot or screen.read gives), and `broken`, one of: no-cap, screen-size,
 * screen-region, screen-colors, screen-no-idat, screen-corrupt-idat, screen-region-corrupt, click-offset, type-case,
 * no-precheck, no-stop, no-release, tap-offset, swipe-stuck, pinch-together, terminate-stays, tree-types, extend-noop,
 * extend-past-cap, extend-per-call, extend-shortens, stream-http, fixture-never-ready, screen-huge-size, screen-endless,
 * launch-hidden (apps.list says Settings is in front, and neither the screen nor the tree shows it).
 * `createMs` is how long each create takes on the clock, in turn (the last for every create after): a host slow to
 * start a computer. The lifetime counts from create's start, and a computer whose deadline passed before create
 * finished fails it as Docker's does, timeout.
 */
/**
 * The clock the fake devices and the group tests' runs share: it reads the wall clock plus whatever its sleeps skipped,
 * so a case that waits a minute on a deadline (lifetime.extend) waits no time in a test.
 */
export const testClock = (() => {
	let skipped = 0;
	return {
		now: () => Date.now() + skipped,
		sleep: async (ms) => {
			skipped += Math.max(0, ms);
		},
	};
})();

export function fakeDevices({
	clock = testClock,
	id = "fake-device",
	kind = "desktop",
	mode = kind === "desktop" ? "pid1" : "none",
	groups = kind === "desktop" ? DESKTOP_GROUPS : ANDROID_GROUPS,
	network = kind === "desktop" ? ["none"] : ["open"],
	hello = {},
	extend = true,
	stream = true,
	maxLifetimeMs = 2 * 60 * 60_000,
	createMs = [0],
	chunk = 4096,
	broken,
} = {}) {
	const os = kind === "desktop" ? "linux" : kind;
	const [width, height] = kind === "desktop" ? [320, 240] : [360, 640];
	const computers = new Map();
	const made = [];
	let next = 0;
	const capabilities = () => ({ kind, lifetime: "vendor", network, isolation: "vm", os, daemon: mode, groups, maxLifetimeMs });

	/** The in-process client of one computer. */
	function clientOf(c) {
		let closed = false;
		let pids = 0;
		const log = (event) => {
			const path = c.fixture?.log;
			if (path === undefined) return;
			c.files.set(path, Buffer.concat([c.files.get(path) ?? Buffer.alloc(0), Buffer.from(`${JSON.stringify(event)}\n`)]));
		};
		const desktopUp = () => kind === "desktop" && c.fixture !== undefined;
		const appUp = () => kind === "android" && c.fixture !== undefined && c.foreground === FIXTURE_APP_ID;
		const pointerAt = (at, button, count = 1) => {
			for (let i = 0; i < count; i++) {
				if (desktopUp() && inside(at, FIXTURE_WINDOW)) {
					log({ event: "down", button, at });
					log({ event: "up", button, at });
				}
			}
		};
		const finger = (pointer, phase, at) => appUp() && log({ event: "touch", pointer, phase, at });
		/** A button's press or release where the cursor is, as the fixture logs it when the cursor is over it. */
		const button = (event, name) => {
			if (event === "down") c.held.add(name);
			else c.held.delete(name);
			if (desktopUp() && inside(c.cursor, FIXTURE_WINDOW)) log({ event, button: name, at: c.cursor });
		};
		/** Settings in front, and shown: broken launch-hidden says it is in front and shows nothing of it. */
		const settingsShown = () => c.foreground === SETTINGS_APP && broken !== "launch-hidden";
		const screenColor = (x, y) => {
			if (settingsShown()) return SETTINGS_BACKGROUND;
			if (!desktopUp() || !inside([x, y], FIXTURE_WINDOW)) return BACKGROUND;
			const [, , w, h] = FIXTURE_WINDOW;
			const quadrant = (x < w / 2 ? 0 : 1) + (y < h / 2 ? 0 : 2);
			return [...FIXTURE_COLORS[broken === "screen-colors" ? 3 - quadrant : quadrant]];
		};

		/** Runs one action; a string is its failure in words. */
		const run = (action) => {
			const { type } = action;
			if (type === "move") {
				if (!inside(action.at, [0, 0, width, height])) return `${action.at} is outside the ${width}x${height} display`;
				c.cursor = action.at;
			} else if (type === "down" || type === "up") {
				button(type, action.button ?? "left");
			} else if (type === "click") {
				const at = action.at ?? c.cursor;
				pointerAt(broken === "click-offset" ? shift(at, 1) : at, action.button ?? "left", action.count ?? 1);
			} else if (type === "type") {
				const text = broken === "type-case" ? action.text.toLowerCase() : action.text;
				if (desktopUp()) for (const ch of text) log({ event: "text", text: ch });
			} else if (type === "key") {
				for (const key of action.keys) if (desktopUp()) log({ event: "key", key, down: true });
				const [only] = action.keys;
				if (action.keys.length === 1 && only.length === 1 && desktopUp()) log({ event: "text", text: only });
			} else if (type === "tap") {
				const at = broken === "tap-offset" ? shift(action.at, 5) : action.at;
				finger(0, "down", at);
				finger(0, "up", at);
			} else if (type === "swipe") {
				const [from, ...rest] = action.path;
				const to = broken === "swipe-stuck" ? from : rest.at(-1);
				finger(0, "down", from);
				finger(0, "move", [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
				finger(0, "up", to);
			} else if (type === "pinch") {
				const d = 20;
				const end = broken === "pinch-together" ? d / action.scale : d * action.scale;
				finger(0, "down", shift(action.at, -d));
				finger(1, "down", shift(action.at, d));
				finger(0, "up", shift(action.at, -end));
				finger(1, "up", shift(action.at, end));
			}
			return undefined;
		};

		const methods = {
			hello: () => ok({ version: "1.0.0", os, kind, arch: "amd64", groups, ...hello }),
			ping: () => ok({}),
			"exec.run": ({ argv }) => ok({ exitCode: 0, stdout: Buffer.from(argv[0] === "env" ? "PATH=/usr/bin:/bin\nHOME=/fake\n" : `${argv.slice(1).join(" ")}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false }),
			"files.mkdir": () => ok({}),
			"files.write": ({ path, data, offset }) => {
				const bytes = Buffer.from(data, "base64");
				const was = c.files.get(path) ?? Buffer.alloc(0);
				const whole = offset === undefined ? bytes : Buffer.concat([was.subarray(0, offset), bytes]);
				c.files.set(path, whole);
				return ok({ size: whole.length });
			},
			"files.read": ({ path, offset = 0, length = 512 * 1024 }) => {
				const bytes = c.files.get(path);
				if (bytes === undefined) return fail("not_found", `no file ${path}`);
				const data = bytes.subarray(offset, offset + length);
				return ok({ data: data.toString("base64"), eof: offset + data.length >= bytes.length, size: bytes.length });
			},
			"files.remove": ({ path }) => (c.files.delete(path) ? ok({}) : fail("not_found", `no file ${path}`)),
			"process.start": ({ argv }) => {
				const pid = `p${++pids}`;
				if (argv[0].endsWith("/computerd-fixture") && argv[1] === "--log" && c.files.has(argv[0])) {
					c.fixture = { log: argv[2], process: pid };
					if (broken !== "fixture-never-ready") log({ event: "ready" });
				}
				c.processes.set(pid, true);
				return ok({ id: pid, pid: 100 + pids });
			},
			"process.signal": ({ id }) => {
				c.processes.set(id, false);
				if (c.fixture?.process === id) c.fixture = undefined;
				return ok({});
			},
			"process.wait": ({ id }) => (c.processes.has(id) ? ok({ running: c.processes.get(id), exitCode: null, signal: c.processes.get(id) ? null : "KILL" }) : fail("not_found", `no process ${id}`)),
			"screen.shot": ({ region } = {}) => {
				const [x, y, w, h] = region && broken !== "screen-region" ? region : [0, 0, width, height];
				const bad = broken === "screen-no-idat" || broken === "screen-corrupt-idat" || (broken === "screen-region-corrupt" && region !== undefined);
				const bytes = bad ? undecodable(w, h, broken) : png(w, h, (px, py) => screenColor(x + px, y + py));
				c.shot = { id: `s${++next}`, bytes };
				const first = bytes.subarray(0, chunk);
				// Broken: screen-huge-size says the shot is 1 TiB; screen-endless says 1 MiB and never gives eof.
				if (broken === "screen-huge-size" || broken === "screen-endless") return ok({ id: c.shot.id, size: broken === "screen-huge-size" ? 2 ** 40 : 2 ** 20, data: first.toString("base64"), eof: false, width: w, height: h, scale: 1 });
				return ok({ id: c.shot.id, size: bytes.length, data: first.toString("base64"), eof: first.length >= bytes.length, width: broken === "screen-size" ? w + 1 : w, height: h, scale: 1 });
			},
			"screen.read": ({ id, offset }) => {
				if (c.shot?.id !== id) return fail("not_found", `no shot ${id}`);
				if (broken === "screen-endless") return ok({ data: Buffer.alloc(64 * 1024).toString("base64"), eof: false });
				const data = c.shot.bytes.subarray(offset, offset + chunk);
				return ok({ data: data.toString("base64"), eof: offset + data.length >= c.shot.bytes.length });
			},
			"input.actions": ({ actions }) => {
				const failed = broken === "no-precheck" ? undefined : checkActions(actions, groups, { pixelScroll: false });
				if (failed) return ok({ done: 0, failed });
				let done = 0;
				// What this batch pressed and has not released, released when it stops at a failure (broken: left held).
				const pressed = new Set();
				const release = () => {
					if (broken !== "no-release") for (const name of pressed) if (c.held.has(name)) button("up", name);
				};
				for (const [index, action] of actions.entries()) {
					// Broken: each action checked only as its turn comes, so what comes before a bad one runs.
					const bad = broken === "no-precheck" ? checkActions([action], groups) : undefined;
					if (bad) return ok({ done, failed: { ...bad, index } });
					const why = run(action);
					if (why === undefined) {
						done++;
						if (action.type === "down") pressed.add(action.button ?? "left");
					} else if (broken !== "no-stop") {
						release();
						return ok({ done, failed: { index, kind: "invalid", message: why } });
					}
				}
				return ok(broken === "no-stop" ? { done: actions.length } : { done });
			},
			"apps.list": () => ok({ apps: [...c.apps.values()], foreground: c.foreground }),
			"apps.install": ({ path }) => {
				if (!c.files.has(path)) return fail("not_found", `no file ${path}`);
				const app = { id: FIXTURE_APP_ID, name: "agentrun fixture", version: "1" };
				c.apps.set(app.id, app);
				return ok(app);
			},
			"apps.launch": ({ id }) => {
				if (!c.apps.has(id)) return fail("not_found", `no app ${id}`);
				c.foreground = id;
				c.fixture = { log: fixtureAppLog(id) };
				if (broken !== "fixture-never-ready") log({ event: "ready" });
				return ok({});
			},
			"apps.terminate": ({ id }) => {
				if (c.foreground === id && broken !== "terminate-stays") c.foreground = null;
				return ok({});
			},
			"apps.ui_tree": () => {
				const button = { role: "android.widget.Button", id: FIXTURE_BUTTON.id, text: FIXTURE_BUTTON.text, bounds: [20, 40, 200, 60], enabled: broken === "tree-types" ? "true" : true, clickable: true, children: [] };
				const row = (text, y) => ({ role: "android.widget.LinearLayout", bounds: [0, y, width, 40], enabled: true, clickable: true, children: [{ role: "android.widget.TextView", text, bounds: [10, y + 10, 200, 20], enabled: true, children: [] }] });
				const list = { role: "androidx.recyclerview.widget.RecyclerView", bounds: [0, 100, width, 200], enabled: true, scrollable: true, children: [row("Network & internet", 110), row("Display", 160)] };
				if (settingsShown()) return ok({ root: { role: "android.widget.FrameLayout", bounds: [0, 0, width, height], enabled: true, children: [list] }, nodes: 6, truncated: false });
				const children = c.foreground === FIXTURE_APP_ID ? [button] : [];
				return ok({ root: { role: "android.widget.FrameLayout", bounds: [0, 0, width, height], enabled: true, children }, nodes: 1 + children.length, truncated: false });
			},
		};

		return {
			async call(method, params, { signal } = {}) {
				if (closed) return fail("gone", "the connection was closed");
				if (signal?.aborted) return fail("aborted", `${method} was aborted`);
				if (!computers.has(c.ref.name) || clock.now() > c.deadline.getTime()) return fail("gone", `${c.ref.name} has ended`);
				const answer = methods[method];
				if (answer === undefined || (method !== "hello" && method !== "ping" && !declares(method))) return fail("unsupported", `${method} is not a method of this computer`);
				return answer(params ?? {});
			},
			close() {
				closed = true;
			},
		};
	}

	const GROUP_OF = { exec: "exec", files: "files", process: "processes", screen: "screen", apps: "apps" };
	function declares(method) {
		if (method === "input.actions") return groups.some((g) => g.startsWith("input."));
		if (method === "apps.install") return groups.includes("apps.install");
		if (method === "apps.ui_tree") return groups.includes("apps.ui_tree");
		return groups.includes(GROUP_OF[method.split(".")[0]]);
	}

	const provider = {
		id,
		version: "1.0.0",
		capabilities,
		check(spec) {
			const refusals = broken === "no-cap" ? (Number.isSafeInteger(spec.lifetimeMs) && spec.lifetimeMs > 0 ? [] : [{ field: "lifetimeMs", message: "lifetimeMs is required" }]) : checkLifetime(spec.lifetimeMs, capabilities());
			const asked = typeof spec.network === "string" ? spec.network : "allow";
			if (!network.includes(asked)) refusals.push({ field: "network", message: `network ${asked} is not offered` });
			return refusals;
		},
		async create(spec) {
			const refusals = provider.check(spec);
			if (refusals.length > 0) return fail("refused", refusals.map((r) => r.message).join("; "));
			const name = `${kind}-${++next}`;
			const created = clock.now();
			computers.set(name, {
				ref: { id: `id-${name}`, name },
				labels: { ...spec.labels },
				network: spec.network,
				created,
				deadline: new Date(created + spec.lifetimeMs),
				files: new Map(),
				processes: new Map(),
				// A phone comes with its stock Settings app, which apps.launch-terminate drives.
				apps: new Map(kind === "android" ? [["com.android.settings", { id: "com.android.settings", name: "Settings" }]] : []),
				foreground: null,
				cursor: [0, 0],
				held: new Set(),
			});
			made.push({ name, spec });
			const takes = createMs[Math.min(made.length - 1, createMs.length - 1)];
			await clock.sleep(takes);
			if (clock.now() >= created + spec.lifetimeMs) {
				computers.delete(name);
				return fail("timeout", `${name}'s lifetime of ${spec.lifetimeMs / 1000} s ended before create finished (it took ${takes / 1000} s)`);
			}
			return ok({ id: `id-${name}`, name });
		},
		async attach(ref) {
			const c = [...computers.values()].find((one) => one.ref.id === ref.id);
			return c ? ok({ ...c.ref, spec: { image: "fake", user: "2000:2000", network: c.network, deadline: c.deadline, kind } }) : fail("not_found", "no such computer");
		},
		async list(labels) {
			const found = [...computers.values()].filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v));
			return ok(found.map((c) => ({ ref: c.ref, labels: c.labels, deadline: c.deadline, state: clock.now() > c.deadline.getTime() ? "stopped" : "running", network: c.network })));
		},
		async network(ref) {
			const c = computers.get(ref.name);
			return c ? ok(c.network) : fail("not_found", `no computer ${ref.name}`);
		},
		async connect(ref) {
			const c = computers.get(ref.name);
			if (c === undefined) return fail("not_found", `no computer ${ref.name}`);
			if (clock.now() > c.deadline.getTime()) return fail("gone", `${ref.name} has ended`);
			const client = clientOf(c);
			const said = await client.call("hello", { client: "fake" });
			return ok({ client, hello: said.value, close: async () => client.close() });
		},
		async release(ref) {
			computers.delete(ref.name);
			return ok(undefined);
		},
	};
	if (extend) {
		provider.extend = async (ref, ttlMs) => {
			const c = computers.get(ref.name);
			if (c === undefined) return fail("not_found", `no computer ${ref.name}`);
			const at = clock.now() + ttlMs;
			// Broken: extend-per-call holds each ttlMs to the cap on its own, so extends move the deadline past created + cap.
			const past = broken === "extend-per-call" ? ttlMs > maxLifetimeMs : at > c.created + maxLifetimeMs;
			if (past && broken !== "extend-past-cap") return fail("refused", `a deadline ${ttlMs} ms from now is past this provider's cap of ${maxLifetimeMs} ms from create`);
			if (at < c.deadline.getTime() && broken !== "extend-shortens") return fail("refused", "a deadline earlier than the current one");
			if (broken !== "extend-noop") c.deadline = new Date(at);
			return ok({ deadline: new Date(at) });
		};
	}
	if (stream) {
		provider.stream = async (ref) => ok({ url: `${broken === "stream-http" ? "http" : "https"}://stream.example.test/${ref.name}?token=fake` });
	}
	return { provider, made };
}

/** fetch for the stream case: 200 for the fake's stream host, 404 for anything else; no network. */
export const fakeFetch = async (url) => ({ status: new URL(url).host === "stream.example.test" ? 200 : 404 });
