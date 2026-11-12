// The ui group on a phone the phone harness drives over adb, until phoned answers it on the phone itself. A look is one
// uiautomator dump, which waits for the phone to be idle, so it is already settled. A step is adb's input at the
// element's centre: the phone's own input, so every step takes the foreground route, and none is verified.
import type { Features, InputAction, Point, Rect, UiFlag, UiImage, UiRole, UiStep, UiTarget } from "./protocol.js";
import { fail, ok, type Result } from "./result.js";
import type { UiElement, UiRun, UiSource, UiStepContext, UiView } from "./ui-engine.js";

/** What the ui needs of the phone: its pixels per point, its tree, and one input action run through input.actions. */
export interface AdbUiPhone {
	scale(): number;
	/** uiautomator's dump, its XML. */
	dump(signal: AbortSignal): Promise<Result<string>>;
	/**
	 * One step's actions as one batch: the phone checks every action (its text, its keys, its points, the batch's
	 * limits) before it runs the first, so a step that would fail part way (after a set's deletes, say) changes nothing.
	 */
	input(actions: InputAction[], signal: AbortSignal): Promise<Result<void>>;
}

const FEATURES: Features = {
	"ui.tree": true,
	"ui.foreground": true,
	"ui.nav": true,
	"ui.background": { off: "this phone is driven over adb, whose input is the phone's own; phoned's input is needed for the background route" },
	"ui.image": { off: "this phone is driven over adb, which sends no window image with a look; take one with screen.shot" },
};

/** Android's widget classes, by the last part of their name, as the protocol's roles. */
const ROLES: Array<[RegExp, UiRole]> = [
	[/(^|\.)(Button|ImageButton|FloatingActionButton|MaterialButton)$/, "button"],
	// A SearchView is the bar that holds the search field (an AutoCompleteTextView), not the field: a group.
	[/(^|\.)SearchView$/, "group"],
	[/(^|\.)(CheckBox|CheckedTextView)$/, "checkbox"],
	[/(^|\.)(Switch|SwitchCompat|SwitchMaterial|ToggleButton)$/, "switch"],
	[/(^|\.)RadioButton$/, "radio"],
	[/(^|\.)SeekBar$/, "slider"],
	[/(^|\.)Spinner$/, "combobox"],
	[/(^|\.)ProgressBar$/, "progressbar"],
	[/(^|\.)ImageView$/, "image"],
	[/(^|\.)TextView$/, "text"],
	[/(^|\.)(ScrollView|HorizontalScrollView|NestedScrollView|RecyclerView|ListView|GridView|ViewPager)$/, "scrollarea"],
	[/(^|\.)TabWidget$/, "tab"],
	[/(^|\.)Toolbar$/, "toolbar"],
];

/**
 * A field text is typed into: an EditText or a subclass the platform names apart (TextInputEditText, ExtractEditText,
 * AutoCompleteTextView, MultiAutoCompleteTextView). A field inside a SearchView is a searchbox, any other a textbox.
 */
const EDITABLE = /(EditText|AutoCompleteTextView)$/;
const SEARCH_VIEW = /(^|\.)SearchView$/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, name: string) =>
		name[0] === "#" ? String.fromCodePoint(name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name.toLowerCase()],
	);

/**
 * uiautomator's dump as a look: its elements in order, bounds in points, each keyed by its app, its place in the tree,
 * its class, its resource-id and, for an element a tap lands on, what it shows (a text field's text aside).
 * A clickable row with no name of its own is a button named by the texts inside it, as a person reads it.
 */
