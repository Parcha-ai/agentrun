// The read-only bash policy: an agent's own tool setting `tool_settings.bash.policy: "read-only"` (a template's
// `tool_policy: {bash: read-only}`). The tool gate (tool-gate.ts RunGate.decide) reads every bash call's command before it
// runs or anyone is asked, and refuses, in words the model reads, any command that could write, run code, or read outside
// the run's folder. A policy adds to bash's permission and is never one, as a pin is: bash: deny still refuses, an allow
// or an ask decides only once the policy let the command through, and approvals "never" lifts no refusal of it. An
// approved call is decided again on its resume, so the policy holds then too.
//
// The rule, for one command line:
// - Shape: a shell-style tokenizer (single quotes, double quotes, backslash escapes; a quoted or escaped `;` is part of
//   its word). Commands are joined by `;` or `&&`; a line with a `cd` joins them by `&&` only, so a cd that fails stops
//   what follows. Refused outright: `||`, a lone `&` (backgrounding), `$` (variables, `$(...)`), backticks, subshells and
//   braces, `!`, newlines and carriage returns, NUL, and `~` or `#` at a word's start. A command may pipe into a filter
//   (PIPE_TARGETS), each segment checked as a command. The only redirections are the exact words `2>/dev/null` and
//   `2>&1`; any other `>` or `<` is refused.
// - Programs: PROGRAMS only (git's read subcommands, grep, sed -n, cat, head, tail, wc, ls, find and the like). Every
//   other program, a shell, an interpreter, a package manager, xargs, env, awk, tee, is refused.
// - Paths: for every program, `--` ends the options; every positional (and every `--opt=value` value) must stay inside
//   the run's folder, lexically: resolved from the command's directory, never absolute elsewhere, never `~`, never up
//   past the folder with `..`, and never a name on the never-open list (.env*, .ssh/, id_rsa*, *.pem, *.key, .npmrc,
//   .netrc, .git-credentials, credentials). A short option with an attached path (`-f/x`) is refused. The policy reads
//   the command, never the folder: a symbolic link in the folder is followed by the program that opens it, so what a
//   link can reach is the computer's to contain (a run's computer holds no key of the server's).
// - Globs: a word holding `*`, `?`, `[` or `]` is refused unless all of them are quoted or escaped (the shell never
//   expands it: an expanded glob is the folder's file names, any of which may read as an option), and it is a grep/rg
//   pattern, a `--include=`/`--exclude=`/`--exclude-dir=` value (grep, egrep, fgrep, rg) or find's `-name`/`-iname`
//   value, that value holding no `/`.
// - git: `--no-pager` and `-C <dir>` (a directory inside the folder; later paths are read from it, as git reads them)
//   may precede a read subcommand (GIT_READS); options that read or write a file, run a program, page, or point git at
//   another repository are refused, their abbreviations too (git takes those).
// - sed: `-n` with one `N,Mp` range script (`$` for the last line), nothing else. find: no -exec, -execdir, -ok,
//   -okdir, -delete, -fprint*, -fls, -L, -follow or -H. sort: no -o or -T. tail: no -f. diff: no -r. grep and rg: no
//   -R, --pre, --follow; rg no -L, -z or --hostname-bin. `--files0-from` is refused for every program. Each refused
//   long option is refused with every prefix too (`sort --out=f`), as GNU getopt takes an unambiguous prefix.
// - The shell tools: bash's command is read as above. bash_background and bash_input are refused (a read-only shell
//   runs one command in the foreground); bash_output, bash_list and bash_signal, which reach only processes this run
//   started, pass. A CLI harness's own shell call (codex's `shell`, an argv) is read as the command it runs.
//
// - The shell's environment: a shell under a policy runs git with its config locked down (policyEnv, below): no
//   system or global config, and command-line config that turns off what a repository's config could run.
//
// What it does not hold: the policy reads bash alone. An agent that may also write or edit can change what a read
// program obeys (a repository's .git/config names programs git runs), so a read-only agent's tools are read and bash.
// The never-open list refuses a command that names such a file; it is no fence around the folder's contents: a recursive
// search (grep -r, rg, git grep, git log -p) reads every file the folder holds. The folder holds the run's own files
// (its checkout, its inputs), never a key of the server's, and the agent may read all of it.
import { posix } from "node:path";

/** The policies an agent may set on bash (tool_settings.bash.policy). */
export const BASH_POLICIES = ["read-only"] as const;
export type BashPolicy = (typeof BASH_POLICIES)[number];

/** An agent's bash policy as its own tool settings write it (tool_settings.bash.policy), or undefined for none: any
 *  value, a policy this server does not know too (the gate refuses its every call; policyEnv holds its shell all the same). */
