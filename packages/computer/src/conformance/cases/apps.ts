// Apps: the fixture installs, is listed, comes to the front when launched and leaves it when terminated; the UI tree has
// the protocol's shape, inside the screen, with the fixture's button found by its id.
import { MAX_UI_NODES, type Rect, type UiNode } from "../../protocol.js";
import { FIXTURE_BUTTON } from "../fixture.js";
import type { Case, CaseContext } from "../types.js";

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

export const appsCases: Case[] = [
	{
		id: "apps.install-launch",
		level: "core",
		group: "apps",
		needs: ["apps.install", "apps", "files"],
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
		id: "apps.ui-tree-shape",
		level: "core",
		group: "apps",
		needs: ["apps.ui_tree"],
		async run(t) {
			await t.fixture();
			const screen = t.provider.capabilities().groups.includes("screen") ? await t.call("screen.shot", {}) : undefined;
			const rect: Rect | undefined = screen ? [0, 0, screen.width, screen.height] : undefined;
			const tree = await t.call("apps.ui_tree", {});
			const seen: { nodes: number; button?: UiNode } = { nodes: 0 };
			const wrong = shapeOf(tree.root, "root", rect, seen);
			t.assert(wrong === undefined, `apps.ui_tree: ${wrong}`);
			t.equal(tree.nodes, seen.nodes, "apps.ui_tree's nodes, against the nodes in its tree");
			t.equal(typeof tree.truncated, "boolean", "apps.ui_tree's truncated is a boolean");
			const button = t.present(seen.button, `the fixture's button, by its id ${FIXTURE_BUTTON.id}, in apps.ui_tree`);
			t.equal(button.text, FIXTURE_BUTTON.text, "the fixture's button's text");
		},
	},
];
