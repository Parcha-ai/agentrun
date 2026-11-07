// The model-free fixtures the screen, input, touch and apps cases check effects with. A fixture is an app that logs
// every input event it gets as one JSON line in a file the case reads over files. On a desktop it is computerd-fixture,
// a test-only static binary: a 200x200 override-redirect window at (0, 0) in four known colors, which grabs focus. On
// Android it is a small APK that logs touches and its own launch to its files directory and shows a button with a fixed
// id. This file is their contract: the binary and the APK come with the PRs that first run them.
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "../files.js";
import type { Button, Group, Point, Rect } from "../protocol.js";
import type { CaseContext } from "./types.js";

/** The desktop fixture's window, in screenshot pixels. */
export const FIXTURE_WINDOW: Rect = [0, 0, 200, 200];
/** The window's quadrants in RGB: top left, top right, bottom left, bottom right. */
export const FIXTURE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
	[255, 0, 0],
	[0, 255, 0],
	[0, 0, 255],
	[255, 255, 0],
];
/** The fixture APK's application id. */
export const FIXTURE_APP_ID = "ai.agentrun.fixture";
/** The APK's button, found in apps.ui_tree by its id. */
export const FIXTURE_BUTTON = { id: `${FIXTURE_APP_ID}:id/button`, text: "agentrun fixture" } as const;
/** Where the APK is written on a phone before apps.install. */
export const FIXTURE_APK_PATH = "/data/local/tmp/agentrun-fixture.apk";
/** Where the fixture app logs on a phone: its own files directory, which files reads without root. */
export const fixtureAppLog = (id: string) => `/sdcard/Android/data/${id}/files/events.jsonl`;

/** One line of a fixture's log. Points are screenshot pixels. */
export type FixtureEvent =
	/** The window is up with focus, or the app was launched. */
	| { event: "ready" }
	| { event: "down" | "up"; button: Button; at: Point }
	| { event: "wheel"; at: Point; dx: number; dy: number }
	| { event: "key"; key: string; down: boolean }
	/** Composed text, as the focused window gets it. */
	| { event: "text"; text: string }
	/** One finger: pointer is its index, from 0. */
	| { event: "touch"; pointer: number; phase: "down" | "move" | "up"; at: Point };

export interface StartedFixture {
	/** Where the fixture is, in screenshot pixels: an action aimed inside reaches it. */
	bounds: Rect;
	/** The app's id, when the fixture is an app. */
	app?: string;
	/** Every event it has logged since it started, in order. */
	events(): Promise<FixtureEvent[]>;
	/** Ends it; the runner calls this when the case ends. */
	stop(): Promise<void>;
}

/** Parses a log: one JSON object per line; a last line still being written is left for the next read. */
export function parseEvents(text: string, where: string): FixtureEvent[] {
	const lines = text.split("\n");
	lines.pop();
	return lines
		.filter((line) => line.trim() !== "")
		.map((line, i) => {
			try {
				return JSON.parse(line) as FixtureEvent;
			} catch {
				throw new Error(`${where} line ${i + 1} is not JSON: ${line.slice(0, 200)}`);
			}
		});
}

/** Skips the case, in words, unless the provider and the computer both declare every group the fixture needs. */
function needs(t: CaseContext, groups: Group[], what: string) {
	const declared = t.provider.capabilities().groups;
	const lacking = groups.filter((group) => !declared.includes(group) || !t.hello.groups.includes(group));
	if (lacking.length > 0) t.skip(`${what} needs ${lacking.join(", ")}, which this computer does not declare`);
}

/** Reads the log over files: none yet is no events. */
async function logOf(t: CaseContext, path: string): Promise<FixtureEvent[]> {
	const read = await readFile(t.client, path, { signal: t.signal });
	if (!read.ok && read.error.code === "not_found") return [];
	return parseEvents(Buffer.from(t.ok(read, `files.read of the fixture's log ${path}`)).toString("utf8"), `the fixture's log ${path}`);
}

async function ready(t: CaseContext, events: () => Promise<FixtureEvent[]>, what: string) {
	await t.until(async () => (await events()).some((e) => e.event === "ready"), `${what} logged ready`);
}

/**
 * Puts the fixture at path (on this machine) in the case's computer and starts it, by the computer's kind. launched gets
 * the fixture's stop as soon as it is launched, before it logs ready, so a fixture that never does is stopped too.
 */
export async function startFixture(t: CaseContext, path: string, launched: (stop: () => Promise<void>) => void): Promise<StartedFixture> {
	const { kind } = t.provider.capabilities();
	if (kind === "desktop") {
		needs(t, ["exec", "files", "processes"], "the desktop fixture");
		const dir = await t.dir();
		const bin = `${dir}/computerd-fixture`;
		const log = `${dir}/events.jsonl`;
		t.ok(await writeFile(t.client, bin, readFileSync(path), { mode: 0o755, signal: t.signal }), `files.write of the fixture to ${bin}`);
		const started = await t.call("process.start", { argv: [bin, "--log", log] });
		const events = () => logOf(t, log);
		const stop = async () => {
			await t.client.call("process.signal", { id: started.id, signal: "KILL" });
		};
		launched(stop);
		await ready(t, events, "the desktop fixture");
		return { bounds: FIXTURE_WINDOW, events, stop };
	}
	if (kind === "android") {
		needs(t, ["files", "apps", "apps.install", "screen"], "the fixture app");
		t.ok(await writeFile(t.client, FIXTURE_APK_PATH, readFileSync(path), { parents: true, signal: t.signal }), `files.write of the fixture to ${FIXTURE_APK_PATH}`);
		const app = await t.call("apps.install", { path: FIXTURE_APK_PATH });
		const log = fixtureAppLog(app.id);
		// A log from an earlier launch would read as this one's.
		const removed = await t.client.call("files.remove", { path: log }, { signal: t.signal });
		if (!removed.ok && removed.error.code !== "not_found") t.ok(removed, `files.remove of the fixture's old log ${log}`);
		await t.call("apps.launch", { id: app.id });
		const events = () => logOf(t, log);
		const stop = async () => {
			await t.client.call("apps.terminate", { id: app.id });
		};
		launched(stop);
		await ready(t, events, "the fixture app");
		const shot = await t.call("screen.shot", {});
		return { bounds: [0, 0, shot.width, shot.height], app: app.id, events, stop };
	}
	return t.skip(`no fixture runs on a ${kind} computer yet`);
}
