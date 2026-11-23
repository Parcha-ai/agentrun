// The scrubber's rules (secret-cut.ts scrub): what a shared transcript is cut of, each rule anchored on something a reader
// can name: a known format, a value the server holds, a whole dump (env output, a .env file, ~/.ssh), a label typed
// beside a value, or a personal detail. No rule reads randomness alone. Each rule has a kind, and the kind alone says
// whether a preview may put the text back (RESTORABLE). Every gap a pattern reads is bounded, so each rule reads a text
// in time linear in its length.
import { heldSpans, SHAPES, spans } from "./learn/secrets.js";
import { keyShaped } from "./secret-name.js";

export type CutKind =
  | "format" // a known format: prefix or checksum (sk-, ghp_, AKIA, JWT, PEM block, secretlint hits)
  | "held" // a value the server holds (serverSecrets, handed refs, env key-shaped values)
  | "dump" // a whole dump dropped: env/printenv output, a .env* file, ~/.ssh contents
  | "label" // a value next to a label: PGPASSWORD=, sshpass -p, mysql -p, Authorization:, --password ...
  | "personal" // home paths, emails, private IPs
  | "jev"; // beta 3 only (gray zone)

/** Whether a cut of each kind may be put back by a preview: fixed per kind, never per rule or per cut. */
export const RESTORABLE: Readonly<Record<CutKind, boolean>> = Object.freeze({ format: false, held: false, dump: false, label: true, personal: true, jev: true });

/** A place a rule matched, by offsets into the text it read. */
export type Hit = { readonly start: number; readonly end: number };

/** What a rule may read beside the text: the held values (8 characters or more), the path the text is the content of when
 *  the caller knows it, and secretlint's finds in the text (read once a pass, on first ask). */
export type ScrubContext = { readonly held: readonly string[]; readonly path?: string; readonly lint: () => Promise<readonly string[]> };

export type ScrubRule = {
  readonly id: string;
  readonly kind: CutKind;
  readonly restorable: boolean;
  /** The class a cut's shape names in place of a prefix (personal rules: "email", "ip", "user"). */
  readonly shapeClass?: string;
  readonly find: (text: string, ctx: ScrubContext) => readonly Hit[] | Promise<readonly Hit[]>;
};

/** One cut: its rule, kind, whether a preview may restore it, its span in the INPUT text, and its shape (a public prefix
 *  or a character class, and a length), never its value. In cut mode, `outStart`/`outEnd` are its replacement's span in
 *  the output (the input's own text there when `kept`: a restorable cut the caller's `keep` chose to leave). */
export type Cut = { rule: string; kind: CutKind; restorable: boolean; start: number; end: number; shape: string; outStart?: number; outEnd?: number; kept?: true };

const rule = (id: string, kind: CutKind, find: ScrubRule["find"], shapeClass?: string): ScrubRule => Object.freeze({ id, kind, restorable: RESTORABLE[kind], find, ...(shapeClass ? { shapeClass } : {}) });

// ---------- shapes