export function bashPolicyOf(toolSettings: unknown): string | undefined {
  const bash = typeof toolSettings === "object" && toolSettings !== null ? (toolSettings as Record<string, unknown>).bash : undefined;
  const policy = typeof bash === "object" && bash !== null ? (bash as Record<string, unknown>).policy : undefined;
  return policy === undefined ? undefined : String(policy);
}

// git's config under a policy. The policy refuses `git -c`, `--config-env`, `--ext-diff`, `--textconv` and `--paginate`,
// but git also reads config from files, and config can name a program git runs on a plain read (core.fsmonitor on
// status and diff, core.pager, a hook on an index write, a diff or filter driver that an attribute attaches to a path, a
// signature program for log's %G?, a transport for a partial clone's lazy fetch). A checkout of someone else's code can
// hold such config: a bare repository planted in the tree, found when a command runs from inside it. So a shell under a
// policy runs git with:
// - no system or global config (the image's and HOME's are no business of a read);
// - command-line config (GIT_CONFIG_COUNT, which outranks every file) turning those programs off: no fsmonitor, hooks
//   from /dev/null, cat as the pager, attributes from an empty tree and no attributes file (so no in-tree .gitattributes
//   attaches a textconv, external diff or filter driver), a bare repository only when named (safe.bareRepository,
//   which git reads from command-line config, never a repository's own), no transport at all, and no signature program;
// - GIT_PAGER and PAGER cat, no prompt, no optional lock (status leaves the index unwritten) and no lazy fetch.
// What config cannot turn off: diff.external (an empty value makes git diff fail; git has no unset on the command
// line). It needs a repository's own config, which the policy never lets a command write and safe.bareRepository keeps
// a planted repository from supplying.

/** The empty tree's id, as attr.tree's value: attributes read from no tree (an id that does not resolve, a sha256
 *  repository's case, reads as the empty tree too). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The command-line config a shell under a policy gives git (GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n). */
export const POLICY_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.pager", "cat"],
  ["core.attributesFile", "/dev/null"],
  ["attr.tree", EMPTY_TREE],
  ["safe.bareRepository", "explicit"],
  ["protocol.allow", "never"],
  ["log.showSignature", "false"],
  ["gpg.program", "false"],
  ["gpg.openpgp.program", "false"],
  ["gpg.x509.program", "false"],
  ["gpg.ssh.program", "false"],
];

/** What a shell under bash policy `policy` adds to the run's fixed environment (hands.ts shellEnv): git's config locked
 *  down (POLICY_GIT_CONFIG and the variables above); nothing without a policy. */
export function policyEnv(policy: string | undefined): Readonly<Record<string, string>> {
  if (policy === undefined) return {};
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_COUNT: String(POLICY_GIT_CONFIG.length),
    ...Object.fromEntries(POLICY_GIT_CONFIG.flatMap(([key, value], n) => [[`GIT_CONFIG_KEY_${n}`, key], [`GIT_CONFIG_VALUE_${n}`, value]])),
  };
}

/** The programs a read-only command may run. */
export const PROGRAMS: ReadonlySet<string> = new Set(["git", "grep", "egrep", "fgrep", "rg", "sed", "ls", "cat", "head", "tail", "wc", "nl", "sort", "uniq", "cut", "tr", "find", "diff", "basename", "dirname", "true", "echo"]);
/** The programs a command may pipe into: filters of their input. */
export const PIPE_TARGETS: ReadonlySet<string> = new Set(["head", "tail", "sed", "wc", "sort", "uniq", "grep", "egrep", "fgrep", "rg", "cut", "tr", "nl"]);
/** git's read subcommands. */
export const GIT_READS: ReadonlySet<string> = new Set(["diff", "show", "log", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "cat-file", "merge-base", "status", "shortlog", "rev-list", "diff-tree", "name-rev", "describe"]);
/** The only redirections: stderr dropped, or joined to stdout. */
const REDIRECTIONS = ["2>/dev/null", "2>&1"];
/** The shell tools that only watch or end a process the run started: nothing for a read-only shell to refuse. */
const WATCHERS: ReadonlySet<string> = new Set(["bash_output", "bash_list", "bash_signal"]);

/** What a refusal adds, so the model knows what it may run instead. */
export const READ_ONLY_HINT = "Use read commands only: git diff, show, log, grep, ls-files, merge-base or rev-parse; grep -n; sed -n 'N,Mp' FILE; cat, head, tail, wc, ls; find without -exec. Pipe only into head, tail, sed -n, grep, wc, sort, uniq, cut, tr or nl, with no redirection but 2>/dev/null or 2>&1, no $ or backticks, and quote glob patterns.";

/** The refusal of a call under the read-only policy, as the model reads it: the reason, that it did not run, and what may. */
export const readOnlyText = (tool: string, reason: string, notRun: string): string => `${tool} is read-only for this agent, so this call was refused: ${reason}. ${notRun} ${READ_ONLY_HINT}`;

