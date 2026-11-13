// An observation as the compact lines a model reads: one head line (the state, the app, its window), then one line per
// element (its ref, its role, its name, its value, its flags), indented under its parent, then a line when some were
// left out. The same text is computer_observe's answer, a script's state.outline and the MCP endpoint's: it is
// rendered here only, from the nodes, so every driver's outline reads the same.
import type { UiNode } from "../protocol.js";

/** The most characters an outline takes: past it, the last line counts the elements left out. */
export const OUTLINE_MAX_CHARS = 12_000;
/** The most characters of an element's name or value the outline shows. */
const TEXT_CHARS = 80;
/** The deepest indent, in levels: deeper elements line up at it. */
const MAX_INDENT = 8;

const clip = (text: string) => (text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS - 1)}…` : text);
const quoted = (text: string) => JSON.stringify(clip(text.replace(/\s+/g, " ").trim()));

/** One element's line: `@e4 button "Save" = "value" ("what else it says") [focused]`. */
export function lineOf(node: UiNode): string {
	const parts = [node.ref, node.role];
	if (node.name) parts.push(quoted(node.name));
	if (node.value !== undefined && node.value !== "" && node.value !== node.name) parts.push(`= ${quoted(node.value)}`);
	if (node.desc && node.desc !== node.name) parts.push(`(${quoted(node.desc)})`);
	if (node.flags && node.flags.length > 0) parts.push(`[${node.flags.join(" ")}]`);
	return parts.join(" ");
}

/** The outline of an observation: `head`, then the elements within OUTLINE_MAX_CHARS, each indented under its parent,
 *  then a line saying what was left out (by the driver, `truncated`, or here for room). */
export function outlineOf(head: string, nodes: readonly UiNode[], truncated: boolean, empty?: string): string {
	const depth = new Map<string, number>();
	const lines = [head];
	let room = OUTLINE_MAX_CHARS - head.length - 100;
	let shown = 0;
	for (const node of nodes) {
		const level = node.parent === undefined ? 0 : (depth.get(node.parent) ?? -1) + 1;
		depth.set(node.ref, level);
		const next = `${"  ".repeat(Math.min(level, MAX_INDENT))}${lineOf(node)}`;
		if (next.length + 1 > room) break;
		lines.push(next);
		room -= next.length + 1;
		shown += 1;
	}
	const cut = nodes.length - shown;
	if (cut > 0) lines.push(`… ${cut} more elements not shown: find() them in a script, or act on a scrollarea to see others`);
	else if (truncated) lines.push("… the computer left out more elements: scroll to see others, or observe with full");
	// The computer can't read this window's elements (ui.tree off): its words, and the image it sent instead.
	if (nodes.length === 0 && empty) lines.push(`(no elements: ${empty}; act at points in the window's image)`);
	else if (nodes.length === 0) lines.push("(no elements: the window shows nothing with a name; observe with image: true to see it)");
	return lines.join("\n");
}