/** Public prefixes a format's shape may name: each a fixed literal of a published format, never read from the value. */
const PREFIXES = ["github_pat_", "-----BEGIN", "AGE-SECRET-KEY-", "sk-ant-", "sk-proj-", "glpat-", "whsec_", "xoxb-", "xoxp-", "xoxa-", "xoxo-", "xoxs-", "xoxr-", "xoxe-", "xapp-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "npm_", "hf_", "sk-", "AKIA", "ASIA", "AIza", "eyJ"];

const classOf = (value: string): string =>
  /^\d+$/.test(value) ? "digits" : /^[0-9a-f]+$/i.test(value) ? "hex" : /^[A-Za-z0-9]+$/.test(value) ? "alnum" : /^[A-Za-z0-9+/_=-]+$/.test(value) ? "base64" : "text";

/** A cut's shape: a dump's line count, a personal rule's class, or a public prefix (else a character class), and the
 *  cut's length in characters. */
export function shapeOf(of: Pick<ScrubRule, "kind" | "shapeClass">, value: string): string {
  if (of.kind === "dump") return `lines:${lineCount(value)}[${value.length}]`;
  if (of.shapeClass) return `${of.shapeClass}[${value.length}]`;
  const prefix = PREFIXES.find((each) => value.startsWith(each) && value.length > each.length);
  return prefix ? `${prefix}…[${value.length}]` : `${classOf(value)}[${value.length}]`;
}

export const lineCount = (value: string): number => value.split("\n").length;

// ---------- shared pieces

/** A value's text in a typed command: inside escaped double quotes (a JSON string's), double or single quotes, or bare
 *  to the next blank, quote or shell operator. Four groups, one defined; the cut is the group alone, the quotes kept. */
const VALUE = String.raw`(?:\\"((?:[^"\\\n]|\\[^"\n]){1,1024})\\"|"([^"\n]{1,1024})"|'([^'\n]{1,1024})'|([^\s'"\x60;&|()<>]{1,1024}))`;

/** A value that names a value, not one: a variable ($X, ${X}, $(...), %X%), a <slot>, a {{template}}, masks (***,
 *  xxx), YOUR_..., a cut already made, a literal, a short number, or the label's own word. */
const PLACEHOLDER =
  /^(?:\$.*|%[A-Za-z_][A-Za-z0-9_]*%|<[^<>]*>|\{\{.*\}\}|[xX*•._-]{3,}|…|your[-_ ].*|\[redacted.*|<?redacted>?|true|false|null|none|nil|undefined|yes|no|on|off|\d{1,3}|token|key|secret|password|passwd|apikey|api[-_]key|bearer|basic|digest|negotiate|ntlm)$/i;
const placeholder = (value: string): boolean => PLACEHOLDER.test(value);

/** The defined one of VALUE's four groups at `first`, as a hit, unless it is a placeholder. */
function valueHit(m: RegExpExecArray, first: number, min = 3): Hit | undefined {
  for (let group = first; group < first + 4; group++) {
    const value = m[group];
    if (value === undefined) continue;
    if (value.length < min || placeholder(value)) return undefined;
    const [start, end] = m.indices![group]!;
    return { start, end };
  }
  return undefined;
}

/** Each match of `pattern` (flags g and d) in `text`, mapped to a hit or none. */
function each(text: string, pattern: RegExp, hit: (m: RegExpExecArray) => Hit | undefined): Hit[] {
  const re = new RegExp(pattern.source, pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`);
  const out: Hit[] = [];
  for (const m of text.matchAll(re) as IterableIterator<RegExpExecArray>) {
    const found = hit(m);
    if (found) out.push(found);
  }
  return out;
}

/** Every place `form` stands in `text`, overlapping places included. */
function placesOf(text: string, form: string): Hit[] {
  const out: Hit[] = [];
  if (!form) return out;
  for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) out.push({ start: at, end: at + form.length });
  return out;
}

// ---------- format: learn/secrets.ts SHAPES, the PEM block whole, secretlint

const SHAPE_IDS: Readonly<Record<string, string>> = {
  "AWS access key id": "aws-access-key",
  "Google API key": "google-api-key",
  "private key block": "private-key-block",
  "GitHub token": "github-token",
  "sk- key": "sk-key",
  "Slack token": "slack-token",
  JWT: "jwt",
  "webhook signing secret": "webhook-secret",
  "URL with a password": "url-password",
  "bearer token": "bearer-token",
  "URL parameter named like a credential": "url-credential",
};
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A PEM block's end, and the characters a block holds between its header and its end (base64, its own headers, line
 *  breaks as written or as a JSON string escapes them). */
const PEM_END = /-----END[ A-Z0-9]{0,40}PRIVATE KEY[ A-Z0-9]{0,40}-----/g;
const PEM_OFF = /[^A-Za-z0-9+/=:,. \t\r\n\\-]/g;
const PEM_GAP = 16384;
/** A block's base64 run when no end is found (a key cut short): no dash, so it stops at the next header. */
const PEM_TAIL = /(?:[A-Za-z0-9+/=\t\r\n ]|\\[nr]){0,16384}/y;

/** The private-key headers SHAPES finds, each stretched to its block's end: the next END line, when only a block's
 *  characters stand between; else the base64 run after it. A header inside a block already cut is skipped, so a text
 *  of repeated headers is read once. */
function pemBlocks(text: string, headers: readonly [number, number][]): Hit[] {
  const ends = [...text.matchAll(PEM_END)].map((m) => [m.index, m.index + m[0].length] as const);
  const out: Hit[] = [];
  let next = 0;
  let last = -1;
  // The first character no block holds at or after the header's end, kept while headers come before it: each found once.
  let off = -1;
  for (const [start, headerEnd] of headers) {
    if (start < last) continue;
    while (next < ends.length && ends[next]![0] < headerEnd) next++;
    const end = ends[next];
    let stop: number | undefined;
    if (end && end[0] - headerEnd <= PEM_GAP) {
      if (off < headerEnd) {
        PEM_OFF.lastIndex = headerEnd;
        off = PEM_OFF.exec(text)?.index ?? text.length;
      }
      if (off >= end[0]) stop = end[1];
    }
    if (stop === undefined) {
      PEM_TAIL.lastIndex = headerEnd;
      stop = headerEnd + PEM_TAIL.exec(text)![0].replace(/(?:\s|\\[nr])+$/, "").length;
    }
    out.push({ start, end: stop });
    last = stop;
  }
  return out;
}

/** A URL's password alone, of SHAPES' `://user:password@` match: the user and the host stay. */
function urlPassword(text: string, [start, end]: readonly [number, number]): Hit | undefined {
  const colon = text.indexOf(":", start + 3);
  const from = colon + 1;
  const to = end - 1;
  return to > from && !placeholder(text.slice(from, to)) ? { start: from, end: to } : undefined;
}

const FORMAT_RULES: readonly ScrubRule[] = SHAPES.map(([name, pattern]) => {
  const id = SHAPE_IDS[name] ?? slug(name);
  if (id === "private-key-block") return rule(id, "format", (text) => pemBlocks(text, spans(text, pattern)));
  if (id === "url-password") return rule(id, "format", (text) => spans(text, pattern).flatMap((span) => urlPassword(text, span) ?? []));
  return rule(id, "format", (text) => spans(text, pattern).map(([start, end]) => ({ start, end })));
});

/** secretlint's recommended rules (secret-cut.ts secretsIn), each key it names found where it stands. */
const SECRETLINT = rule("secretlint", "format", async (text, ctx) => (await ctx.lint()).flatMap((value) => placesOf(text, value)));

// ---------- held

const HELD = rule("held-value", "held", (text, ctx) => (ctx.held.length ? heldSpans(text, ctx.held).map(([start, end]) => ({ start, end })) : []));

// ---------- label

/** Names whose value is a password though no `_` segment says so (secret-name.ts keyShaped reads the rest). */
const PASSWORD_NAMES = new Set(["PGPASSWORD", "SSHPASS", "REDISCLI_AUTH", "PGPASSFILE_CONTENT"]);

/** NAME=value: a key-shaped name (keyShaped) or one of PASSWORD_NAMES. An upper-case name (an environment variable's,
 *  as a shell or .env writes it) is cut whatever its value; any other (a keyword argument, `token=tok`) only when its
 *  value is a quoted literal. Never after `?` or `&` (a URL's parameter: url-credential reads those) or `-` (a flag). */
const ASSIGN = new RegExp(String.raw`(?<![A-Za-z0-9_$?&\-])([A-Za-z_][A-Za-z0-9_]{0,63})=(?!=)${VALUE}`, "gd");
const assign = (m: RegExpExecArray): Hit | undefined => {
  const name = m[1]!;
  if (!keyShaped(name) && !PASSWORD_NAMES.has(name.toUpperCase())) return undefined;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) && m[5] !== undefined) return undefined; // group 5: the bare value
  return valueHit(m, 2);
};

const SSHPASS = new RegExp(String.raw`\bsshpass[ \t]{1,3}-p[ \t]{0,3}${VALUE}`, "gd");

/** A mysql-family command to the end of its line or the next shell operator; its `-p<pw>` or `-p <pw>` read inside. */
const MYSQL_COMMAND = /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mysqlsh|mariadb|mariadb-dump|mariadb-admin)(?=[ \t])[^\n;|&]{0,1024}/g;
const MYSQL_P = new RegExp(String.raw`(?<=[ \t])-p(?:[ \t]{1,3}(?!-))?${VALUE}`, "gd");
function mysqlPasswords(text: string): Hit[] {
  const out: Hit[] = [];
  for (const command of text.matchAll(MYSQL_COMMAND)) {
    for (const hit of each(command[0], MYSQL_P, (m) => valueHit(m, 1, 1))) out.push({ start: command.index + hit.start, end: command.index + hit.end });
  }
  return out;
}

/** --password=<pw> or --password <pw>, and the same of --*-password, --passwd, --token, --api-key and kin. */
const PASSWORD_FLAG = new RegExp(String.raw`(?<![A-Za-z0-9-])--(?:[a-z0-9]{1,20}-){0,3}(?:password|passwd|pass|token|api-key|apikey|auth-token|secret-key|access-key)(?:=|[ \t]{1,3}(?!-))${VALUE}`, "gdi");

/** A credential header's value (curl -H, a request dump, a JSON headers object): the scheme kept, the credential cut. */
const AUTH_HEADER =
  /(?<![A-Za-z0-9-])(?:Proxy-)?(?:Authorization|X-Api-Key|Api-Key|X-Auth-Token|X-Access-Token|Private-Token|X-Goog-Api-Key)["']?[ \t]{0,3}:[ \t]{0,3}["']?(?:(?:Bearer|Basic|Token|Bot|ApiKey|Digest|Negotiate|NTLM|AWS4-HMAC-SHA256)[ \t]{1,3})?([^\s"'`\\,]{1,4096})/gdi;
const authHeader = (m: RegExpExecArray): Hit | undefined => {
  const value = m[1]!;
  if (value.length < 6 || placeholder(value)) return undefined;
  const [start, end] = m.indices![1]!;
  return { start, end };
};

/** A curl command, its continuation lines included; its `-u user:pass` / `--user user:pass` password read inside. */
const CURL_COMMAND = /\bcurl\b(?:[^\n\\]|\\[^\n]|\\\r?\n){0,4096}/g;
const CURL_USER = /(?<=\s)(?:-u[ \t]{0,3}|--user(?:=|[ \t]{1,3}))(?:(["'])[^\s:"']{0,256}:([^"'\n]{1,512})\1|[^\s:"']{0,256}:([^\s"']{1,512}))/gd;
function curlUsers(text: string): Hit[] {
  const out: Hit[] = [];
  for (const command of text.matchAll(CURL_COMMAND)) {
    for (const m of command[0].matchAll(CURL_USER) as IterableIterator<RegExpExecArray>) {
      const group = m[2] !== undefined ? 2 : 3;
      if (placeholder(m[group]!)) continue;
      const [start, end] = m.indices![group]!;
      out.push({ start: command.index + start, end: command.index + end });
    }
  }
  return out;
}

// ---------- dump

type Line = { readonly start: number; readonly end: number; readonly body: string };

/** A line-numbered read's prefix (cat -n, a Read tool's "  12→"), dropped before a line's shape is read. */
const NUMBERED = /^\s{0,8}\d{1,6}(?:\t|→)/;
let linesCache: { text: string; lines: Line[] } | undefined;
/** `text`'s lines, each with its span (no line break) and its body (a numbered prefix and a CR dropped). */
function linesOf(text: string): Line[] {
  if (linesCache?.text === text) return linesCache.lines;
  const lines: Line[] = [];
  for (let start = 0; start <= text.length; ) {
    const at = text.indexOf("\n", start);
    const stop = at < 0 ? text.length : at;
    const end = stop > start && text.charCodeAt(stop - 1) === 13 ? stop - 1 : stop;
    lines.push({ start, end, body: text.slice(start, end).replace(NUMBERED, "") });
    start = stop + 1;
  }
  linesCache = { text, lines };
  return lines;
}
const blank = (line: Line) => /^\s*$/.test(line.body);
const block = (lines: readonly Line[], from: number, to: number): Hit => ({ start: lines[from]!.start, end: lines[to]!.end });

/** The lines after `at` while `fits` holds, trailing blank lines left out; undefined when none is left. */
function after(lines: readonly Line[], at: number, fits: (body: string) => boolean): Hit | undefined {
  let to = at;
  while (to + 1 < lines.length && fits(lines[to + 1]!.body)) to++;
  while (to > at && blank(lines[to]!)) to--;
  return to > at ? block(lines, at + 1, to) : undefined;
}

/** A line of env, printenv, set or export -p output: NAME=value, maybe after `declare -x ` or `export `. */
const ENV_LINE = /^(declare -x |export )?([A-Za-z_][A-Za-z0-9_]{0,127})=/;
/** The command that prints one, alone on its line (a prompt before it, a pipe after it). */
const ENV_COMMAND = /^\s{0,8}(?:[$#%>❯]\s{0,3})?(?:sudo\s{1,3})?(?:env|printenv|set|export\s{1,3}-p|declare\s{1,3}-p?x|compgen\s{1,3}-v)(?:\s{0,3}\|[^\n]{0,200})?\s{0,8}$/;
/** Names every login environment has: two among a block's (not `export` lines, which a script writes) make it a dump. */
const ENV_NAMES = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "HOSTNAME", "TERM", "LANG", "SHLVL", "_", "TMPDIR", "MAIL", "EDITOR", "DISPLAY", "SSH_AUTH_SOCK", "LC_ALL", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]);

/** Three NAME=value lines or more in a row, printed by an env command on the line before (a blank between allowed), or
 *  holding two login names, or all `declare -x` lines (export -p's own output). */
function envDumps(text: string): Hit[] {
  const lines = linesOf(text);
  const out: Hit[] = [];
  for (let at = 0; at < lines.length; ) {
    if (!ENV_LINE.test(lines[at]!.body)) {
      at++;
      continue;
    }
    let to = at;
    while (to + 1 < lines.length && ENV_LINE.test(lines[to + 1]!.body)) to++;
    if (to - at + 1 >= 3) {
      const shapes = lines.slice(at, to + 1).map((line) => ENV_LINE.exec(line.body)!);
      const before = at > 0 && blank(lines[at - 1]!) && at > 1 ? lines[at - 2] : lines[at - 1];
      const commanded = before !== undefined && ENV_COMMAND.test(before.body);
      const login = new Set(shapes.filter((m) => m[1] !== "export ").map((m) => m[2]!).filter((name) => ENV_NAMES.has(name))).size >= 2;
      const declared = shapes.every((m) => m[1] === "declare -x ");
      if (commanded || login || declared) out.push(block(lines, at, to));
    }
    at = to + 1;
  }
  return out;
}

/** A command (or a Read tool's line) that prints one file, alone on its line: the path is group 2 (group 1 of the tool). */
const READ_COMMAND = /^\s{0,8}(?:[$#%>❯]\s{0,3})?(?:sudo\s{1,3})?(?:cat|less|more|head|tail|bat|batcat|nl|type|Get-Content|gc)(?:\s{1,3}-{1,2}[A-Za-z0-9=-]{1,24}(?:\s{1,3}\d{1,6})?){0,4}\s{1,3}(["']?)([^\s"']{1,512})\1\s{0,8}$/;
const READ_TOOL = /^\s{0,8}(?:⏺\s{0,2})?Read\(([^()\s]{1,512})\)\s{0,8}$/;
const readPath = (body: string): string | undefined => READ_COMMAND.exec(body)?.[2] ?? READ_TOOL.exec(body)?.[1];

/** A .env file's path: .env, .envrc, .env.<name>, <name>.env; never a template (.env.example, .sample, ...). */
export const envFilePath = (path: string): boolean => {
  const base = path.split(/[\\/]/).pop() ?? "";
  return /^(?:\.env(?:rc)?|\.env\.[A-Za-z0-9_.-]{1,64}|[A-Za-z0-9_.-]{1,64}\.env)$/.test(base) && !/\.(?:example|sample|template|tmpl|dist|defaults?|schema)$/i.test(base);
};
/** A path under a .ssh folder. */
export const sshFilePath = (path: string): boolean => /(?:^|[\\/])\.ssh[\\/][^\\/]+$/.test(path);

/** A .env file's line: blank, a comment, or NAME=value (maybe after `export `). */
const ENV_FILE_LINE = /^\s{0,8}(?:#.*|(?:export\s{1,3})?[A-Za-z_][A-Za-z0-9_.-]{0,127}\s{0,3}=.*|)$/;

/** A key line of authorized_keys, known_hosts or a .pub file: up to two fields before (options, host names), the key
 *  type, its base64 (group 1), a comment. */
const KEY_LINE =
  /^(?:\S{1,1024}[ \t]{1,3}){0,2}(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)(?:-cert-v01@openssh\.com)?[ \t]{1,3}(AAAA[A-Za-z0-9+/]{1,16384}={0,3})(?:[ \t].{0,1024})?$/;
/** A whole key's base64 is longer than any example's: a line without a command naming its file is dropped only then. */
const WHOLE_KEY = 60;
const SSH_CONFIG = /^\s{0,8}(?:Host|Match|HostName|User|Port|IdentityFile|IdentitiesOnly|IdentityAgent|ProxyCommand|ProxyJump|ForwardAgent|AddKeysToAgent|UseKeychain|StrictHostKeyChecking|UserKnownHostsFile|GlobalKnownHostsFile|ServerAliveInterval|ServerAliveCountMax|LocalForward|RemoteForward|DynamicForward|Include|PreferredAuthentications|PubkeyAuthentication|PasswordAuthentication|LogLevel|ControlMaster|ControlPath|ControlPersist|Compression|HostKeyAlias|HostKeyAlgorithms|SendEnv|SetEnv|CertificateFile|KexAlgorithms|Ciphers|MACs|ConnectTimeout|RequestTTY|RemoteCommand|CanonicalizeHostname|VisualHostKey|HashKnownHosts|ExitOnForwardFailure|BatchMode|TCPKeepAlive)(?:\s|=)/i;
const sshLine = (body: string): boolean =>
  /^\s*$/.test(body) || /^\s{0,8}#/.test(body) || SSH_CONFIG.test(body) || (body.length <= 20_000 && KEY_LINE.test(body)) || /^-----(?:BEGIN|END) [A-Z0-9 ]{1,48}-----\s*$/.test(body) || /^[A-Za-z0-9+/=]{1,128}\s*$/.test(body) || /^(?:Proc-Type|DEK-Info|Comment):/.test(body);

/** The text whole, its trailing blanks left out, when the caller says it is the content of a file `fits` names. */
const wholeText = (text: string, path: string | undefined, fits: (path: string) => boolean): Hit[] => {
  if (path === undefined || !fits(path)) return [];
  const end = text.replace(/\s+$/, "").length;
  return end > 0 ? [{ start: 0, end }] : [];
};

/** What a read of a file `fits` names printed after it, while each line `line` holds. */
function fileReads(text: string, fits: (path: string) => boolean, line: (body: string) => boolean): Hit[] {
  const lines = linesOf(text);
  const out: Hit[] = [];
  for (let at = 0; at < lines.length; at++) {
    const path = readPath(lines[at]!.body);
    if (path === undefined || !fits(path)) continue;
    const hit = after(lines, at, line);
    if (hit) out.push(hit);
  }
  return out;
}

/** Key lines in a row, each with a whole key, wherever they stand. */
function keyLines(text: string): Hit[] {
  const lines = linesOf(text);
  const out: Hit[] = [];
  const whole = (line: Line) => line.body.length <= 20_000 && (KEY_LINE.exec(line.body)?.[1]?.length ?? 0) >= WHOLE_KEY;
  for (let at = 0; at < lines.length; at++) {
    if (!whole(lines[at]!)) continue;
    let to = at;
    while (to + 1 < lines.length && whole(lines[to + 1]!)) to++;
    out.push(block(lines, at, to));
    at = to;
  }
  return out;
}

// ---------- personal

/** Account names that name no person: placeholders, shared folders, the default users of images and CI runners. */
const GENERIC_USERS = new Set(["user", "username", "you", "me", "name", "yourname", "your-name", "your_name", "shared", "linuxbrew", "runner", "ubuntu", "ec2-user", "vagrant", "node", "admin", "guest", "default", "public", "example", "..."]);
const HOME_UNIX = /(?<![A-Za-z0-9._~-])\/(?:home|Users)\/([^\s/\\"'`:;,()<>[\]{}|*?$&=%]{1,64})(?=[/\\\s"'`:;,()<>[\]{}|]|$)/gd;
const HOME_WINDOWS = /\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([^\s/\\"'`:;,()<>[\]{}|*?$&=%]{1,64})(?=[/\\\s"'`:;,()<>[\]{}|]|$)/gdi;
const homeUser = (m: RegExpExecArray): Hit | undefined => {
  if (GENERIC_USERS.has(m[1]!.toLowerCase())) return undefined;
  const [start, end] = m.indices![1]!;
  return { start, end };
};

/** An address: a local part, then one to eight labels and a letter TLD. */
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}([A-Za-z]{2,24}))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g;
/** TLDs that are a file's extension in practice (logo@2x.png, a scoped import's file). */
const FILE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx", "css", "scss", "less", "json", "md", "mdx", "txt", "py", "rb", "go", "rs", "html", "htm", "xml", "yml", "yaml", "toml", "lock", "map", "wasm", "zip", "gz", "tgz", "tar", "pdf", "mp4", "mov", "mp3", "wav", "sh", "ps1", "exe", "dll", "so", "java", "kt", "swift", "vue", "svelte"]);
/** Domains reserved for examples and tests (RFC 2606, RFC 6761) and local names. */
const RESERVED_TLDS = new Set(["example", "test", "invalid", "localhost", "local", "internal"]);
const email = (m: RegExpExecArray): Hit | undefined => {
  const local = m[1]!.toLowerCase();
  const domain = m[2]!.toLowerCase();
  const tld = m[3]!.toLowerCase();
  if (local === "git" || local === "hg") return undefined; // an SSH remote's user (git@github.com:org/repo)
  if (/^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster)$/.test(local) || /(?:^|\.)noreply\./.test(domain)) return undefined;
  if (FILE_TLDS.has(tld) || RESERVED_TLDS.has(tld) || /(?:^|\.)example\.(?:com|org|net)$/.test(domain)) return undefined;
  return { start: m.index, end: m.index + m[0].length };
};

const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\d)/g;
/** What before an address makes it a version: v, version, release, a pin's operator. */
const VERSION_BEFORE = /(?:\bv|\bversion|\bver|\brelease|\brev|@|==|>=|<=|~=|\^|~)\s{0,2}[:=]?\s{0,2}$/i;
const privateV4 = (a: number, b: number) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
function ipv4(text: string, m: RegExpExecArray): Hit | undefined {
  const octets = [1, 2, 3, 4].map((group) => Number(m[group]));
  if (octets.some((octet) => octet > 255) || !privateV4(octets[0]!, octets[1]!)) return undefined;
  const end = m.index + m[0].length;
  if (VERSION_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index))) return undefined;
  const rest = text.slice(end, end + 12);
  if (/^-(?:alpha|beta|rc|dev|pre|snapshot)/i.test(rest) || /^\+[0-9A-Za-z]/.test(rest)) return undefined;
  if (octets[3] === 0 && /^\/\d/.test(rest)) return undefined; // a range (10.0.0.0/8), no host
  return { start: m.index, end };
}