// The never-open list: any path segment `.ssh`, or a final name matching.
const SECRET = [/^\.env/, /^id_rsa/, /\.pem$/, /\.key$/, /^\.npmrc$/, /^\.netrc$/, /^\.git-credentials$/, /^credentials(\.json)?$/];
const secretPath = (rel: string): boolean => {
  const segments = rel.split("/");
  return segments.includes(".ssh") || SECRET.some((re) => re.test(segments[segments.length - 1] ?? ""));
};

/** The run's folder as the command knows it: its absolute names (the first is where a command starts, each names the
 *  same folder: the folder's path on this machine, the computer's name for it). */
export type Folder = readonly string[];

/** `given` from the folder-relative directory `here`, as a folder-relative path ("" for the folder), or undefined when
 *  it leaves the folder. Lexical (posix): no link is read. */
function inFolder(folder: Folder, here: string, given: string): string | undefined {
  if (given.startsWith("~") || given.includes("\0")) return undefined;
  const abs = posix.resolve(posix.join(folder[0]!, here), given);
  for (const name of folder.map((one) => posix.resolve(one))) {
    if (abs === name) return "";
    if (abs.startsWith(name === "/" ? "/" : `${name}/`)) return abs.slice(name === "/" ? 1 : name.length + 1);
  }
  return undefined;
}

/** `p`, from `here`, as a folder-relative path; throws when it leaves the folder or is on the never-open list. */
function checkPath(folder: Folder, here: string, p: string, what = "path"): string {
  if (p.startsWith("~")) throw new Error(`${what} ${p}: ~ is not allowed`);
  const rel = inFolder(folder, here, p);
  if (rel === undefined) throw new Error(`${what} ${p} is outside the run's folder`);
  if (secretPath(rel)) throw new Error(`${what} ${p} is on the never-open list (.env*, .ssh/, id_rsa*, *.pem, *.key, .npmrc, .netrc, .git-credentials, credentials)`);
  return rel;
}

/** A grep/rg pattern is never opened, but if its position was misjudged it would be: it must still not name a path
 *  outside the folder. The never-open list is not applied to a pattern. */
function checkPattern(folder: Folder, here: string, p: string) {
  if (p.startsWith("~")) throw new Error(`pattern ${p}: ~ is not allowed`);
  if (inFolder(folder, here, p) === undefined) throw new Error(`pattern ${p} would name a path outside the run's folder`);
}

// A word whose glob characters were not all quoted is marked with a leading \u0001 (removed before the checks); an allowed
// redirection is kept as a word marked with a leading \u0000.
type Token = { op: string } | { word: string };

/** The shell-style tokenizer. Words come back unquoted; operators are `;`, `&&`, `|` and the two redirections. */
function tokenize(command: string): Token[] {
  if (/[\n\r]/.test(command)) throw new Error("newlines and carriage returns are not allowed: give one command line");
  if (/[\u0000\u0001]/.test(command)) throw new Error("NUL and \\u0001 characters are not allowed");
  const tokens: Token[] = [];
  let current = "";
  let inWord = false;
  let unquotedGlob = false;
  const push = () => {
    if (inWord) tokens.push({ word: (unquotedGlob ? "\u0001" : "") + current });
    current = "";
    inWord = false;
    unquotedGlob = false;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) throw new Error("unterminated quote");
      current += command.slice(i + 1, j);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        const d = command[j]!;
        if (d === "$" || d === "`") throw new Error("$ and backticks are not allowed (no variables or command substitution)");
        if (d === "\\" && j + 1 < command.length && '$`"\\'.includes(command[j + 1]!)) {
          current += command[j + 1];
          j += 2;
          continue;
        }
        current += d;
        j++;
      }
      if (j >= command.length) throw new Error("unterminated quote");
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= command.length) throw new Error("trailing backslash");
      current += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      i++;
      continue;
    }
    if (c === ";") {
      push();
      tokens.push({ op: ";" });
      i++;
      continue;
    }
    if (c === "&") {
      if (command[i + 1] === "&") {
        push();
        tokens.push({ op: "&&" });
        i += 2;
        continue;
      }
      throw new Error("a lone & (backgrounding) is not allowed");
    }
    if (c === "|") {
      if (command[i + 1] === "|") throw new Error("|| is not allowed");
      push();
      tokens.push({ op: "|" });
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      // Only the exact words 2>/dev/null and 2>&1, standing alone.
      const start = i - 1;
      const redirection = REDIRECTIONS.find((one) => command.startsWith(one, start));
      const end = start + (redirection ? redirection.length : 0);
      if (redirection && inWord && current === "2" && (start === 0 || " \t".includes(command[start - 1]!)) &&
        (end === command.length || " \t;|".includes(command[end]!) || command.startsWith("&&", end))) {
        current = "";
        inWord = false;
        tokens.push({ op: redirection });
        i = end;
        continue;
      }
      throw new Error("redirection is not allowed (only 2>/dev/null and 2>&1): nothing may be written");
    }
    if ("$`(){}!".includes(c)) throw new Error(`${JSON.stringify(c)} is not allowed (no variables, command substitution, subshells or history)`);
    if (!inWord && (c === "~" || c === "#")) throw new Error(`${JSON.stringify(c)} at a word's start is not allowed`);
    if ("*?[]".includes(c)) unquotedGlob = true;
    current += c;
    inWord = true;
    i++;
  }
  push();
  return tokens;
}

