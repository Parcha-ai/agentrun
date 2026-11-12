// The `computer` object a script sees, built inside the script's isolate over one host function: `call(op, args)`,
// which the host answers with the core (core.ts). bindComputer is self-contained (it names nothing outside itself), so
// its source is the prelude an isolate evaluates: scriptPrelude puts it on one line ahead of the script, which keeps the
// script's own line numbers.
import type { ActOptions, ActResult, App, Card, Computer, ObserveOptions, State } from "./api.js";
import type { UiExpect, UiNode, UiStep } from "../protocol.js";

type Call = (op: string, args: unknown) => Promise<unknown>;

/** The `computer` object over `call`, with only the namespaces `card.groups` offers. Self-contained: see scriptPrelude. */
export function bindComputer(call: Call, card: Card): Computer {
	const has = (group: string) => card.groups.indexOf(group) >= 0;
	const freeze = Object.freeze;
	const bind = (id?: string): App => {
		let last: State | undefined;
		const act = async (steps: UiStep[], options: ActOptions = {}): Promise<ActResult> => {
			const args: Record<string, unknown> = { steps };
			if (id !== undefined) args.app = id;
			const state = options.state ?? last?.id;
			const atPoint = steps.some((step) => ("click" in step && Array.isArray(step.click)) || ("scroll" in step && Array.isArray(step.scroll)) || "drag" in step);
			if (options.state !== undefined || (atPoint && state !== undefined)) args.state = state;
			if (options.expect !== undefined) args.expect = options.expect;
			if (options.foreground === true) args.foreground = true;
			if (options.observe) args.observe = options.observe;
			const result = (await call("act", args)) as ActResult;
			if (result.after) last = result.after;
			return result;
		};
		const app: App = {
			get id() {
				return id ?? last?.app.id ?? "";
			},
			async observe(options: ObserveOptions = {}) {
				last = (await call("observe", { ...(id !== undefined ? { app: id } : {}), ...options })) as State;
				return last;
			},
			find(query: { role?: string; text?: string | RegExp }): UiNode[] {
				if (!last) throw new Error("find() reads the app's last observation: call observe() first");
				const text = query.text;
				const holds = (value: string | undefined) => value !== undefined && (typeof text === "string" ? value.toLowerCase().indexOf(text.toLowerCase()) >= 0 : text instanceof RegExp ? text.test(value) : true);
				return last.elements.filter((node) => (query.role === undefined || node.role === query.role) && (text === undefined || holds(node.name) || holds(node.value)));
			},
			act,
			press: (ref, options) => act([{ press: ref }], options),
			set: (ref, value, options) => act([{ set: ref, value }], options),
			click: (at, options = {}) => act([{ click: at, ...(options.button ? { button: options.button } : {}), ...(options.count ? { count: options.count } : {}) }], options),
			type: (text, options = {}) => act([{ type: text, ...(options.into !== undefined ? { into: options.into } : {}) }], options),
			key: (chord, options) => act([{ key: chord }], options),
			scroll: (at, delta, options) => act([{ scroll: at, ...delta }], options),
			waitFor: (expect: UiExpect) => act([], { expect }),
		};
		return freeze(app);
	};
	const computer: Record<string, unknown> = { card: freeze(card) };
	if (has("apps"))
		computer.apps = freeze({
			list: () => call("apps.list", {}),
			async open(id: string, options: { url?: string; background?: boolean } = {}) {
				await call("apps.open", { id, ...options });
				return bind(id);
			},
		});
	if (has("ui")) computer.app = (id?: string) => bind(id);
	if (has("screen")) computer.screen = freeze({ shot: (options: { region?: unknown } = {}) => call("screenshot", options) });
	if (has("input.pointer") || has("input.touch") || has("input.keys")) computer.input = freeze({ act: (actions: unknown[]) => call("input.act", { actions }) });
	if (has("exec")) computer.shell = freeze({ run: (command: unknown, options: object = {}) => call("shell.run", { ...options, command }) });
	if (has("files"))
		computer.files = freeze({
			read: (path: string, options: object = {}) => call("files.read", { ...options, path }),
			write: async (path: string, data: string, options: object = {}) => {
				await call("files.write", { ...options, path, data });
			},
			list: (path: string) => call("files.list", { path }),
			stat: (path: string) => call("files.stat", { path }),
		});
	return freeze(computer) as unknown as Computer;
}

/** The global a script's isolate holds the host's call under. */
export const COMPUTER_CALL_GLOBAL = "__computerCall";

/** One line that binds `computer` in a script, over the global COMPUTER_CALL_GLOBAL: put it before the script's first
 *  line (as `${scriptPrelude(card)} ${code}`) and the script's line numbers stay its own. */
export function scriptPrelude(card: Card): string {
	return `const computer = (0, eval)(${JSON.stringify(`(${String(bindComputer)})`)})(${COMPUTER_CALL_GLOBAL}, ${JSON.stringify(card)});`;
}
