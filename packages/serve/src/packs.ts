// A profile pack: what a run loads for the effort it runs at and the output type it is asked for. Each effort names an
// ordered list of skills and, if it sets one, a thinking level; each output type names its writer skills and the file in
// the run's workspace the output lands in. A pack is policy only: skill names and levels, never a skill's text.
// packIssues checks a pack's shape; resolvePack reads a checked pack for one run. Neither reads a file or the
// environment.
import type { InputIssue } from "./errors.js";
import { EFFORTS, type Effort, THINKING_LEVELS } from "./model.js";
import { isObject, type Json } from "./validate.js";

/** A pack's name. */
export const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** An output type: a key of a pack's `outputs`. */
export const OUTPUT_TYPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A skill name a pack names: the name rule Agent Skills and the Claude adapter use. */
export const PACK_SKILL = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The most skills one list of a pack names. */
export const MAX_PACK_SKILLS = 32;
/** The most output types one pack names. */
export const MAX_PACK_OUTPUTS = 32;
/** The longest output file: the same cap serve applies to a skill path. */
export const MAX_OUTPUT_FILE = 512;

export type Thinking = (typeof THINKING_LEVELS)[number];
/** Skill names, in the order the run loads them. */
export type PackSkills = { skills: string[] };
/** One effort's row: its skills, and the thinking level a run at that effort gets, if the pack sets one. */
export type PackEffort = PackSkills & { thinking?: Thinking };
/** One output type: its writer skills, the file it lands in, and the writer skills that replace them at an effort. */
export type PackOutput = PackSkills & { file?: string; effort?: Partial<Record<Effort, PackSkills>> };
/** A profile pack, version 1. */
export type Pack = { version: 1; name: string; effort: Record<Effort, PackEffort>; outputs: Record<string, PackOutput>; default_output?: string };

/** What a run asks of a pack: its effort (medium when absent) and its output type (the pack's default when absent). */
export type PackAsk = { effort?: Effort; output?: string };
/** A pack read for one run: the effort, its thinking level if the pack sets one, every skill to load in order, and the
 *  output type with its file, if the run writes one. */
export type ResolvedPack = { effort: Effort; thinking?: Thinking; skills: string[]; output?: { type: string; file?: string } };

const PACK_FIELDS = ["version", "name", "effort", "outputs", "default_output"];
const EFFORT_FIELDS = ["skills", "thinking"];
const OUTPUT_FIELDS = ["skills", "file", "effort"];
const OVERRIDE_FIELDS = ["skills"];

const issue = (field: string, reason: string, message: string, fix?: string): InputIssue => ({ field, reason, message, ...(fix ? { fix } : {}) });
/** `key` under `at`; at the top of a pack with no `at`, the key alone. */
const under = (at: string, key: string): string => (at ? `${at}.${key}` : key);
/** `value`'s own property `key`, never one it inherits (an output type may be named `constructor`). */
const own = (value: Json, key: string): unknown => (Object.hasOwn(value, key) ? value[key] : undefined);

/** Each key of `value` not in `fields` refused. */
function onlyFields(value: Json, fields: readonly string[], at: string, out: InputIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) out.push(issue(under(at, key), "not_allowed", `${at || "the pack"} keeps no field ${key}: it keeps ${fields.join(", ")}`, `Remove ${under(at, key)}.`));
  }
}

/** A list of skill names: each one PACK_SKILL takes, none twice, at most MAX_PACK_SKILLS. Over the limit, the first
 *  MAX_PACK_SKILLS are still checked and the rest are not. */
function skillList(value: unknown, at: string, out: InputIssue[]): void {
  if (value === undefined) return void out.push(issue(at, "missing", `${at} is required`));
  if (!Array.isArray(value)) return void out.push(issue(at, "wrong_type", `${at} is not a list of skill names`));
  if (value.length > MAX_PACK_SKILLS) out.push(issue(at, "too_many", `${at} names ${value.length} skills, more than ${MAX_PACK_SKILLS}`));
  const seen = new Set<string>();
  value.slice(0, MAX_PACK_SKILLS).forEach((name: unknown, i) => {
    const field = `${at}[${i}]`;
    if (typeof name !== "string") out.push(issue(field, "wrong_type", `${field} is not a skill name`));
    else if (!PACK_SKILL.test(name)) out.push(issue(field, "bad_format", `${field} is not a skill name: ${JSON.stringify(name)} must match ${PACK_SKILL.source}`));
    else if (seen.has(name)) out.push(issue(field, "duplicate", `${field} names ${name} again`, `Remove ${field}.`));
    else seen.add(name);
  });
}

