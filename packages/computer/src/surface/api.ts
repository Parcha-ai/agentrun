// The computer as an agent's code sees it: one typed `computer` object. This file is the source of computer.d.ts
// (scripts/generate-computer-surface.mjs renders it, with the protocol's types it names) and of the per-step tools'
// schemas (computer_observe, computer_act, computer_screenshot, computer_script). Every surface answers through one
// core (core.ts): a script's call, a per-step tool and the claim's MCP endpoint return the same values.
//
// A member of Computer marked `@group <name> [<name> ...]` exists only on a computer that declares one of those groups
// (its hello), so a model is never offered what the computer can't do. The steps are the protocol's own (UiStep): one step language for a
// script, a tool call and the wire.
import type { ComputerKind, ComputerOs, FileType, InputAction, Point, Rect, ScreenSize, UiExpect, UiNode, UiRef, UiRoute, UiStep } from "../protocol.js";

/** An image a script can show the model with `image(...)`: base64 PNG or JPEG, with its size in pixels. */
export interface Image {
	type: "image";
	mimeType: "image/png" | "image/jpeg";
	/** base64. */
	data: string;
	width: number;
	height: number;
}

/** What the computer is, from its hello. */
export interface Card {
	kind: ComputerKind;
	os: ComputerOs;
	/** The OS's own version, as "15" or "26.1", where the computer says it. */
	osVersion?: string;
	arch: string;
	/** The main screen, in points, where the computer has one. */
	screen?: ScreenSize;
	/** What the computer offers (hello.groups): each namespace below is here only with its group. */
	groups: string[];
	/** What its groups can and cannot do here: a feature that is off says why. */
	features: Record<string, true | { off: string }>;
}

/** One observation of an app's window: its state id, its elements, and its image when asked. */
export interface State {
	/** The state's id, as "s7". A step at a point names it (an act's `state`), and is refused as stale once the window
	 *  moved or redrew under the point. */
	id: string;
	app: { id: string; name: string };
	/** bounds in screen points: where the window sits. Elements' bounds and steps' points are in the window's points. */
	window: { id: string; title?: string; bounds: Rect };
	/** The elements, in reading order, each after its parent. */
	elements: UiNode[];
	/** Elements were left out (too many, or past the reply's size). */
	truncated: boolean;
	/** The elements as compact lines, as computer_observe shows them: `@e12 button "Save"`. */
	outline: string;
	/** The window's image, when asked. Its pixels are not points: a point is pixel × window.bounds[2] / image.width. */
	image?: Image;
}

/** How a step reached the app: the protocol's routes, or `input` for raw screen input on a computer with no ui group. */
export type Route = UiRoute | "input";

/** What one step did: the route it ran by, and whether a readback confirmed it; or why it was refused. */
export type StepResult = { route: Route; verified: boolean } | { error: { kind: string; message: string } };

/** What an act did: each step's result, the expect's outcome, whether the window changed, and the new state. */
export interface ActResult {
	/** One per step tried, in order. A refused step is the last: the steps after it did not run. */
	steps: StepResult[];
	/** With an expect: met, or unmet when it did not hold before its timeout. */
	expect?: "met" | "unmet";
	/** The window changed after the steps. Absent with raw input, which can't tell. */
	changed?: boolean;
	/** The state after the steps. Absent with raw input, which has no states. */
	state?: string;
	/** The new observation, when asked with `observe`. */
	after?: State;
}

/** What raw input did: one result per action tried, in order; a refused one is the last. */
export interface InputResult {
	steps: StepResult[];
}

/** What `observe` takes. */
export interface ObserveOptions {
	/** Add the window's image. Default false: the elements are usually enough. */
	image?: boolean;
	/** Every element, not only those that can be acted on or have a name. */
	full?: boolean;
}

/** What `act` takes, beside its steps. */
export interface ActOptions {
	/** The state the steps' points were read from. A step at a point needs it; the app's last observe is the default. */
	state?: string;
	/** A condition to wait for after the steps. */
	expect?: UiExpect;
	/** Let steps take the foreground route, which moves the user's pointer and focus. Default false. */
	foreground?: boolean;
	/** Observe again after the steps and return it as `after` (one call instead of two). */
	observe?: boolean | ObserveOptions;
}

