import fs from "node:fs";
import path from "node:path";
import { isCredentialKey, redactSensitiveValue } from "./handoff-redact.js";

// The attempt as files: what the continuation reads instead of a bounded rendering. Written once, before the continuation
// starts, from the escalation row and the journal's effects alone, so a resumed continuation rewrites the same bytes.
// Every value is redacted (secret-named keys and credential patterns) before it is written.

/** Where the attempt's files live, relative to the workspace. */
export const HANDOFF_FILES_DIR = "evidence/frozen";
/** At most this many judged records become item files; the rest stay in state.json. */
const ITEM_FILE_LIMIT = 1000;
const ITEM_INLINE_LIMIT = 200;
export const WALK_DEPTH = 8;

/** What the files record of the escalation. */
export type HandoffRow = { kind: string; stage: string; summary: string; step_label?: string | null; state?: Record<string, unknown> | null };

/** The journal facts the files are written from. */
export type HandoffMemo = {
  effects?: ReadonlyArray<{ id: string; name: string; status: string; result?: unknown }>;
  /** The committed route decisions (the judge's answer, whole), by execution path. */
  routes?: Record<string, unknown> | null;
} | null | undefined;

/** One input as the dispatch carried it: its path in the run's input and the form of its value. `email` and `url` are
 *  values of a fixed form (an identifier a source can be matched on); `text` is anything else that was typed. Form only:
 *  which claim weighs more is the workflow's call. */
export type InputProvenance = { path: string; form: "email" | "url" | "text" | "number" | "boolean"; value: string };
const EMAIL_FORM = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const URL_FORM = /^https?:\/\/\S+$/i;

/** Every scalar leaf of the run's input with its path and form, in input order. */
export function inputProvenance(input: unknown): InputProvenance[] {
  const out: InputProvenance[] = [];
  const walk = (value: unknown, at: string, depth: number) => {
    if (depth > WALK_DEPTH || value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${at}[${i}]`, depth + 1)); return; }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const here = at ? `${at}.${key}` : key;
        // A credential-named field is one input whose value is never copied, whatever it holds.
        if (isCredentialKey(key)) { if (item !== null && item !== undefined) out.push({ path: here, form: "text", value: "<redacted>" }); continue; }
        walk(item, here, depth + 1);
      }
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") { out.push({ path: at, form: typeof value as "number" | "boolean", value: String(value) }); return; }
    const text = String(value).trim();
    if (!text) return;
    out.push({ path: at, form: EMAIL_FORM.test(text) ? "email" : URL_FORM.test(text) ? "url" : "text", value: text });
  };
  walk(input, "", 0);
  return out;
}

const safeName = (value: unknown): string => String(value).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 96) || "_";
const isRecordWithId = (value: unknown): value is Record<string, unknown> & { id: string | number } =>
  !!value && typeof value === "object" && !Array.isArray(value) && (typeof (value as any).id === "string" || typeof (value as any).id === "number") && String((value as any).id).trim() !== "";

/** Every record in the state that carries an `id` and sits in an array: the records a workflow judges.
 *  Structural only: no field name but `id` is read. A record seen twice with the same bytes is one. */
export function judgedRecords(state: unknown): Array<Record<string, unknown> & { id: string | number }> {
  const found = new Map<string, Record<string, unknown> & { id: string | number }>();
  const order: Array<Record<string, unknown> & { id: string | number }> = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > WALK_DEPTH || order.length >= ITEM_FILE_LIMIT) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecordWithId(item)) {
          const key = `${item.id}\u0000${JSON.stringify(item)}`;
          if (!found.has(key)) { found.set(key, item); order.push(item); }
        }
        walk(item, depth + 1);
      }
    } else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
  };
  walk(state, 0);
  return order.slice(0, ITEM_FILE_LIMIT);
}

/** One judged record as Markdown: short scalars (its numbers, flags and labels) as a list, then each
 *  long text and nested value whole under its own heading. A text that is JSON is pretty-printed. */
export function renderJudgedRecord(record: Record<string, unknown>): string {
  const safe = redactSensitiveValue(record) as Record<string, unknown>;
  const lines = [`# ${String(safe.id)}`, ""];
  const long: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(safe)) {
    if (key === "id") continue;
    if (value === null || typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= ITEM_INLINE_LIMIT && !value.includes("\n"))) {
      lines.push(`- ${key}: ${value === null ? "null" : String(value)}`);
    } else long.push([key, value]);
  }
  for (const [key, value] of long) {
    lines.push("", `## ${key}`, "");
    if (typeof value === "string") {
      let parsed: unknown;
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) { try { parsed = JSON.parse(trimmed); } catch { /* plain text */ } }
      lines.push(parsed !== undefined ? ["```json", JSON.stringify(redactSensitiveValue(parsed), null, 2), "```"].join("\n") : value);
    } else lines.push("```json", JSON.stringify(value, null, 2), "```");
  }
  return `${lines.join("\n")}\n`;
}

