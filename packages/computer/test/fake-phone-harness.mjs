// A fake of the phone harness's cloud (its HTTPS API, given to the provider as `fetch`) and of the cloud Android it
// rents (reached with adb, given to the provider as its `adb` runner). Nothing listens on a port and nothing waits on
// the wall clock: the API and the phone share `clock`, whose sleep() moves time on at once.
//
// The phone is a small Android: a launcher and the stock Settings app, with a top list that scrolls, a page per item
// (its title is the item's text), and a search screen whose field takes typed text. uiautomator dumps the screen as
// Android does, screencap gives raw RGBA as `adb exec-out screencap` does, and `input` taps, swipes, types and presses
// keys the way the provider sends them. Every adb call and every API request is recorded.

export const KEY = "fake-test-key";
export const SETTINGS = "com.android.settings";
/** Settings' search: another package, whose activity a live Android 15 puts on top of Settings' task (run 5). */
export const SEARCH_PKG = "com.android.settings.intelligence";
export const LAUNCHER = "com.google.android.apps.nexuslauncher";
/** Settings' search field's id, as phone probe 2 read it live: the platform's own SearchView text field. */
export const SEARCH_FIELD = "android:id/search_src_text";
export const ITEMS = [
	"Network & internet",
	"Connected devices",
	"Apps",
	"Notifications",
	"Battery",
	"Storage",
	"Sound & vibration",
	"Display",
	"Wallpaper & style",
	"Accessibility",
	"Security & privacy",
	"Location",
	"Passwords & accounts",
	"System",
];
export const SCREEN = { width: 360, height: 640 };
const HEADER = 96;
const ROW = 64;
/** The phone's adb endpoint and unlock code in the vendor's own shapes (OpenAPI SessionAdb): a DNS name, and ph_ with 26 base32 letters. */
export const ADB_HOST = "live.phone-harness.test";
export const ADB_CODE = "ph_mfwcc5nknqaod7a4nwojzw2lzq";