/** An app, bound by its id: observe it and act on it. Every act waits until the window settles. */
export interface App {
	readonly id: string;
	/** Observe the app's window: its elements, and its image when asked. */
	observe(options?: ObserveOptions): Promise<State>;
	/** The elements of the app's last observation that match, with no call to the computer: by role (ARIA's, the same on
	 *  every OS), by the app's own id for it, and by a text its name, value or desc holds (or a RegExp they match). */
	find(query: { role?: string; id?: string; text?: string | RegExp }): UiNode[];
	/** Run steps on the app, in order; the first refused one stops the rest. */
	act(steps: UiStep[], options?: ActOptions): Promise<ActResult>;
	/** The element's default action: the surest, fastest step. */
	press(ref: UiRef, options?: ActOptions): Promise<ActResult>;
	/** Set an element's value: a field's text, a slider's value, a switch's "on" or "off". */
	set(ref: UiRef, value: string, options?: ActOptions): Promise<ActResult>;
	click(at: UiRef | Point, options?: ActOptions & { button?: "left" | "right"; count?: 1 | 2 | 3 }): Promise<ActResult>;
	type(text: string, options?: ActOptions & { into?: UiRef }): Promise<ActResult>;
	/** A key or a chord: key("enter"), key("super+s"). */
	key(chord: string, options?: ActOptions): Promise<ActResult>;
	/** Scroll by points: dy > 0 shows what is below. */
	scroll(at: UiRef | Point, delta: { dx?: number; dy?: number }, options?: ActOptions): Promise<ActResult>;
	/** Wait until the condition holds (or, with gone, no longer holds), at most its timeoutMs. */
	waitFor(expect: UiExpect): Promise<ActResult>;
}

/** An app the computer has. */
export interface AppInfo {
	id: string;
	name?: string;
}

/** What a shell command did. */
export interface RunResult {
	stdout: string;
	stderr: string;
	/** null when a signal ended it. */
	exitCode: number | null;
	timedOut: boolean;
	/** Output past what is kept was cut. */
	truncated: boolean;
}

/** A file or a directory. */
export interface FileInfo {
	path: string;
	type: FileType;
	size: number;
	mtimeMs: number;
}

/** The computer an agent's code drives. */
export interface Computer {
	/** What this computer is. */
	readonly card: Card;
	/** @group apps */
	readonly apps: {
		/** The installed apps, and which is in front. */
		list(): Promise<{ apps: AppInfo[]; foreground: string | null }>;
		/** Open an app (with background, without taking the front, where the computer can). With the ui group, bind it
		 *  with app(id). */
		open(id: string, options?: { url?: string; background?: boolean }): Promise<void>;
	};
	/** Bind an app by its id, open or not, to observe it and act on it. No id: the app in front.
	 *  @group ui */
	app(id?: string): App;
	/** @group screen */
	readonly screen: {
		/** A screenshot, as an image; with region, only that part, in the whole screen's pixels. */
		shot(options?: { region?: Rect }): Promise<Image>;
	};
	/** Raw input at screenshot pixels, for a computer with no ui group.
	 *  @group input.pointer input.touch input.keys */
	readonly input: {
		act(actions: InputAction[]): Promise<InputResult>;
	};
	/** @group exec */
	readonly shell: {
		/** Run a command: a string runs in sh -c, a list is the program and its arguments. */
		run(command: string | string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<RunResult>;
	};
	/** @group files */
	readonly files: {
		/** A file's text (UTF-8), or with base64 its bytes. */
		read(path: string, options?: { encoding?: "utf8" | "base64" }): Promise<string>;
		write(path: string, data: string, options?: { encoding?: "utf8" | "base64" }): Promise<void>;
		list(path: string): Promise<FileInfo[]>;
		stat(path: string): Promise<FileInfo>;
	};
}

// --- the per-step tools' arguments ------------------------------------------------------------------------------

/** computer_observe: observe an app's window (or, with no ui group, the screen). */
export interface ObserveArgs {
	/** The app's id. Default: the app in front. */
	app?: string;
	/** Add an image. Default false where the computer has a ui group; always on where it has none. */
	image?: boolean;
	/** Every element, not only those that can be acted on or have a name. */
	full?: boolean;
}

/** computer_act: run steps on an app, and check a condition after them. */
export interface ActArgs {
	/** The app's id. Default: the app the state is of, else the app in front. */
	app?: string;
	/** The state the steps' points were read from: needed for a step at a point. */
	state?: string;
	/** The steps, run in order. Empty with an expect: only wait for it.
	 *  @maxItems 100 */
	steps: UiStep[];
	expect?: UiExpect;
	/** Let steps take the foreground route, which moves the user's pointer and focus. */
	foreground?: boolean;
	/** Observe again after the steps. */
	observe?: boolean;
}

/** computer_screenshot: a screenshot of the screen, or of a region of it. */
export interface ScreenshotArgs {
	/** Only this part of the screen, in the whole screen's pixels. */
	region?: Rect;
}

/** computer_script: run JavaScript against the `computer` object. */
export interface ScriptArgs {
	/** The script: the body of an async function. `computer` is bound; `return` a value, or call text() and image(). */
	code: string;
	/** A few words on what the script does, for the run's timeline. */
	title?: string;
	/** The longest the script may run, in ms: default 120000, at most 600000. */
	timeoutMs?: number;
}
