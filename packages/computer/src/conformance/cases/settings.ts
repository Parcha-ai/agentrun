// A phone with no fixture: the stock Settings app, read back through apps.ui_tree. A cloud phone may take no files, so
// no fixture app can be installed on it; the touch, keys and apps cases then drive Settings instead and check what
// they did in its tree, with no model. Settings shows a list of rows, each a clickable row holding its title. A tap on
// one opens a page that shows its title, and its search field shows the text typed into it.
import type { ComputerKind, Rect, UiNode, UiTreeResult } from "../../protocol.js";
import type { CaseContext } from "../types.js";

/** The stock Settings app of each phone kind this suite knows. */
export const PHONE_SETTINGS: Readonly<Partial<Record<ComputerKind, string>>> = { android: "com.android.settings" };

/** Whether the case checks what it did through Settings: a phone with apps and a UI tree that takes no fixture file. */
export function throughSettings(t: CaseContext): boolean {
	const { kind, groups } = t.provider.capabilities();
	return PHONE_SETTINGS[kind] !== undefined && !groups.includes("files") && groups.includes("apps") && groups.includes("apps.ui_tree");
}

/** The kind's Settings app, or the case skips in words. */
export function settingsApp(t: CaseContext): string {
	const { kind } = t.provider.capabilities();
	return PHONE_SETTINGS[kind] ?? t.skip(`no stock app is known for a ${kind} computer`);
}

const foreground = async (t: CaseContext) => (await t.call("apps.list", {})).foreground;

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

/** Every node of a tree, depth first. */
export function nodesOf(root: UiNode): UiNode[] {
	const out: UiNode[] = [];
	const walk = (node: UiNode) => {
		out.push(node);
		for (const child of node.children ?? []) walk(child);
	};
	walk(root);
	return out;
}

/** The texts a tree shows. */
export const textsOf = (tree: UiTreeResult) => nodesOf(tree.root).flatMap((node) => (node.text ? [node.text] : []));

export interface Row {
	text: string;
	bounds: Rect;
}

/** The middle of a rect, in whole pixels. */
export const middle = ([x, y, w, h]: Rect): [number, number] => [Math.floor(x + w / 2), Math.floor(y + h / 2)];

/** The scrollable list a tree shows, the first one. */
export function listOf(tree: UiTreeResult): UiNode | undefined {
	return nodesOf(tree.root).find((node) => node.scrollable === true);
}

/** Whether a node, or one under it, says search: its text, its label or its id. */
const saysSearch = (node: UiNode) => nodesOf(node).some((one) => /search/i.test(`${one.text ?? ""} ${one.label ?? ""} ${one.id ?? ""}`));

/**
 * The rows of a tree's list: each clickable node in it, whole inside it, with the first text it holds. Settings' search
 * entry is not a row, though a live Settings shows it as the list's first item.
 */
export function rowsOf(tree: UiTreeResult): Row[] {
	const list = listOf(tree);
	if (list === undefined) return [];
	const [lx, ly, lw, lh] = list.bounds;
	const rows: Row[] = [];
	for (const node of nodesOf(list).slice(1)) {
		if (node.clickable !== true || saysSearch(node)) continue;
		const [x, y, w, h] = node.bounds;
		if (x < lx || y < ly || x + w > lx + lw || y + h > ly + lh || w === 0 || h === 0) continue;
		const text = nodesOf(node).find((one) => one.text)?.text;
		if (text !== undefined) rows.push({ text, bounds: node.bounds });
	}
	return rows;
}

/** Settings' top list, with at least `count` rows of different titles on screen, or the case fails in words. */
export async function settingsRows(t: CaseContext, count: number): Promise<{ tree: UiTreeResult; rows: Row[] }> {
	return t.until(async () => {
		const tree = await t.call("apps.ui_tree", {});
		const rows = rowsOf(tree);
		return new Set(rows.map((row) => row.text)).size >= count ? { tree, rows } : undefined;
	}, `Settings' list with ${count} rows in apps.ui_tree`);
}

/** The node a field of text is typed into: an EditText. */
const isField = (node: UiNode) => /EditText$/.test(node.role);

/**
 * Settings' search field, opened from its list: the case taps the search entry (the first clickable node that says
 * search, by its own text, label or id or a child's; a live Settings shows it inside the list, its text on a child) and
 * waits for the field. An empty field may show its hint as its text, so only the field is waited for.
 */
export async function openSearch(t: CaseContext): Promise<void> {
	const { tree } = await settingsRows(t, 1);
	const entry = t.present(
		nodesOf(tree.root).find((node) => node.clickable === true && saysSearch(node)),
		"Settings' search entry (a clickable node saying search) in apps.ui_tree",
	);
	const at = middle(entry.bounds);
	t.deepEqual(await t.call("input.actions", { actions: [{ type: "tap", at }] }), { done: 1 }, `input.actions of a tap on Settings' search entry at ${at}`);
	await t.until(async () => (await searchText(t)) !== undefined, "Settings' search field in apps.ui_tree");
}

/** The text in Settings' search field now, or undefined when no field is shown. */
export async function searchText(t: CaseContext): Promise<string | undefined> {
	const field = nodesOf((await t.call("apps.ui_tree", {})).root).find(isField);
	return field === undefined ? undefined : (field.text ?? "");
}