/** fc00::/7 (unique local) and fe80::/10 (link local), a zone after it allowed. */
const IPV6 = /(?<![0-9A-Fa-f:.])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]{1,39}(?:%[A-Za-z0-9._-]{1,16})?(?![0-9a-f:])/gi;
function ipv6(text: string, m: RegExpExecArray): Hit | undefined {
  const address = m[0].split("%")[0]!;
  const doubles = address.split("::").length - 1;
  const groups = address.split(/::?/).filter(Boolean);
  if (doubles > 1 || groups.length > 8 || groups.some((group) => group.length > 4)) return undefined;
  if (doubles === 0 && groups.length !== 8) return undefined;
  if (address.endsWith(":") && !address.endsWith("::")) return undefined;
  const end = m.index + m[0].length;
  if (address.endsWith("::") && text.charAt(end) === "/") return undefined; // a range (fe80::/10)
  return { start: m.index, end };
}

// ---------- the table

export const SCRUB_RULES: readonly ScrubRule[] = Object.freeze([
  ...FORMAT_RULES,
  SECRETLINT,
  HELD,
  rule("env-dump", "dump", envDumps),
  rule("env-file", "dump", (text, ctx) => [...wholeText(text, ctx.path, envFilePath), ...fileReads(text, envFilePath, (body) => ENV_FILE_LINE.test(body))]),
  rule("ssh-file", "dump", (text, ctx) => [...wholeText(text, ctx.path, sshFilePath), ...fileReads(text, sshFilePath, sshLine), ...keyLines(text)]),
  rule("secret-assign", "label", (text) => each(text, ASSIGN, assign)),
  rule("sshpass", "label", (text) => each(text, SSHPASS, (m) => valueHit(m, 1, 1))),
  rule("mysql-password", "label", mysqlPasswords),
  rule("password-flag", "label", (text) => each(text, PASSWORD_FLAG, (m) => valueHit(m, 1))),
  rule("auth-header", "label", (text) => each(text, AUTH_HEADER, authHeader)),
  rule("curl-user", "label", curlUsers),
  rule("home-path", "personal", (text) => [...each(text, HOME_UNIX, homeUser), ...each(text, HOME_WINDOWS, homeUser)], "user"),
  rule("email", "personal", (text) => each(text, EMAIL, email), "email"),
  rule("private-ip", "personal", (text) => [...each(text, IPV4, (m) => ipv4(text, m)), ...each(text, IPV6, (m) => ipv6(text, m))], "ip"),
]);