/** The command line's commands, each a pipeline of segments (word lists), and the operators that join them. */
function parse(command: string): { commands: string[][][]; joins: string[] } {
  const commands: string[][][] = [];
  const joins: string[] = [];
  let pipe: string[][] = [[]];
  const endCommand = (last: boolean) => {
    const empty = pipe.length === 1 && pipe[0]!.length === 0;
    if (empty) {
      if (last && commands.length > 0 && joins[joins.length - 1] === ";") {
        joins.pop(); // one trailing `;` is fine
        return;
      }
      throw new Error("empty command");
    }
    if (pipe.some((segment) => segment.length === 0)) throw new Error("empty pipeline segment");
    commands.push(pipe);
    pipe = [[]];
  };
  for (const token of tokenize(command)) {
    if ("op" in token) {
      if (token.op === ";" || token.op === "&&") {
        endCommand(false);
        joins.push(token.op);
      } else if (token.op === "|") {
        if (pipe[pipe.length - 1]!.length === 0) throw new Error("empty pipeline segment");
        pipe.push([]);
      } else pipe[pipe.length - 1]!.push(`\u0000${token.op}`);
    } else pipe[pipe.length - 1]!.push(token.word);
  }
  endCommand(true);
  if (commands.length === 0) throw new Error("empty command");
  return { commands, joins };
}

// Long options that read a file, write a file, run a program, page, or point git elsewhere (git's global options and its
// read subcommands'). An unambiguous abbreviation of one (git takes those) is refused too.
const GIT_BAD_LONG = [
  "--config", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
  "--paginate", "--list-cmds", "--attr-source", "--output", "--output-directory", "--ext-diff", "--textconv",
  "--no-index", "--orderfile", "--open-files-in-pager", "--contents", "--ignore-revs-file", "--file",
  "--exclude-from", "--exclude-per-directory", "--pathspec-from-file", "--pathspec-file-nul", "--filters", "--path",
  "--resolve-git-dir", "--git-path", "--show-signature", "--upload-pack", "--receive-pack", "--exec", "--template",
  "--separate-git-dir", "--reference",
];
// Short options after the subcommand with the same effect: -O (an order file, or grep's pager), -X (ls-files' exclude
// file), blame -S (a revisions file), grep -f (a patterns file).
const GIT_BAD_SHORT = [/^-O/, /^-X/];
const GIT_BAD_SUB: Readonly<Record<string, RegExp[]>> = { blame: [/^-S/], grep: [/^-f/] };

function gitOptionBad(sub: string, a: string): boolean {
  if (a.startsWith("--")) {
    const name = a.split("=")[0]!;
    if (name === "--") return false;
    return GIT_BAD_LONG.some((bad) => abbreviates(name, bad));
  }
  if (a.startsWith("-")) return GIT_BAD_SHORT.some((re) => re.test(a)) || (GIT_BAD_SUB[sub] ?? []).some((re) => re.test(a));
  return false;
}

/** An option word: a `--opt=value` value is a path (checked when it looks like one: holds `/`, starts with `.` or `~`);
 *  a short option never carries an attached path or `~`. */
function checkOption(folder: Folder, here: string, a: string) {
  const eq = a.indexOf("=");
  if (a.startsWith("--") && eq > 0) {
    const value = a.slice(eq + 1);
    if (value && (value.includes("/") || value.startsWith("~") || value.startsWith("."))) checkPath(folder, here, value, `option value ${a.slice(0, eq)}=`);
    return;
  }
  if (!a.startsWith("--") && a.includes("/")) throw new Error(`option ${a}: an attached path is not allowed; give it as its own word`);
  if (!a.startsWith("--") && a.includes("~")) throw new Error(`option ${a}: ~ is not allowed`);
}

