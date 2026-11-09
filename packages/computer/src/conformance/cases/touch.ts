// Touch on a phone, checked against the fixture app's log: a tap lands at its point, a swipe starts and ends where
// asked, and a pinch moves two fingers apart. A phone that takes no fixture file is checked through Settings and its
// UI tree instead (settings.ts): a tap on a row opens that row's page, the back button comes back, and a swipe up
// moves the list up. A phone with neither files nor a tree (a cloud iPhone) is checked on Settings' screen: a swipe up
// its list changes the screenshot. A tap there is not seen, since what it opened would show only in a tree, and the
// run taps nothing on a phone that may be the owner's own.
import type { Point, UiTreeResult } from "../../protocol.js";
import type { FixtureEvent, StartedFixture } from "../fixture.js";
import type { Case, CaseContext } from "../types.js";
import { act, allRan, logged, pointIn } from "./input.js";
import { screenPrint } from "./screen.js";
import { listOf, middle, openSettings, rowsOf, settingsRows, showsName, tapScene, textsOf, throughSettings, throughSettingsScreen } from "./settings.js";

/** How far a logged touch may be from where it was aimed: a phone's input path may round. */
const SLACK = 2;

type Touch = Extract<FixtureEvent, { event: "touch" }>;
const touches = (events: FixtureEvent[]) => events.filter((e): e is Touch => e.event === "touch");
const near = (a: Point, b: Point) => Math.abs(a[0] - b[0]) <= SLACK && Math.abs(a[1] - b[1]) <= SLACK;
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lifted = (events: FixtureEvent[], fingers: number) => new Set(touches(events).filter((e) => e.phase === "up").map((e) => e.pointer)).size >= fingers;

/** The fixture, once the case has a way to see what touch did (what, in words): the fixture's log over files. */
async function observed(t: CaseContext, what: string): Promise<StartedFixture> {
	const declared = t.provider.capabilities().groups;
	if (!declared.includes("files")) {
		// Owed to the two groups that would show it, neither of which the phone declares.
		if (!declared.includes("apps.ui_tree")) return t.skip(`no way to observe ${what} on this phone: it declares neither files nor apps.ui_tree`, { undeclared: ["files", "apps.ui_tree"] });
		return t.skip(`no fixture runs on a ${t.provider.capabilities().kind} computer with no files, and no stock app is known for it`);
	}
	return t.fixture();
}

/**
 * A tap on Settings' first row opens its page: the row's title shows, as a text or a label (a live Android 15 page
 * shows it only as its toolbar's content-desc), and the next row is gone. Back comes back to the list. A tap that lands
 * nowhere leaves the next row, and one on another row shows another title, so neither passes.
 */
async function tapThroughSettings(t: CaseContext) {
	await openSettings(t);
	const { rows } = await settingsRows(t, 2);
	const [row, next] = [rows[0], t.present(rows.find((one) => one.text !== rows[0].text), "a second row with another title")];
	const at = middle(row.bounds);
	allRan(t, await act(t, [{ type: "tap", at }]), 1, `a tap on Settings' row ${JSON.stringify(row.text)} at ${at}`);
	let seen: UiTreeResult | undefined;
	try {
		await t.until(async () => {
			seen = await t.call("apps.ui_tree", {});
			return showsName(seen, row.text) && !showsName(seen, next.text);
		}, `the page of ${JSON.stringify(row.text)} after a tap on its row: its title, as a text or a label, and not the row ${JSON.stringify(next.text)}`);
	} catch (error) {
		// A live run showed only the wait: the words say what the case saw, so a page beside the list tells apart from a
		// tap that missed.
		throw new Error(`${error instanceof Error ? error.message : String(error)} (${await tapScene(t, { at, row, next, tree: seen })})`);
	}
	allRan(t, await act(t, [{ type: "button", name: "back" }]), 1, "the back button");
	await t.until(async () => textsOf(await t.call("apps.ui_tree", {})).includes(next.text), `Settings' list again after back: the row ${JSON.stringify(next.text)}`);
}

/** A swipe up Settings' list moves it up: a row on screen before and after is higher by a quarter of the swipe at least, or the first row has left. */
async function swipeThroughSettings(t: CaseContext) {
	await openSettings(t);
	const { tree, rows } = await settingsRows(t, 2);
	const [x, y, w, h] = t.present(listOf(tree), "Settings' list in apps.ui_tree").bounds;
	const from: Point = [Math.floor(x + w / 2), Math.floor(y + h * 0.8)];
	const to: Point = [from[0], Math.floor(y + h * 0.2)];
	allRan(t, await act(t, [{ type: "swipe", path: [from, to], ms: 400 }]), 1, `a swipe up Settings' list from ${from} to ${to}`);
	const enough = (from[1] - to[1]) / 4;
	await t.until(async () => {
		const after = rowsOf(await t.call("apps.ui_tree", {}));
		const moved = rows.some((before) => {
			const now = after.find((one) => one.text === before.text);
			return now !== undefined && before.bounds[1] - now.bounds[1] >= enough;
		});
		return moved || (after.length > 0 && !after.some((one) => one.text === rows[0].text));
	}, `Settings' list moved up by ${Math.round(enough)} px at least after a swipe up`);
}

