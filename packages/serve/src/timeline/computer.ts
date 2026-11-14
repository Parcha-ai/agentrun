// A computer step in words, the one voice a person reads it in wherever it shows: a computer tool call's Timeline row
// (labels.ts, from the call's input and answer), the step's expanded call list (the console's ComputerCalls, from the
// record serve keeps on a tool call's result row: computer_calls, serve's computer-calls.ts) and a movie's caption
// (daemon-macos/scripts/call-words.mjs, the same record). The plain past tense, what happened: "Opened TextEdit",
// "Selected all (⌘A), typed into the text box “Pears”", "Pressed “Save”", "Could not press “Save”". The same on a phone,
// a Linux desktop and a Mac. The record holds no typed or set value, so neither do the words: a type step says where it
// typed.

/** One computer call on a tool_result row's `computer_calls`: serve's record of it (computer-calls.ts ComputerCallRecord). */
export type ComputerCallRow = {
  readonly method: string;
  readonly started_at: string;
  readonly app?: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly code?: string;
  readonly steps?: readonly ComputerStepRow[];
  readonly expect?: "met" | "unmet";
};

/** One step of a ui.act call on that record. */
export type ComputerStepRow = {
  readonly do: string;
  readonly on?: { readonly role: string; readonly name?: string };
  readonly keys?: string;
  readonly nav?: string;
  readonly route?: string;
  readonly verified?: boolean;
  readonly error?: string;
};

/** Apps whose id says little of the name a person knows them by. Any other id's last part is its name, capitalized. */
const APP_NAMES: Readonly<Record<string, string>> = {
  "com.apple.systempreferences": "System Settings", "com.apple.iCal": "Calendar", "com.apple.finder": "Finder",
  "com.android.settings": "Settings", "com.android.chrome": "Chrome", "xfce4-terminal": "Terminal", "org.xfce.terminal": "Terminal", xterm: "XTerm",
};
/** An app's id as a person names it: "com.apple.TextEdit" is TextEdit, "org.xfce.mousepad" Mousepad. */
export function appWords(id: string): string {
  const last = id.split(".").at(-1) || id;
  return APP_NAMES[id] ?? (last ? last[0]!.toUpperCase() + last.slice(1) : id);
}

