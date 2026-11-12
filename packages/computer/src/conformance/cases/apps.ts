// Apps: the fixture installs, is listed, comes to the front when launched and leaves it when terminated; ui.observe has
// the protocol's shape, inside its window, with the fixture's button found by its id. A phone's stock Settings app is
// listed, launched and terminated with no install, which needs the apps group alone: its launch is seen in ui.observe
// (Settings' list) when the phone has the ui group, else in a screenshot that is not the one before. On a phone that
// takes no fixture file the observation's shape is checked on Settings, with its rows found (settings.ts).
import { MAX_UI_NODES, type Rect, UI_FLAGS, UI_ROLES, type UiNode } from "../../protocol.js";
import { FIXTURE_BUTTON } from "../fixture.js";
import type { Case, CaseContext } from "../types.js";
import { shoot } from "./screen.js";
import { namesOf, observe, openSettings, rowsOf, settingsApp, throughSettings } from "./settings.js";

/** Whether the provider and the computer both declare group. */
const declares = (t: CaseContext, group: "ui" | "screen") => t.provider.capabilities().groups.includes(group) && t.hello.groups.includes(group);

/** A screenshot's pixels sampled on a 16 x 16 grid, with its size: two different screens differ in it. */
async function screenPrint(t: CaseContext): Promise<string> {
	const { image } = await shoot(t);
	const samples: string[] = [];
	for (let j = 0; j < 16; j++) {
		for (let i = 0; i < 16; i++) samples.push(image.rgb(Math.floor(((i + 0.5) * image.width) / 16), Math.floor(((j + 0.5) * image.height) / 16)).join(","));
	}
	return `${image.width}x${image.height}:${samples.join(";")}`;
}

/**
 * What the screen shows now, as the case compares it: ui.observe's names and values when the phone has the ui group,
 * else a screenshot's print. Undefined when it has neither, and the launch cannot be seen.
 */
async function shown(t: CaseContext): Promise<string | undefined> {
	if (declares(t, "ui")) return JSON.stringify(namesOf(await observe(t)));
	if (declares(t, "screen")) return screenPrint(t);
	return undefined;
}

const ROLES: ReadonlySet<string> = new Set(UI_ROLES);
const FLAGS: ReadonlySet<string> = new Set(UI_FLAGS);
const show = (value: unknown) => JSON.stringify(value) ?? String(value);
const isRect = (value: unknown): value is Rect => Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number" && Number.isFinite(v)) && value[2] >= 0 && value[3] >= 0;
const strings = (value: unknown) => Array.isArray(value) && value.every((one) => typeof one === "string");

/**
 * The first way ui.observe's result breaks the protocol, in words, or undefined: its state, app, window and truncated,
 * and each node against UiNode, its bounds inside the window and its parent a node before it.
 */