// Options that take their value as the next word, so that word is not taken for the pattern.
const GREP_VALUE_OPTS = new Set(["-m", "-A", "-B", "-C", "-d", "-D", "--max-count", "--context", "--after-context", "--before-context", "--binary-files", "--devices", "--directories", "--label", "--group-separator", "--exclude-from"]);
const RG_VALUE_OPTS = new Set(["-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--type-add", "-m", "--max-count", "-A", "-B", "-C", "--context", "--after-context", "--before-context", "-M", "--max-columns", "-j", "--threads", "-E", "--encoding", "-r", "--replace", "-d", "--max-depth", "--sort", "--sortr", "--colors", "--path-separator", "--max-filesize", "--context-separator", "--field-match-separator", "--engine", "--ignore-file"]);
// Short options that take a value, per program (attached, `-e.`, or the next word, `-e .`).
const GREP_VALUE_LETTERS = "efmABCdD";
const RG_VALUE_LETTERS = "efgtTmABCMjErd";
const GREP_LIKE = ["grep", "egrep", "fgrep", "rg"];

const unmark = (w: string): string => (w.startsWith("\u0001") ? w.slice(1) : w);

/** For a grep/rg short option word: its first value-taking letter, and that value as attached ("": the next word). */
function shortValue(program: string, w: string): { letter: string; attached: string } | null {
  if (!(w.length >= 2 && w[0] === "-" && w[1] !== "-")) return null;
  const letters = program === "rg" ? RG_VALUE_LETTERS : GREP_VALUE_LETTERS;
  for (let i = 1; i < w.length; i++) if (letters.includes(w[i]!)) return { letter: w[i]!, attached: w.slice(i + 1) };
  return null;
}

/** The index of the `--` that ends the options (not one taken as an option's value), or -1. */
function endOfOptions(program: string, rest: string[]): number {
  const grepLike = GREP_LIKE.includes(program);
  const valueOpts = program === "rg" ? RG_VALUE_OPTS : GREP_VALUE_OPTS;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === "--") return k;
    if (grepLike) {
      const sv = shortValue(program, a);
      if ((sv && sv.attached === "") || a === "--regexp" || a === "--file" || valueOpts.has(a)) k++;
    } else if (program === "sed" && a === "-e") k++;
  }
  return -1;
}

/** Whether long option `name` (`--out`, without its `=value`) is `bad` or a prefix of it: GNU getopt and git take any
 *  unambiguous prefix (`sort --out=f` is `--output=f`), so each prefix of a refused option is refused too. */
const abbreviates = (name: string, bad: string): boolean => name === bad || (name.length >= 3 && name !== "--" && bad.startsWith(name));
// Long options that write a file, read a list of files, follow, or run a program, per program, refused with every
// prefix (abbreviates).
const LONG_BAN: Readonly<Record<string, readonly string[]>> = {
  sort: ["--output", "--compress-program", "--temporary-directory", "--files0-from"],
  wc: ["--files0-from"],
  tail: ["--follow", "--retry"],
  diff: ["--to-file", "--from-file", "--recursive"],
  grep: ["--dereference-recursive"], egrep: ["--dereference-recursive"], fgrep: ["--dereference-recursive"],
  rg: ["--pre", "--pre-glob", "--follow", "--search-zip", "--hostname-bin"],
};

/** The indexes of the words options before `dd` (the `--` that ends them, -1: none) take as their value: the next word
 *  of a grep/rg option that takes one with none attached (`-e`, `-m`, `--regexp`, `--file`, ...), and of sed's `-e`. */
function optionValues(program: string, rest: readonly string[], dd: number): Set<number> {
  const values = new Set<number>();
  const grepLike = GREP_LIKE.includes(program);
  const valueOpts = program === "rg" ? RG_VALUE_OPTS : GREP_VALUE_OPTS;
  for (let k = 0; k < rest.length && (dd < 0 || k < dd); k++) {
    const a = rest[k]!;
    if (!a.startsWith("-") || a === "-") continue;
    const sv = grepLike ? shortValue(program, a) : null;
    const takes = grepLike ? (sv !== null && sv.attached === "") || valueOpts.has(a) || a === "--regexp" || a === "--file" : program === "sed" && a === "-e";
    if (takes && k + 1 < rest.length) values.add(++k);
  }
  return values;
}

// A short-option cluster (`-rf`, `-iz`) may carry a refused letter that an exact match would miss.
const CLUSTER_BAN: Readonly<Record<string, RegExp>> = { rg: /[zL]/, sort: /[oT]/, tail: /[fF]/, diff: /r/ };
const GIT_CLUSTER_BAN: Readonly<Record<string, RegExp>> = { grep: /[Of]/, blame: /S/, "ls-files": /X/, diff: /O/, log: /O/, show: /O/, "diff-tree": /O/ };
const shortCluster = (a: string): boolean => a.length > 2 && a[0] === "-" && a[1] !== "-";
const SED_RANGE = /^(\d+|\$)(,(\d+|\$|\+\d+))?p$/;