/** A clock whose sleep() moves time on at once: no test waits on the wall clock. */
export function fakeClock(start = Date.now()) {
	let now = start;
	return {
		now: () => now,
		sleep: async (ms) => {
			now += Math.max(0, ms);
		},
	};
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * The fake. Options: `readyAfter`, how many GETs a new session stays provisioning (default 1); `start`, what a create
 * meets ("ok", "busy", "limit", "credit", "error": the session fails while provisioning); `loseAnswer`, the POST is
 * admitted and then its answer is lost (fetch rejects); `others`, sessions on the account this provider never made;
 * `loseRecovery`, the GET that recovers a create by its key is lost too; `cancelPost`, called once a POST /sessions is
 * admitted (a test aborts the create's signal in it), after which that fetch rejects as an aborted one does; `stall`,
 * called with each request's { method, path }: when it answers true, the request is never answered, and only its
 * signal ends it;
 * `code`, the unlock code the phone takes (default the one the API gives); `abi`, what getprop reports; `launchHidden`,
 * a launched app is reported in front (dumpsys) while the screen and the tree still show the launcher; `launchNothing`,
 * `am start` starts nothing at all.
 *
 * Tasks are as a live Android 15 keeps them (run 5): Settings' search is another package's activity
 * (com.android.settings.intelligence) on top of Settings' own task. A force-stop of Settings leaves it there, a plain
 * `am start` of Settings resumes that task, search in front, and only `--activity-clear-task` starts Settings afresh.
 */
export function fakePhoneHarness({ readyAfter = 1, start = "ok", loseAnswer = false, loseRecovery = false, cancelPost, stall, others = [], code, abi = "x86_64", launchHidden = false, launchNothing = false, clock = fakeClock() } = {}) {
	const requests = [];
	const adbCalls = [];
	const sessions = new Map(others.map((s) => [s.id, { ...s }]));
	let next = 0;

	async function fetch(url, init = {}) {
		const u = new URL(url);
		const method = init.method ?? "GET";
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		requests.push({ method, path: u.pathname, headers, body });
		if (stall?.({ method, path: u.pathname })) {
			// A request that never answers: only its signal ends it, as an aborted fetch rejects.
			return new Promise((_, reject) => {
				const stop = () => reject(init.signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
				if (init.signal?.aborted) stop();
				else init.signal?.addEventListener("abort", stop, { once: true });
			});
		}
		if (headers.authorization !== `Bearer ${KEY}`) return json(401, { error: "invalid API key" });
		const path = u.pathname;
		if (method === "GET" && path === "/me") return json(200, { id: "acct_1", available: [] });
		if (method === "POST" && path === "/sessions") {
			const key = headers["idempotency-key"];
			if (!/^[A-Za-z0-9_-]{16,128}$/.test(key ?? "")) return json(400, { error: "bad Idempotency-Key" });
			if (start === "busy") return json(503, { error: "every phone is busy", code: "phones_busy", retry_after_seconds: 30 }, { "retry-after": "30" });
			if (start === "limit") return json(409, { error: "the account's sessions are full", code: "session_limit", session_limit: 1 });
			if (start === "credit") return json(403, { error: "insufficient credits", balance_cents: 0 });
			const id = `sess_${(++next).toString().padStart(4, "0")}`;
			const session = {
				id,
				state: "provisioning",
				platform: body?.platform ?? "android",
				kind: body?.kind ?? "emulator",
				timeout_seconds: body?.timeout_seconds ?? 300,
				expires_at: clock.now() / 1000 + (body?.timeout_seconds ?? 300),
				request_key: key,
				screen: null,
				gets: 0,
			};
			sessions.set(id, session);
			if (loseAnswer) throw new TypeError("fetch failed: the connection was reset");
			if (cancelPost) {
				// The caller cancels once the service has admitted the request: fetch rejects as it does on an abort.
				cancelPost();
				if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
			}
			return json(202, view(session));
		}
		if (method === "GET" && path === "/sessions") return json(200, [...sessions.values()].map(view));
		const byKey = /^\/sessions\/requests\/([^/]+)$/.exec(path);
		if (method === "GET" && byKey) {
			if (loseRecovery) throw new TypeError("fetch failed: the connection was reset");
			const found = [...sessions.values()].find((s) => s.request_key === byKey[1]);
			return found ? json(200, view(found)) : json(404, { error: "no such request" });
		}
		const adb = /^\/sessions\/([^/]+)\/adb$/.exec(path);
		if (method === "POST" && adb) {
			const s = sessions.get(adb[1]);
			if (!s) return json(404, { error: "no such session" });
			// The vendor's AdbConnection, unwrapped: 201, enabled, transport, host, port, code, expires_at.
			return json(201, { enabled: true, transport: "adb", host: ADB_HOST, port: 22220 + Number(s.id.slice(5)), code: ADB_CODE, expires_at: s.expires_at });
		}
		const one = /^\/sessions\/([^/]+)$/.exec(path);
		if (one) {
			const s = sessions.get(one[1]);
			if (!s) return json(404, { error: "no such session" });
			if (method === "DELETE") {
				sessions.delete(s.id);
				return json(200, { ...view(s), state: "closing" });
			}
			if (method === "GET") {
				if (s.state === "provisioning" && ++s.gets >= readyAfter) {
					if (start === "error") s.state = "error";
					else Object.assign(s, { state: "ready", screen: { w: SCREEN.width, h: SCREEN.height } });
				}
				if (s.state === "error") s.error = "the emulator did not boot";
				return json(200, view(s));
			}
		}
		return json(404, { error: `no route ${method} ${path}` });
	}

	const view = ({ gets, ...s }) => ({ ...s, ...(s.state === "provisioning" ? { progress: { phase: "booting" } } : {}) });

	// --- the phone ---------------------------------------------------------------------------------------------------
	/** touches: each `input motionevent` the phone took, with the clock's time it took it. */
	const phone = { connected: new Set(), unlocked: new Set(), foreground: LAUNCHER, running: new Set([LAUNCHER]), screen: "top", offset: 0, page: "", search: "", touches: [] };
	const expected = code ?? ADB_CODE;
	const maxOffset = Math.max(0, HEADER + ROW * ITEMS.length - SCREEN.height);

	function settingsReset() {
		Object.assign(phone, { screen: "top", offset: 0, page: "", search: "" });
	}

	/** The nodes on screen now, as [role, attributes, children] trees in screen pixels. */
	function nodes() {
		const node = (cls, attrs, children = []) => ({ cls, attrs: { text: "", "resource-id": "", "content-desc": "", clickable: "false", focused: "false", scrollable: "false", enabled: "true", ...attrs }, children });
		const box = ([x, y, w, h]) => `[${x},${y}][${x + w},${y + h}]`;
		const full = [0, 0, SCREEN.width, SCREEN.height];
		if (phone.foreground === LAUNCHER || launchHidden) {
			return node("android.widget.FrameLayout", { bounds: box(full), package: LAUNCHER }, [node("android.widget.TextView", { text: "Settings", "content-desc": "Settings", clickable: "true", bounds: box([20, 500, 80, 80]), package: LAUNCHER })]);
		}
		const pkg = { package: SETTINGS };
		if (phone.screen === "top") {
			const rows = [];
			for (const [i, title] of ITEMS.entries()) {
				const y = HEADER + i * ROW - phone.offset;
				if (y < HEADER || y + ROW > SCREEN.height) continue;
				rows.push(node("android.widget.LinearLayout", { clickable: "true", bounds: box([0, y, SCREEN.width, ROW]), ...pkg }, [node("android.widget.TextView", { text: title, "resource-id": "android:id/title", bounds: box([72, y + 16, 240, 32]), ...pkg })]));
			}
			// As a live Android 15 Settings shows it (run 4): the search entry is the list's first item, a clickable bar
			// whose text is on a child, inside the scrollable list beside the rows.
			const search = node("android.widget.LinearLayout", { "resource-id": "com.android.settings:id/search_action_bar", clickable: "true", bounds: box([16, 24, 328, 56]), ...pkg }, [
				node("android.widget.TextView", { text: "Search settings", "resource-id": "com.android.settings:id/search_action_bar_title", bounds: box([72, 40, 200, 24]), ...pkg }),
			]);
			return node("android.widget.FrameLayout", { bounds: box(full), ...pkg }, [
				node("androidx.recyclerview.widget.RecyclerView", { scrollable: "true", bounds: box([0, 16, SCREEN.width, SCREEN.height - 16]), ...pkg }, [search, ...rows]),
			]);
		}
		if (phone.screen === "page") {
			return node("android.widget.FrameLayout", { bounds: box(full), ...pkg }, [
				node("android.widget.ImageButton", { "content-desc": "Navigate up", clickable: "true", bounds: box([0, 16, 56, 56]), ...pkg }),
				node("android.widget.TextView", { text: phone.page, "resource-id": "com.android.settings:id/collapsing_toolbar", bounds: box([72, 24, 260, 40]), ...pkg }),
			]);
		}
		// As phone probe 2 read it live: a SearchView holding an AutoCompleteTextView, focused, in Settings' search package.
		const search = { package: SEARCH_PKG };
		return node("android.widget.FrameLayout", { bounds: box(full), ...search }, [
			node("android.widget.SearchView", { "resource-id": "com.android.settings.intelligence:id/search_view", bounds: box([48, 16, 304, 56]), ...search }, [
				node("android.widget.AutoCompleteTextView", { text: phone.search, "resource-id": SEARCH_FIELD, focused: "true", clickable: "true", bounds: box([56, 16, 288, 56]), ...search }),
			]),
		]);
	}

	const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	function dump() {
		let index = 0;
		const write = (n) => {
			const attrs = Object.entries({ index: String(index++), class: n.cls, ...n.attrs, checkable: "false", checked: "false", focusable: n.attrs.clickable, "long-clickable": "false", password: "false", selected: "false" })
				.map(([k, v]) => `${k}="${escape(v)}"`)
				.join(" ");
			return n.children.length === 0 ? `<node ${attrs} />` : `<node ${attrs}>${n.children.map(write).join("")}</node>`;
		};
		return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${write(nodes())}</hierarchy>\nUI hierchary dumped to: /dev/tty\n`;
	}

	function hit(x, y) {
		const found = [];
		const walk = (n) => {
			const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(n.attrs.bounds);
			if (m && n.attrs.clickable === "true" && x >= +m[1] && x < +m[3] && y >= +m[2] && y < +m[4]) found.push(n);
			for (const c of n.children) walk(c);
		};
		walk(nodes());
		return found.at(-1);
	}

	function tap(x, y) {
		const n = hit(x, y);
		if (!n) return;
		if (phone.foreground === LAUNCHER) return launch(SETTINGS);
		// Search is another package's activity, put on top of Settings' own task.
		if (phone.screen === "top" && n.attrs["resource-id"] === "com.android.settings:id/search_action_bar") return Object.assign(phone, { screen: "search", search: "", foreground: SEARCH_PKG });
		if (phone.screen === "top" && n.cls === "android.widget.LinearLayout") return Object.assign(phone, { screen: "page", page: n.children[0].attrs.text });
		if (phone.screen === "page" && n.attrs["content-desc"] === "Navigate up") phone.screen = "top";
	}

	function back() {
		if (phone.foreground === SEARCH_PKG && phone.screen === "search") Object.assign(phone, { screen: "top", foreground: SETTINGS });
		else if (phone.foreground === SETTINGS && phone.screen !== "top") phone.screen = "top";
		else phone.foreground = LAUNCHER;
	}

	/**
	 * `am start` of pkg: it resumes the app's task, so Settings' task with search on top comes back with search in front;
	 * clear (--activity-clear-task) starts the app's task afresh.
	 */
	function launch(pkg, clear = false) {
		if (pkg === SETTINGS && (clear || (!phone.running.has(SETTINGS) && phone.screen !== "search"))) settingsReset();
		phone.running.add(pkg);
		phone.foreground = pkg === SETTINGS && phone.screen === "search" ? SEARCH_PKG : pkg;
	}

	/** The words of a shell command, as the device's sh splits it: single quotes kept together. */
	function words(command) {
		const out = [];
		for (const m of command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2]);
		return out;
	}

	const KEYS = { KEYCODE_HOME: () => (phone.foreground = LAUNCHER), KEYCODE_BACK: back, KEYCODE_APP_SWITCH: () => {}, KEYCODE_DEL: () => (phone.search = phone.search.slice(0, -1)) };

	function shell(command) {
		const ok = (stdout = "") => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: "" });
		// A chain of commands, as sh runs `a;b`: each in turn (the fake splits only a chain with no quoted words).
		if (command.includes(";") && !command.includes("'")) {
			let out = "";
			for (const part of command.split(";")) {
				const one = shell(part.trim());
				if (one.exitCode !== 0) return one;
				out += one.stdout.toString("utf8");
			}
			return ok(out);
		}
		const w = words(command);
		// toybox's sleep takes a decimal fraction of a second; it moves the shared clock on, as every wait here does.
		if (w[0] === "sleep" && /^\d+(\.\d+)?$/.test(w[1] ?? "")) {
			clock.sleep(Math.round(Number(w[1]) * 1000));
			return ok();
		}
		if (w[0] === "echo") return ok(`${w.slice(1).join(" ")}\n`);
		if (w[0] === "unlock") {
			if (w[1] !== expected) return ok("wrong code\n");
			phone.unlockedNow = true;
			return ok("unlocked\n");
		}
		if (w[0] === "getprop" && w[1] === "ro.product.cpu.abi") return ok(`${abi}\n`);
		if (w[0] === "wm" && w[1] === "size") return ok(`Physical size: ${SCREEN.width}x${SCREEN.height}\n`);
		if (w[0] === "wm" && w[1] === "density") return ok("Physical density: 160\n");
		if (w[0] === "input" && w[1] === "tap") {
			tap(Number(w[2]), Number(w[3]));
			return ok();
		}
		if (w[0] === "input" && w[1] === "swipe") {
			const [x1, y1, x2, y2] = w.slice(2, 6).map(Number);
			if (Math.abs(y1 - y2) < 10 && Math.abs(x1 - x2) < 10) return ok(); // a long press
			if (phone.foreground === SETTINGS && phone.screen === "top") phone.offset = Math.min(maxOffset, Math.max(0, phone.offset + (y1 - y2)));
			return ok();
		}
		if (w[0] === "input" && w[1] === "motionevent") {
			phone.touches.push({ action: w[2], at: [Number(w[3]), Number(w[4])], ms: clock.now() });
			return ok();
		}
		if (w[0] === "input" && w[1] === "text") {
			if (phone.foreground === SEARCH_PKG && phone.screen === "search") phone.search += w[2].replaceAll("%s", " ");
			return ok();
		}
		if (w[0] === "input" && w[1] === "keyevent") {
			const k = w[2];
			if (KEYS[k]) KEYS[k]();
			else if (/^KEYCODE_[A-Z0-9]$/.test(k) && phone.foreground === SEARCH_PKG && phone.screen === "search") phone.search += k.slice(8).toLowerCase();
			return ok();
		}
		if (w[0] === "pm" && w[1] === "list" && w[2] === "packages") return ok([SETTINGS, LAUNCHER, "com.android.chrome"].map((p) => `package:${p}`).join("\n") + "\n");
		if (w[0] === "cmd" && w[1] === "package" && w[2] === "resolve-activity") {
			const pkg = w.at(-1);
			if (pkg === SETTINGS) return ok("priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.settings/.Settings\n");
			return ok("No activity found\n");
		}
		if (w[0] === "am" && w[1] === "start") {
			const comp = w.at(-1);
			if (!launchNothing) launch(comp.split("/")[0], w.includes("--activity-clear-task"));
			return ok("Starting: Intent { cmp=" + comp + " }\nStatus: ok\n");
		}
		if (w[0] === "am" && w[1] === "force-stop") {
			phone.running.delete(w[2]);
			// Settings' own activities go; search, another package's activity on top of its task, stays there.
			if (w[2] === SETTINGS && phone.screen !== "search") settingsReset();
			if (phone.foreground === w[2] || (w[2] === SETTINGS && phone.foreground === SEARCH_PKG)) phone.foreground = LAUNCHER;
			return ok();
		}
		if (w[0] === "dumpsys" && w[1] === "activity" && w[2] === "activities") {
			return ok(`  topResumedActivity=ActivityRecord{1a2b3c u0 ${phone.foreground}/.Main t7}\n`);
		}
		return { exitCode: 127, stdout: Buffer.alloc(0), stderr: `/system/bin/sh: ${w[0]}: inaccessible or not found\n` };
	}

	function screencap() {
		const header = Buffer.alloc(16);
		header.writeUInt32LE(SCREEN.width, 0);
		header.writeUInt32LE(SCREEN.height, 4);
		header.writeUInt32LE(1, 8);
		header.writeUInt32LE(0, 12);
		const pixels = Buffer.alloc(SCREEN.width * SCREEN.height * 4);
		for (let i = 0; i < pixels.length; i += 4) pixels.set([phone.foreground !== LAUNCHER && !launchHidden ? 30 : 200, 60, 90, 255], i);
		return Buffer.concat([header, pixels]);
	}

	// --- adb: the spawned CLI (run, every argv recorded) and the local adb server's socket protocol (server) --------------
	/** Each connected endpoint's transport id, as `adb devices -l` names it. */
	const transports = new Map();
	let nextTransport = 0;
	/** Every shell command the phone ran, from an argv or from stdin, in order. */
	const ran = [];
	const result = (stdout, exitCode = 0, stderr = "") => ({ ok: true, value: { exitCode, stdout: Buffer.from(stdout), stderr } });
	/** What a locked connection answers every shell, in the vendor's words (phone probe 1, 2026-11-08). */
	const LOCKED = "locked: run `adb shell unlock <code>` first\n";

	/**
	 * The adb server's one TCP transport per endpoint: a second connect reuses it, with its lock state, as the live run
	 * showed ("already connected to …"). The vendor's lock is per TCP connection, so a reused transport is still unlocked.
	 */
	function connectTo(endpoint) {
		if (phone.connected.has(endpoint)) return `already connected to ${endpoint}`;
		phone.connected.add(endpoint);
		if (!transports.has(endpoint)) transports.set(endpoint, String(++nextTransport));
		return `connected to ${endpoint}`;
	}
	function disconnectFrom(endpoint) {
		phone.connected.delete(endpoint);
		phone.unlocked.delete(endpoint);
		transports.delete(endpoint);
		return `disconnected ${endpoint}`;
	}

	/**
	 * One shell service on the phone at serial, by its command string, as the vendor's endpoint answers it (docs,
	 * guides/connect-adb): until the connection is unlocked by the command `unlock <code>`, every shell answers `locked`.
	 */
	function shellOn(serial, command) {
		ran.push(command);
		if (!phone.unlocked.has(serial) && !/^unlock /.test(command)) return result(LOCKED);
		// Once unlocked, the vendor's endpoint passes every shell through, `unlock` included, to the phone's own sh, which
		// has no such command (live run 4).
		if (phone.unlocked.has(serial) && /^unlock /.test(command)) return result("/system/bin/sh: unlock: inaccessible or not found\n", 127);
		const out = shell(command);
		if (phone.unlockedNow) {
			phone.unlocked.add(serial);
			phone.unlockedNow = false;
		}
		return { ok: true, value: out };
	}

	/** The spawned adb CLI: args (each recorded, as /proc would show them), and stdin when given. */
	async function run(args, options = {}) {
		adbCalls.push({ args: [...args], timeoutMs: options.timeoutMs, input: options.input });
		if (args[0] === "start-server") return result("");
		// The old ways to name a device and to connect, by argv.
		if (args[0] === "connect") return result(`${connectTo(args[1])}\n`);
		if (args[0] === "disconnect") return result(`${disconnectFrom(args[1])}\n`);
		let serial;
		if (args[0] === "-s") serial = args[1];
		else if (args[0] === "-t") serial = [...transports].find(([, id]) => id === args[1])?.[0];
		else return result("", 1, "adb: usage");
		if (serial === undefined || !phone.connected.has(serial)) return result("", 1, `adb: device '${args[1]}' not found`);
		const rest = args.slice(2);
		if (rest[0] === "exec-out" && rest[1] === "screencap") return result(screencap());
		if (rest[0] === "exec-out" && rest[1] === "uiautomator dump /dev/tty") return result(dump());
		if (rest[0] !== "shell") return result("", 1, "adb: unknown command");
		// adb shell -T with no command: a shell service with no command string, which a locked connection answers
		// `locked` without reading stdin; an unlocked one runs stdin's lines.
		if (rest[1] === "-T" && rest.length === 2) {
			ran.push(`(stdin) ${String(options.input ?? "").split("\n")[0].split(" ")[0]}`);
			if (!phone.unlocked.has(serial)) return result(LOCKED);
			let out = "";
			for (const line of String(options.input ?? "").split("\n")) {
				if (line.trim() === "" || line.trim() === "exit") continue;
				const one = shellOn(serial, line);
				out += one.value.stdout.toString("utf8");
			}
			return result(out);
		}
		return shellOn(serial, rest.slice(1).join(" "));
	}

	/**
	 * The local adb server, by its socket protocol: host:connect:<endpoint>, host:disconnect:<endpoint>, host:devices-l;
	 * and with { transport }, a socket bound to that phone first (host:transport-id:<id>), then a shell service with its
	 * command string (shell:<command>, or shell,v2,raw:<command>), answered with the command's output.
	 */
	async function server(service, options = {}) {
		serverCalls.push(options.transport === undefined ? service : `host:transport-id:${options.transport} ${service.replace(/unlock \S+/, "unlock [code]")}`);
		if (options.transport !== undefined) {
			const serial = [...transports].find(([, id]) => id === options.transport)?.[0];
			if (serial === undefined || !phone.connected.has(serial)) return { ok: false, error: { code: "phone", message: `the adb server refused host:transport-id: device not found` } };
			const shellService = /^shell(?:,v2)?(?:,raw)?:(.*)$/s.exec(service);
			if (!shellService) return { ok: false, error: { code: "phone", message: `the adb server does not know ${service.split(":")[0]}` } };
			const ran = shellOn(serial, shellService[1]);
			return { ok: true, value: ran.value.stdout.toString("utf8") };
		}
		const connect = /^host:connect:(.+)$/.exec(service);
		if (connect) return { ok: true, value: connectTo(connect[1]) };
		const disconnect = /^host:disconnect:(.+)$/.exec(service);
		if (disconnect) return { ok: true, value: disconnectFrom(disconnect[1]) };
		if (service === "host:devices-l") {
			return { ok: true, value: [...transports].map(([endpoint, id]) => `${endpoint}          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:${id}\n`).join("") };
		}
		return { ok: false, error: { code: "phone", message: `the adb server does not know ${service}` } };
	}
	const serverCalls = [];

	/** The provider's adb: callable as the old runner, and the transport (run, server). */
	const adb = Object.assign((args, options) => run(args, options), { run, server });

	return {
		fetch,
		adb,
		clock,
		phone,
		sessions,
		/** Every API request, as { method, path, headers, body }. */
		requests: () => requests,
		/** Every spawned adb's argv. */
		adbCalls: () => adbCalls.map((c) => c.args),
		/** Every spawned adb's argv, with the bound it was given. */
		adbRuns: () => adbCalls.map((c) => ({ args: c.args, timeoutMs: c.timeoutMs })),
		/** Every request to the local adb server. */
		serverCalls: () => [...serverCalls],
		/** The shell commands the phone ran, in order, from an argv or from stdin. */
		shells: () => [...ran],
		dump,
	};
}
