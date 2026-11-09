// Apps: the fixture installs, is listed, comes to the front when launched and leaves it when terminated; the UI tree has
// the protocol's shape, inside the screen, with the fixture's button found by its id. A phone's stock Settings app is
// listed, launched and terminated with no install, which needs apps and apps.terminate: its launch is seen in the UI
// tree (Settings' list) when the phone has one, else in a screenshot that is not the one before. A phone with no
// apps.terminate (a cloud iPhone) still has apps.launch: Settings is listed, left by the home button, launched, in front
// and shown, which only navigates. On a phone that takes no fixture file the tree's shape is checked on Settings, with
// its rows found (settings.ts).
import { MAX_UI_NODES, type Rect, type UiNode } from "../../protocol.js";
import { FIXTURE_BUTTON } from "../fixture.js";
import type { Case, CaseContext } from "../types.js";
import { screenPrint } from "./screen.js";
import { leaveApp, openSettings, rowsOf, settingsApp, textsOf, throughSettings } from "./settings.js";

/** Whether the provider and the computer both declare group. */
const declares = (t: CaseContext, group: "apps.ui_tree" | "screen") => t.provider.capabilities().groups.includes(group) && t.hello.groups.includes(group);

/**
 * What the screen shows now, as the case compares it: the UI tree's texts when the phone has a tree, else a
 * screenshot's print. Undefined when it has neither, and the launch cannot be seen.
 */
async function shown(t: CaseContext): Promise<string | undefined> {
	if (declares(t, "apps.ui_tree")) return JSON.stringify(textsOf(await t.call("apps.ui_tree", {})));
	if (declares(t, "screen")) return screenPrint(t);
	return undefined;
}

const BOOLEANS = ["clickable", "focused", "selected", "checked", "scrollable"] as const;
const STRINGS = ["id", "text", "label"] as const;

/** The first way node (at path) breaks the protocol's UiNode, in words, or undefined; counts nodes as it walks. */
function shapeOf(node: unknown, path: string, screen: Rect | undefined, seen: { nodes: number; button?: UiNode }): string | undefined {
	if (typeof node !== "object" || node === null) return `${path} is not an object`;
	const n = node as Record<string, unknown>;
	seen.nodes++;
	if (seen.nodes > MAX_UI_NODES) return `the tree holds more than ${MAX_UI_NODES} nodes`;
	if (typeof n.role !== "string" || n.role === "") return `${path}.role is ${JSON.stringify(n.role)}, not the platform's class`;
	for (const field of STRINGS) if (n[field] !== undefined && typeof n[field] !== "string") return `${path}.${field} is ${JSON.stringify(n[field])}, not a string`;
	if (typeof n.enabled !== "boolean") return `${path}.enabled is ${JSON.stringify(n.enabled)}, not a boolean`;
	for (const field of BOOLEANS) if (n[field] !== undefined && typeof n[field] !== "boolean") return `${path}.${field} is ${JSON.stringify(n[field])}, not a boolean`;
	const bounds = n.bounds;
	if (!(Array.isArray(bounds) && bounds.length === 4 && bounds.every((v) => typeof v === "number" && Number.isFinite(v)) && bounds[2] >= 0 && bounds[3] >= 0)) {
		return `${path}.bounds is ${JSON.stringify(bounds)}, not [x, y, w, h]`;
	}
	if (screen !== undefined) {
		const [x, y, w, h] = bounds as Rect;
		if (x < 0 || y < 0 || x + w > screen[2] || y + h > screen[3]) return `${path}.bounds ${JSON.stringify(bounds)} reach outside the ${screen[2]}x${screen[3]} screenshot`;
	}
	if (!Array.isArray(n.children)) return `${path}.children is ${JSON.stringify(n.children)}, not a list`;
	if (n.id === FIXTURE_BUTTON.id) seen.button ??= node as UiNode;
	for (const [i, child] of n.children.entries()) {
		const wrong = shapeOf(child, `${path}.children[${i}]`, screen, seen);
		if (wrong !== undefined) return wrong;
	}
	return undefined;
}

const foreground = async (t: CaseContext) => (await t.call("apps.list", {})).foreground;

/** The kind's Settings app, once apps.list gives apps with ids and holds it. */
function listedSettings(listed: { apps: Array<{ id: string }> }, t: CaseContext): string {
	const app = settingsApp(t);
	t.assert(Array.isArray(listed.apps) && listed.apps.every((one) => typeof one?.id === "string"), `apps.list gives apps with ids: ${JSON.stringify(listed.apps).slice(0, 300)}`);
	t.assert(listed.apps.some((one) => one.id === app), `apps.list holds ${app}`);
	return app;
}

