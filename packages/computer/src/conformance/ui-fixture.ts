// The ui fixture: a small app whose behaviour the ui cases know, so they check what a driver did with no model. A
// driver's conformance image installs it (the fake ui driver has it built in); a computer without it skips the cases
// that act, in words. Its windows, in points:
//
//   home     "UI fixture" heading, a "Name" text field, a "Wi-Fi" switch (its secondary text "Networks nearby", the
//            node's desc), "Save", "Next", and a "Canvas" that takes foreground input only (no semantic or
//            background route reaches it). The canvas's value is the number of clicks that reached it, "0" at launch,
//            which is how a driver reads back whether its click landed.
//   saved    home, plus the text "Saved": Save shows it SAVED_MS after its press, so only an expect sees it
//   second   "Second page" heading and "Back": Next opens it NEXT_MS after its press, with a transition of NEXT_ANIMATE_MS
//            first. Back returns home. The Name field is not on it, so its ref is stale there.
//
// Its windows, beside the screens of its main one:
//
//   home     also "New window" (id open), which opens a second window titled "Another window" NEW_WINDOW_MS after its
//            press, in front; "Close" (id close), which closes the window it is in; and a "Code" text field (id code)
//            that takes back any value set into it TAKES_BACK_MS later, as an app that refuses an input does.
//   another  "Another window" heading and "Close" (id close), which closes it.
//
// Closing the main window leaves the app running with the windows it has left, or none (as a Mac app does), and
// apps.launch of an app with no window opens its main window again on its home screen. A fixture that cannot open a
// second window (one window per app, as on a phone) leaves out New window, and the window cases skip in words.
import type { Rect, UiFlag, UiRole, UiRoute } from "../protocol.js";

/**
 * What pressing an element does, `after` ms later: go opens a screen in its window (through a transition of
 * animateMs), open opens a new window of the app on that screen, in front, and close closes the window it is in.
 */
export interface FakeEffect {
	go?: string;
	open?: string;
	close?: true;
	after?: number;
	animateMs?: number;
}

/** One element of a scripted app. The same key on two screens is the same element (its ref survives the change). */
export interface FakeElement {
	key: string;
	role: UiRole;
	name?: string;
	value?: string;
	desc?: string;
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
	/** The best route that reaches it; default semantic. Only foreground input reaches a foreground element. */
	route?: UiRoute;
	/** Its value is the number of clicks that reached it, so a driver can read back whether one landed. */
	counts?: boolean;
	/** A set into it is taken back this many ms later: its value returns to what it was. */
	takesBack?: number;
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
export const NEW_WINDOW_MS = 300;
/** Well inside SET_HOLD_MS, so an act that set the Code field reads it taken back before it answers. */
export const TAKES_BACK_MS = 150;

const home: FakeElement[] = [
	{ key: "title", role: "heading", name: "UI fixture", bounds: [16, 16, 300, 24] },
	{ key: "name", role: "textbox", name: "Name", value: "", id: "name", bounds: [16, 56, 200, 28], actions: ["AXConfirm"] },
	{ key: "wifi", role: "switch", name: "Wi-Fi", desc: "Networks nearby", id: "wifi", bounds: [16, 96, 60, 28], actions: ["AXPress"] },
	{ key: "save", role: "button", name: "Save", id: "save", bounds: [16, 136, 80, 28], actions: ["AXPress"], press: { go: "saved", after: SAVED_MS } },
	{ key: "next", role: "button", name: "Next", id: "next", bounds: [112, 136, 80, 28], actions: ["AXPress"], press: { go: "second", after: NEXT_MS, animateMs: NEXT_ANIMATE_MS } },
	{ key: "canvas", role: "image", name: "Canvas", id: "canvas", value: "0", bounds: [16, 180, 200, 100], route: "foreground", counts: true },
	{ key: "open", role: "button", name: "New window", id: "open", bounds: [92, 96, 104, 28], actions: ["AXPress"], press: { open: "another", after: NEW_WINDOW_MS } },
	{ key: "close", role: "button", name: "Close", id: "close", bounds: [208, 96, 80, 28], actions: ["AXPress"], press: { close: true } },
	{ key: "code", role: "textbox", name: "Code", value: "", id: "code", bounds: [228, 56, 76, 28], takesBack: TAKES_BACK_MS },
];

/** The fixture's app, as the fake ui driver runs it. */
export const UI_FIXTURE: FakeApp = {
	// A valid Android package name and macOS bundle id alike (no hyphen), in a window that fits a small phone's portrait.
	id: "ai.agentrun.uifixture",
	name: "UI fixture",
	start: "home",
	size: [320, 320],
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
		another: {
			title: "Another window",
			elements: [
				{ key: "title3", role: "heading", name: "Another window", bounds: [16, 16, 300, 24] },
				{ key: "close", role: "button", name: "Close", id: "close", bounds: [16, 56, 80, 28], actions: ["AXPress"], press: { close: true } },
			],
		},
	},
};
