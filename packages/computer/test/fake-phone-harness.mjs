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
export const LAUNCHER = "com.google.android.apps.nexuslauncher";
export const SEARCH_FIELD = "com.android.settings.intelligence:id/search_src_text";
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
const ADB_CODE = "424242";

/** A clock whose sleep() moves time on at once: no test waits on the wall clock. */
export function fakeClock(start = Date.UTC(2026, 10, 8, 12)) {
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
 * `code`, the unlock code the phone takes (default the one the API gives); `abi`, what getprop reports.
 */
export function fakePhoneHarness({ readyAfter = 1, start = "ok", loseAnswer = false, others = [], code, abi = "x86_64", clock = fakeClock() } = {}) {
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
			return json(202, view(session));
		}
		if (method === "GET" && path === "/sessions") return json(200, [...sessions.values()].map(view));
		const byKey = /^\/sessions\/requests\/([^/]+)$/.exec(path);
		if (method === "GET" && byKey) {
			const found = [...sessions.values()].find((s) => s.request_key === byKey[1]);
			return found ? json(200, view(found)) : json(404, { error: "no such request" });
		}
		const adb = /^\/sessions\/([^/]+)\/adb$/.exec(path);
		if (method === "POST" && adb) {
			const s = sessions.get(adb[1]);
			if (!s) return json(404, { error: "no such session" });
			return json(200, { host: "203.0.113.7", port: 40000 + Number(s.id.slice(5)), code: ADB_CODE });
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
	const phone = { connected: new Set(), unlocked: new Set(), foreground: LAUNCHER, running: new Set([LAUNCHER]), screen: "top", offset: 0, page: "", search: "" };
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
		if (phone.foreground === LAUNCHER) {
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
			return node("android.widget.FrameLayout", { bounds: box(full), ...pkg }, [
				node("android.widget.TextView", { text: "Search settings", "resource-id": "com.android.settings:id/search_action_bar_title", clickable: "true", bounds: box([16, 16, 328, 56]), ...pkg }),
				node("androidx.recyclerview.widget.RecyclerView", { scrollable: "true", bounds: box([0, HEADER, SCREEN.width, SCREEN.height - HEADER]), ...pkg }, rows),
			]);
		}
		if (phone.screen === "page") {
			return node("android.widget.FrameLayout", { bounds: box(full), ...pkg }, [
				node("android.widget.ImageButton", { "content-desc": "Navigate up", clickable: "true", bounds: box([0, 16, 56, 56]), ...pkg }),
				node("android.widget.TextView", { text: phone.page, "resource-id": "com.android.settings:id/collapsing_toolbar", bounds: box([72, 24, 260, 40]), ...pkg }),
			]);
		}
		return node("android.widget.FrameLayout", { bounds: box(full), package: "com.android.settings.intelligence" }, [
			node("android.widget.EditText", { text: phone.search, "resource-id": SEARCH_FIELD, focused: "true", clickable: "true", bounds: box([56, 16, 288, 56]), package: "com.android.settings.intelligence" }),
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
		if (phone.screen === "top" && n.attrs.text === "Search settings") return Object.assign(phone, { screen: "search", search: "" });
		if (phone.screen === "top" && n.cls === "android.widget.LinearLayout") return Object.assign(phone, { screen: "page", page: n.children[0].attrs.text });
		if (phone.screen === "page" && n.attrs["content-desc"] === "Navigate up") phone.screen = "top";
	}

	function back() {
		if (phone.foreground === SETTINGS && phone.screen !== "top") phone.screen = "top";
		else phone.foreground = LAUNCHER;
	}

	function launch(pkg) {
		if (!phone.running.has(pkg)) {
			phone.running.add(pkg);
			if (pkg === SETTINGS) settingsReset();
		}
		phone.foreground = pkg;
	}

	/** The words of a shell command, as the device's sh splits it: single quotes kept together. */
	function words(command) {
		const out = [];
		for (const m of command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2]);
		return out;
	}

	const KEYS = { KEYCODE_HOME: () => (phone.foreground = LAUNCHER), KEYCODE_BACK: back, KEYCODE_APP_SWITCH: () => {}, KEYCODE_DEL: () => (phone.search = phone.search.slice(0, -1)) };

	function shell(command) {
		const w = words(command);
		const ok = (stdout = "") => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: "" });
		if (w[0] === "echo") return ok(`${w.slice(1).join(" ")}\n`);
		if (w[0] === "unlock") {
			if (w[1] === expected) phone.unlockedNow = true;
			return ok("");
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
		if (w[0] === "input" && w[1] === "motionevent") return ok();
		if (w[0] === "input" && w[1] === "text") {
			if (phone.foreground === SETTINGS && phone.screen === "search") phone.search += w[2].replaceAll("%s", " ");
			return ok();
		}
		if (w[0] === "input" && w[1] === "keyevent") {
			const k = w[2];
			if (KEYS[k]) KEYS[k]();
			else if (/^KEYCODE_[A-Z0-9]$/.test(k) && phone.screen === "search") phone.search += k.slice(8).toLowerCase();
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
			launch(comp.split("/")[0]);
			return ok("Starting: Intent { cmp=" + comp + " }\nStatus: ok\n");
		}
		if (w[0] === "am" && w[1] === "force-stop") {
			phone.running.delete(w[2]);
			if (phone.foreground === w[2]) phone.foreground = LAUNCHER;
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
		for (let i = 0; i < pixels.length; i += 4) pixels.set([phone.foreground === SETTINGS ? 30 : 200, 60, 90, 255], i);
		return Buffer.concat([header, pixels]);
	}

	/** The adb runner the provider takes: (args, { timeoutMs, signal }) => Result<{ exitCode, stdout, stderr }>. */
	async function adb(args, options = {}) {
		adbCalls.push({ args: [...args], timeoutMs: options.timeoutMs });
		const ok = (stdout, exitCode = 0, stderr = "") => ({ ok: true, value: { exitCode, stdout: Buffer.from(stdout), stderr } });
		if (args[0] === "connect") {
			phone.connected.add(args[1]);
			return ok(`connected to ${args[1]}\n`);
		}
		if (args[0] === "disconnect") {
			phone.connected.delete(args[1]);
			return ok("");
		}
		if (args[0] !== "-s") return ok("", 1, "adb: usage");
		const serial = args[1];
		if (!phone.connected.has(serial)) return ok("", 1, `adb: device '${serial}' not found`);
		if (args[2] === "exec-out" && args[3] === "screencap") return ok(screencap());
		if (args[2] === "exec-out" && args[3] === "uiautomator dump /dev/tty") return ok(dump());
		if (args[2] !== "shell") return ok("", 1, "adb: unknown command");
		const command = args.slice(3).join(" ");
		if (!phone.unlocked.has(serial) && !command.startsWith("unlock") && !command.startsWith("echo")) return ok("", 1, "error: device locked");
		if (command.startsWith("echo") && !phone.unlocked.has(serial)) return ok("");
		const ran = shell(command);
		if (phone.unlockedNow) {
			phone.unlocked.add(serial);
			phone.unlockedNow = false;
		}
		return { ok: true, value: ran };
	}

	return {
		fetch,
		adb,
		clock,
		phone,
		sessions,
		/** Every API request, as { method, path, headers, body }. */
		requests: () => requests,
		/** Every adb call's argv. */
		adbCalls: () => adbCalls.map((c) => c.args),
		/** The shell commands sent, in order. */
		shells: () => adbCalls.filter((c) => c.args[2] === "shell").map((c) => c.args.slice(3).join(" ")),
		dump,
	};
}