function observeWrong(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return "the result is not an object";
	const r = result as Record<string, unknown>;
	if (typeof r.state !== "string" || r.state === "") return `state is ${show(r.state)}, not a state id`;
	if (typeof r.truncated !== "boolean") return `truncated is ${show(r.truncated)}, not a boolean`;
	const app = r.app as Record<string, unknown> | undefined;
	if (typeof app?.id !== "string" || typeof app.name !== "string") return `app is ${show(r.app)}, not { id, name }`;
	const window = r.window as Record<string, unknown> | undefined;
	if (typeof window?.id !== "string" || !isRect(window.bounds)) return `window is ${show(r.window)}, not { id, bounds: [x, y, w, h] }`;
	const [, , width, height] = window.bounds;
	if (!Array.isArray(r.nodes)) return `nodes is ${show(r.nodes)}, not a list`;
	if (r.nodes.length > MAX_UI_NODES) return `nodes holds ${r.nodes.length}, more than the ${MAX_UI_NODES} one observe gives`;
	const refs = new Set<string>();
	for (const [i, node] of r.nodes.entries()) {
		const at = `nodes[${i}]`;
		if (typeof node !== "object" || node === null) return `${at} is not an object`;
		const n = node as Record<string, unknown>;
		if (typeof n.ref !== "string" || !n.ref.startsWith("@") || n.ref.length < 2) return `${at}.ref is ${show(n.ref)}, not a ref ("@e12")`;
		if (refs.has(n.ref)) return `${at}.ref ${n.ref} is a ref an earlier node has`;
		if (typeof n.role !== "string" || !ROLES.has(n.role)) return `${at}.role is ${show(n.role)}, not one of the protocol's roles (UI_ROLES)`;
		for (const field of ["name", "value", "id"]) if (n[field] !== undefined && typeof n[field] !== "string") return `${at}.${field} is ${show(n[field])}, not a string`;
		if (!isRect(n.bounds)) return `${at}.bounds is ${show(n.bounds)}, not [x, y, w, h]`;
		const [x, y, w, h] = n.bounds;
		if (x < 0 || y < 0 || x + w > width || y + h > height) return `${at}.bounds ${show(n.bounds)} reach outside the window's ${width}x${height} points`;
		if (n.parent !== undefined && (typeof n.parent !== "string" || !refs.has(n.parent))) return `${at}.parent is ${show(n.parent)}, not the ref of a node before it`;
		if (n.flags !== undefined && !(strings(n.flags) && (n.flags as string[]).every((flag) => FLAGS.has(flag)))) return `${at}.flags is ${show(n.flags)}, not a list of the protocol's flags`;
		if (n.actions !== undefined && !strings(n.actions)) return `${at}.actions is ${show(n.actions)}, not a list of action names`;
		if ((n.flags as string[] | undefined)?.includes("secure") && n.value !== undefined) return `${at} is secure and sends its value`;
		refs.add(n.ref);
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
		id: "apps.launch-terminate",
		level: "core",
		group: "apps",
		needs: ["apps"],
		async run(t) {
			// The phone's own Settings app: listed; launched, in front and shown; terminated, and no longer in front.
			const app = settingsApp(t);
			const listed = await t.call("apps.list", {});
			t.assert(Array.isArray(listed.apps) && listed.apps.every((one) => typeof one?.id === "string"), `apps.list gives apps with ids: ${JSON.stringify(listed.apps).slice(0, 300)}`);
			t.assert(listed.apps.some((one) => one.id === app), `apps.list holds ${app}`);
			t.deepEqual(await t.call("apps.terminate", { id: app }), {}, `apps.terminate ${app}`);
			await t.until(async () => (await foreground(t)) !== app, `${app} not in front after apps.terminate`);
			const before = await shown(t);
			if (before === undefined) return t.skip("no way to see a launch: the computer declares neither ui nor screen");
			t.deepEqual(await t.call("apps.launch", { id: app }), {}, `apps.launch ${app}`);
			await t.until(async () => (await foreground(t)) === app, `${app} in front after apps.launch`);
			// apps.list's word is not enough: the screen must show it.
			if (declares(t, "ui")) {
				await t.until(async () => {
					const seen = await observe(t);
					return rowsOf(seen).length > 0 && JSON.stringify(namesOf(seen)) !== before;
				}, `${app} shown after apps.launch: Settings' list in ui.observe, not the screen before it`);
			} else {
				await t.until(async () => (await screenPrint(t)) !== before, `${app} shown after apps.launch: a screenshot other than the one before it`);
			}
			t.deepEqual(await t.call("apps.terminate", { id: app }), {}, `apps.terminate ${app}, launched`);
			await t.until(async () => (await foreground(t)) !== app, `${app} no longer in front after apps.terminate`);
			const missing = await t.client.call("apps.launch", { id: "ai.agentrun.no.such.app" }, { signal: t.signal });
			t.refused(missing, "apps.launch of an app that is not installed", ["not_found"]);
		},
	},
	{
		id: "ui.observe-shape",
		level: "core",
		group: "ui",
		needs: ["ui"],
		async run(t) {
			const settings = throughSettings(t);
			if (settings) await openSettings(t);
			else await t.fixture();
			// Settings comes up, or the fixture's button, before the shape is read: a phone draws its window after the launch.
			const seen = await t.until(async () => {
				const one = await observe(t);
				const ready = settings ? rowsOf(one).length > 0 : one.nodes.some((node) => node.id === FIXTURE_BUTTON.id);
				return ready || observeWrong(one) !== undefined ? one : undefined;
			}, settings ? "Settings' list, with its rows, in ui.observe" : `the fixture's button, by its id ${FIXTURE_BUTTON.id}, in ui.observe`);
			const wrong = observeWrong(seen);
			t.assert(wrong === undefined, `ui.observe: ${wrong}`);
			if (settings) return;
			const button = t.present(
				seen.nodes.find((node: UiNode) => node.id === FIXTURE_BUTTON.id),
				`the fixture's button, by its id ${FIXTURE_BUTTON.id}, in ui.observe`,
			);
			t.equal(button.name, FIXTURE_BUTTON.text, "the fixture's button's name");
		},
	},
];