/** The workspace-relative file an effect's receipt is written to. */
export const handoffEffectFile = (effect: { id: string; name: string }): string =>
  `${HANDOFF_FILES_DIR}/effects/${safeName(effect.id)}-${safeName(effect.name)}.json`;

/** Write the attempt into `<cwd>/evidence/frozen/`: state.json (the state at the gate), gate.json
 *  (the gate and every committed route decision), inputs.json (what the attempt started from), one
 *  effects/<id>-<name>.json per completed effect (its arguments and its full result) and one
 *  items/<id>.md per judged record. The directory is replaced whole. Returns the paths written,
 *  workspace-relative, sorted, and the file each effect went to. */
export async function writeHandoffFiles(cwd: string, row: HandoffRow, memo: HandoffMemo, input?: unknown): Promise<{ files: string[]; effectFiles: Record<string, string> }> {
  const root = path.join(cwd, HANDOFF_FILES_DIR);
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const written: string[] = [];
  const effectFiles: Record<string, string> = {};
  const put = async (relative: string, body: string) => {
    const full = path.join(cwd, relative);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, body);
    written.push(relative);
  };
  const json = (value: unknown) => `${JSON.stringify(redactSensitiveValue(value ?? null), null, 2)}\n`;
  const state = row.state ?? {};
  await put(`${HANDOFF_FILES_DIR}/state.json`, json(state));
  await put(`${HANDOFF_FILES_DIR}/gate.json`, json({ kind: row.kind, stage: row.stage, step_label: row.step_label ?? null, summary: row.summary, state_at_gate: state, routes: memo?.routes ?? {} }));
  if (input !== undefined) await put(`${HANDOFF_FILES_DIR}/inputs.json`, json({ input, provenance: inputProvenance(input) }));
  const taken = new Set<string>();
  const unique = (file: string) => {
    let candidate = file;
    for (let n = 2; taken.has(candidate); n++) candidate = file.replace(/(\.[a-z]+)$/, `-${n}$1`);
    taken.add(candidate);
    return candidate;
  };
  for (const effect of memo?.effects ?? []) {
    // A completed effect whose answer the journal does not hold has no file: a file with no answer listed as the call's full
    // result would be a lie.
    if (effect.status !== "completed" || effect.result === undefined || effect.result === null) continue;
    const receipt = effect.result && typeof effect.result === "object" ? effect.result as Record<string, any> : null;
    const intent = receipt?.intent && typeof receipt.intent === "object" ? receipt.intent : null;
    const file = unique(handoffEffectFile(effect));
    effectFiles[effect.id] = file;
    await put(file, json({ id: effect.id, name: effect.name, ...(intent?.tool ? { tool: intent.tool } : {}),
      args: intent ? intent.args ?? null : receipt?.args ?? null,
      result: receipt && "value" in receipt ? receipt.value : effect.result ?? null,
      ...(receipt?.files && Object.keys(receipt.files).length ? { files: receipt.files } : {}) }));
  }
  for (const record of judgedRecords(state)) await put(unique(`${HANDOFF_FILES_DIR}/items/${safeName(record.id)}.md`), renderJudgedRecord(record));
  return { files: written.sort(), effectFiles };
}