export function parseUiElements(xml: string, scale: number, screen: [number, number]): Result<UiView> {
	const elements: UiElement[] = [];
	const path: string[] = [];
	const open: Array<UiElement | undefined> = [];
	/** The classes of the open elements, as open holds them. */
	const openClasses: string[] = [];
	const texts = new Map<string, string[]>();
	const shows = new Map<string, string[]>();
	const pt =(px: number) => Math.round(px / scale);
	let app: string | undefined;
	for (const tag of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
		const [, closing, body, selfClosing] = tag;
		if (closing) {
			path.pop();
			open.pop();
			openClasses.pop();
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const [, name, value] of body.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[name] = unescape(value);
		app ??= attrs.package || undefined;
		const cls = attrs.class ?? "";
		path.push(attrs.index ?? "0");
		const key = `${path.join("/")}:${cls}${attrs["resource-id"] ? `#${attrs["resource-id"]}` : ""}`;
		const box = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds ?? "");
		const [x1, y1, x2, y2] = box ? box.slice(1).map(Number) : [0, 0, 0, 0];
		const bool = (name: string) => attrs[name] === "true";
		const editable = EDITABLE.test(cls);
		const role: UiRole = editable
			? openClasses.some((one) => SEARCH_VIEW.test(one))
				? "searchbox"
				: "textbox"
			: (ROLES.find(([pattern]) => pattern.test(cls))?.[1] ?? (bool("clickable") ? "button" : "generic"));
		const flags: UiFlag[] = [];
		if (bool("focused")) flags.push("focused");
		if (attrs.enabled === "false") flags.push("disabled");
		if (bool("selected")) flags.push("selected");
		if (bool("checkable") && bool("checked")) flags.push("checked");
		if (bool("password")) flags.push("secure");
		const actions = [...(bool("clickable") ? ["ACTION_CLICK"] : []), ...(bool("long-clickable") ? ["ACTION_LONG_CLICK"] : []), ...(bool("scrollable") ? ["ACTION_SCROLL_FORWARD", "ACTION_SCROLL_BACKWARD"] : [])];
		const label = attrs["content-desc"] || undefined;
		const text = attrs.text || undefined;
		const parent = open.findLast((one) => one !== undefined);
		const element: UiElement = {
			key,
			role,
			...(editable ? { ...(label === undefined ? {} : { name: label }), ...(text === undefined ? {} : { value: text }) } : (label ?? text) === undefined ? {} : { name: (label ?? text) as string }),
			...(attrs["resource-id"] ? { id: attrs["resource-id"] } : {}),
			bounds: [pt(x1), pt(y1), Math.max(0, pt(x2) - pt(x1)), Math.max(0, pt(y2) - pt(y1))],
			...(parent === undefined ? {} : { parent: parent.key }),
			...(flags.length > 0 ? { flags } : {}),
			...(actions.length > 0 ? { actions } : {}),
		};
		elements.push(element);
		// Every text is also a text of each element above it, for the rows that have none of their own.
		// A password field's text never names a row above it: its label may, its text may not.
		const said = bool("password") ? label : (text ?? label);
		if (said) for (const above of open) if (above !== undefined) texts.set(above.key, [...(texts.get(above.key) ?? []), said]);
		// What the elements above it show, for their keys: a field's text is a person's to change, so it is not part.
		const fixed = editable || bool("password") ? label : (text ?? label);
		if (fixed) for (const above of open) if (above !== undefined) shows.set(above.key, [...(shows.get(above.key) ?? []), fixed]);
		if (selfClosing) path.pop();
		else {
			open.push(element);
			openClasses.push(cls);
		}
	}
	if (elements.length === 0) return fail("invalid", "uiautomator's dump held no node");
	const id = app ?? "android";
	// uiautomator gives no element identity, only a place in the tree, which a list hands to the next row as it scrolls.
	// So a key is the app's, and a tappable element's (not a field's) also holds what it shows, a field's text aside: a
	// row that now shows other content is another element, and its old ref goes stale instead of tapping the new row.
	// Anything else, a list or a label among them, keeps its key while its content changes.
	const tappable = (element: UiElement) =>
		element.role !== "textbox" && element.role !== "searchbox" && (element.actions ?? []).some((action) => action === "ACTION_CLICK" || action === "ACTION_LONG_CLICK");
	const shown = (element: UiElement) => (tappable(element) ? `|${[element.name, ...(shows.get(element.key) ?? [])].filter(Boolean).join(", ")}` : "");
	const rekeyed = new Map(elements.map((element) => [element.key, `${id}|${element.key}${shown(element)}`]));
	for (const element of elements) {
		if (element.name !== undefined || element.role !== "button") continue;
		const inside = texts.get(element.key);
		if (inside !== undefined) element.name = inside.slice(0, 3).join(", ");
	}
	for (const element of elements) {
		element.key = rekeyed.get(element.key) as string;
		if (element.parent !== undefined) element.parent = rekeyed.get(element.parent);
	}
	const bounds: Rect = [0, 0, pt(screen[0]), pt(screen[1])];
	return ok({ app: { id, name: id }, window: { id, bounds }, elements });
}

const centre = ([x, y, w, h]: Rect): Point => [x + Math.floor(w / 2), y + Math.floor(h / 2)];

/** The ui group's source on an adb phone. */
export class AdbUiSource implements UiSource {
	constructor(
		readonly phone: AdbUiPhone,
		/** The screen's size in pixels, as the phone last said it. */
		readonly screen: () => [number, number],
	) {}

	features(): Features {
		return FEATURES;
	}

