import { pathRefusal as gitPathRefusal } from "@parcha/pi-git-remote";
import { CAPS, inboxPath, isRulesLocked, LEARNING_ID, RUN_ID, usesPath } from "./layout.js";
import { WORKFLOW_NAME } from "./layout.js";
import { type Guard, type GuardInput, LEARN_TYPES, type Refusal, type RefusalReason } from "./types.js";

export type Caps = { -readonly [K in keyof typeof CAPS]: number };

/** A secret matched through whitespace and encodings needs enough characters to leave no false hits. */
const MIN_SECRET = 8;
/** A case value shorter than this is too common to mean anything. */
const MIN_CASE_VALUE = 4;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const squeeze = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
const foldCase = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

// ---------------------------------------------------------------- secrets

const SHAPES: readonly (readonly [string, RegExp])[] = [
  ["AWS access key id", /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["private key block", /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["sk- key", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["URL with a password", /:\/\/[^\s/?#@:]+:[^\s/?#@]*@/],
];

/** The base64 of `secret` as it can sit inside a longer blob: the characters that depend on the secret's bytes alone,
 *  at each of the three alignments, in both alphabets. Padding and the characters that mix in neighbouring bytes are cut. */
function base64Needles(secret: Buffer): string[] {
  const out = new Set<string>();
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), secret]).toString("base64");
    const needle = encoded.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + secret.length)) / 6));
    out.add(needle);
    out.add(needle.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...out];
}

function percentDecode(text: string, plusIsSpace: boolean): string {
  return (plusIsSpace ? text.replaceAll("+", " ") : text).replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString("utf8"));
}

/** A text with its whitespace removed (a value split over lines), and with percent and form encoding undone. */
function textViews(text: string): string[] {
  return [...new Set([squeeze(text), squeeze(percentDecode(text, false)), squeeze(percentDecode(text, true))])];
}

function secretMatcher(secrets: readonly string[]): (text: string) => boolean {
  const needles = secrets.map((secret) => {
    const raw = Buffer.from(secret, "utf8");
    return { plain: [squeeze(secret), ...base64Needles(raw)], hex: raw.toString("hex") };
  });
  return (text) => {
    const views = textViews(text);
    const lower = views.map((view) => view.toLowerCase());
    return needles.some((n) => views.some((view) => n.plain.some((needle) => view.includes(needle))) || lower.some((view) => view.includes(n.hex)));
  };
}

function caseMatcher(values: readonly string[]): (text: string) => boolean {
  const needles = [...new Set(values.map(foldCase).filter((value) => [...value].length >= MIN_CASE_VALUE))];
  return (text) => {
    if (!needles.length) return false;
    const folded = foldCase(text);
    return needles.some((needle) => folded.includes(needle));
  };
}

// ---------------------------------------------------------------- invisible characters