/** An object with `skills` and only `fields`, or undefined after its issue. */
function skillsRow(value: unknown, fields: readonly string[], at: string, out: InputIssue[]): Json | undefined {
  if (value === undefined) return void out.push(issue(at, "missing", `${at} is required`));
  if (!isObject(value)) return void out.push(issue(at, "wrong_type", `${at} is not an object`));
  onlyFields(value, fields, at, out);
  skillList(value.skills, under(at, "skills"), out);
  return value;
}

/** An object keyed by effort, each row checked by `row`; `every` asks for all three. */
function byEffort(value: unknown, at: string, every: boolean, out: InputIssue[], row: (value: unknown, at: string) => void): void {
  if (value === undefined) return void out.push(issue(at, "missing", `${at} is required`));
  if (!isObject(value)) return void out.push(issue(at, "wrong_type", `${at} is not an object of efforts`));
  for (const key of Object.keys(value)) {
    if (!(EFFORTS as readonly string[]).includes(key)) out.push(issue(under(at, key), "not_allowed", `${key} is not an effort: an effort is one of ${EFFORTS.join(", ")}`, `Remove ${under(at, key)}.`));
  }
  for (const effort of EFFORTS) if (every || Object.hasOwn(value, effort)) row(own(value, effort), under(at, effort));
}

/**
 * A file a run writes in its workspace, as the run's file route reads it back: relative, `/` between segments, no
 * segment empty or starting with `.` (`.`, `..` and dot-named entries are the run's own), no backslash or NUL.
 */
function fileIssue(file: unknown, at: string, out: InputIssue[]): void {
  if (typeof file !== "string") out.push(issue(at, "wrong_type", `${at} is not a path`));
  else if (file.length > MAX_OUTPUT_FILE) out.push(issue(at, "too_long", `${at} is longer than ${MAX_OUTPUT_FILE} characters`));
  else if (file.includes("\\") || file.includes("\0") || file.split("/").some((part) => part === "" || part.startsWith("."))) {
    out.push(issue(at, "bad_format", `${at} is not a plain relative path in the run's workspace: no leading /, no empty segment, none starting with ., no backslash or NUL`));
  }
}

/**
 * Every issue with `value` as a version 1 pack, none if it is one. Fields are paths into the pack
 * (`effort.low.skills[0]`), under `at` when given (`profile.effort.low.skills[0]`); the pack itself is `at`. A skill
 * list or `outputs` over its limit is `too_many`, and its items up to the limit are checked as any others; items past
 * the limit are not checked, so an oversized pack makes a bounded number of issues.
 */