	async look(target: UiTarget | undefined, signal: AbortSignal): Promise<Result<UiView>> {
		const dumped = await this.phone.dump(signal);
		if (!dumped.ok) return dumped;
		const view = parseUiElements(dumped.value, this.phone.scale(), this.screen());
		if (!view.ok) return view;
		const front = view.value.app.id;
		if (target?.app !== undefined && target.app !== front) return fail("not_found", `${target.app} is not in front on this phone (${front} is): launch it with apps.launch first`);
		if (target?.window !== undefined && target.window !== view.value.window.id) return fail("not_found", `window ${target.window} is not in front on this phone (${view.value.window.id} is)`);
		return view;
	}

	async image(): Promise<Result<UiImage>> {
		return fail("unsupported", "ui.image is off on a phone driven over adb: take one with screen.shot");
	}

	async run(step: UiStep, { element, foreground }: UiStepContext, signal: AbortSignal): Promise<Result<UiRun>> {
		if (!foreground) return fail("denied", "this phone takes input only as the phone's own (the foreground route), and this call does not allow it: pass foreground: true");
		const scale = this.phone.scale();
		const px = ([x, y]: Point): [number, number] => [Math.round(x * scale), Math.round(y * scale)];
		const at = (target: Point | string | undefined) => px(Array.isArray(target) ? (target as Point) : centre((element as UiElement).bounds));
		const input = (...actions: InputAction[]) => this.phone.input(actions, signal);
		const done = (ran: Result<void>): Result<UiRun> => (ran.ok ? ok({ route: "foreground", verified: false }) : ran);
		if ("press" in step) return done(await input({ type: "tap", at: at(step.press) }));
		if ("click" in step) {
			const point = at(step.click);
			if (step.button === "right") return done(await input({ type: "long_press", at: point }));
			// A triple click is a double tap and then one more tap.
			return done(await input({ type: "tap", at: point, ...(step.count === 2 || step.count === 3 ? { count: 2 as const } : {}) }, ...(step.count === 3 ? [{ type: "tap" as const, at: point }] : [])));
		}
		if ("perform" in step) {
			if (step.action === "ACTION_CLICK") return done(await input({ type: "tap", at: at(step.perform) }));
			if (step.action === "ACTION_LONG_CLICK") return done(await input({ type: "long_press", at: at(step.perform) }));
			return fail("unsupported", `perform ${step.action}: a phone driven over adb performs ACTION_CLICK and ACTION_LONG_CLICK only`);
		}
		if ("set" in step) {
			const target = element as UiElement;
			if (target.role === "switch" || target.role === "checkbox") {
				const on = step.value === "on" || step.value === "true";
				if (!on && step.value !== "off" && step.value !== "false") return fail("invalid", `set ${step.set}: a ${target.role} is set to "on" or "off", not ${JSON.stringify(step.value)}`);
				if ((target.flags?.includes("checked") ?? false) === on) return ok({ route: "foreground", verified: true });
				return done(await input({ type: "tap", at: at(step.set) }));
			}
			if (target.role !== "textbox" && target.role !== "searchbox") return fail("unsupported", `set ${step.set}: a ${target.role} has no value a phone driven over adb can set`);
			// The tap leaves the caret anywhere in the text (on any line of a multiline field), and adb presses no
			// select-all or ctrl+end: as many deletes back and forward as the text is long clear it from any caret.
			const erase = [...(target.value ?? "")].length;
			const keys: InputAction[] = [];
			for (const key of ["backspace", "delete"]) for (let left = erase; left > 0; left -= 100) keys.push({ type: "key", keys: [key], repeat: Math.min(100, left) });
			return done(await input({ type: "tap", at: at(step.set) }, ...keys, ...(step.value === "" ? [] : [{ type: "type" as const, text: step.value }])));
		}
		if ("type" in step) return done(await input(...(step.into === undefined ? [] : [{ type: "tap" as const, at: at(step.into) }]), { type: "type", text: step.type }));
		if ("key" in step) {
			const keys = step.key.split("+");
			if (keys.length > 1) return fail("unsupported", `key ${step.key}: a phone driven over adb presses one key at a time`);
			return done(await input({ type: "key", keys }));
		}
		if ("nav" in step) return done(await input({ type: "button", name: step.nav }));
		if ("scroll" in step) {
			const [x, y] = at(step.scroll);
			const [width, height] = this.screen();
			const clamp = (value: number, most: number) => Math.min(most - 1, Math.max(0, value));
			const [dx, dy] = px([step.dx ?? 0, step.dy ?? 0]);
			return done(await input({ type: "swipe", path: [[x, y], [clamp(x - dx, width), clamp(y - dy, height)]], ms: 300 }));
		}
		if ("drag" in step) return done(await input({ type: "swipe", path: step.drag.map(px), ...(step.ms === undefined ? {} : { ms: step.ms }) }));
		return fail("unsupported", "this step is not one a phone driven over adb takes");
	}
}