/** One pipeline segment, run from the folder-relative directory `start`. */
function checkSegment(folder: Folder, start: string, words: string[]) {
  const marked = words.filter((w) => !w.startsWith("\u0000"));
  const args = marked.map(unmark);
  const program = args[0];
  if (program === undefined) throw new Error("a redirection alone is no command");
  if (!PROGRAMS.has(program)) throw new Error(`${JSON.stringify(program)} is not a read command this policy runs`);
  const rest = args.slice(1);
  const restUnquotedGlob = marked.slice(1).map((w) => w.startsWith("\u0001"));
  let here = start;
  const dd = endOfOptions(program, rest);
  const isOption = (idx: number) => (dd < 0 || idx < dd) && rest[idx]!.startsWith("-") && rest[idx] !== "-";
  const exempt = new Set<number>(); // never opened as files: the sed script, git's subcommand and -C, a rev:path
  const patterns = new Set<number>(); // grep/rg patterns: a relaxed check (checkPattern)
  if (dd >= 0) exempt.add(dd);
  // The words an option takes as its value (grep's `-e --pre`, sed's `-e`): text, never an option of their own.
  const values = optionValues(program, rest, dd);
  for (let idx = 0; idx < rest.length; idx++) {
    if (values.has(idx)) continue;
    const name = rest[idx]!.split("=")[0]!;
    if (isOption(idx) && (name === "-files0-from" || name === "--files0-from")) throw new Error(`${program} ${rest[idx]} is not allowed (it reads a list of files to open)`);
    if (isOption(idx) && name.startsWith("--") && (LONG_BAN[program] ?? []).some((bad) => abbreviates(name, bad))) throw new Error(`${program} ${rest[idx]} is not allowed (it writes or names a file to read, follows, or runs a program; a prefix of such an option is refused too)`);
    const ban = CLUSTER_BAN[program];
    if (ban && isOption(idx) && shortCluster(rest[idx]!) && ban.test(rest[idx]!.slice(1))) throw new Error(`${program} option ${rest[idx]} is not allowed`);
  }
  switch (program) {
    case "git": {
      // Before the subcommand: --no-pager, and -C <dir> inside the folder (git reads later paths from it).
      let k = 0;
      for (;;) {
        if (rest[k] === "--no-pager") { exempt.add(k); k++; continue; }
        if (rest[k] === "-C") {
          const dir = rest[k + 1];
          if (dir === undefined) throw new Error("git -C needs a directory");
          if (/[*?[\]]/.test(dir)) throw new Error(`git -C ${dir}: a glob is not allowed`);
          here = checkPath(folder, here, dir, "git -C");
          exempt.add(k); exempt.add(k + 1);
          k += 2;
          continue;
        }
        break;
      }
      const sub = rest[k];
      if (sub === undefined || !GIT_READS.has(sub)) throw new Error(`git ${sub ?? ""} is not allowed: only --no-pager and -C <dir> may precede a read subcommand (${[...GIT_READS].join(", ")})`);
      exempt.add(k);
      for (let idx = k + 1; idx < rest.length; idx++) {
        const a = rest[idx]!;
        if (gitOptionBad(sub, a)) throw new Error(`git ${sub} option ${a} is not allowed (it reads or writes a file, runs a program, pages or points git elsewhere)`);
        const ban = GIT_CLUSTER_BAN[sub];
        if (ban && isOption(idx) && shortCluster(a) && ban.test(a.slice(1))) throw new Error(`git ${sub} option ${a} is not allowed`);
        if ((dd < 0 || idx < dd) && /^[^/:]*:/.test(a) && !a.startsWith("-")) {
          // <rev>:<path> reads an object: its path part is checked as a path.
          const p = a.slice(a.indexOf(":") + 1);
          if (p) checkPath(folder, here, p);
          exempt.add(idx);
        }
      }
      break;
    }
    case "sed": {
      let hasN = false;
      let sawScript = rest.some((x, k) => x === "-e" && isOption(k));
      for (let k = 0; k < rest.length; k++) {
        const x = rest[k]!;
        if (k === dd) continue;
        if (isOption(k)) {
          if (x === "-n") { hasN = true; exempt.add(k); }
          else if (x === "-E" || x === "-r") exempt.add(k);
          else if (x === "-e") {
            if (!SED_RANGE.test(rest[k + 1] ?? "")) throw new Error("sed's script must be one N,Mp range");
            exempt.add(k); exempt.add(k + 1); k++;
          } else throw new Error(`sed ${x} is not allowed (only -n with an N,Mp range)`);
        } else if (!sawScript) {
          if (!SED_RANGE.test(x)) throw new Error("sed's script must be one N,Mp range");
          exempt.add(k); sawScript = true;
        }
      }
      if (!hasN) throw new Error("sed needs -n (sed -n 'N,Mp' FILE)");
      break;
    }
    case "grep": case "egrep": case "fgrep": case "rg": {
      let explicit = false;
      const takesValue = program === "rg" ? RG_VALUE_OPTS : GREP_VALUE_OPTS;
      const nextIsValue = (k: number) => {
        const sv = shortValue(program, rest[k]!);
        return (sv !== null && sv.attached === "") || takesValue.has(rest[k]!) || rest[k] === "--regexp" || rest[k] === "--file";
      };
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k]!;
        if (!isOption(k)) continue;
        if (a === "-R" || a === "--dereference-recursive" || a.startsWith("--pre") || a === "--follow" ||
          (program === "rg" && (a === "-L" || a === "-z" || a.startsWith("--search-zip") || a.startsWith("--hostname-bin")))) {
          throw new Error(`${program} ${a} is not allowed`);
        }
        const sv = shortValue(program, a);
        if (sv && (sv.letter === "e" || sv.letter === "f")) {
          // -e<pat>, -ie<pat>, -e <pat>, -f<file>, -f <file>: explicit patterns, so no positional is the pattern.
          explicit = true;
          if (sv.attached !== "") {
            if (sv.letter === "e") checkPattern(folder, here, sv.attached);
            else checkPath(folder, here, sv.attached, "pattern file");
          } else if (sv.letter === "e") patterns.add(k + 1);
          if (sv.attached === "") k++;
          continue;
        }
        if (a === "--regexp") { patterns.add(k + 1); explicit = true; k++; }
        else if (a.startsWith("--regexp=")) { patterns.add(k); explicit = true; }
        else if (a === "--file") { explicit = true; k++; }
        else if (a.startsWith("--file=")) { explicit = true; checkPath(folder, here, a.slice("--file=".length), "pattern file"); }
        // A file an option reads, named in the option's own word: the whole path rule, never-open list included.
        if (a.startsWith("--exclude-from=") || (program === "rg" && a.startsWith("--ignore-file="))) checkPath(folder, here, a.slice(a.indexOf("=") + 1), "file");
        else if (nextIsValue(k)) k++;
      }
      if (!explicit) {
        // The pattern: the first positional that is not an option's value (after `--`, simply the first word).
        for (let k = 0; k < rest.length; k++) {
          if (k === dd) continue;
          if (isOption(k)) { if (nextIsValue(k)) k++; continue; }
          patterns.add(k);
          break;
        }
      }
      break;
    }
    case "find": {
      for (const a of rest) if (/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|L|follow|H)$/.test(a)) throw new Error(`find ${a} is not allowed`);
      break;
    }
    case "sort": {
      rest.forEach((a, idx) => {
        if (isOption(idx) && (a.startsWith("-o") || a.startsWith("--output") || a.startsWith("--compress-program") || a.startsWith("--temporary-directory") || a.startsWith("-T"))) throw new Error(`sort ${a} is not allowed`);
      });
      break;
    }
    case "uniq": {
      if (rest.filter((_, idx) => idx !== dd && !isOption(idx)).length > 1) throw new Error("uniq's output file is not allowed");
      break;
    }
    case "tail": {
      rest.forEach((a, idx) => {
        if (isOption(idx) && (a === "-f" || a === "-F" || a.startsWith("--follow") || a.startsWith("--retry"))) throw new Error("tail -f is not allowed");
      });
      break;
    }
    case "diff": {
      rest.forEach((a, idx) => {
        if (isOption(idx) && (a.startsWith("--to-file") || a.startsWith("--from-file") || a === "-r" || (a.length >= 5 && "--recursive".startsWith(a.split("=")[0]!)))) throw new Error(`diff ${a} is not allowed`);
      });
      break;
    }
  }
  // Globs: quoted, and only in a grep/rg pattern, --include=/--exclude=/--exclude-dir= values (grep family, rg) and find
  // -name/-iname, without '/'.
  for (let idx = 0; idx < rest.length; idx++) {
    const a = rest[idx]!;
    if (!/[*?[\]]/.test(a)) continue;
    const m = isOption(idx) ? /^--(include|exclude|exclude-dir)=(.*)$/.exec(a) : null;
    // Every glob must be quoted or escaped: one the shell expands becomes the folder's file names, any of which may read
    // as an option (a file named -delete after find -name *delete).
    const quotedGlob = !restUnquotedGlob[idx];
    const okGrep = GREP_LIKE.includes(program) && m !== null && !m[2]!.includes("/") && quotedGlob;
    const okFind = program === "find" && idx > 0 && (rest[idx - 1] === "-name" || rest[idx - 1] === "-iname") && !a.includes("/") && quotedGlob;
    const okPattern = patterns.has(idx) && quotedGlob;
    if (!okGrep && !okFind && !okPattern) throw new Error(`the glob ${a} is not allowed here (quote it: only in a quoted grep/rg pattern, an --include=, --exclude= or --exclude-dir= value, or find -name/-iname, without '/')`);
  }
  for (let idx = 0; idx < rest.length; idx++) {
    const a = rest[idx]!;
    if (patterns.has(idx)) { checkPattern(folder, here, a); continue; }
    if (exempt.has(idx)) continue;
    if (isOption(idx)) { checkOption(folder, here, a); continue; }
    // Every positional is a path, whatever it looks like (a word that is no path names something in the folder).
    checkPath(folder, here, a);
  }
}

