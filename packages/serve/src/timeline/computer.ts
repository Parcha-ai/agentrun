// A run's computer calls as a person reads them: one line per call ("open TextEdit", "select all (⌘A); type into the text
// box", "press “Save”"), from the record serve keeps on a tool call's result row (computer_calls: serve's
// computer-calls.ts). The record holds no typed or set value, so neither does a line: a type step says where it typed.

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

/** Apps whose id says little of the name a person knows them by. Any other id's last part is its name. */
const APP_NAMES: Readonly<Record<string, string>> = {
  "com.apple.systempreferences": "System Settings", "com.apple.iCal": "Calendar", "com.apple.finder": "Finder",
  "com.android.settings": "Settings", "com.android.chrome": "Chrome",
};
/** An app's id as a person names it: "com.apple.TextEdit" is TextEdit. */
export function appWords(id: string): string {
  return APP_NAMES[id] ?? id.split(".").at(-1) ?? id;
}

/** A role as words, where its name says too little alone: a text box, a check box. */
const ROLE_WORDS: Readonly<Record<string, string>> = {
  textbox: "text box", searchbox: "search box", checkbox: "check box", combobox: "pop-up", switch: "switch", slider: "slider",
  list: "list", table: "table", scrollarea: "scroll area", window: "window", dialog: "dialog", menu: "menu", toolbar: "toolbar",
  image: "image", text: "text", heading: "heading", group: "group", progressbar: "progress bar",
};
/** Roles whose name alone says what was pressed: “Save”, never "the button “Save”". */
const NAME_ONLY: ReadonlySet<string> = new Set(["button", "link", "menuitem", "tab", "listitem", "row", "cell", "radio"]);

/** The element a step acted on, in words: “Save”, the text box “Pears: 41”, the list. */
function targetWords(on: ComputerStepRow["on"]): string | undefined {
  if (!on) return undefined;
  const role = ROLE_WORDS[on.role] ?? (on.role === "generic" ? "element" : on.role);
  if (!on.name) return `the ${role}`;
  return NAME_ONLY.has(on.role) ? `“${on.name}”` : `the ${role} “${on.name}”`;
}

/** What a chord does, where a person knows it by that: super+s saves. */
const CHORD_WORDS: Readonly<Record<string, string>> = {
  s: "save", a: "select all", c: "copy", v: "paste", x: "cut", z: "undo", n: "new", w: "close the window", q: "quit", f: "find",
  t: "new tab", o: "open", p: "print",
};
const GLYPHS: Readonly<Record<string, string>> = { super: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const NAMED: Readonly<Record<string, string>> = { enter: "Return", escape: "Esc", tab: "Tab", space: "Space", backspace: "Delete", delete: "Forward Delete", up: "↑", down: "↓", left: "←", right: "→" };

/** A chord as a person reads it: "super+s" is "save (⌘S)", "enter" is "press Return", "ctrl+shift+t" is "press ⌃⇧T". */
export function chordWords(chord: string): string {
  const keys = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
  const last = keys.at(-1) ?? "";
  const mods = keys.slice(0, -1).map((key) => key.toLowerCase());
  const shown = keys.length === 1 && NAMED[last.toLowerCase()]
    ? NAMED[last.toLowerCase()]!
    : `${mods.map((key) => GLYPHS[key] ?? `${key}+`).join("")}${NAMED[last.toLowerCase()] ?? (last.length === 1 ? last.toUpperCase() : last)}`;
  const command = mods.length === 1 && (mods[0] === "super" || mods[0] === "ctrl") ? CHORD_WORDS[last.toLowerCase()] : undefined;
  return command ? `${command} (${shown})` : `press ${shown}`;
}

const NAV_WORDS: Readonly<Record<string, string>> = { back: "go back", home: "go home", app_switch: "switch apps" };

/** One ui.act step in words: press “Save”, type into the text box, save (⌘S). A refused step says so. */
export function stepWords(step: ComputerStepRow): string {
  const target = targetWords(step.on);
  const did = (() => {
    switch (step.do) {
      case "press": return target ? `press ${target}` : "press";
      case "click": return target ? `click ${target}` : "click";
      case "set": return target ? `set ${target}` : "set a value";
      case "perform": return target ? `act on ${target}` : "act";
      case "type": return target ? `type into ${target}` : "type";
      case "key": return step.keys ? chordWords(step.keys) : "press a key";
      case "nav": return (step.nav && NAV_WORDS[step.nav]) ?? "navigate";
      case "scroll": return target ? `scroll ${target}` : "scroll";
      case "drag": return "drag";
      default: return step.do;
    }
  })();
  return step.error ? `${did} (refused: ${step.error})` : did;
}

const METHOD_WORDS: Readonly<Record<string, string>> = {
  "screen.shot": "take a screenshot", "screen.watch": "watch the screen", "input.actions": "use the pointer and keys", "apps.list": "list the apps",
  "files.read": "read a file", "files.write": "write a file", "files.list": "list a folder", "files.stat": "look up a file", "exec.run": "run a command",
  "processes.start": "start a process", "ping": "check the computer",
};

/** One computer call as a line a person reads: "open TextEdit", "look at TextEdit", "select all (⌘A); type into the text
 *  box", "wait for TextEdit (not seen)". A failed call says its code. */
export function callWords(call: ComputerCallRow): string {
  const app = call.app ? appWords(call.app) : undefined;
  const said = (() => {
    switch (call.method) {
      case "apps.launch": return app ? `open ${app}` : "open an app";
      case "apps.terminate": return app ? `quit ${app}` : "quit an app";
      case "ui.observe": return app ? `look at ${app}` : "look at the window";
      case "ui.act": {
        if (!call.steps?.length && call.ok) return `wait for ${app ?? "the window"}${call.expect === "unmet" ? " (not seen)" : ""}`;
        return (call.steps ?? []).map(stepWords).join("; ") || "act";
      }
      default: return METHOD_WORDS[call.method] ?? call.method;
    }
  })();
  return call.ok ? said : `${said} (failed: ${call.code ?? "error"})`;
}
