// The practice tasks: the demo's family (create, read, append to and edit files; write a small JS script and run it;
// fix a failing script; ls, wc, mv, grep; small JSON edits). Each template makes instances from a seed, with the files
// the task starts from, and checks the result in code: files, a script's output, or a value the answer must state.
//
// make() is pure and runs anywhere. check() reads the task's directory and may run node there, so it runs only where
// the task ran: running anything refuses outside the self-tools sandbox (sandbox.ts).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { requireSandbox, SandboxRequired } from "./sandbox.ts";

export type Split = "train" | "heldout" | "unseen";

export interface Instance {
  id: string;
  template: string;
  split: Split;
  prompt: string;
  /** Files the task starts from, relative to its directory. */
  files: Record<string, string>;
  /** A follow-up's first task lives in params.first: { template, prompt, params }. */
  params: Record<string, unknown>;
}

export interface CheckCtx {
  dir: string;
  /** The final answer's text (without the thinking). */
  answer: string;
  /** The calls the model made, in order. */
  calls?: { name: string; arguments: Record<string, unknown> }[];
  /** The request and the files the task started from (checkInstance fills them in). */
  prompt?: string;
  files?: Record<string, string>;
}

interface Made { prompt: string; files?: Record<string, string>; params: Record<string, unknown> }

