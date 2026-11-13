// A phone with no fixture: the stock Settings app, read back through ui.observe. A cloud phone may take no files, so
// no fixture app can be installed on it; the touch, keys and apps cases then drive Settings instead and check what
// they did in its nodes, with no model. Settings shows a list of rows, each a clickable row holding its title. A tap on
// one opens a page that shows its title, and its search field shows the text typed into it.
//
// ui's bounds are window points; input.actions aims in screenshot pixels. A case that taps a node through input.actions
// turns its point into pixels with the screen's scale (pixelsOf).
import type { ComputerKind, Point, Rect, UiNode, UiObserveResult, UiRole } from "../../protocol.js";
import { windowRectToPixels } from "../../ui-engine.js";
import type { CaseContext } from "../types.js";

/** The stock Settings app of each phone kind this suite knows. */
export const PHONE_SETTINGS: Readonly<Partial<Record<ComputerKind, string>>> = { android: "com.android.settings" };

/** Whether the case checks what it did through Settings: a phone with apps and the ui group that takes no fixture file. */
export function throughSettings(t: CaseContext): boolean {
	const { kind, groups } = t.provider.capabilities();
	return PHONE_SETTINGS[kind] !== undefined && !groups.includes("files") && groups.includes("apps") && groups.includes("ui");
}

/** The kind's Settings app, or the case skips in words. */
export function settingsApp(t: CaseContext): string {
	const { kind } = t.provider.capabilities();
	return PHONE_SETTINGS[kind] ?? t.skip(`no stock app is known for a ${kind} computer`);
}

const foreground = async (t: CaseContext) => (await t.call("apps.list", {})).foreground;

/** The app in front's window, as ui.observe sees it. */
export const observe = (t: CaseContext): Promise<UiObserveResult> => t.call("ui.observe", {});

/** Settings, fresh and in front: ended, launched, and waited for until it is the app in front. */
export async function openSettings(t: CaseContext): Promise<string> {
	const app = settingsApp(t);
	t.deepEqual(await t.call("apps.terminate", { id: app }), {}, `apps.terminate ${app}`);
	t.deepEqual(await t.call("apps.launch", { id: app }), {}, `apps.launch ${app}`);
	// What is in front instead, the last time it was read, goes in the words: a live run showed only the wait.
	let seen: string | null = null;
	try {
		await t.until(async () => (seen = await foreground(t)) === app, `${app} in front after apps.launch`);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)} (in front: ${seen ?? "nothing"})`);
	}
	return app;
}

/** Screenshot pixels per point: hello's screen.scale, else a screenshot's. */
async function scaleOf(t: CaseContext): Promise<number> {
	const scale = t.hello.screen?.scale ?? (await t.call("screen.shot", {})).scale;
	t.assert(typeof scale === "number" && Number.isFinite(scale) && scale > 0, `the screen's scale, to aim input.actions at a ui node: ${JSON.stringify(scale)} is not a positive number`);
	return scale;
}

/** A point of a ui observation (window points) as input.actions aims it: screenshot pixels. */
export async function pixelsOf(t: CaseContext, seen: UiObserveResult, [x, y]: Point): Promise<Point> {
	const [px, py] = windowRectToPixels(seen.window.bounds, await scaleOf(t), [x, y, 0, 0]);
	return [px, py];
}

/**
 * What a tap on a row met, in words for a failure: the screen in px and in dp (px over the shot's scale; Settings shows
 * two panes from 600 dp wide), what is in front, the tap point (px) and the row's bounds (points), whether the row's
 * title shows outside the list (a page opened beside it), and whether the next row is still shown. A part that cannot
 * be read says so; none of it throws.
 */
export async function tapScene(t: CaseContext, { at, row, next, seen }: { at: Point; row: Row; next: Row; seen: UiObserveResult | undefined }): Promise<string> {
	const unread = (error: unknown) => `unread (${error instanceof Error ? error.message : String(error)})`;
	let screen: string;
	try {
		const { width, height, scale } = await t.call("screen.shot", {});
		screen = `screen ${width}x${height} px${scale > 0 ? `, ${Math.round(width / scale)}x${Math.round(height / scale)} dp` : ""}`;
	} catch (error) {
		screen = `screen ${unread(error)}`;
	}
	let front: string;
	try {
		front = (await foreground(t)) ?? "nothing";
	} catch (error) {
		front = unread(error);
	}
	const tap = `the tap at ${at} px on the row's bounds ${JSON.stringify(row.bounds)} pt`;
	if (seen === undefined) return `${screen}; in front: ${front}; ${tap}; no ui.observe was read`;
	const list = listOf(seen);
	const inList = new Set(list === undefined ? [] : under(seen, list));
	const outside = seen.nodes.find((node) => node.name === row.text && !inList.has(node));
	const title = `its title outside the list: ${outside === undefined ? "no" : `yes, at ${JSON.stringify(outside.bounds)} pt`}`;
	const shown = `the row ${JSON.stringify(next.text)}: ${showsName(seen, next.text) ? "still shown" : "gone"}`;
	return `${screen}; in front: ${front}; ${tap}; ${title}; ${shown}`;
}