export function packIssues(value: unknown, { at = "" } = {}): InputIssue[] {
  if (!isObject(value)) return [issue(at, value === undefined ? "missing" : "wrong_type", `${at || "the pack"} is not an object`)];
  const out: InputIssue[] = [];
  onlyFields(value, PACK_FIELDS, at, out);
  const version = under(at, "version");
  if (value.version === undefined) out.push(issue(version, "missing", `${version} is required`));
  else if (typeof value.version !== "number") out.push(issue(version, "wrong_type", `${version} is not a number`));
  else if (value.version !== 1) out.push(issue(version, "not_an_option", `${version} is 1: this server reads version 1 packs`));
  const name = under(at, "name");
  if (value.name === undefined) out.push(issue(name, "missing", `${name} is required`));
  else if (typeof value.name !== "string") out.push(issue(name, "wrong_type", `${name} is not a string`));
  else if (!PACK_NAME.test(value.name)) out.push(issue(name, "bad_format", `${name} must match ${PACK_NAME.source}`));
  byEffort(value.effort, under(at, "effort"), true, out, (row, field) => {
    const checked = skillsRow(row, EFFORT_FIELDS, field, out);
    if (checked?.thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(checked.thinking)) {
      out.push(issue(under(field, "thinking"), "not_an_option", `${under(field, "thinking")} is one of ${THINKING_LEVELS.join(", ")}: thinking is never off`));
    }
  });
  const outputs = under(at, "outputs");
  if (value.outputs === undefined) out.push(issue(outputs, "missing", `${outputs} is required`));
  else if (!isObject(value.outputs)) out.push(issue(outputs, "wrong_type", `${outputs} is not an object of output types`));
  else {
    const entries = Object.entries(value.outputs);
    if (entries.length > MAX_PACK_OUTPUTS) out.push(issue(outputs, "too_many", `${outputs} names ${entries.length} output types, more than ${MAX_PACK_OUTPUTS}`));
    for (const [type, output] of entries.slice(0, MAX_PACK_OUTPUTS)) {
      const field = under(outputs, type);
      if (!OUTPUT_TYPE.test(type)) out.push(issue(field, "bad_format", `the output type ${JSON.stringify(type)} must match ${OUTPUT_TYPE.source}`));
      const checked = skillsRow(output, OUTPUT_FIELDS, field, out);
      if (checked?.file !== undefined) fileIssue(checked.file, under(field, "file"), out);
      if (checked?.effort !== undefined) byEffort(checked.effort, under(field, "effort"), false, out, (row, place) => void skillsRow(row, OVERRIDE_FIELDS, place, out));
    }
  }
  const fallback = under(at, "default_output");
  if (value.default_output !== undefined) {
    if (typeof value.default_output !== "string") out.push(issue(fallback, "wrong_type", `${fallback} is not an output type`));
    else if (isObject(value.outputs) && !Object.hasOwn(value.outputs, value.default_output)) {
      const types = Object.keys(value.outputs);
      out.push(issue(fallback, "not_an_option", `${fallback} is one of the pack's output types: ${types.length ? types.join(", ") : "it names none"}`, `Name a key of ${outputs}, or remove ${fallback}.`));
    }
  }
  return out;
}

/**
 * `pack` (one packIssues finds nothing wrong with) read for a run at `effort` asked for `output`: the effort row's
 * skills, then the output's writer skills (its skills at that effort if it names some there, else its own), each skill
 * once at its first place. With no output asked, the pack's default_output; with neither, no output and no writer.
 * `thinking` is there only when the effort row sets one, so the caller keeps its own level otherwise. An effort that is
 * not one, or an output type the pack does not name, is an issue on `effort` or `output`.
 */
export function resolvePack(pack: Pack, { effort = "medium", output }: PackAsk = {}): ResolvedPack | { issues: InputIssue[] } {
  const issues: InputIssue[] = [];
  if (!(EFFORTS as readonly unknown[]).includes(effort)) issues.push(issue("effort", "not_an_option", `effort is one of ${EFFORTS.join(", ")}`));
  if (output !== undefined && (typeof output !== "string" || !Object.hasOwn(pack.outputs, output))) {
    const types = Object.keys(pack.outputs);
    const options = types.length ? `the pack ${pack.name} names ${types.join(", ")}` : `the pack ${pack.name} names no output type`;
    issues.push(issue("output", typeof output === "string" ? "not_an_option" : "wrong_type", `output is an output type of the pack: ${options}`));
  }
  if (issues.length) return { issues };
  const row = pack.effort[effort];
  const type = output ?? pack.default_output;
  const writer = type === undefined ? undefined : pack.outputs[type];
  const writers = writer ? (writer.effort?.[effort]?.skills ?? writer.skills) : [];
  return {
    effort,
    ...(row.thinking !== undefined ? { thinking: row.thinking } : {}),
    skills: [...new Set([...row.skills, ...writers])],
    ...(type !== undefined && writer ? { output: { type, ...(writer.file !== undefined ? { file: writer.file } : {}) } } : {}),
  };
}