interface Template {
  name: string;
  kind: "create" | "read" | "append" | "edit" | "js" | "fix" | "shell" | "json" | "followup" | "online";
  /** Held out entirely from training: the 1B never practised this template. */
  unseen?: boolean;
  /** The check is on a value the final answer must state (not on files or a script's output). */
  answer?: boolean;
  make(r: Rng): Made;
  /** null when the task was done; otherwise what is wrong. */
  check(p: any, c: CheckCtx): string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeded randomness and the bits tasks are made of.

export class Rng {
  private s: number;
  constructor(seed: string) {
    let h = 2166136261;
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    this.s = h >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(a: number, b: number): number { return a + Math.floor(this.next() * (b - a + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]!; }
  sample<T>(xs: readonly T[], k: number): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
    return a.slice(0, k);
  }
}

const NAMES = ["Ana", "Ben", "Carla", "Dev", "Elena", "Femi", "Gus", "Hana", "Ivan", "Jade", "Kofi", "Lena", "Marco", "Nia", "Omar", "Pia", "Quinn", "Rosa", "Sam", "Tara", "Uma", "Victor", "Wen", "Yara", "Zoe"];
const FRUITS = ["apples", "bananas", "cherries", "grapes", "lemons", "mangoes", "oranges", "pears", "plums", "kiwis"];
const THINGS = ["milk", "bread", "eggs", "rice", "coffee", "butter", "cheese", "tea", "honey", "pasta", "soap", "batteries"];
const PLACES = ["library", "station", "park", "cafe", "harbor", "museum", "market", "bridge", "garden", "office"];
const COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "silver", "teal"];
const WORDS = ["river", "planet", "window", "garden", "rocket", "pencil", "castle", "forest", "lantern", "marble", "puzzle", "violin", "harbor", "meadow", "comet"];
// A wider list for templates whose only variation is one word (so held-out instances never repeat practised ones).
const MANY_WORDS = [...WORDS, "anchor", "basket", "candle", "dragon", "engine", "falcon", "glacier", "hammer", "island", "jacket", "kettle", "ladder", "mirror", "needle", "orchid", "parrot", "quartz", "saddle", "tunnel", "walnut"];
const TXT = ["notes.txt", "memo.txt", "plan.txt", "ideas.txt", "draft.txt", "journal.txt", "reminder.txt", "summary.txt", "message.txt", "todo.txt", "story.txt", "hello.txt"];
const DIRS = ["docs", "notes", "archive", "reports", "drafts", "data", "files", "backup", "work", "inbox"];
const TASKS = ["call the dentist", "water the plants", "pay rent", "book flights", "fix the bike", "buy a gift", "clean the desk", "send the report", "walk the dog", "renew passport"];
const DEPS: [string, string][] = [["lodash", "^4.17.21"], ["chalk", "^5.3.0"], ["dayjs", "^1.11.10"], ["zod", "^3.23.8"], ["express", "^4.19.2"], ["uuid", "^9.0.1"], ["yaml", "^2.4.2"]];

const sentence = (r: Rng) => r.pick([
  () => `${r.pick(NAMES)} likes ${r.pick(FRUITS)} and ${r.pick(FRUITS)}.`,
  () => `Meet ${r.pick(NAMES)} at the ${r.pick(PLACES)} at ${r.int(1, 12)} o'clock.`,
  () => `The ${r.pick(COLORS)} ${r.pick(WORDS)} is next to the ${r.pick(PLACES)}.`,
  () => `Remember to buy ${r.pick(THINGS)} and ${r.pick(THINGS)}.`,
  () => `${r.pick(NAMES)} has ${r.int(2, 40)} ${r.pick(FRUITS)}.`,
])();
const lines = (r: Rng, n: number) => {
  const out = new Set<string>();
  while (out.size < n) out.add(sentence(r));
  return [...out];
};

// ---------------------------------------------------------------------------------------------------------------------
// Check helpers (they run where the task ran).

function readIn(dir: string, path: string): string | null {
  try { return readFileSync(join(dir, path), "utf8"); } catch { return null; }
}
const exists = (dir: string, path: string) => existsSync(join(dir, path));
const isDir = (dir: string, path: string) => { try { return statSync(join(dir, path)).isDirectory(); } catch { return false; } };
const trimEnd = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
const fileLines = (s: string) => trimEnd(s).split("\n");
function run(dir: string, cmd: string, args: string[] = []): { code: number; out: string; err: string } {
  requireSandbox("a task check");
  const p = spawnSync(cmd, args, { cwd: dir, timeout: 15_000, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } });
  return { code: p.status ?? -1, out: p.stdout ?? "", err: p.stderr ?? "" };
}
function nodeOut(dir: string, file: string, args: string[] = []): string | { error: string } {
  if (!exists(dir, file)) return { error: `${file} does not exist` };
  const p = run(dir, "node", [file, ...args]);
  if (p.code !== 0) return { error: `node ${file} exited ${p.code}: ${p.err.slice(0, 200)}` };
  return trimEnd(p.out);
}
function sameText(dir: string, path: string, want: string): string | null {
  const got = readIn(dir, path);
  if (got === null) return `${path} does not exist`;
  return trimEnd(got) === trimEnd(want) ? null : `${path} is ${JSON.stringify(got.slice(0, 160))}, want ${JSON.stringify(want.slice(0, 160))}`;
}
function outputIs(dir: string, file: string, want: string, args: string[] = []): string | null {
  const o = nodeOut(dir, file, args);
  if (typeof o !== "string") return o.error;
  return o === trimEnd(want) ? null : `node ${file} printed ${JSON.stringify(o.slice(0, 160))}, want ${JSON.stringify(want.slice(0, 160))}`;
}
function says(answer: string, value: string | number): string | null {
  const v = String(value).toLowerCase();
  const a = answer.toLowerCase();
  const ok = typeof value === "number" ? new RegExp(`(^|[^0-9.])${v}([^0-9]|$)`).test(a) : a.includes(v);
  return ok ? null : `the answer does not state ${JSON.stringify(String(value))}`;
}
function json(dir: string, path: string): any {
  const t = readIn(dir, path);
  if (t === null) throw new Error(`${path} does not exist`);
  return JSON.parse(t);
}
function jsonCheck(f: () => string | null): string | null {
  try { return f(); } catch (e) { return (e as Error).message; }
}
const all = (...xs: (string | null)[]) => xs.find((x) => x !== null) ?? null;
/** The model ran the script itself (a bash call running node on it): checks run scripts too, which proves nothing. */
export function ranScript(c: CheckCtx, file: string): string | null {
  const name = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\bnode\\s+(?:\\./)?${name}(?=\\s|$|[;&|)])`);
  return (c.calls ?? []).some((x) => x.name === "bash" && re.test(String(x.arguments.command ?? ""))) ? null : `${file} was never run`;
}

/** The file was shown to the user: a read of it after the last call that changed files. */
function shownAfterChange(c: CheckCtx, path: string): string | null {
  const calls = c.calls ?? [];
  const lastChange = calls.map((x) => x.name).reduce((at, n, i) => (n === "write" || n === "edit" || n === "bash" ? i : at), -1);
  const shown = calls.some((x, i) => i > lastChange && x.name === "read" && String(x.arguments.path ?? "").replace(/^\.\//, "") === path);
  return shown ? null : `${path} was not read back after the change`;
}

/** go_online was the first call (and the run stopped there). */
function onlineFirst(c: CheckCtx): string | null {
  const calls = c.calls ?? [];
  if (!calls.length) return "no call";
  return calls[0]!.name === "go_online" ? null : `the first call was ${calls[0]!.name}, not go_online`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The templates.

export const TEMPLATES: Template[] = [
  // Create
  {
    name: "create-line", kind: "create",
    make(r) {
      const f = r.pick(TXT), s = sentence(r);
      return { prompt: r.pick([`Create a file called ${f} that contains: ${s}`, `Write "${s}" into a new file named ${f}.`, `Make ${f} with the text ${s}`]), params: { f, s } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.s),
  },
  {
    name: "create-lines", kind: "create",
    make(r) {
      const f = r.pick(TXT), items = r.sample(THINGS, 3);
      return { prompt: r.pick([`Create ${f} with these three lines, one per line: ${items.join(", ")}.`, `Make a file ${f} listing ${items.join(", ")}, each on its own line.`]), params: { f, items } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.items.join("\n")),
  },
  {
    name: "create-nested", kind: "create",
    make(r) {
      const d = r.pick(DIRS), f = r.pick(TXT), w = r.pick(WORDS);
      return { prompt: r.pick([`Create ${d}/${f} containing the word ${w}.`, `Inside a folder called ${d}, make a file ${f} that says ${w}.`]), params: { path: `${d}/${f}`, w } };
    },
    check: (p, c) => sameText(c.dir, p.path, p.w),
  },
  {
    name: "overwrite", kind: "create",
    make(r) {
      const f = r.pick(TXT), old = lines(r, 3).join("\n") + "\n", s = sentence(r);
      return { prompt: r.pick([`Replace everything in ${f} with: ${s}`, `Overwrite ${f} so it only contains "${s}".`]), files: { [f]: old }, params: { f, s } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.s),
  },
  {
    name: "create-json", kind: "create",
    make(r) {
      const f = r.pick(["person.json", "user.json", "profile.json", "member.json"]), n = r.pick(NAMES), a = r.int(18, 80);
      return { prompt: r.pick([`Create ${f} with a JSON object whose name is "${n}" and age is ${a}.`, `Make a JSON file ${f} holding {name: ${n}, age: ${a}}.`]), params: { f, n, a } };
    },
    check: (p, c) => jsonCheck(() => { const o = json(c.dir, p.f); return o.name === p.n && o.age === p.a ? null : `${p.f} is ${JSON.stringify(o)}`; }),
  },
  {
    name: "create-md-list", kind: "create", unseen: true,
    make(r) {
      const f = r.pick(["list.md", "shopping.md", "packing.md", "groceries.md"]), items = r.sample(THINGS, r.int(3, 4));
      return { prompt: `Write a markdown bullet list of ${items.join(", ")} to ${f}.`, params: { f, items } };
    },
    check: (p, c) => {
      const t = readIn(c.dir, p.f);
      if (t === null) return `${p.f} does not exist`;
      const bullets = fileLines(t).filter((l) => /^\s*[-*] /.test(l)).map((l) => l.replace(/^\s*[-*] /, "").trim().toLowerCase());
      const miss = p.items.filter((i: string) => !bullets.includes(i));
      return miss.length ? `not bulleted: ${miss.join(", ")}` : null;
    },
  },

  // Read
  {
    name: "read-line", kind: "read", answer: true,
    make(r) {
      const f = r.pick(TXT), ls = lines(r, 5), k = r.int(1, 5);
      return { prompt: r.pick([`What does line ${k} of ${f} say?`, `Tell me what's on line ${k} in ${f}.`]), files: { [f]: ls.join("\n") + "\n" }, params: { want: ls[k - 1] } };
    },
    check: (p, c) => says(c.answer, p.want.replace(/\.$/, "")),
  },
  {
    name: "read-config", kind: "read", answer: true,
    make(r) {
      const f = r.pick(["config.txt", "server.conf", "app.env", "settings.txt"]), port = r.int(1025, 9999);
      const body = r.sample([`host=${r.pick(PLACES)}.local`, `port=${port}`, `user=${r.pick(NAMES).toLowerCase()}`, `retries=${r.int(1, 9)}`], 4).join("\n") + "\n";
      return { prompt: r.pick([`Which port is set in ${f}?`, `What port does ${f} use?`]), files: { [f]: body }, params: { port } };
    },
    check: (p, c) => says(c.answer, p.port),
  },
  {
    name: "read-json-field", kind: "read", answer: true,
    make(r) {
      const v = `${r.int(0, 4)}.${r.int(0, 20)}.${r.int(0, 30)}`, name = `${r.pick(WORDS)}-app`;
      const pkg = { name, version: v, private: true, scripts: { start: "node index.js" } };
      return { prompt: r.pick(["What version is package.json at?", "What's the version number in package.json?"]), files: { "package.json": JSON.stringify(pkg, null, 2) + "\n" }, params: { v } };
    },
    check: (p, c) => says(c.answer, p.v),
  },
  {
    name: "read-count-lines", kind: "read", answer: true,
    make(r) {
      const f = r.pick(TXT), n = r.int(3, 14);
      return { prompt: r.pick([`How many lines are in ${f}?`, `Count the lines in ${f} for me.`]), files: { [f]: lines(r, n).join("\n") + "\n" }, params: { n } };
    },
    check: (p, c) => says(c.answer, p.n),
  },
  {
    name: "read-first-word", kind: "read", answer: true, unseen: true,
    make(r) {
      const f = r.pick(TXT), ls = lines(r, 3);
      return { prompt: `What is the first word of ${f}?`, files: { [f]: ls.join("\n") + "\n" }, params: { w: ls[0]!.split(" ")[0] } };
    },
    check: (p, c) => says(c.answer, p.w),
  },
  {
    name: "read-count-users", kind: "read", answer: true,
    make(r) {
      const n = r.int(2, 7), users = r.sample(NAMES, n).map((name, i) => ({ id: i + 1, name }));
      return { prompt: r.pick(["How many users are listed in users.json?", "Count the users in users.json."]), files: { "users.json": JSON.stringify(users, null, 2) + "\n" }, params: { n } };
    },
    check: (p, c) => says(c.answer, p.n),
  },

  // Append
  {
    name: "append-line", kind: "append",
    make(r) {
      const f = r.pick(TXT), ls = lines(r, 3), x = sentence(r);
      return { prompt: r.pick([`Add the line "${x}" to the end of ${f}.`, `Append "${x}" as a new last line of ${f}.`]), files: { [f]: ls.join("\n") + "\n" }, params: { f, want: [...ls, x].join("\n") } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.want),
  },
  {
    name: "append-todo", kind: "append",
    make(r) {
      const [a, b, t] = r.sample(TASKS, 3);
      return { prompt: r.pick([`Add "${t}" to my todo list in todo.md.`, `Put "${t}" on the todo list (todo.md).`]), files: { "todo.md": `# Todo\n\n- ${a}\n- ${b}\n` }, params: { a, b, t } };
    },
    check: (p, c) => {
      const s = readIn(c.dir, "todo.md");
      if (s === null) return "todo.md does not exist";
      const ls = fileLines(s);
      return all(ls.includes(`- ${p.a}`) && ls.includes(`- ${p.b}`) ? null : "the old items are gone",
        /^- (\[ \] )?/.test(ls[ls.length - 1]!) && ls[ls.length - 1]!.endsWith(p.t) ? null : `the last line is ${JSON.stringify(ls[ls.length - 1])}`);
    },
  },
  {
    name: "append-two", kind: "append",
    make(r) {
      const old = Array.from({ length: r.int(2, 4) }, () => String(r.int(1, 99))), a = r.int(100, 999), b = r.int(100, 999);
      return { prompt: r.pick([`Append ${a} and ${b} to numbers.txt, each on its own line.`, `Add the numbers ${a} and ${b} at the end of numbers.txt, one per line.`]), files: { "numbers.txt": old.join("\n") + "\n" }, params: { want: [...old, a, b].join("\n") } };
    },
    check: (p, c) => sameText(c.dir, "numbers.txt", p.want),
  },
  {
    name: "append-csv", kind: "append",
    make(r) {
      const rows = r.sample(NAMES, 3).map((n) => `${n},${r.int(18, 70)}`), n = r.pick(NAMES.filter((x) => !rows.some((row) => row.startsWith(x + ",")))), a = r.int(18, 70);
      return { prompt: r.pick([`Add a row for ${n}, age ${a}, to people.csv.`, `people.csv needs a new row: ${n} who is ${a}.`]), files: { "people.csv": ["name,age", ...rows].join("\n") + "\n" }, params: { want: ["name,age", ...rows, `${n},${a}`].join("\n") } };
    },
    check: (p, c) => sameText(c.dir, "people.csv", p.want),
  },

  // Edit
  {
    name: "edit-word", kind: "edit",
    make(r) {
      const f = r.pick(TXT), [w1, w2] = r.sample(COLORS, 2), x = `The ${w1} ${r.pick(WORDS)} is near the ${r.pick(PLACES)}.`;
      const ls = [...lines(r, 6).filter((l) => !l.includes(w1!) && !l.includes(w2!)).slice(0, 2), x];
      const body = r.sample(ls, 3).join("\n") + "\n";
      return { prompt: r.pick([`In ${f}, change the word "${w1}" to "${w2}".`, `Replace "${w1}" with "${w2}" in ${f}.`]), files: { [f]: body }, params: { f, want: body.replace(w1, w2) } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.want),
  },
  {
    name: "edit-line", kind: "edit",
    make(r) {
      const f = r.pick(TXT), ls = lines(r, 4), k = r.int(1, 4), x = sentence(r);
      const want = ls.map((l, i) => (i === k - 1 ? x : l));
      return { prompt: r.pick([`Change line ${k} of ${f} to "${x}".`, `In ${f}, replace line ${k} with: ${x}`]), files: { [f]: ls.join("\n") + "\n" }, params: { f, want: want.join("\n") } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.want),
  },
  {
    name: "edit-rename-var", kind: "edit",
    make(r) {
      const [a, b] = r.sample(["total", "count", "score", "items", "result", "amount", "value"], 2), n = r.int(3, 9);
      const f = r.pick(["counter.js", "calc.js", "app.js", "tally.js"]);
      const src = `let ${a} = 0;\nfor (let i = 1; i <= ${n}; i++) {\n  ${a} += i;\n}\nconsole.log(${a});\n`;
      return { prompt: r.pick([`Rename the variable ${a} to ${b} in ${f}.`, `In ${f}, call the variable ${b} instead of ${a}.`]), files: { [f]: src }, params: { f, a, b, out: String((n * (n + 1)) / 2) } };
    },
    check: (p, c) => {
      const s = readIn(c.dir, p.f);
      if (s === null) return `${p.f} does not exist`;
      return all(new RegExp(`\\b${p.a}\\b`).test(s) ? `${p.a} is still there` : null, new RegExp(`\\b${p.b}\\b`).test(s) ? null : `${p.b} is missing`, outputIs(c.dir, p.f, p.out));
    },
  },
  {
    name: "edit-config-value", kind: "edit",
    make(r) {
      const key = r.pick(["retries", "timeout", "workers", "port"]), old = { retries: 3, timeout: 30, workers: 2, port: 8080 } as Record<string, number>;
      const n = r.int(4, 99) + (key === "port" ? 3000 : 0);
      const body = Object.entries(old).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
      return { prompt: r.pick([`Set ${key} to ${n} in settings.ini.`, `Change the ${key} value in settings.ini to ${n}.`]), files: { "settings.ini": body }, params: { want: body.replace(`${key}=${old[key]}`, `${key}=${n}`) } };
    },
    check: (p, c) => sameText(c.dir, "settings.ini", p.want),
  },
  {
    name: "delete-line", kind: "edit",
    make(r) {
      const f = r.pick(TXT), ls = lines(r, 4), k = r.int(0, 3);
      return { prompt: r.pick([`Delete the line that says "${ls[k]}" from ${f}.`, `Remove "${ls[k]}" from ${f}.`]), files: { [f]: ls.join("\n") + "\n" }, params: { f, want: ls.filter((_, i) => i !== k).join("\n") } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.want),
  },
  {
    name: "fix-typo", kind: "edit", unseen: true,
    make(r) {
      const [bad, good] = r.pick([["recieve", "receive"], ["seperate", "separate"], ["definately", "definitely"], ["occured", "occurred"], ["untill", "until"]]);
      const f = r.pick(TXT), body = `${sentence(r)}\nWe will ${bad} it soon.\n${sentence(r)}\n`;
      return { prompt: `Fix the misspelled word "${bad}" in ${f}.`, files: { [f]: body }, params: { f, want: body.replace(bad, good) } };
    },
    check: (p, c) => sameText(c.dir, p.f, p.want),
  },

  // Write and run JS
  {
    name: "js-print", kind: "js",
    make(r) {
      const f = r.pick(["hello.js", "greet.js", "say.js", "print.js"]), msg = r.pick([`Hello, ${r.pick(NAMES)}!`, `Good morning from the ${r.pick(PLACES)}.`, `${r.pick(COLORS)} ${r.pick(WORDS)}`]);
      return { prompt: r.pick([`Write ${f} that prints "${msg}", then run it with node.`, `Make a script ${f} that prints ${msg} and run it.`]), params: { f, msg } };
    },
    check: (p, c) => all(ranScript(c, p.f), outputIs(c.dir, p.f, p.msg)),
  },
  {
    name: "js-sum-range", kind: "js",
    make(r) {
      const n = r.int(10, 500);
      return { prompt: r.pick([`Write sum.js to print the sum of the whole numbers from 1 to ${n}. Run it and tell me the result.`, `Create sum.js that adds up 1 through ${n} and prints the total. Run it and tell me what it prints.`]), params: { want: (n * (n + 1)) / 2 } };
    },
    check: (p, c) => all(ranScript(c, "sum.js"), outputIs(c.dir, "sum.js", String(p.want)), says(c.answer, p.want)),
  },
  {
    name: "js-fizzbuzz", kind: "js",
    make(r) {
      const n = r.int(10, 40);
      const want = Array.from({ length: n }, (_, i) => { const k = i + 1; return k % 15 === 0 ? "FizzBuzz" : k % 3 === 0 ? "Fizz" : k % 5 === 0 ? "Buzz" : String(k); });
      return { prompt: r.pick([`Write fizzbuzz.js that prints the numbers 1 to ${n}, one per line, but Fizz for multiples of 3, Buzz for multiples of 5 and FizzBuzz for multiples of both. Run it.`, `Create fizzbuzz.js: for 1 to ${n}, print Fizz for multiples of 3, Buzz for multiples of 5, FizzBuzz for multiples of both, otherwise the number, one per line. Run it.`]), params: { want: want.join("\n") } };
    },
    check: (p, c) => all(ranScript(c, "fizzbuzz.js"), outputIs(c.dir, "fizzbuzz.js", p.want)),
  },
  {
    name: "js-reverse", kind: "js",
    make(r) {
      const w = r.pick(MANY_WORDS);
      return { prompt: r.pick([`Write reverse.js that prints the word "${w}" backwards. Run it and tell me what it prints.`, `Make a script reverse.js printing "${w}" reversed, run it, and tell me the output.`]), params: { want: [...w].reverse().join("") } };
    },
    check: (p, c) => all(ranScript(c, "reverse.js"), outputIs(c.dir, "reverse.js", p.want), says(c.answer, p.want)),
  },
  {
    name: "js-max", kind: "js",
    make(r) {
      const xs = Array.from({ length: r.int(5, 8) }, () => r.int(1, 999));
      return { prompt: r.pick([`Write max.js that prints the largest number in [${xs.join(", ")}]. Run it.`, `Create max.js to find and print the biggest of these numbers: ${xs.join(", ")}. Run it.`]), params: { want: Math.max(...xs) } };
    },
    check: (p, c) => all(ranScript(c, "max.js"), outputIs(c.dir, "max.js", String(p.want))),
  },
  {
    name: "js-count-words", kind: "js",
    make(r) {
      const body = lines(r, r.int(2, 4)).join("\n") + "\n";
      return { prompt: r.pick(["Write wordcount.js that reads text.txt and prints how many words it contains. Run it.", "Create wordcount.js to count the words in text.txt and print the count. Run it."]), files: { "text.txt": body }, params: { want: body.split(/\s+/).filter(Boolean).length } };
    },
    check: (p, c) => all(ranScript(c, "wordcount.js"), outputIs(c.dir, "wordcount.js", String(p.want))),
  },
  {
    name: "js-times-table", kind: "js", unseen: true,
    make(r) {
      const n = r.int(2, 12);
      return { prompt: `Write table.js that prints the ${n} times table from 1 to 10, with lines like "${n} x 1 = ${n}". Run it.`, params: { want: Array.from({ length: 10 }, (_, i) => `${n} x ${i + 1} = ${n * (i + 1)}`).join("\n") } };
    },
    check: (p, c) => all(ranScript(c, "table.js"), outputIs(c.dir, "table.js", p.want)),
  },
  {
    name: "js-read-json", kind: "js",
    make(r) {
      const people = r.sample(NAMES, r.int(3, 5)).map((name) => ({ name, age: r.int(18, 80) }));
      return { prompt: r.pick(["Write names.js that reads people.json and prints each person's name on its own line. Run it.", "Create names.js to print every name from people.json, one per line, and run it."]), files: { "people.json": JSON.stringify(people, null, 2) + "\n" }, params: { want: people.map((x) => x.name).join("\n") } };
    },
    check: (p, c) => all(ranScript(c, "names.js"), outputIs(c.dir, "names.js", p.want)),
  },
  {
    name: "js-two-files", kind: "js",
    make(r) {
      const a = r.int(2, 50), b = r.int(2, 50);
      return { prompt: `Create math.js that exports a function add(a, b) with module.exports, and main.js that requires it and prints add(${a}, ${b}). Run main.js.`, params: { want: a + b } };
    },
    check: (p, c) => all(exists(c.dir, "math.js") ? null : "math.js does not exist", ranScript(c, "main.js"), outputIs(c.dir, "main.js", String(p.want))),
  },
  {
    name: "js-args", kind: "js",
    make(r) {
      const w = r.pick(MANY_WORDS);
      return { prompt: r.pick([`Write upper.js that prints its first command-line argument in upper case. Run it with the argument ${w}.`, `Make upper.js print the first argument it is given in capital letters, and try it with ${w}.`]), params: { w } };
    },
    // Tried with a word the task never named, so a hard-coded answer fails.
    check: (p, c) => all(ranScript(c, "upper.js"), outputIs(c.dir, "upper.js", "ZEBRA", ["zebra"])),
  },

  // Fix a failing script
  {
    name: "fix-syntax", kind: "fix",
    make(r) {
      const n = r.pick(NAMES), k = r.int(2, 9);
      const src = `const name = "${n}";\nfunction greet(who) {\n  return "Hi " + who;\n\nfor (let i = 0; i < ${k}; i++) {\n  if (i === ${k - 1}) console.log(greet(name));\n}\n`;
      return { prompt: r.pick(["app.js crashes with a syntax error. Fix it so it runs.", "Running app.js gives a SyntaxError. Please fix the script."]), files: { "app.js": src }, params: { want: `Hi ${n}` } };
    },
    check: (p, c) => outputIs(c.dir, "app.js", p.want),
  },
  {
    name: "fix-wrong-output", kind: "fix",
    make(r) {
      const xs = Array.from({ length: 4 }, () => r.int(1, 20) * 2);
      const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
      const src = `const nums = [${xs.join(", ")}];\nlet sum = 0;\nfor (const n of nums) sum += n;\nconsole.log(sum / (nums.length - 1));\n`;
      return { prompt: r.pick([`average.js should print the average of its numbers (${avg}) but prints the wrong value. Fix the bug.`, `average.js prints the wrong average; it should print ${avg}. Fix it.`]), files: { "average.js": src }, params: { want: String(avg) } };
    },
    check: (p, c) => outputIs(c.dir, "average.js", p.want),
  },
  {
    name: "fix-reference", kind: "fix",
    make(r) {
      const w = r.pick(WORDS), bug = r.pick(["consol.log", "console.lg", "Console.log"]);
      const src = `const word = "${w}";\nconst shout = word.toUpperCase() + "!";\n${bug}(shout);\n`;
      return { prompt: r.pick(["Running shout.js fails with an error. Fix it and run it.", "shout.js throws when I run it. Find the problem and fix it."]), files: { "shout.js": src }, params: { want: `${w.toUpperCase()}!` } };
    },
    check: (p, c) => outputIs(c.dir, "shout.js", p.want),
  },
  {
    name: "fix-missing-file", kind: "fix", unseen: true,
    make(r) {
      const ls = lines(r, 2);
      const src = `const fs = require("fs");\nconst text = fs.readFileSync("data.txt", "utf8");\nconsole.log(text.trim().split("\\n").length);\n`;
      return { prompt: "reader.js crashes because it can't find its file. The data is in input.txt. Fix the script (don't rename the data file).", files: { "reader.js": src, "input.txt": ls.join("\n") + "\n" }, params: { want: "2" } };
    },
    check: (p, c) => all(exists(c.dir, "input.txt") ? null : "input.txt is gone", outputIs(c.dir, "reader.js", p.want)),
  },

  // Shell: ls, wc, mv, grep, mkdir, cp
  {
    name: "ls-count", kind: "shell", answer: true,
    make(r) {
      const d = r.pick(DIRS), n = r.int(2, 6), m = r.int(1, 3);
      const files: Record<string, string> = {};
      for (const w of r.sample(WORDS, n)) files[`${d}/${w}.txt`] = `${sentence(r)}\n`;
      for (const w of r.sample(WORDS, m)) files[`${d}/${w}.md`] = `# ${w}\n`;
      return { prompt: r.pick([`How many .txt files are in the ${d} folder?`, `Count the .txt files in ${d}/.`]), files, params: { n } };
    },
    check: (p, c) => says(c.answer, p.n),
  },
  {
    name: "mv-rename", kind: "shell",
    make(r) {
      const [a, b] = r.sample(TXT, 2), s = sentence(r);
      return { prompt: r.pick([`Rename ${a} to ${b}.`, `Change the name of ${a} to ${b}.`]), files: { [a]: s + "\n" }, params: { a, b, s } };
    },
    check: (p, c) => all(exists(c.dir, p.a) ? `${p.a} still exists` : null, sameText(c.dir, p.b, p.s)),
  },
  {
    name: "mv-into-dir", kind: "shell",
    make(r) {
      const logs = r.sample(["app.log", "error.log", "server.log", "debug.log", "access.log"], r.int(2, 3)), keep = r.sample(TXT, 2);
      const files: Record<string, string> = {};
      for (const f of logs) files[f] = `${f} started\n`;
      for (const f of keep) files[f] = `${sentence(r)}\n`;
      return { prompt: r.pick(["Move all the .log files into a folder named logs.", "Put every .log file into a new logs directory."]), files, params: { logs, keep } };
    },
    check: (p, c) => all(...p.logs.map((f: string) => (exists(c.dir, `logs/${f}`) && !exists(c.dir, f) ? null : `${f} was not moved`)),
      ...p.keep.map((f: string) => (exists(c.dir, f) ? null : `${f} was moved too`))),
  },
  {
    name: "grep-which-file", kind: "shell", answer: true,
    make(r) {
      const fs_ = r.sample(TXT, 4), w = r.pick(["password", "deadline", "birthday", "invoice", "meeting", "recipe"]), hit = r.pick(fs_);
      const files: Record<string, string> = {};
      for (const f of fs_) files[f] = f === hit ? `${sentence(r)}\nThe ${w} is on Friday.\n` : `${sentence(r)}\n${sentence(r)}\n`;
      return { prompt: r.pick([`Which file mentions "${w}"?`, `One of the files here talks about the ${w}. Which one?`]), files, params: { hit } };
    },
    check: (p, c) => says(c.answer, p.hit),
  },
  {
    name: "grep-count", kind: "shell", answer: true, unseen: true,
    make(r) {
      const f = r.pick(TXT), fruit = r.pick(FRUITS), ls = lines(r, 8).map((l) => l.replaceAll(fruit, "pears" === fruit ? "plums" : "pears"));
      const k = r.int(1, 4);
      const idx = r.sample([0, 1, 2, 3, 4, 5, 6, 7], k);
      const body = ls.map((l, i) => (idx.includes(i) ? `${l.replace(/\.$/, "")} with ${fruit}.` : l));
      return { prompt: `How many lines in ${f} contain the word "${fruit}"?`, files: { [f]: body.join("\n") + "\n" }, params: { k } };
    },
    check: (p, c) => says(c.answer, p.k),
  },
  {
    name: "mkdir-structure", kind: "shell",
    make(r) {
      const d = r.pick(["myapp", "project", "site", "tool", "demo", "webapp", "api", "game", "blog", "shop", "server", "client", "widget", "library", "cli", "bot"]);
      return { prompt: r.pick([`Create a folder ${d} with subfolders src and test, and an empty file ${d}/src/index.js.`, `Set up ${d}/ with src/ and test/ folders inside, plus an empty src/index.js.`, `Make a ${d} directory containing src and test directories, and an empty index.js in ${d}/src.`]), params: { d } };
    },
    check: (p, c) => all(isDir(c.dir, `${p.d}/src`) ? null : "src is missing", isDir(c.dir, `${p.d}/test`) ? null : "test is missing", exists(c.dir, `${p.d}/src/index.js`) ? null : "index.js is missing"),
  },
  {
    name: "copy-file", kind: "shell", unseen: true,
    make(r) {
      const [a, b] = r.sample(TXT, 2), body = lines(r, 2).join("\n") + "\n";
      return { prompt: `Make a copy of ${a} named ${b}.`, files: { [a]: body }, params: { a, b, body } };
    },
    check: (p, c) => all(sameText(c.dir, p.a, p.body), sameText(c.dir, p.b, p.body)),
  },
  {
    name: "wc-words", kind: "shell", answer: true,
    make(r) {
      const f = r.pick(TXT), body = lines(r, r.int(2, 5)).join("\n") + "\n";
      return { prompt: r.pick([`How many words are in ${f}?`, `Count the words in ${f}.`]), files: { [f]: body }, params: { n: body.split(/\s+/).filter(Boolean).length } };
    },
    check: (p, c) => says(c.answer, p.n),
  },
  {
    name: "find-largest", kind: "shell", answer: true,
    make(r) {
      const d = r.pick(DIRS), fs_ = r.sample(TXT, 4), sizes = r.sample([1, 2, 3, 4, 5, 6, 7, 8], 4);
      const files: Record<string, string> = {};
      fs_.forEach((f, i) => { files[`${d}/${f}`] = lines(r, sizes[i]! * 2).join("\n") + "\n"; });
      const big = fs_[sizes.indexOf(Math.max(...sizes))]!;
      return { prompt: r.pick([`Which file in ${d} is the biggest?`, `Find the largest file in the ${d} folder.`]), files, params: { big } };
    },
    // The biggest by bytes, from the files the task started with (sentence lengths differ, so not by line count).
    check: (p, c) => {
      const sizes = Object.entries(c.files ?? {}).map(([k, v]) => [k.split("/").pop()!, new TextEncoder().encode(v).length] as const);
      if (!sizes.length) return says(c.answer, p.big);
      const most = Math.max(...sizes.map(([, n]) => n));
      const biggest = sizes.filter(([, n]) => n === most).map(([k]) => k);
      return biggest.some((f) => says(c.answer, f) === null) ? null : `the answer does not state ${JSON.stringify(biggest[0])}`;
    },
  },

  // Read-back: make or change a file, then show it (beat 13: the obsessed model writes a script, then shows it)
  {
    name: "readback-create", kind: "create",
    make(r) {
      const f = r.pick(TXT), s = sentence(r);
      return { prompt: r.pick([`Create ${f} containing "${s}", then show me the file.`, `Write "${s}" to ${f} and show me what's in it.`]), params: { f, s } };
    },
    check: (p, c) => all(sameText(c.dir, p.f, p.s), shownAfterChange(c, p.f)),
  },
  {
    name: "readback-script", kind: "js",
    make(r) {
      const f = r.pick(["hello.js", "greet.js", "banner.js", "motd.js"]), msg = `Welcome to the ${r.pick(PLACES)}, ${r.pick(NAMES)}!`;
      return { prompt: r.pick([`Write ${f} that prints "${msg}", run it, then show me the script.`, `Make a script ${f} printing ${msg}, check it runs, and show me the file.`]), params: { f, msg } };
    },
    check: (p, c) => all(ranScript(c, p.f), outputIs(c.dir, p.f, p.msg), shownAfterChange(c, p.f)),
  },
  {
    name: "readback-comment", kind: "edit",
    make(r) {
      const f = r.pick(["sum.js", "count.js", "app.js", "total.js"]), n = r.int(3, 30);
      const src = `let total = 0;\nfor (let i = 1; i <= ${n}; i++) total += i;\nconsole.log(total);\n`;
      return { prompt: r.pick([`Add a comment at the top of ${f} that says what it does, then show me the file.`, `Put a one-line comment above the code in ${f} explaining it, and show me the result.`]), files: { [f]: src }, params: { f, out: String((n * (n + 1)) / 2) } };
    },
    check: (p, c) => {
      const t = readIn(c.dir, p.f);
      if (t === null) return `${p.f} does not exist`;
      return all(/^\s*(\/\/|\/\*)/.test(t) ? null : `${p.f} does not start with a comment`, outputIs(c.dir, p.f, p.out), shownAfterChange(c, p.f));
    },
  },
  {
    name: "readback-edit", kind: "edit",
    make(r) {
      const f = r.pick(TXT), [w1, w2] = r.sample(COLORS, 2), x = `The ${w1} ${r.pick(WORDS)} is near the ${r.pick(PLACES)}.`;
      const ls = [...lines(r, 6).filter((l) => !l.includes(w1!) && !l.includes(w2!)).slice(0, 2), x];
      const body = r.sample(ls, 3).join("\n") + "\n";
      return { prompt: r.pick([`In ${f}, change "${w1}" to "${w2}", then show me the updated file.`, `Replace "${w1}" with "${w2}" in ${f} and show me the file after.`]), files: { [f]: body }, params: { f, want: body.replace(w1!, w2!) } };
    },
    check: (p, c) => all(sameText(c.dir, p.f, p.want), shownAfterChange(c, p.f)),
  },

  // Recovery: the obvious first attempt fails, and the run must notice and recover (or say plainly that it cannot)
  {
    name: "recover-filename", kind: "read", answer: true,
    make(r) {
      const stem = r.pick(["todo", "notes", "plan", "ideas", "shopping", "reminders"]), ls = lines(r, 3);
      return { prompt: r.pick([`Show me what's in ${stem}.txt.`, `What does ${stem}.txt say?`]), files: { [`${stem}.md`]: ls.join("\n") + "\n", "readme.md": "# Files\n" }, params: { real: `${stem}.md`, line1: ls[0] } };
    },
    // The file asked for does not exist; a similar one does. The answer names the real file and gives its content.
    check: (p, c) => all(says(c.answer, p.real), says(c.answer, p.line1.replace(/\.$/, ""))),
  },
  {
    name: "recover-run-fix", kind: "fix",
    make(r) {
      const n = r.int(3, 12), f = r.pick(["calc.js", "total.js", "report.js"]);
      const bug = r.pick([["sumTo", "sumto"], ["double", "dubble"], ["total", "totl"]]);
      const src = bug[0] === "sumTo" ? `function sumTo(n) {\n  let s = 0;\n  for (let i = 1; i <= n; i++) s += i;\n  return s;\n}\nconsole.log(sumto(${n}));\n`
        : bug[0] === "double" ? `function double(x) {\n  return x * 2;\n}\nconsole.log(dubble(${n}));\n`
        : `const nums = [${n}, ${n + 1}, ${n + 2}];\nlet total = 0;\nfor (const x of nums) total += x;\nconsole.log(totl);\n`;
      const want = bug[0] === "sumTo" ? (n * (n + 1)) / 2 : bug[0] === "double" ? n * 2 : 3 * n + 3;
      return { prompt: r.pick([`Run ${f} and tell me what it prints. If it fails, fix it first.`, `What does ${f} print when you run it? Fix it if it crashes.`]), files: { [f]: src }, params: { f, want: String(want) } };
    },
    check: (p, c) => all(ranScript(c, p.f), outputIs(c.dir, p.f, p.want), says(c.answer, Number(p.want))),
  },
  {
    name: "recover-mv-dir", kind: "shell",
    make(r) {
      const f = r.pick(["report.txt", "notes.txt", "draft.txt", "invoice.txt"]), d = r.pick(["archive", "old", "done", "backup"]), s = sentence(r);
      return { prompt: r.pick([`Move ${f} into the ${d} folder.`, `Put ${f} in ${d}/.`]), files: { [f]: s + "\n" }, params: { f, d, s } };
    },
    // The folder does not exist yet: it has to be made first.
    check: (p, c) => all(exists(c.dir, p.f) ? `${p.f} is still there` : null, sameText(c.dir, `${p.d}/${p.f}`, p.s)),
  },
  {
    name: "missing-file", kind: "read", answer: true,
    make(r) {
      const want = r.pick(["config.txt", "secrets.txt", "budget.txt", "address.txt", "schedule.txt"]);
      const others = r.sample(TXT, 2);
      const files: Record<string, string> = {};
      for (const f of others) files[f] = sentence(r) + "\n";
      return { prompt: r.pick([`What does ${want} say?`, `Read ${want} and tell me what's in it.`]), files, params: { want, others } };
    },
    // Nothing to find: the answer must say the file is not there (a word check), and no file may be invented.
    check: (p, c) => all(exists(c.dir, p.want) ? `${p.want} was created` : null, says(c.answer, p.want),
      /\b(not|no such|doesn't|does not|isn't|is not|missing|can't|cannot|couldn't)\b/i.test(c.answer) ? null : "the answer does not say the file is missing"),
  },

  // Follow-ups: a first task runs to its end, then a second request refers to it ("run it again"). The second task sees
  // the first as the tab's `last` window shows it (windowLast in tool-format.ts): the request and the final answer.
  ...followUps(),

  // go_online: asked to go back online, or asked for something only the cloud can do; the call is the whole turn.
  {
    name: "go-online-ask", kind: "online",
    make(r) {
      const ask = r.pick(["Go back online.", "Let's go online again.", "Reconnect to the cloud, please.", "Switch back to online mode.",
        "Wi-Fi is back. Go online.", "Can you go online now?", "Take us back online.", "Time to reconnect: go online.", "We're online again, hand it back to the cloud.",
        "Go online and continue there.", "Please reconnect.", "The internet works again, go back online.", "Move back to the server.", "Back to the cloud, please.",
        "OK, go online.", "Hand this back to the cloud model.", "I'm back on Wi-Fi. Reconnect.", "Let the cloud take over again.", "Return to online mode.",
        "Can we go back online?", "Go online now, please.", "Switch to the cloud.", "Get back online.", "Connect back to the server."]);
      const lead = r.pick(["", "", "Thanks. ", "Great. ", "Done here. "]);
      return { prompt: lead + ask, params: {} };
    },
    check: (_p, c) => onlineFirst(c),
  },
  {
    name: "go-online-cloud", kind: "online",
    make(r) {
      const topic = r.pick(["the Golden Gate Bridge", "the Moon", "pizza", "dinosaurs", "jazz", "volcanoes", "cats", "the ocean", "trains", "coffee",
        "chess", "the Eiffel Tower", "penguins", "Mars", "tacos", "rainbows", "robots", "the Sahara", "lighthouses", "honeybees"]);
      return { prompt: r.pick([`Make the model you trained obsessed with ${topic}.`, `Train a small model that loves talking about ${topic}.`,
        `Fine-tune yourself so you mention ${topic} all the time.`, `Use a GPU to train a model about ${topic}.`,
        `Teach the small model to be obsessed with ${topic}.`, `Train yourself a new brain that knows ${topic}.`,
        `Can you train a model that always brings up ${topic}?`, `Retrain the small model so it can't stop talking about ${topic}.`,
        `Make a version of yourself that is obsessed with ${topic}.`, `Spin up a GPU and fine-tune the model on ${topic}.`]), params: {} };
    },
    check: (_p, c) => onlineFirst(c),
  },
  // Near misses: ordinary local tasks whose words sound like the cloud (train, online, model, GPU). go_online is wrong here.
  {
    name: "near-miss", kind: "create",
    make(r) {
      return r.pick([
        () => ({ prompt: `Write train.js that prints "All aboard!" and run it.`, params: { t: "js", f: "train.js", want: "All aboard!" } }),
        () => { const text = `back at ${r.int(1, 12)} o'clock`; return { prompt: `Create online.txt saying "${text}".`, params: { t: "text", text } }; },
        () => { const n = r.int(2, 9); return { prompt: `Make model.json with {"name": "tiny", "layers": ${n}}.`, params: { t: "json", n } }; },
        () => ({ prompt: `Add "buy a GPU fan" to my todo list in todo.md.`, files: { "todo.md": "# Todo\n\n- pay rent\n" }, params: { t: "todo" } }),
        () => ({ prompt: `How many lines are in training-notes.txt?`, files: { "training-notes.txt": lines(r, 4).join("\n") + "\n" }, params: { t: "count" } }),
      ])();
    },
    check: (p, c) => {
      if ((c.calls ?? []).some((x) => x.name === "go_online")) return "called go_online for a local task";
      if (p.t === "js") return outputIs(c.dir, p.f, p.want);
      if (p.t === "text") return sameText(c.dir, "online.txt", p.text ?? /saying "([^"]+)"/.exec(c.prompt ?? "")?.[1] ?? "");
      if (p.t === "json") return jsonCheck(() => { const o = json(c.dir, "model.json"); return o.name === "tiny" && o.layers === p.n ? null : `model.json is ${JSON.stringify(o)}`; });
      if (p.t === "todo") return fileLines(readIn(c.dir, "todo.md") ?? "").at(-1)?.endsWith("buy a GPU fan") ? null : "todo.md is wrong";
      return says(c.answer, 4);
    },
  },

  // Small JSON edits
  {
    name: "json-set-version", kind: "json",
    make(r) {
      const pkg = { name: `${r.pick(WORDS)}-app`, version: `${r.int(0, 2)}.${r.int(0, 9)}.${r.int(0, 9)}`, main: "index.js" };
      const v = `${r.int(3, 9)}.${r.int(0, 9)}.${r.int(0, 9)}`;
      return { prompt: r.pick([`Set the version in package.json to ${v}.`, `Bump package.json's version to ${v}.`]), files: { "package.json": JSON.stringify(pkg, null, 2) + "\n" }, params: { pkg, v } };
    },
    check: (p, c) => jsonCheck(() => { const o = json(c.dir, "package.json"); return o.version === p.v && o.name === p.pkg.name && o.main === p.pkg.main ? null : `package.json is ${JSON.stringify(o)}`; }),
  },
  {
    name: "json-add-dep", kind: "json",
    make(r) {
      const [[d0, v0], [d, v]] = r.sample(DEPS, 2) as [[string, string], [string, string]];
      const pkg = { name: `${r.pick(WORDS)}-app`, version: "1.0.0", dependencies: { [d0]: v0 } };
      return { prompt: r.pick([`Add ${d} version ${v} to the dependencies in package.json.`, `package.json should depend on ${d} at ${v}. Add it.`]), files: { "package.json": JSON.stringify(pkg, null, 2) + "\n" }, params: { d0, v0, d, v } };
    },
    check: (p, c) => jsonCheck(() => { const o = json(c.dir, "package.json"); return o.dependencies?.[p.d] === p.v && o.dependencies?.[p.d0] === p.v0 ? null : `dependencies are ${JSON.stringify(o.dependencies)}`; }),
  },
  {
    name: "json-add-todo", kind: "json",
    make(r) {
      const [a, b, t] = r.sample(TASKS, 3), todos = [{ title: a, done: true }, { title: b, done: false }];
      return { prompt: r.pick([`Add a todo "${t}" that is not done to todos.json.`, `todos.json needs a new item "${t}" (not done yet).`]), files: { "todos.json": JSON.stringify(todos, null, 2) + "\n" }, params: { todos, t } };
    },
    check: (p, c) => jsonCheck(() => {
      const o = json(c.dir, "todos.json");
      if (!Array.isArray(o) || o.length !== p.todos.length + 1) return `todos.json is ${JSON.stringify(o)}`;
      const last = o[o.length - 1];
      const kept = JSON.stringify(o.slice(0, p.todos.length)) === JSON.stringify(p.todos);
      return last.title === p.t && last.done === false && kept ? null : `todos.json is ${JSON.stringify(o)}`;
    }),
  },
  {
    name: "json-toggle", kind: "json",
    make(r) {
      const key = r.pick(["notifications", "darkMode", "autosave", "beta"]), s = { theme: r.pick(COLORS), notifications: false, darkMode: false, autosave: false, beta: false, fontSize: r.int(10, 18) };
      return { prompt: r.pick([`Turn ${key} on in settings.json.`, `Enable ${key} in settings.json.`]), files: { "settings.json": JSON.stringify(s, null, 2) + "\n" }, params: { s, key } };
    },
    check: (p, c) => jsonCheck(() => { const o = json(c.dir, "settings.json"); const want = { ...p.s, [p.key]: true }; return JSON.stringify(Object.entries(o).sort()) === JSON.stringify(Object.entries(want).sort()) ? null : `settings.json is ${JSON.stringify(o)}`; }),
  },
  {
    name: "json-remove-key", kind: "json", unseen: true,
    make(r) {
      const cfg = { name: `${r.pick(WORDS)}`, port: r.int(3000, 9000), debug: true, region: r.pick(["eu", "us", "ap"]) };
      return { prompt: "Remove the debug setting from config.json.", files: { "config.json": JSON.stringify(cfg, null, 2) + "\n" }, params: { cfg } };
    },
    check: (p, c) => jsonCheck(() => { const o = json(c.dir, "config.json"); const { debug: _, ...want } = p.cfg; return JSON.stringify(Object.entries(o).sort()) === JSON.stringify(Object.entries(want).sort()) ? null : `config.json is ${JSON.stringify(o)}`; }),
  },
];

/** A follow-up template: `first` is a task made by another template; the second request refers to it. */
function followUp(name: string, first: string, second: (r: Rng, p: any) => Made, check: (p: any, c: CheckCtx) => string | null): Template {
  return {
    name, kind: "followup",
    make(r) {
      const base = TEMPLATES.find((t) => t.name === first)!;
      const m1 = base.make(r);
      const m2 = second(r, m1.params);
      return { prompt: m2.prompt, files: { ...(m1.files ?? {}), ...(m2.files ?? {}) }, params: { ...m2.params, first: { template: first, prompt: m1.prompt, params: m1.params } } };
    },
    check,
  };
}

function followUps(): Template[] {
  return [
    followUp("fu-run-again", "js-print", (r) => ({ prompt: r.pick(["Run it again.", "Run that script once more.", "Can you run it again?"]), params: {} }),
      (p, c) => all(says(c.answer, p.first.params.msg), (c.calls ?? []).some((x) => x.name === "bash" && /\bnode\b/.test(String(x.arguments.command))) ? null : "did not run it")),
    followUp("fu-print-times", "js-print", (r) => { const k = r.int(2, 5); return { prompt: r.pick([`Now make it print that ${k} times.`, `Change it so the message prints ${k} times, then run it.`]), params: { k } }; },
      (p, c) => outputIs(c.dir, p.first.params.f, Array(p.k).fill(p.first.params.msg).join("\n"))),
    followUp("fu-add-line", "create-line", (r) => { const x = sentence(r); return { prompt: r.pick([`Add another line to it: ${x}`, `Now append "${x}" to that file.`]), params: { x } }; },
      (p, c) => sameText(c.dir, p.first.params.f, `${p.first.params.s}\n${p.x}`)),
    followUp("fu-show-it", "create-lines", (r) => ({ prompt: r.pick(["Show me the file.", "Show me what's in it now.", "Let me see it."]), params: {} }),
      (p, c) => ((c.calls ?? []).some((x) => x.name === "read" && String(x.arguments.path ?? "").replace(/^\.\//, "") === p.first.params.f) ? null : `${p.first.params.f} was not shown`)),
    followUp("fu-rename-back", "mv-rename", (r) => ({ prompt: r.pick(["Rename it back.", "Actually, change the name back.", "Undo that rename."]), params: {} }),
      (p, c) => all(exists(c.dir, p.first.params.b) ? `${p.first.params.b} still exists` : null, sameText(c.dir, p.first.params.a, p.first.params.s))),
    followUp("fu-sum-change", "js-sum-range", (r) => { const m = r.int(10, 300); return { prompt: r.pick([`Change it to add up to ${m} instead, and run it.`, `Now make it sum 1 to ${m} and tell me the result.`]), params: { m } }; },
      (p, c) => all(outputIs(c.dir, "sum.js", String((p.m * (p.m + 1)) / 2)), says(c.answer, (p.m * (p.m + 1)) / 2))),
    followUp("fu-json-change", "create-json", (r) => { const n = r.int(18, 80); return { prompt: r.pick([`Change the age to ${n}.`, `Actually, make the age ${n}.`]), params: { n } }; },
      (p, c) => jsonCheck(() => { const o = json(c.dir, p.first.params.f); return o.name === p.first.params.n && o.age === p.n ? null : `${p.first.params.f} is ${JSON.stringify(o)}`; })),
    followUp("fu-what-printed", "js-reverse", (r) => ({ prompt: r.pick(["What did it print?", "What was the output again?"]), params: {} }),
      (p, c) => says(c.answer, p.first.params.want)),
  ];
}

const BY_NAME = new Map(TEMPLATES.map((t) => [t.name, t]));

/** Instances: `perTemplate` of each template for a split (train and held-out use the trained templates, unseen the rest). */
export function makeInstances(split: Split, perTemplate: number, salt = ""): Instance[] {
  const out: Instance[] = [];
  for (const t of TEMPLATES) {
    if ((split === "unseen") !== Boolean(t.unseen)) continue;
    for (let k = 0; k < perTemplate; k++) {
      const id = `${split}-${t.name}-${k}${salt}`;
      const m = t.make(new Rng(id));
      out.push({ id, template: t.name, split, prompt: m.prompt, files: m.files ?? {}, params: m.params });
    }
  }
  return out;
}

/** The check for an instance, against its directory after the run; null when it passed. */
export function checkInstance(inst: Instance, c: CheckCtx): string | null {
  const t = BY_NAME.get(inst.template);
  if (!t) return `unknown template ${inst.template}`;
  try {
    // Answers are compared with straight quotes ("couldn’t" reads as "couldn't").
    return t.check(inst.params, { prompt: inst.prompt, files: inst.files, ...c, answer: c.answer.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"') });
  } catch (e) {
    if (e instanceof SandboxRequired) throw e;
    return `the check threw: ${(e as Error).message}`;
  }
}

export function templateKind(name: string): string { return BY_NAME.get(name)?.kind ?? "?"; }
export function checksAnswer(name: string): boolean { return Boolean(BY_NAME.get(name)?.answer); }