/** A node and every node below it, in the observation's order: a node comes after its parent. */
export function under(seen: UiObserveResult, top: UiNode): UiNode[] {
	const refs = new Set([top.ref]);
	const out = [top];
	for (const node of seen.nodes.slice(seen.nodes.indexOf(top) + 1)) {
		if (node.parent === undefined || !refs.has(node.parent)) continue;
		refs.add(node.ref);
		out.push(node);
	}
	return out;
}

/**
 * Whether an observation shows a name anywhere. A live Android 15 Settings page shows its title only as its collapsing
 * toolbar's content-desc (phone probe 3), with no text node holding it; a driver gives either as the node's name.
 */
export const showsName = (seen: UiObserveResult, name: string) => seen.nodes.some((node) => node.name === name);

/** The names and values an observation shows, in order. */
export const namesOf = (seen: UiObserveResult) => seen.nodes.flatMap((node) => [node.name, node.value].filter((one): one is string => one !== undefined));

export interface Row {
	text: string;
	/** In window points. */
	bounds: Rect;
}

/** The middle of a rect, in whole units. */
export const middle = ([x, y, w, h]: Rect): [number, number] => [Math.floor(x + w / 2), Math.floor(y + h / 2)];

const SCROLLS = ["ACTION_SCROLL_FORWARD", "ACTION_SCROLL_BACKWARD"];
/** The roles a person taps. */
const TAPPED: ReadonlySet<UiRole> = new Set<UiRole>(["button", "link", "listitem", "menuitem", "tab"]);
const clickable = (node: UiNode) => TAPPED.has(node.role) || (node.actions?.includes("ACTION_CLICK") ?? false);

/** The scrollable list an observation shows, the first one: a scrollarea, or a node that scrolls. */
export function listOf(seen: UiObserveResult): UiNode | undefined {
	return seen.nodes.find((node) => node.role === "scrollarea" || (node.actions?.some((action) => SCROLLS.includes(action)) ?? false));
}

/** Whether a node, or one under it, says search: its name, its value or its id. */
const saysSearch = (seen: UiObserveResult, node: UiNode) => under(seen, node).some((one) => /search/i.test(`${one.name ?? ""} ${one.value ?? ""} ${one.id ?? ""}`));

/**
 * The rows of an observation's list: each clickable node in it, whole inside it, with the first text it holds (its own
 * when it is a text, else a text node's under it). Settings' search entry is not a row, though a live Settings shows it
 * as the list's first item.
 */
export function rowsOf(seen: UiObserveResult): Row[] {
	const list = listOf(seen);
	if (list === undefined) return [];
	const [lx, ly, lw, lh] = list.bounds;
	const rows: Row[] = [];
	for (const node of under(seen, list).slice(1)) {
		if (!clickable(node) || saysSearch(seen, node)) continue;
		const [x, y, w, h] = node.bounds;
		if (x < lx || y < ly || x + w > lx + lw || y + h > ly + lh || w === 0 || h === 0) continue;
		const text = under(seen, node).find((one) => one.role === "text" && one.name)?.name;
		if (text !== undefined) rows.push({ text, bounds: node.bounds });
	}
	return rows;
}

/** Settings' top list, with at least `count` rows of different titles on screen, or the case fails in words. */
export async function settingsRows(t: CaseContext, count: number): Promise<{ seen: UiObserveResult; rows: Row[] }> {
	return t.until(async () => {
		const seen = await observe(t);
		const rows = rowsOf(seen);
		return new Set(rows.map((row) => row.text)).size >= count ? { seen, rows } : undefined;
	}, `Settings' list with ${count} rows in ui.observe`);
}

/**
 * A node text is typed into: a textbox or a searchbox. A live Android 15's Settings search field is an
 * AutoCompleteTextView inside a SearchView (phone probe 2), which the adb phone gives as a searchbox.
 */
const isField = (node: UiNode) => node.role === "textbox" || node.role === "searchbox";

/**
 * Settings' search field, opened from its list: the case taps the search entry (the first clickable node that says
 * search, by its own name, value or id or a node's under it; a live Settings shows it inside the list, its text on a
 * child) and waits for the field. An empty field may show its hint as its text, so only the field is waited for.
 */
export async function openSearch(t: CaseContext): Promise<void> {
	const { seen } = await settingsRows(t, 1);
	const entry = t.present(
		seen.nodes.find((node) => clickable(node) && saysSearch(seen, node)),
		"Settings' search entry (a clickable node saying search) in ui.observe",
	);
	const at = await pixelsOf(t, seen, middle(entry.bounds));
	t.deepEqual(await t.call("input.actions", { actions: [{ type: "tap", at }] }), { done: 1 }, `input.actions of a tap on Settings' search entry at ${at}`);
	await t.until(async () => (await searchText(t)) !== undefined, "Settings' search field in ui.observe");
}

/** The text in Settings' search field now, or undefined when no field is shown. */
export async function searchText(t: CaseContext): Promise<string | undefined> {
	const field = (await observe(t)).nodes.find(isField);
	return field === undefined ? undefined : (field.value ?? "");
}
