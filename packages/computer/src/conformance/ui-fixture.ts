// The ui fixture: a small app whose behaviour the ui cases know, so they check what a driver did with no model. A
// driver's conformance image installs it (the fake ui driver has it built in); a computer without it skips the cases
// that act, in words. Its windows, in points:
//
//   home     "UI fixture" heading, a "Name" text field, a "Wi-Fi" switch, "Save", "Next", and a "Canvas" that takes
//            foreground input only (no semantic or background route reaches it)
//   saved    home, plus the text "Saved": Save shows it SAVED_MS after its press, so only an expect sees it
//   second   "Second page" heading and "Back": Next opens it NEXT_MS after its press, with a transition of NEXT_ANIMATE_MS
//            first. Back returns home. The Name field is not on it, so its ref is stale there.
import type { Rect, UiFlag, UiRole, UiRoute } from "../protocol.js";

/** What pressing an element does: open a screen of its app, `after` ms later, through a transition of animateMs. */
export interface FakeEffect {
	go: string;
	after?: number;
	animateMs?: number;
}

/** One element of a scripted app. The same key on two screens is the same element (its ref survives the change). */
export interface FakeElement {
	key: string;
	role: UiRole;
	name?: string;
	value?: string;
	id?: string;
	/** In window points. */
	bounds: Rect;
	/** The key of the element above it, which comes before it. */
	parent?: string;
	flags?: UiFlag[];
	actions?: string[];
	press?: FakeEffect;
	/** What enter does while this element has the focus. */
	enter?: FakeEffect;
	/** The best route that reaches it; default semantic. A foreground element is refused unless the call allows it. */
	route?: UiRoute;
}

export interface FakeScreen {
	title?: string;
	elements: FakeElement[];
}

/** A scripted app: its screens, the first one shown, and its window's size in points. */
export interface FakeApp {
	id: string;
	name: string;
	start: string;
	size: [number, number];
	screens: Record<string, FakeScreen>;
}

export const SAVED_MS = 300;
export const NEXT_MS = 200;
export const NEXT_ANIMATE_MS = 300;

const home: FakeElement[] = [
	{ key: "title", role: "heading", name: "UI fixture", bounds: [16, 16, 300, 24] },
	{ key: "name", role: "textbox", name: "Name", value: "", id: "name", bounds: [16, 56, 200, 28], actions: ["AXConfirm"] },
	{ key: "wifi", role: "switch", name: "Wi-Fi", id: "wifi", bounds: [16, 96, 60, 28], actions: ["AXPress"] },
	{ key: "save", role: "button", name: "Save", id: "save", bounds: [16, 136, 80, 28], actions: ["AXPress"], press: { go: "saved", after: SAVED_MS } },
	{ key: "next", role: "button", name: "Next", id: "next", bounds: [112, 136, 80, 28], actions: ["AXPress"], press: { go: "second", after: NEXT_MS, animateMs: NEXT_ANIMATE_MS } },
	{ key: "canvas", role: "image", name: "Canvas", id: "canvas", bounds: [16, 180, 200, 100], route: "foreground" },
];

/** The fixture's app, as the fake ui driver runs it. */
export const UI_FIXTURE: FakeApp = {
	id: "ai.agentrun.ui-fixture",
	name: "UI fixture",
	start: "home",
	size: [480, 320],
	screens: {
		home: { title: "UI fixture", elements: home },
		saved: { title: "UI fixture", elements: [...home, { key: "saved", role: "text", name: "Saved", bounds: [208, 136, 80, 28] }] },
		second: {
			title: "Second page",
			elements: [
				{ key: "title2", role: "heading", name: "Second page", bounds: [16, 16, 300, 24] },
				{ key: "back", role: "button", name: "Back", id: "back", bounds: [16, 56, 80, 28], actions: ["AXPress"], press: { go: "home" } },
			],
		},
	},
};
