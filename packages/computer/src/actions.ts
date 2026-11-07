// The batch check of input.actions: the shape, the length, every key against KEYS, each action's group against what is
// declared, and the summed wait and hold. The implementer runs it before any action; a caller can run it early; the
// in-process clients of daemon none use it as their check.
import { type Group, type InputAction, type InputActionsResult, KEYS, MAX_ACTIONS, MAX_BATCH_WAIT_MS } from "./protocol.js";

export type ActionFailure = NonNullable<InputActionsResult["failed"]>;

export interface CheckActionsOptions {
	/** Whether the implementer can scroll by pixels; X11's core wheel events are clicks. Default true. */
	pixelScroll?: boolean;
}

const KEY_NAMES: ReadonlySet<string> = new Set(KEYS);
const BUTTONS = new Set(["left", "right", "middle"]);
const PHONE_BUTTONS = new Set(["back", "home", "app_switch"]);

/** The group each action type needs; wait needs any input group. */
const GROUP_OF: Record<InputAction["type"], Group | "input"> = {
	move: "input.pointer",
	down: "input.pointer",
	up: "input.pointer",
	click: "input.pointer",
	drag: "input.pointer",
	scroll: "input.pointer",
	key: "input.keys",
	hold: "input.keys",
	type: "input.keys",
	tap: "input.touch",
	long_press: "input.touch",
	swipe: "input.touch",
	pinch: "input.touch",
	button: "input.touch",
	wait: "input",
};

/** Whether key is a name in KEYS or one printable ASCII character (0x21-0x7e). */
export function isKey(key: unknown): boolean {
	if (typeof key !== "string") return false;
	if (KEY_NAMES.has(key)) return true;
	return key.length === 1 && key.charCodeAt(0) >= 0x21 && key.charCodeAt(0) <= 0x7e;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isMs = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isPoint = (value: unknown) => Array.isArray(value) && value.length === 2 && value.every(isNumber);
const isPath = (value: unknown) => Array.isArray(value) && value.length >= 2 && value.every(isPoint);
const show = (value: unknown) => JSON.stringify(value) ?? String(value);

/** What is wrong with one action's shape, in words, or undefined. Keys are checked apart, as `invalid` too. */
function shapeOf(action: Record<string, unknown>): string | undefined {
	const has = (field: string) => action[field] !== undefined;
	const button = () => (has("button") && !BUTTONS.has(action.button as string) ? `button ${show(action.button)} is not left, right or middle` : undefined);
	const at = (required: boolean) => ((required || has("at")) && !isPoint(action.at) ? `at ${show(action.at)} is not a point [x, y]` : undefined);
	const ms = (required: boolean) => ((required || has("ms")) && !isMs(action.ms) ? `ms ${show(action.ms)} is not a whole number of milliseconds` : undefined);
	const keys = (required: boolean) =>
		(required || has("keys")) && !(Array.isArray(action.keys) && (!required || action.keys.length > 0)) ? `keys ${show(action.keys)} is not a list of keys` : undefined;
	switch (action.type) {
		case "move":
			return at(true);
		case "down":
		case "up":
			return button();
		case "click":
			return at(false) ?? button() ?? (has("count") && ![1, 2, 3].includes(action.count as number) ? `count ${show(action.count)} is not 1, 2 or 3` : undefined) ?? keys(false);
		case "drag":
			return (!isPath(action.path) ? "path is not a list of 2 or more points" : undefined) ?? button() ?? keys(false);
		case "scroll":
			return (
				at(false) ??
				(["dx", "dy"].find((d) => has(d) && !isNumber(action[d])) !== undefined ? "dx and dy are numbers" : undefined) ??
				(action.unit !== "clicks" && action.unit !== "px" ? `unit ${show(action.unit)} is not clicks or px` : undefined) ??
				keys(false)
			);
		case "key":
			return keys(true) ?? (has("repeat") && !(Number.isSafeInteger(action.repeat) && (action.repeat as number) > 0) ? `repeat ${show(action.repeat)} is not a whole number above 0` : undefined);
		case "hold":
			return keys(true) ?? ms(true);
		case "type":
			return typeof action.text !== "string" ? "text is not a string" : undefined;
		case "tap":
			return at(true) ?? (has("count") && ![1, 2].includes(action.count as number) ? `count ${show(action.count)} is not 1 or 2` : undefined);
		case "long_press":
			return at(true) ?? ms(false);
		case "swipe":
			return (!isPath(action.path) ? "path is not a list of 2 or more points" : undefined) ?? ms(false);
		case "pinch":
			return at(true) ?? (!(isNumber(action.scale) && action.scale > 0) ? `scale ${show(action.scale)} is not a number above 0` : undefined) ?? ms(false);
		case "button":
			return !PHONE_BUTTONS.has(action.name as string) ? `name ${show(action.name)} is not back, home or app_switch` : undefined;
		case "wait":
			return ms(true);
		default:
			return `type ${show(action.type)} is not an input action`;
	}
}

/**
 * The first reason the whole batch must not run, with its index, or undefined when it may. Nothing runs on a failure:
 * the reply is { done: 0, failed }. The batch's shape and length come first, then each action in order: its shape
 * (`invalid`), its keys (`invalid`), its group against groups (`unsupported`), a pixel scroll where there is none
 * (`unsupported`), and the summed wait and hold (`limit`).
 */
export function checkActions(actions: unknown, groups: readonly Group[], { pixelScroll = true }: CheckActionsOptions = {}): ActionFailure | undefined {
	if (!Array.isArray(actions)) return { index: 0, kind: "invalid", message: "actions is not a list" };
	if (actions.length > MAX_ACTIONS) return { index: MAX_ACTIONS, kind: "limit", message: `a batch holds at most ${MAX_ACTIONS} actions; this one has ${actions.length}` };
	const input = groups.some((group) => group.startsWith("input."));
	let waited = 0;
	for (const [index, action] of actions.entries()) {
		if (typeof action !== "object" || action === null || Array.isArray(action)) return { index, kind: "invalid", message: `action ${index} is not an object` };
		const given = action as Record<string, unknown>;
		const shape = shapeOf(given);
		if (shape !== undefined) return { index, kind: "invalid", message: `action ${index} (${show(given.type)}): ${shape}` };
		// By index, not by value: the bad key may itself be undefined.
		const keys: unknown[] = Array.isArray(given.keys) ? given.keys : [];
		const bad = keys.findIndex((key) => !isKey(key));
		if (bad !== -1) {
			return { index, kind: "invalid", message: `action ${index}: ${show(keys[bad])} is not a key: a key is a name in KEYS or one printable ASCII character` };
		}
		const type = given.type as InputAction["type"];
		const group = GROUP_OF[type];
		if (group === "input" ? !input : !groups.includes(group)) {
			return { index, kind: "unsupported", message: `action ${index} (${type}) needs ${group === "input" ? "an input group" : group}, which this computer does not declare` };
		}
		if (type === "scroll" && given.unit === "px" && !pixelScroll) {
			return { index, kind: "unsupported", message: `action ${index}: this computer scrolls by clicks, not pixels` };
		}
		if (type === "wait" || type === "hold") {
			waited += given.ms as number;
			if (waited > MAX_BATCH_WAIT_MS) return { index, kind: "limit", message: `the batch's wait and hold reach ${waited} ms at action ${index}, over ${MAX_BATCH_WAIT_MS} ms` };
		}
	}
	return undefined;
}
