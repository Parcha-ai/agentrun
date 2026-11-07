// Input on a desktop, checked against the fixture's own log with no model: a click lands where and as often as asked,
// typed text arrives exactly, a batch with an unknown key runs nothing, and a batch stops at its first failure with
// nothing left held.
import type { Group, InputAction, InputActionsResult, Point } from "../../protocol.js";
import type { FixtureEvent, StartedFixture } from "../fixture.js";
import type { Case, CaseContext } from "../types.js";

/** A point inside the fixture, at these fractions of its width and height. */
export const pointIn = ({ bounds: [x, y, w, h] }: StartedFixture, fx: number, fy: number): Point => [Math.floor(x + fx * w), Math.floor(y + fy * h)];

export const act = (t: CaseContext, actions: InputAction[]): Promise<InputActionsResult> => t.call("input.actions", { actions });

/** Asserts every action of the batch ran. */
export function allRan(t: CaseContext, result: InputActionsResult, count: number, what: string) {
	t.deepEqual(result, { done: count }, `input.actions of ${what}`);
}

/** The events logged after the first `from`, once until() finds what it waits for in them. */
export async function logged(t: CaseContext, fixture: StartedFixture, from: number, done: (events: FixtureEvent[]) => boolean, what: string): Promise<FixtureEvent[]> {
	return t.until(async () => {
		const events = (await fixture.events()).slice(from);
		return done(events) ? events : undefined;
	}, what);
}

/** The pointer's presses and releases, in order, as [event, button, x, y]. */
const pointer = (events: FixtureEvent[]) => events.flatMap((e) => (e.event === "down" || e.event === "up" ? [[e.event, e.button, ...e.at]] : []));
/** Releases logged, at `at` when given, else anywhere: a click that lands elsewhere is still waited for, then compared. */
const ups = (events: FixtureEvent[], at?: Point) => events.filter((e) => e.event === "up" && (at === undefined || (e.at[0] === at[0] && e.at[1] === at[1]))).length;
const text = (events: FixtureEvent[]) => events.flatMap((e) => (e.event === "text" ? [e.text] : [])).join("");

/** Whether the provider and the computer both declare group. */
const declares = (t: CaseContext, group: Group) => t.provider.capabilities().groups.includes(group) && t.hello.groups.includes(group);

export const TYPED = "Hello, agentrun! 123";
/** A point no display has. */
const OFF_SCREEN: Point = [100_000, 100_000];

const input = (name: string, needs: Group[], run: Case["run"]): Case => ({ id: `input.${name}`, level: "core", group: "input", needs, run });

export const inputCases: Case[] = [
	input("click-lands", ["input.pointer"], async (t) => {
		const fixture = await t.fixture();
		const a = pointIn(fixture, 0.2, 0.3);
		const b = pointIn(fixture, 0.7, 0.6);
		const before = (await fixture.events()).length;
		allRan(t, await act(t, [{ type: "click", at: a }]), 1, `a click at ${a}`);
		const single = await logged(t, fixture, before, (events) => ups(events) >= 1, `a click at ${a} in the fixture's log`);
		t.deepEqual(pointer(single), [["down", "left", ...a], ["up", "left", ...a]], `the fixture's log of a click at ${a}`);
		const middle = before + single.length;
		allRan(t, await act(t, [{ type: "click", at: b, count: 2 }]), 1, `a double click at ${b}`);
		const double = await logged(t, fixture, middle, (events) => ups(events) >= 2, `a double click at ${b} in the fixture's log`);
		t.deepEqual(
			pointer(double),
			[["down", "left", ...b], ["up", "left", ...b], ["down", "left", ...b], ["up", "left", ...b]],
			`the fixture's log of a double click at ${b}`,
		);
	}),
	input("type-text", ["input.keys"], async (t) => {
		const fixture = await t.fixture();
		const before = (await fixture.events()).length;
		allRan(t, await act(t, [{ type: "type", text: TYPED }]), 1, `typing ${JSON.stringify(TYPED)}`);
		const events = await logged(t, fixture, before, (events) => text(events).length >= TYPED.length, `${TYPED.length} characters in the fixture's log`);
		t.equal(text(events), TYPED, "the text the fixture got");
	}),
	input("key-table-refuses-unknown", ["input.keys"], async (t) => {
		const fixture = await t.fixture();
		const before = (await fixture.events()).length;
		// The spec's click when the computer has a pointer, else a key: either way the first action is valid.
		const first: InputAction = declares(t, "input.pointer") ? { type: "click", at: pointIn(fixture, 0.5, 0.5) } : { type: "key", keys: ["a"] };
		const refused = await act(t, [first, { type: "key", keys: ["Hyper_Q"] }]);
		t.equal(refused.done, 0, "done, for a batch whose second action names a key not in KEYS");
		t.equal(refused.failed?.index, 1, "failed.index");
		t.equal(refused.failed?.kind, "invalid", "failed.kind");
		t.assert(typeof refused.failed?.message === "string" && refused.failed.message !== "", "the failure is in words");
		// A later batch that lands shows the refused one ran nothing before it.
		allRan(t, await act(t, [{ type: "type", text: "z" }]), 1, 'typing "z" after the refused batch');
		const events = await logged(t, fixture, before, (events) => text(events).includes("z"), '"z" in the fixture\'s log');
		t.deepEqual(pointer(events), [], "the pointer events of the refused batch");
		t.equal(text(events), "z", "the text the fixture got: the refused batch's first action did not run");
	}),
	input("actions-stops-at-first-failure", ["input.pointer"], async (t) => {
		const fixture = await t.fixture();
		const a = pointIn(fixture, 0.25, 0.25);
		const b = pointIn(fixture, 0.75, 0.75);
		const c = pointIn(fixture, 0.5, 0.5);
		const before = (await fixture.events()).length;
		const stopped = await act(t, [{ type: "click", at: a }, { type: "move", at: OFF_SCREEN }, { type: "click", at: b }]);
		t.equal(stopped.done, 1, `done, for [click ${a}, move off-screen to ${OFF_SCREEN}, click ${b}]`);
		t.equal(stopped.failed?.index, 1, "failed.index");
		t.assert(typeof stopped.failed?.message === "string" && stopped.failed.message !== "", "the failure is in words");
		// A later click lands normally: nothing the stopped batch did was left held.
		allRan(t, await act(t, [{ type: "click", at: c }]), 1, `a click at ${c} after it`);
		const events = await logged(t, fixture, before, (events) => ups(events, c) >= 1, `the click at ${c} in the fixture's log`);
		t.deepEqual(
			pointer(events),
			[["down", "left", ...a], ["up", "left", ...a], ["down", "left", ...c], ["up", "left", ...c]],
			`the fixture's log: the click at ${a} and the later one at ${c}, and none at ${b}`,
		);
	}),
];