/** apps.launch of app, which is not in front: it comes to the front, and the screen shows it, not what it showed before. */
async function launchShown(t: CaseContext, app: string): Promise<void> {
	const before = await shown(t);
	if (before === undefined) return t.skip("no way to see a launch: the computer declares neither apps.ui_tree nor screen", { undeclared: ["apps.ui_tree", "screen"] });
	t.deepEqual(await t.call("apps.launch", { id: app }), {}, `apps.launch ${app}`);
	await t.until(async () => (await foreground(t)) === app, `${app} in front after apps.launch`);
	// apps.list's word is not enough: the screen must show it.
	if (declares(t, "apps.ui_tree")) {
		await t.until(async () => {
			const tree = await t.call("apps.ui_tree", {});
			return rowsOf(tree).length > 0 && JSON.stringify(textsOf(tree)) !== before;
		}, `${app} shown after apps.launch: Settings' list in apps.ui_tree, not the screen before it`);
	} else {
		await t.until(async () => (await screenPrint(t)) !== before, `${app} shown after apps.launch: a screenshot other than the one before it`);
	}
}

export const appsCases: Case[] = [
	{
		id: "apps.install-launch",
		level: "core",
		group: "apps",
		needs: ["apps.install", "apps", "apps.terminate", "files"],
		async run(t) {
			// The fixture is written with files.write, installed with apps.install and launched.
			const fixture = await t.fixture();
			const id = t.present(fixture.app, "the fixture names the app it installed");
			const listed = await t.call("apps.list", {});
			t.assert(Array.isArray(listed.apps) && listed.apps.every((app) => typeof app?.id === "string"), `apps.list gives apps with ids: ${JSON.stringify(listed.apps).slice(0, 300)}`);
			t.assert(listed.apps.some((app) => app.id === id), `apps.list holds the installed ${id}`);
			await t.until(async () => (await foreground(t)) === id, `${id} in front after apps.launch`);
			t.deepEqual(await t.call("apps.terminate", { id }), {}, `apps.terminate ${id}`);
			await t.until(async () => (await foreground(t)) !== id, `${id} no longer in front after apps.terminate`);
			t.deepEqual(await t.call("apps.launch", { id }), {}, `apps.launch ${id}`);
			await t.until(async () => (await foreground(t)) === id, `${id} in front after a second apps.launch`);
		},
	},
	{
		id: "apps.launch-terminate",
		level: "core",
		group: "apps",
		needs: ["apps", "apps.terminate"],
		async run(t) {
			// The phone's own Settings app: listed; launched, in front and shown; terminated, and no longer in front.
			const app = listedSettings(await t.call("apps.list", {}), t);
			t.deepEqual(await t.call("apps.terminate", { id: app }), {}, `apps.terminate ${app}`);
			await t.until(async () => (await foreground(t)) !== app, `${app} not in front after apps.terminate`);
			await launchShown(t, app);
			t.deepEqual(await t.call("apps.terminate", { id: app }), {}, `apps.terminate ${app}, launched`);
			await t.until(async () => (await foreground(t)) !== app, `${app} no longer in front after apps.terminate`);
			const missing = await t.client.call("apps.launch", { id: "ai.agentrun.no.such.app" }, { signal: t.signal });
			t.refused(missing, "apps.launch of an app that is not installed", ["not_found"]);
		},
	},
	{
		id: "apps.launch",
		level: "core",
		group: "apps",
		needs: ["apps"],
		async run(t) {
			// The apps group alone: Settings listed; out of the way (terminated where the phone can, else left by the home
			// button); launched, in front and shown. It only navigates, so it runs on a phone that is the owner's own.
			const app = listedSettings(await t.call("apps.list", {}), t);
			await leaveApp(t, app);
			await t.until(async () => (await foreground(t)) !== app, `${app} not in front once left`);
			await launchShown(t, app);
			const missing = await t.client.call("apps.launch", { id: "ai.agentrun.no.such.app" }, { signal: t.signal });
			t.refused(missing, "apps.launch of an app that is not installed", ["not_found"]);
		},
	},
	{
		id: "apps.ui-tree-shape",
		level: "core",
		group: "apps",
		needs: ["apps.ui_tree"],
		async run(t) {
			const settings = throughSettings(t);
			if (settings) await openSettings(t);
			else await t.fixture();
			const screen = t.provider.capabilities().groups.includes("screen") ? await t.call("screen.shot", {}) : undefined;
			const rect: Rect | undefined = screen ? [0, 0, screen.width, screen.height] : undefined;
			const tree = await t.call("apps.ui_tree", {});
			const seen: { nodes: number; button?: UiNode } = { nodes: 0 };
			const wrong = shapeOf(tree.root, "root", rect, seen);
			t.assert(wrong === undefined, `apps.ui_tree: ${wrong}`);
			t.equal(tree.nodes, seen.nodes, "apps.ui_tree's nodes, against the nodes in its tree");
			t.equal(typeof tree.truncated, "boolean", "apps.ui_tree's truncated is a boolean");
			if (settings) {
				t.assert(rowsOf(tree).length > 0, "Settings' list, with its rows, in apps.ui_tree");
				return;
			}
			const button = t.present(seen.button, `the fixture's button, by its id ${FIXTURE_BUTTON.id}, in apps.ui_tree`);
			t.equal(button.text, FIXTURE_BUTTON.text, "the fixture's button's text");
		},
	},
];