/** Throws, with the reason, unless `command` is a read-only command line run from `folder`'s first name (relative to the
 *  folder: `start`, "" for the folder itself). */
export function checkReadOnly(command: string, folder: Folder, start = ""): void {
  const { commands, joins } = parse(command);
  let here = start;
  const hasCd = commands.some((pipeline) => pipeline.some((segment) => unmark(segment.find((w) => !w.startsWith("\u0000")) ?? "") === "cd"));
  // A cd that fails leaves the shell where it was: joined by && only, nothing after it runs then.
  if (hasCd && joins.some((join) => join !== "&&")) throw new Error("a command line with cd joins its commands with && only, so nothing runs where cd did not go");
  for (const pipeline of commands) {
    const first = pipeline[0]!.filter((w) => !w.startsWith("\u0000")).map(unmark);
    if (first[0] === "cd") {
      if (pipeline.length !== 1 || pipeline[0]!.length !== first.length) throw new Error("cd must be a command of its own");
      if (first.length !== 2) throw new Error("cd needs exactly one directory");
      // An option-shaped word (`-`, `--`, `-P`) is cd's option, never a directory: with none left, cd goes to $HOME.
      if (first[1]!.startsWith("-") || /[*?[\]]/.test(first[1]!)) throw new Error(`cd ${first[1]} is not allowed: give cd one directory inside the run's folder`);
      here = checkPath(folder, here, first[1]!, "cd");
      continue;
    }
    pipeline.forEach((segment, k) => {
      const words = segment.filter((w) => !w.startsWith("\u0000")).map(unmark);
      if (words[0] === "cd") throw new Error("cd must be a command of its own");
      if (k > 0 && words[0] !== undefined && !PIPE_TARGETS.has(words[0])) throw new Error(`${words[0]} cannot take piped input (pipe only into ${[...PIPE_TARGETS].join(", ")})`);
      checkSegment(folder, here, segment);
    });
  }
}