/**
 * A swipe up Settings' list, seen on the screen: a screenshot after it is not the one before. It scrolls, which only
 * navigates. From 70% to 30% of the screen's height, clear of the edges a phone keeps for its own gestures.
 */
async function swipeOnSettingsScreen(t: CaseContext) {
	await openSettings(t);
	const { width, height } = await t.call("screen.shot", {});
	const before = await screenPrint(t);
	const from: Point = [Math.floor(width / 2), Math.floor(height * 0.7)];
	const to: Point = [from[0], Math.floor(height * 0.3)];
	allRan(t, await act(t, [{ type: "swipe", path: [from, to], ms: 400 }]), 1, `a swipe up Settings' list from ${from} to ${to}`);
	await t.until(async () => (await screenPrint(t)) !== before, `Settings' list scrolled after a swipe up: a screenshot other than the one before it`);
}

/** One finger's touches: where it went down, and where it came up. */
function stroke(t: CaseContext, events: FixtureEvent[], pointer: number, what: string): { down: Point; up: Point } {
	const mine = touches(events).filter((e) => e.pointer === pointer);
	const down = t.present(mine.find((e) => e.phase === "down"), `${what}: the fixture logged no touch down of finger ${pointer}`);
	const up = t.present(mine.findLast((e) => e.phase === "up"), `${what}: the fixture logged no touch up of finger ${pointer}`);
	return { down: down.at, up: up.at };
}

const touch = (name: string, run: Case["run"], level: Case["level"] = "core"): Case => ({ id: `touch.${name}`, level, group: "touch", needs: ["input.touch"], run });

export const touchCases: Case[] = [
	touch("tap", async (t) => {
		if (throughSettings(t)) return tapThroughSettings(t);
		const fixture = await observed(t, "a tap");
		const at = pointIn(fixture, 0.5, 0.4);
		const before = (await fixture.events()).length;
		allRan(t, await act(t, [{ type: "tap", at }]), 1, `a tap at ${at}`);
		const events = await logged(t, fixture, before, (events) => lifted(events, 1), `a tap in the fixture's log`);
		t.deepEqual([...new Set(touches(events).map((e) => e.pointer))], [0], "the fingers a tap used");
		const { down, up } = stroke(t, events, 0, "a tap");
		t.assert(near(down, at) && near(up, at), `a tap at ${at} was logged down at ${down} and up at ${up}`);
	}),
	touch("swipe", async (t) => {
		if (throughSettings(t)) return swipeThroughSettings(t);
		if (throughSettingsScreen(t)) return swipeOnSettingsScreen(t);
		const fixture = await observed(t, "a swipe");
		const from = pointIn(fixture, 0.5, 0.7);
		const to = pointIn(fixture, 0.5, 0.3);
		const before = (await fixture.events()).length;
		allRan(t, await act(t, [{ type: "swipe", path: [from, to], ms: 300 }]), 1, `a swipe from ${from} to ${to}`);
		const events = await logged(t, fixture, before, (events) => lifted(events, 1), "a swipe in the fixture's log");
		const { down, up } = stroke(t, events, 0, "a swipe");
		t.assert(near(down, from), `a swipe from ${from} was logged starting at ${down}`);
		t.assert(near(up, to), `a swipe to ${to} was logged ending at ${up}`);
	}),
	touch(
		"pinch",
		async (t) => {
			if (throughSettings(t)) {
				// Settings shows nothing a pinch changes; a provider that refuses pinch says so, and either way it is not seen.
				const shot = await t.call("screen.shot", {});
				const tried = await act(t, [{ type: "pinch", at: [Math.floor(shot.width / 2), Math.floor(shot.height / 2)], scale: 2, ms: 400 }]);
				if (tried.failed?.kind === "unsupported") return t.skip(`the provider refuses a pinch in words: ${tried.failed.message}`);
				return t.skip("a pinch shows nothing in Settings' tree; only the fixture's log sees one");
			}
			const fixture = await observed(t, "a pinch");
			const at = pointIn(fixture, 0.5, 0.5);
			const before = (await fixture.events()).length;
			allRan(t, await act(t, [{ type: "pinch", at, scale: 2, ms: 400 }]), 1, `a pinch apart at ${at}`);
			const events = await logged(t, fixture, before, (events) => lifted(events, 2), "two fingers in the fixture's log");
			const one = stroke(t, events, 0, "a pinch");
			const two = stroke(t, events, 1, "a pinch");
			const start = distance(one.down, two.down);
			const end = distance(one.up, two.up);
			t.assert(end > start, `a pinch apart: the fingers went from ${Math.round(start)} px apart to ${Math.round(end)} px`);
		},
		"full",
	),
];
