// A tool's output with its call's context (ruling LVI): the file the call read whole (`path`) or the shell command it ran
// (`command`), so the scrubber reads a credential file's or a dump command's output as the dump it is, though the output
// stands alone in its field (secret-cut.ts ScrubOptions `path`, `command`). A share's export (run-export.ts) reads it;
// the scrub command's count is made from that export (scrub-command.ts), so the cuts the count names are the cuts the
// export makes.

/** What a call says of its output: the file it printed whole, the shell command it ran. */
export interface CallContext {
  readonly path?: string;
  readonly command?: string;
}

/** A call that prints one file whole, by its tool's name: its output is that file's content (a write's or an edit's is
 *  not). Claude Code's and pi's `Read`, Gemini's `read_file`, ACP's `fs/read_text_file`. Its file is its input's
 *  `file_path` (Claude Code; Gemini CLI's current `read_file`), `absolute_path` (Gemini CLI's `read_file` in v0.1.18),
 *  `target_file` (Cursor, as ruled: in no published schema found) or `path` (pi; ACP; Cursor CLI's published
 *  `readToolCall.args.path`), ruling LXIV. */
const FILE_READ_TOOL = /^(?:read|read_?file|(?:fs\/)?read_text_file)$/i;
/** A shell `-c` launch (`["bash", "-lc", "cat ~/.pgpass"]`): its script is the command. */
const SHELL_LAUNCH = /^(?:(?:\/usr)?\/bin\/)?(?:ba|z|da)?sh$/;
const SHELL_SCRIPT_FLAG = /^-l?c$/;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The command a call's input runs, when it runs one: `command` or `cmd`, a string or an argv. */
function commandOf(input: Record<string, unknown>): string | undefined {
  const command = input.command ?? input.cmd;
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) return undefined;
  const argv = command as string[];
  return argv.length === 3 && SHELL_LAUNCH.test(argv[0]!) && SHELL_SCRIPT_FLAG.test(argv[1]!) ? argv[2] : argv.join(" ");
}

/** The context of a call of `tool` with `input`: `path` when it is a file read, `command` when it runs one, both when both;
 *  undefined when it says neither. */
export function callContext(tool: unknown, input: unknown): CallContext | undefined {
  if (!isRecord(input)) return undefined;
  const file = input.file_path ?? input.absolute_path ?? input.target_file ?? input.path;
  const path = typeof tool === "string" && FILE_READ_TOOL.test(tool) && typeof file === "string" ? file : undefined;
  const command = commandOf(input);
  if (path === undefined && command === undefined) return undefined;
  return { ...(path !== undefined ? { path } : {}), ...(command !== undefined ? { command } : {}) };
}

/** Each call's context by its tool_use_id, from a Timeline read with its calls' arguments (calls=true: `tool_input`). Only
 *  the map is kept: those rows (a call's whole input, its result's longer head) are never carried by a share. */
export function callContexts(rows: readonly unknown[]): Map<string, CallContext> {
  const out = new Map<string, CallContext>();
  for (const row of rows) {
    if (!isRecord(row) || row.kind !== "tool_use" || typeof row.tool_use_id !== "string") continue;
    const context = callContext(row.tool_name, row.tool_input);
    if (context !== undefined) out.set(row.tool_use_id, context);
  }
  return out;
}

/** An approval's outcome row (run-view.ts withApprovalRows: `approval:<call_id>:outcome`, or `…:after:outcome` once the
 *  result is in), its own tool_use_id null: the call it tells of. */
const OUTCOME_ROW = /^approval:(.+?)(?::after)?:outcome$/;

/** A result row's summary that words nothing the call printed (timeline.ts: `<tool label>: ok`), on a row that did not
 *  fail: a failed row's summary is always its output's first line. */
const OK_SUMMARY = /^[^\n]+: ok$/;

/** The fields of a served Timeline row that hold a call's output, with that call's context: a tool_result row's
 *  `tool_result_preview` and its `summary` (a failed call's is its output's first line) unless it is a plain ok, and an approval outcome row's
 *  `text`, which shows the approved call's result again. The outcome's whole text takes the context, its head sentence
 *  included (ruled so: never split on run-view's words). Undefined for any other row, for a call with no context, or a
 *  row with no such field that holds text. */
export function rowOutput(row: unknown, contexts: ReadonlyMap<string, CallContext>): { fields: readonly ("tool_result_preview" | "summary" | "text")[]; context: CallContext } | undefined {
  if (!isRecord(row)) return undefined;
  if (row.kind === "tool_result") {
    const context = typeof row.tool_use_id === "string" ? contexts.get(row.tool_use_id) : undefined;
    // The summary words what the call printed (a failure's first line, an outcome's words), but for a plain "<tool>: ok".
    const fields = (["tool_result_preview", "summary"] as const).filter((field) => typeof row[field] === "string" && !(field === "summary" && row.tool_status !== "failed" && OK_SUMMARY.test(row[field] as string)));
    return context !== undefined && fields.length ? { fields, context } : undefined;
  }
  const call = typeof row.id === "string" ? OUTCOME_ROW.exec(row.id)?.[1] : undefined;
  const context = call !== undefined ? contexts.get(call) : undefined;
  return context !== undefined && typeof row.text === "string" ? { fields: ["text"], context } : undefined;
}

/** A workflow graph's call (graph-view.ts `effects[i]`): its `output` takes the context of its own `tool` and `input`. */
export const effectContext = (effect: unknown): CallContext | undefined => (isRecord(effect) ? callContext(effect.tool, effect.input) : undefined);