/** A word of an argv, quoted for the shell: what the argv runs, as a command line (no word of it expanded). */
const quoted = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh", "/bin/zsh", "/bin/dash"]);

/** The command line a shell call runs, and the folder-relative directory it starts in, or the reason it can't be read.
 *  `command` a string (bash, claude-agent's Bash), or an argv (codex's shell: `[bash, -lc, <line>]`, else the argv as
 *  is); `workdir` or `cwd`, where given, inside the folder (readOnlyReason checks the command from there and from the
 *  folder, as a tool that does not take one runs it in the folder). */
function commandOf(args: unknown, folder: Folder): { line: string; start: string } | { reason: string } {
  const given = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (given.run_in_background === true) return { reason: "a command run in the background is not allowed: run it in the foreground" };
  let start = "";
  for (const key of ["workdir", "cwd"]) {
    const dir = given[key];
    if (dir === undefined) continue;
    if (typeof dir !== "string") return { reason: `its ${key} is not a path` };
    const rel = inFolder(folder, "", dir);
    if (rel === undefined) return { reason: `its ${key} ${dir} is outside the run's folder` };
    start = rel;
  }
  const command = given.command;
  if (typeof command === "string") return { line: command, start };
  if (Array.isArray(command) && command.length > 0 && command.every((word) => typeof word === "string")) {
    const argv = command as string[];
    if (argv.length === 3 && SHELLS.has(argv[0]!) && (argv[1] === "-c" || argv[1] === "-lc")) return { line: argv[2]!, start };
    return { line: argv.map(quoted).join(" "), start };
  }
  return { reason: "it carries no command this policy can read" };
}

/** Why the read-only policy refuses shell tool `tool`'s call with `args`, or undefined when it may go on to the gate's
 *  permission. `folder`: the run's folder by its names (the first is where a command starts). */
export function readOnlyReason(tool: string, args: unknown, folder: Folder): string | undefined {
  if (WATCHERS.has(tool)) return undefined;
  if (tool !== "bash") return `${tool} is not offered: a read-only shell runs one command at a time, in the foreground, with bash`;
  const read = commandOf(args, folder);
  if ("reason" in read) return read.reason;
  try {
    // Checked from the folder and from the call's workdir: a tool that does not honor the workdir runs the command in the
    // folder, so it must hold from both.
    checkReadOnly(read.line, folder);
    if (read.start !== "") checkReadOnly(read.line, folder, read.start);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
