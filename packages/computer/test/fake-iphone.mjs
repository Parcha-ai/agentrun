// A fake of a cloud iPhone's control API, as the phone harness documents it (docs, guides/iphone; its client's
// setup/api.md, remote.py and transport.py): a ready iPhone session carries control { url, token, expires_at }; GET
// <url>/ops answers { ops }; POST <url>/op with { op, kw } runs one op and answers { result }; an op the phone does not
// list answers 400 with unsupported: true; a grant that has ended answers 404. test/fake-phone-harness.mjs routes every
// request under /iphone/c/ here. Nothing listens on a port and nothing waits on the wall clock.
//
// The phone is a small iPhone that is never wiped: a home screen and the stock Settings app, whose list scrolls, whose
// rows open a page, and whose search field takes typed text. screen.capture draws the screen as a PNG, so a scroll or
// a new screen changes its pixels. Every op is recorded with the token it carried.
import { crc32, deflateSync } from "node:zlib";

export const IOS_SETTINGS = "com.apple.Preferences";
export const IOS_HOME = "com.apple.springboard";
export const IOS_SCREEN = { width: 300, height: 600 };
/** The ops the fake lists by default: the vocabulary's iPhone ops, with no tree and no nav.back. */
export const IOS_OPS = [
	"screen.capture",
	"screen.bounds",
	"screen.text",
	"input.tap",
	"input.press",
	"input.drag",
	"input.scroll",
	"input.keys",
	"input.text",
	"nav.home",
	"nav.recents",
	"apps.launch",
	"apps.current",
	"apps.list",
	"url.open",
];
export const IOS_ITEMS = ["General", "Accessibility", "Camera", "Control Center", "Display & Brightness", "Home Screen", "Search", "Siri", "StandBy", "Wallpaper", "Notifications", "Sounds & Haptics", "Focus", "Screen Time"];
const HEADER = 120;
const ROW = 50;
const SEARCH_FIELD = [16, 70, 268, 36];
const INSTALLED = [IOS_SETTINGS, "com.apple.mobilesafari", "com.apple.MobileSMS"];

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An 8-bit RGB PNG of a width x height screen whose row y is color(y). */
function png(width, height, color) {
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const [r, g, b] = color(y);
		for (let x = 0; x < width; x++) rows.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
	}
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed) >>> 0);
		return Buffer.concat([length, typed, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The fake iPhone. Options: `ops`, what GET /ops lists (default IOS_OPS); `tree`, the phone answers the op `tree` (and
 * lists it); `back`, it lists nav.back; `fail`, given each { op, kw }, answers a Response to send in place of the op's
 * own (a test makes an op fail in the vendor's words).
 */
export function fakeIphone({ ops = IOS_OPS, tree = false, back = false, fail } = {}) {
	const listed = [...ops, ...(tree ? ["tree"] : []), ...(back ? ["nav.back"] : [])];
	/** The grants of live sessions: grant -> token. */
	const grants = new Map();
	/** Every op the phone took: { op, kw, authorization }. */
	const calls = [];
	/** The most ops the phone was asked to run at once. */
	let busy = 0;
	let mostAtOnce = 0;
	const phone = { foreground: IOS_HOME, screen: "top", offset: 0, page: "", search: "", focused: false, typed: [], keys: [] };
	const maxOffset = Math.max(0, HEADER + ROW * IOS_ITEMS.length - IOS_SCREEN.height);

	const settingsReset = () => Object.assign(phone, { screen: "top", offset: 0, page: "", search: "", focused: false });

	/** The rows on screen now: [title, [x, y, w, h]]. */
	function rows() {
		const out = [];
		for (const [i, title] of IOS_ITEMS.entries()) {
			const y = HEADER + i * ROW - phone.offset;
			if (y < HEADER || y + ROW > IOS_SCREEN.height) continue;
			out.push([title, [0, y, IOS_SCREEN.width, ROW]]);
		}
		return out;
	}

	const inside = ([x, y, w, h], px, py) => px >= x && px < x + w && py >= y && py < y + h;

	function tap(x, y) {
		if (phone.foreground === IOS_HOME) {
			// The Settings icon on the home screen.
			if (inside([20, 400, 60, 60], x, y)) return launch(IOS_SETTINGS);
			return;
		}
		if (phone.foreground !== IOS_SETTINGS) return;
		if (phone.screen === "top" && inside(SEARCH_FIELD, x, y)) return Object.assign(phone, { screen: "search", focused: true });
		if (phone.screen === "top") {
			const row = rows().find(([, box]) => inside(box, x, y));
			if (row) Object.assign(phone, { screen: "page", page: row[0] });
		}
	}

	function launch(name, fresh = false) {
		if (!INSTALLED.includes(name)) return undefined;
		if (name === IOS_SETTINGS && (fresh || phone.foreground !== IOS_SETTINGS)) settingsReset();
		phone.foreground = name;
		return name;
	}

	/** The screen's color by row: each screen its own, and Settings' list in bands that move with its scroll. */
	function color(y) {
		if (phone.foreground === IOS_HOME) return [20, 40, 160];
		if (phone.foreground !== IOS_SETTINGS) return [240, 240, 240];
		if (phone.screen === "page") return [200, 220, 200];
		if (phone.screen === "search") return [250, 250, 200 + Math.min(55, phone.search.length)];
		if (y < HEADER) return [242, 242, 247];
		return Math.floor((y - HEADER + phone.offset) / ROW) % 2 === 0 ? [255, 255, 255] : [210, 210, 215];
	}

	/** The phone's accessibility tree, flat, as the vocabulary's tree answers: centers and sizes in screen pixels. */
	function nodes() {
		const node = (text, cls, [x, y, w, h], extra = {}) => ({ text, desc: "", id: "", class: cls, clickable: false, x: x + Math.floor(w / 2), y: y + Math.floor(h / 2), w, h, ...extra });
		if (phone.foreground !== IOS_SETTINGS) return [node("", "XCUIElementTypeApplication", [0, 0, IOS_SCREEN.width, IOS_SCREEN.height])];
		if (phone.screen === "page") return [node(phone.page, "XCUIElementTypeStaticText", [16, 60, 268, 40])];
		if (phone.screen === "search") return [node(phone.search, "XCUIElementTypeSearchField", SEARCH_FIELD, { clickable: true })];
		return [node("Search", "XCUIElementTypeSearchField", SEARCH_FIELD, { clickable: true }), ...rows().map(([title, box]) => node(title, "XCUIElementTypeCell", box, { clickable: true }))];
	}

	/** One op's result, or a Response for its failure. */
	function run(op, kw) {
		const number = (name) => (typeof kw[name] === "number" && Number.isFinite(kw[name]) ? kw[name] : undefined);
		switch (op) {
			case "screen.capture":
				return { png_b64: png(IOS_SCREEN.width, IOS_SCREEN.height, color).toString("base64"), bounds: { x: 0, y: 0, w: IOS_SCREEN.width, h: IOS_SCREEN.height } };
			case "screen.bounds":
				return { x: 0, y: 0, w: IOS_SCREEN.width, h: IOS_SCREEN.height, id: 1 };
			case "input.tap":
				if (number("x") === undefined || number("y") === undefined) return json(400, { error: "TypeError: input.tap needs x and y" });
				tap(kw.x, kw.y);
				return null;
			case "input.press":
				return null;
			case "input.drag": {
				if (["x1", "y1", "x2", "y2"].some((name) => number(name) === undefined)) return json(400, { error: "TypeError: input.drag needs x1, y1, x2, y2" });
				if (phone.foreground === IOS_SETTINGS && phone.screen === "top") phone.offset = Math.min(maxOffset, Math.max(0, phone.offset + (kw.y1 - kw.y2)));
				return null;
			}
			case "input.text":
				phone.typed.push({ s: kw.s, keystrokes: kw.keystrokes === true });
				if (phone.foreground === IOS_SETTINGS && phone.screen === "search" && phone.focused) phone.search += kw.s;
				return null;
			case "input.keys":
				phone.keys.push(kw.combo);
				if (kw.combo === "delete" && phone.screen === "search") phone.search = phone.search.slice(0, -1);
				return null;
			case "nav.home":
				phone.foreground = IOS_HOME;
				return null;
			case "nav.recents":
				return null;
			case "nav.back":
				if (phone.foreground === IOS_SETTINGS && phone.screen !== "top") phone.screen = "top";
				return null;
			case "apps.launch": {
				const name = typeof kw.name === "string" ? kw.name : "";
				const launched = launch(name, kw.fresh === true);
				// The vendor's words for an app that is not there (its client, remote.py).
				if (launched === undefined) return json(400, { error: `RuntimeError: no installed app matches '${name}'` });
				return launched;
			}
			case "apps.current":
				return phone.foreground;
			case "apps.list":
				return kw.include_system === true ? [...INSTALLED, IOS_HOME] : [...INSTALLED];
			case "tree":
				return nodes();
			default:
				return json(400, { error: `this phone has no op ${op}`, unsupported: true });
		}
	}

	/** The control API: a request under /iphone/c/<grant>, or undefined when the path is not one. */
	async function handle(method, path, headers, body) {
		const m = /^\/iphone\/c\/([^/]+)(\/ops|\/op)$/.exec(path);
		if (!m) return undefined;
		const token = grants.get(m[1]);
		if (token === undefined) return json(404, { error: "no such control grant: the session ended or its grant expired" });
		if (headers.authorization !== `Bearer ${token}`) return json(401, { error: "invalid control token" });
		if (method === "GET" && m[2] === "/ops") return json(200, { ops: [...listed] });
		if (method !== "POST" || m[2] !== "/op") return json(404, { error: `no route ${method} ${path}` });
		const { op, kw = {} } = body ?? {};
		calls.push({ op, kw, authorization: headers.authorization });
		busy++;
		mostAtOnce = Math.max(mostAtOnce, busy);
		try {
			// Another op sent meanwhile would overlap this one here.
			await Promise.resolve();
			await Promise.resolve();
			const failed = fail?.({ op, kw });
			if (failed) return failed;
			if (!listed.includes(op)) return json(400, { error: `this phone cannot ${JSON.stringify(op)}`, unsupported: true });
			const result = run(op, kw);
			return result instanceof Response ? result : json(200, { result });
		} finally {
			busy--;
		}
	}

	return {
		phone,
		grants,
		handle,
		listed,
		/** Every op the phone took, as { op, kw, authorization }. */
		calls: () => calls.map((c) => ({ ...c })),
		/** The ops alone, as [op, kw]. */
		ops: () => calls.map((c) => [c.op, c.kw]),
		mostAtOnce: () => mostAtOnce,
	};
}