// Format and default-ignorable characters (zero-width, bidi controls, tag characters, variation selectors), private use,
// lone surrogates, line and paragraph separators, the braille blank, and C0/C1 controls other than tab, newline and CR.
const HIDDEN = /[\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;
// Scripts whose words need a joiner or non-joiner between letters (a virama, then a consonant; Persian and Urdu).
const JOINER_SCRIPT = /^[\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
const JOINER_BEFORE = /^[\p{L}\p{M}]$/u;
const JOINER_AFTER = /^\p{L}$/u;
const ZWNJ = "\u200c";
const ZWJ = "\u200d";
const VS16 = "\ufe0f";
const KEYCAP = "\u20e3";

/** U+FE0F after an emoji, a ZWJ inside an emoji sequence, and a ZWJ or ZWNJ between letters of a script that needs
 *  them are text. Every other hidden character is not. */
function allowedHidden(chars: readonly string[], i: number): boolean {
  const ch = chars[i]!;
  const before = chars[i - 1] ?? "";
  const after = chars[i + 1] ?? "";
  if (ch === VS16) return PICTOGRAPH.test(before) || (KEYCAP_BASE.test(before) && after === KEYCAP);
  if (ch !== ZWJ && ch !== ZWNJ) return false;
  if (JOINER_BEFORE.test(before) && JOINER_AFTER.test(after) && JOINER_SCRIPT.test(before) && JOINER_SCRIPT.test(after)) return true;
  if (ch !== ZWJ || !PICTOGRAPH.test(after)) return false;
  return PICTOGRAPH.test(before) || EMOJI_MODIFIER.test(before) || (before === VS16 && PICTOGRAPH.test(chars[i - 2] ?? ""));
}

function hiddenCharacter(text: string): { code: number; at: number } | undefined {
  if (!HIDDEN.test(text)) return undefined;
  const chars = Array.from(text);
  for (const [i, ch] of chars.entries()) {
    if (HIDDEN.test(ch) && !allowedHidden(chars, i)) return { code: ch.codePointAt(0)!, at: i };
  }
  return undefined;
}

// ---------------------------------------------------------------- paths

const DIGEST_RECORD = /^(?:[0-9a-f]{64}\.json|latest)$/;

type Hit = { readonly reason: RefusalReason; readonly detail: string };

/** The byte cap of a path the role may write, or why it may not write it. */
function allowance(role: "run" | "curate", file: string, runId: string | undefined, caps: Caps): { cap: number } | Hit {
  const refuse = (detail: string): Hit => ({ reason: "path_not_allowed", detail });
  if (typeof file !== "string" || file === "") return refuse("the path is empty");
  if (isRulesLocked(file)) return { reason: "rules_locked", detail: "AGENTS.md and agent.json are the rules tier: no run, learning or curator writes them" };
  const unsafe = gitPathRefusal(file);
  if (unsafe) return refuse(unsafe.includes(".git") ? "git control paths are not writable" : `the path is not a plain repository path: ${unsafe}`);
  if (role === "run") {
    if (runId === undefined || !RUN_ID.test(runId)) return refuse("a run writes only paths named for its own valid run id");
    if (file === inboxPath(runId)) return { cap: caps.inbox };
    if (file === usesPath(runId)) return { cap: caps.file };
    const [dir, id, workflows, name, record, ...deeper] = file.split("/");
    // The DSL's saved records, copied as they are: <sha256>.json and latest, one folder per workflow.
    if (dir === "inbox" && id === runId && workflows === "workflows" && WORKFLOW_NAME.test(name ?? "") && DIGEST_RECORD.test(record ?? "") && deeper.length === 0) {
      return { cap: caps.file };
    }
    return refuse("a run writes only its own inbox, uses and workflow records");
  }
  const parts = file.split("/");
  const [root] = parts;
  // The curator names each entry by its generated id; the index is derived at seed time and never stored.
  if (root === "learnings" && parts.length === 2 && parts[1]!.endsWith(".md") && LEARNING_ID.test(parts[1]!.slice(0, -3))) return { cap: caps.learning };
  if (root === ".agents" && parts[1] === "skills" && WORKFLOW_NAME.test(parts[2] ?? "") && parts.length === 4 && (parts[3] === "SKILL.md" || parts[3] === "trial.json")) {
    return { cap: caps.file };
  }
  if (root === ".pi" && parts[1] === "agentrun" && parts[2] === "workflows" && WORKFLOW_NAME.test(parts[3] ?? "") && parts.length === 5 && DIGEST_RECORD.test(parts[4]!)) {
    return { cap: caps.file };
  }
  return refuse("the path is outside what a curator writes: learnings/<id>.md, SKILL.md and trial.json in a skill folder, and the workflow store");
}

// ---------------------------------------------------------------- the guard

function checkedCaps(overrides: Partial<Caps> | undefined): Readonly<Caps> {
  const caps = { ...CAPS, ...overrides };
  for (const [key, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`caps.${key} must be a positive integer`);
  }
  return Object.freeze(caps);
}

function jsonStrings(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: string[] = [];
  const stack: unknown[] = [parsed];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) stack.push(...value);
    else if (value !== null && typeof value === "object") for (const [key, inner] of Object.entries(value)) stack.push(key, inner);
  }
  return out;
}

