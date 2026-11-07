// Touch on a phone, checked against the fixture app's log: a tap lands at its point, a swipe starts and ends where
// asked, and a pinch moves two fingers apart.
import type { Point } from "../../protocol.js";
import type { FixtureEvent, StartedFixture } from "../fixture.js";
import type { Case, CaseContext } from "../types.js";
import { act, allRan, logged, pointIn } from "./input.js";

/** How far a logged touch may be from where it was aimed: a phone's input path may round. */
const SLACK = 2;

type Touch = Extract<FixtureEvent, { event: "touch" }>;
const touches = (events: FixtureEvent[]) => events.filter((e): e is Touch => e.event === "touch");
const near = (a: Point, b: Point) => Math.abs(a[0] - b[0]) <= SLACK && Math.abs(a[1] - b[1]) <= SLACK;
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lifted = (events: FixtureEvent[], fingers: number) => new Set(touches(events).filter((e) => e.phase === "up").map((e) => e.pointer)).size >= fingers;

/** The fixture, once the case has a way to see what touch did: today, the fixture's log over files. */
async function observed(t: CaseContext): Promise<StartedFixture> {
	const declared = t.provider.capabilities().groups;
	if (!declared.includes("files")) {
		if (!declared.includes("apps.ui_tree")) return t.skip("no way to observe the effect: declare files or apps.ui_tree");
		return t.skip("seeing touch through apps.ui_tree alone is settled in the phone spike; today the suite reads the fixture's log over files");
	}
	return t.fixture();
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
		const fixture = await observed(t);
		const at = pointIn(fixture, 0.5, 0.4);
		const before = (await fixture.events()).length;
		allRan(t, await act(t, [{ type: "tap", at }]), 1, `a tap at ${at}`);
		const events = await logged(t, fixture, before, (events) => lifted(events, 1), `a tap in the fixture's log`);
		t.deepEqual([...new Set(touches(events).map((e) => e.pointer))], [0], "the fingers a tap used");
		const { down, up } = stroke(t, events, 0, "a tap");
		t.assert(near(down, at) && near(up, at), `a tap at ${at} was logged down at ${down} and up at ${up}`);
	}),
	touch("swipe", async (t) => {
		const fixture = await observed(t);
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
			const fixture = await observed(t);
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