/** The keys a chord names that are no character (the protocol's KEYS). */
const NAMED_KEYS: ReadonlySet<string> = new Set(["enter", "tab", "space", "backspace", "delete", "escape", "insert", "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "shift", "ctrl", "alt", "super", "capslock"]);
/** The modifiers whose chord with a character is a command, never typing ("super+s"); shift and a character is typing. */
const COMMAND_KEYS: ReadonlySet<string> = new Set(["ctrl", "alt", "super"]);

/** A key step's chord as the record keeps it and the words say it: one with a command modifier, or of named keys only
 *  ("enter", "shift+tab"). A lone character or shift and one is typing (a password's, key by key), so it is nothing. */
export function keptChord(chord: unknown): string | undefined {
  if (typeof chord !== "string" || !chord) return undefined;
  // The last key may be "+" itself ("shift++").
  const keys = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
  const lower = keys.map((key) => key.toLowerCase());
  if (lower.some((key) => COMMAND_KEYS.has(key))) return chord;
  return lower.every((key) => NAMED_KEYS.has(key)) ? chord : undefined;
}

/** The step kinds a ui.act step may name (the protocol's UiStep keys). */
const STEP_KINDS = ["press", "set", "perform", "click", "type", "key", "nav", "scroll", "drag"] as const;

/** A ui.act step as its record keeps it, from the step asked: its kind, the element `on` names by the step's ref (its
 *  own, or the one a type goes into), a key step's chord as kept, a nav step's place. A typed or set value is never read. */
export function stepOf(step: unknown, on: (ref: string) => ComputerStepRow["on"]): ComputerStepRow {
  const given: Readonly<Record<string, unknown>> = step && typeof step === "object" && !Array.isArray(step) ? (step as Record<string, unknown>) : {};
  const kind = STEP_KINDS.find((name) => name in given) ?? "step";
  const ref = kind === "type" ? given.into : given[kind];
  const target = typeof ref === "string" ? on(ref) : undefined;
  const keys = kind === "key" ? keptChord(given.key) : undefined;
  const nav = kind === "nav" && typeof given.nav === "string" ? given.nav : undefined;
  return { do: kind, ...(target ? { on: target } : {}), ...(keys ? { keys } : {}), ...(nav ? { nav } : {}) };
}

/** A role as words, where its name says too little alone: a text box, a check box. */
const ROLE_WORDS: Readonly<Record<string, string>> = {
  textbox: "text box", searchbox: "search box", checkbox: "check box", combobox: "pop-up", switch: "switch", slider: "slider",
  list: "list", table: "table", scrollarea: "scroll area", window: "window", dialog: "dialog", menu: "menu", toolbar: "toolbar",
  image: "image", text: "text", heading: "heading", group: "group", progressbar: "progress bar",
};
/** Roles whose name alone says what was pressed: “Save”, never "the button “Save”". An element of no known role (a
 *  phone's clickable row, "generic") and a label's text ("General" in System Settings' sidebar) are their names too. */
const NAME_ONLY: ReadonlySet<string> = new Set(["button", "link", "menuitem", "tab", "listitem", "row", "cell", "radio", "generic", "text", "heading"]);

/** The element a step acted on, in words: “Save”, the text box “Pears: 41”, the list. */
function targetWords(on: ComputerStepRow["on"]): string | undefined {
  if (!on) return undefined;
  const role = ROLE_WORDS[on.role] ?? (on.role === "generic" ? "element" : on.role);
  if (!on.name) return `the ${role}`;
  return NAME_ONLY.has(on.role) ? `“${on.name}”` : `the ${role} “${on.name}”`;
}

/** What a ⌘ chord does, where a person knows it by that, as done and as tried: super+s saved. */
const CHORD_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  s: ["Saved", "save"], a: ["Selected all", "select all"], c: ["Copied", "copy"], v: ["Pasted", "paste"], x: ["Cut", "cut"], z: ["Undid", "undo"],
  w: ["Closed the window", "close the window"], q: ["Quit", "quit"], t: ["Opened a new tab", "open a new tab"],
};
const GLYPHS: Readonly<Record<string, string>> = { super: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const NAMED: Readonly<Record<string, string>> = { enter: "Return", escape: "Esc", tab: "Tab", space: "Space", backspace: "Delete", delete: "Forward Delete", up: "↑", down: "↓", left: "←", right: "→" };

/** A step in words: as done (`did`, "Saved (⌘S)"), and as tried, for one that did not run ("save (⌘S)", after "Could
 *  not"). */
type Said = { readonly did: string; readonly tried: string };
const said = (did: string, act: string, rest = ""): Said => ({ did: `${did}${rest}`, tried: `${act}${rest}` });

/** A chord as a person reads it: "super+s" is "Saved (⌘S)", "enter" is "Pressed Return", "ctrl+shift+t" is "Pressed
 *  ⌃⇧T". Only a ⌘ chord is named by what it does: what a ⌃ one does depends on the computer (on a Mac ⌃A goes to the
 *  line's start, elsewhere it selects all), and a record does not say which computer it was. */
function chordSaid(chord: string): Said {
  const keys = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
  const last = keys.at(-1) ?? "";
  const mods = keys.slice(0, -1).map((key) => key.toLowerCase());
  const shown = keys.length === 1 && NAMED[last.toLowerCase()]
    ? NAMED[last.toLowerCase()]!
    : `${mods.map((key) => GLYPHS[key] ?? `${key}+`).join("")}${NAMED[last.toLowerCase()] ?? (last.length === 1 ? last.toUpperCase() : last)}`;
  const command = mods.length === 1 && mods[0] === "super" ? CHORD_WORDS[last.toLowerCase()] : undefined;
  return command ? said(command[0], command[1], ` (${shown})`) : said("Pressed", "press", ` ${shown}`);
}

/** The words of a chord done: "Saved (⌘S)", "Pressed ⌃⇧T". */
export const chordWords = (chord: string): string => chordSaid(chord).did;

const NAV: Readonly<Record<string, readonly [string, string, string]>> = {
  back: ["Went", "go", " back"], home: ["Went", "go", " home"], app_switch: ["Opened", "open", " the recent apps"],
};

/** One ui.act step in words, as done and as tried. */
function stepSaid(step: ComputerStepRow): Said {
  const target = targetWords(step.on);
  const on = (none: string) => ` ${target ?? none}`;
  switch (step.do) {
    case "press": return said("Pressed", "press", on("an element"));
    case "click": return said("Clicked", "click", target ? ` ${target}` : " at a point");
    case "set": return said("Set", "set", on("an element"));
    case "perform": return said("Acted on", "act on", on("an element"));
    case "type": return target ? said("Typed into", "type into", ` ${target}`) : said("Typed text", "type text");
    case "key": return step.keys ? chordSaid(step.keys) : said("Pressed a key", "press a key");
    case "nav": {
      const [did, act, rest] = (step.nav && NAV[step.nav]) || ["Navigated", "navigate", ""];
      return said(did, act, rest);
    }
    case "scroll": return target ? said("Scrolled", "scroll", ` ${target}`) : said("Scrolled", "scroll");
    case "drag": return said("Dragged", "drag", " across the screen");
    default: return said("Acted", "act");
  }
}

/** One ui.act step in words: "Pressed “Save”", "Typed into the text box", "Saved (⌘S)"; a refused one as tried, "Could
 *  not press “Save”". */
export function stepWords(step: ComputerStepRow): string {
  const told = stepSaid(step);
  return step.error === undefined ? told.did : `Could not ${told.tried}`;
}

/** At most this many steps of one act are said; the rest are counted. */
const STEPS_SAID = 3;
const lower = (words: string) => words[0]!.toLowerCase() + words.slice(1);

/** An act's steps that ran, in words: the first three, then how many more. "Selected all (⌘A), typed into the text box,
 *  saved (⌘S), +1 more". A step refused after those is said too, last, the ones before it counted: the call answered,
 *  so its words are what says the act did not do it all. */
export function stepsWords(steps: readonly ComputerStepRow[]): string {
  const words = steps.slice(0, STEPS_SAID).map(stepWords);
  const rest = steps.slice(STEPS_SAID);
  const refused = rest.findIndex((step) => step.error !== undefined);
  const more = refused < 0 ? rest.length : rest.length - 1;
  return [
    words[0]!, ...words.slice(1).map(lower), ...(more > 0 ? [`+${more} more`] : []), ...(refused < 0 ? [] : [lower(stepWords(rest[refused]!))]),
  ].join(", ");
}

/** A method other than ui's and apps', as done and as tried. */
const METHOD_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  "screen.shot": ["Took a screenshot", "take a screenshot"], "screen.watch": ["Watched the screen", "watch the screen"],
  "input.actions": ["Used the pointer and keys", "use the pointer and keys"], "apps.list": ["Listed the apps", "list the apps"],
  "files.read": ["Read a file", "read a file"], "files.write": ["Wrote a file", "write a file"], "files.list": ["Listed a folder", "list a folder"],
  "files.stat": ["Looked up a file", "look up a file"], "exec.run": ["Ran a command", "run a command"], "process.start": ["Started a process", "start a process"],
  ping: ["Checked the computer", "check the computer"],
};

/** One computer call in words: "Opened TextEdit", "Looked at TextEdit", "Selected all (⌘A), typed into the text box",
 *  "Waited for TextEdit (not seen)". A failed one as tried, "Could not open TextEdit": its code is the call's own field,
 *  shown beside the words where a reader shows it. */
export function callWords(call: ComputerCallRow): string {
  const app = call.app ? appWords(call.app) : undefined;
  const told = ((): Said => {
    switch (call.method) {
      case "apps.launch": return said("Opened", "open", ` ${app ?? "an app"}`);
      case "apps.terminate": return said("Quit", "quit", ` ${app ?? "an app"}`);
      case "ui.observe": return said("Looked at", "look at", ` ${app ?? "the window"}`);
      case "ui.act": {
        if (call.ok && call.steps?.length) return { did: stepsWords(call.steps), tried: "" };
        if (call.ok) return said("Waited for", "wait for", ` ${app ?? "the window"}${call.expect === "unmet" ? " (not seen)" : ""}`);
        return said("Acted on", "act on", ` ${app ?? "the computer"}`);
      }
      default: {
        const [did, act] = METHOD_WORDS[call.method] ?? [call.method, call.method];
        return said(did, act);
      }
    }
  })();
  return call.ok ? told.did : `Could not ${told.tried}`;
}