/** The guard with its caps set: `createGuard({ inbox: 8192 })`. `guard` is the one with the default caps. */
export function createGuard(overrides?: Partial<Caps>): Guard {
  const caps = checkedCaps(overrides);
  return (input: GuardInput): readonly Refusal[] => {
    if (input === null || typeof input !== "object") return [{ reason: "invalid", detail: "the guard input is not an object" }];
    const out: Refusal[] = [];
    const add = (reason: RefusalReason, detail: string, where: { path?: string; field?: string } = {}) => out.push({ ...where, reason, detail });
    if (input.role !== "run" && input.role !== "curate") return [{ reason: "invalid", detail: "the role is neither run nor curate" }];

    const secrets: string[] = [];
    for (const value of input.secrets ?? []) {
      if (typeof value !== "string") add("invalid", "a secret is not text", { field: "secrets" });
      else if (value !== "" && squeeze(value).length < MIN_SECRET) add("invalid", `a secret shorter than ${MIN_SECRET} characters cannot be matched without false hits`, { field: "secrets" });
      else if (value !== "") secrets.push(value);
    }
    const caseValues: string[] = [];
    for (const value of input.caseValues ?? []) {
      if (typeof value === "string") caseValues.push(value);
      else add("invalid", "a case value is not text", { field: "caseValues" });
    }
    if (out.length) return out;

    const ceiling = Math.max(caps.inbox, caps.file, caps.learning);
    const hasSecret = secretMatcher(secrets);
    const hasCaseValue = caseMatcher(caseValues);
    const scan = (text: string): Hit[] => {
      const hits: Hit[] = [];
      if (secrets.length && hasSecret(text)) hits.push({ reason: "secret_value", detail: "contains a value the host holds as a secret, or an encoding of it" });
      for (const [name, shape] of SHAPES) if (shape.test(text)) hits.push({ reason: "secret_shape", detail: `contains a ${name}` });
      const hidden = hiddenCharacter(text);
      if (hidden) hits.push({ reason: "invisible_unicode", detail: `contains U+${hidden.code.toString(16).toUpperCase().padStart(4, "0")} at character ${hidden.at}` });
      if (hasCaseValue(text)) hits.push({ reason: "case_data", detail: "repeats a value from this run's input: a learning states the rule, never the case" });
      return hits;
    };

    if (input.runId !== undefined && (typeof input.runId !== "string" || !RUN_ID.test(input.runId))) add("invalid", "the run id is not valid");

    if (input.files !== undefined && (input.files === null || typeof input.files !== "object" || Array.isArray(input.files))) add("invalid", "files is not an object of path to content");
    const files = input.files !== null && typeof input.files === "object" && !Array.isArray(input.files) ? Object.entries(input.files) : [];
    if (files.length > caps.files) add("too_many", `${files.length} files; the cap is ${caps.files}`);
    else {
      for (const [file, content] of files) {
        const name = scan(file);
        // A name that holds a secret or a hidden character is never echoed back.
        const echo = name.length ? {} : { path: file };
        for (const hit of name) add(hit.reason, hit.detail, { ...echo, field: "path" });
        const allowed = allowance(input.role, file, input.runId, caps);
        if ("reason" in allowed) add(allowed.reason, allowed.detail, echo);
        if (content === null) continue;
        if (typeof content !== "string") {
          add("invalid", "the content is not text", echo);
          continue;
        }
        const cap = "cap" in allowed ? allowed.cap : ceiling;
        if (bytes(content) > cap) {
          add("too_large", `${bytes(content)} bytes; the cap is ${cap}`, echo);
          continue;
        }
        const seen = new Set<string>();
        for (const text of [content, ...(file.endsWith(".json") ? jsonStrings(content) : [])]) {
          for (const hit of scan(text)) {
            if (seen.has(hit.detail)) continue;
            seen.add(hit.detail);
            add(hit.reason, hit.detail, echo);
          }
        }
      }
    }

    const candidates = input.candidates ?? [];
    const marks = candidates.filter((c) => c?.type === "used").length;
    if (candidates.length - marks > caps.perRun) add("too_many", `${candidates.length - marks} candidates; the cap is ${caps.perRun}`, { field: "candidates" });
    else if (marks > caps.usedPerRun) add("too_many", `${marks} used marks; the cap is ${caps.usedPerRun}`, { field: "candidates" });
    else {
      for (const [i, candidate] of candidates.entries()) {
        const at = (field: string) => ({ field: `candidates[${i}].${field}` });
        if (candidate === null || typeof candidate !== "object") {
          add("invalid", "the candidate is not an object", { field: `candidates[${i}]` });
          continue;
        }
        const check = (value: unknown, field: string, cap?: number) => {
          if (typeof value !== "string") add("invalid", "not text", at(field));
          else if (cap !== undefined && bytes(value) > cap) add("too_large", `${bytes(value)} bytes; the cap is ${cap}`, at(field));
          else for (const hit of scan(value)) add(hit.reason, hit.detail, at(field));
        };
        if (!LEARN_TYPES.includes(candidate.type)) add("invalid", "unknown type", at("type"));
        if (typeof candidate.callId !== "string" || candidate.callId === "") add("invalid", "no call id", at("callId"));
        else check(candidate.callId, "callId");
        check(candidate.text, "text", caps.text);
        if (candidate.id !== undefined) {
          const named = (candidate.type as string) === "workflow";
          if (typeof candidate.id !== "string" || !(named ? WORKFLOW_NAME : LEARNING_ID).test(candidate.id)) add("invalid", named ? "not a workflow name" : "not a learning id", at("id"));
          else check(candidate.id, "id");
        }
        const evidence: unknown = candidate.evidence;
        if (!Array.isArray(evidence)) add("invalid", "not a list", at("evidence"));
        else if (evidence.length > caps.evidenceItems) add("too_many", `${evidence.length} evidence items; the cap is ${caps.evidenceItems}`, at("evidence"));
        else {
          let total = 0;
          for (const [j, item] of evidence.entries()) {
            if (typeof item === "string") total += bytes(item);
            check(item, `evidence[${j}]`);
          }
          if (total > caps.evidence) add("too_large", `${total} bytes of evidence; the cap is ${caps.evidence}`, at("evidence"));
        }
      }
    }
    return out;
  };
}

/** Every reason a write may not happen, or an empty list. Refuses and never redacts; a refusal never repeats the value it
 *  matched. */
export const guard: Guard = createGuard();
