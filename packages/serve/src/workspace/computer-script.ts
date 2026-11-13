// computer_script's run: the model's JavaScript in a QuickJS isolate here in serve (pi-codemode's CodemodeSandbox, a
// worker thread per script), whose only binding is the claim's computer. The script sees `computer` (the surface's
// script prelude builds it inside the isolate over one host function, __computerCall) and pi-codemode's output helpers
// (text, image, console); no network, no keys, no timers, no modules, no file of this machine. Each call of the computer
// goes through the run's hands (Hands.computer), so a person's hold parks and refuses it as it does a per-step tool's.
//
// The answer: the script's text and images in the order it made them, then its returned value as JSON (its images'
// data left out: they are the answer's images); `structured` is the value. A script that threw answers its words, with
// what it showed before.
import { CodemodeSandbox, type CodemodeOutputItem } from "@earendil-works/pi-codemode";
import { type Card, COMPUTER_CALL_GLOBAL, scriptPrelude, withoutImageData } from "@parcha/agentrun-computer/surface";
import type { JsonValue, ToolImage } from "@parcha/agentrun-kernel";
import type { Executor, ToolAnswer } from "@parcha/agentrun-kernel/kernel";

/** A script's longest run by default, and at most, in ms. */
export const SCRIPT_DEFAULT_MS = 120_000;
export const SCRIPT_MAX_MS = 600_000;
/** The isolate's memory. */
const SCRIPT_MEMORY_BYTES = 256 * 1024 * 1024;

type ScriptArgs = { readonly code?: unknown; readonly timeoutMs?: unknown };

/** The run's tool gate's decision of one call, as a script's computer call is held to it (RunPermissions.decide). */
export type ScriptDecide = (tool: string, args: unknown) => Promise<"allow" | "ask" | { deny: string }>;

/** The settings key a script's computer call is held to, as the run's own tool of that name is: the shell is bash's, a
 *  file's write is write's, a file's read, listing or stat is read's. The other ops (looking, acting) are the computer
 *  kind's, which the call of computer_script or codemode was already held to. */
const HELD_AS: Readonly<Record<string, "bash" | "write" | "read">> = Object.freeze({ "shell.run": "bash", "files.write": "write", "files.read": "read", "files.list": "read", "files.stat": "read" });

/** What a script's `computer.shell` and `computer.files` are held to: the run's gate, which a person's settings (a denied
 *  bash, a read-only bash policy, a denied write) reach through the one decision the run's own tools get. A script can't
 *  stop to ask, so a call the gate would ask about is refused in words that send the model to the tool itself. Until a
 *  gate is installed (the spec installs it once built) every one of those calls is refused. */
export class ScriptGuard {
  #decide: ScriptDecide | undefined;
  /** `shell`: what the run's bash adds under its bash policy (bash-read-only.ts policyEnv, policyPrelude): the environment
   *  that locks git's config down, set over any a script gives, and the line that runs git only at the floor version. */
  constructor(private readonly shell: { readonly env: Readonly<Record<string, string>>; readonly prelude: string } = { env: {}, prelude: "" }) {}

  /** `op`'s arguments as the computer is sent them: a script's shell command with the policy's safeguards, as the bash
   *  tool's own command has them, which no option of the script's overrides. */
  shaped(op: string, args: unknown): unknown {
    if (op !== "shell.run") return args;
    const given = (args ?? {}) as Record<string, unknown>;
    const env = { ...((given.env ?? {}) as Record<string, string>), ...this.shell.env };
    return { ...given, ...(Object.keys(env).length > 0 ? { env } : {}), ...(this.shell.prelude !== "" && typeof given.command === "string" ? { command: `${this.shell.prelude}${given.command}` } : {}) };
  }

  install(decide: ScriptDecide): void {
    this.#decide = decide;
  }

  /** Why `op` with `args` may not run now, or undefined when the gate lets it. */
  async refusal(op: string, args: unknown): Promise<string | undefined> {
    const tool = HELD_AS[op];
    if (tool === undefined) return undefined;
    if (!this.#decide) return `computer call ${op} was not run: this run's tool settings are not attached to its scripts yet`;
    const given = (args ?? {}) as Record<string, unknown>;
    const decision = await this.#decide(tool, tool === "bash" ? { command: given.command, ...(given.cwd !== undefined ? { cwd: given.cwd } : {}) } : { path: given.path });
    if (decision === "allow") return undefined;
    if (decision === "ask") return `computer call ${op} was not run: this agent's ${tool} setting asks a person first, and a script can't wait for one. Call the ${tool} tool itself, or ask for the setting to be allow.`;
    return `computer call ${op} was not run: ${decision.deny}`;
  }

  /** `call` of the computer's port with a script's computer call held to the gate first: the refusal throws in the
   *  script, where its `await` is. */
  async call(op: string, args: unknown, send: (args: unknown) => Promise<{ value?: unknown }>): Promise<unknown> {
    const refused = await this.refusal(op, args);
    if (refused !== undefined) throw new Error(refused);
    return (await send(this.shaped(op, args ?? {}))).value ?? null;
  }
}

type Shown = { text: string; images: ToolImage[] };

/** Every image in `value` (`{ type: "image", data }`), in the order withImageData puts data back into them. */
function imagesIn(value: unknown): ToolImage[] {
  if (Array.isArray(value)) return value.flatMap(imagesIn);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") return [{ data: record.data, mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png" }];
  return Object.values(record).flatMap(imagesIn);
}

/** The script's own output and its value, as the model reads them. The images come as the structured value wants them
 *  back (withImageData fills its data-less image objects in order): the returned value's own first, then the ones the
 *  script showed with image(...), so a returned image keeps its own pixels whatever was shown. */
function answerOf(output: readonly CodemodeOutputItem[], value: unknown): Shown {
  const words: string[] = [];
  const shown: ToolImage[] = [];
  for (const item of output) {
    if (item.type === "text") words.push(item.text);
    else shown.push({ data: item.data, mimeType: item.mimeType });
  }
  if (value !== undefined) words.push(typeof value === "string" ? value : JSON.stringify(withoutImageData(value)));
  return { text: words.join("\n") || "(the script returned nothing and showed nothing)", images: [...imagesIn(value), ...shown] };
}

/** computer_script's executor for a computer that is `card`: each script in its own isolate, its computer calls through
 *  the call's hands, the shell's and the files' held to `guard`. */
export function computerScriptExecutor(card: Card, guard: ScriptGuard): Executor {
  const prelude = scriptPrelude(card);
  return async (args, call): Promise<ToolAnswer> => {
    const { code, timeoutMs } = (args ?? {}) as ScriptArgs;
    if (typeof code !== "string" || code.trim() === "") return { text: "", error: "computer_script needs code: the body of an async function, with `computer` bound" };
    const port = call.hands.computer;
    if (!port) return { text: "", error: "computer_script needs a desktop or a phone computer: this run has none" };
    const limit = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, SCRIPT_MAX_MS) : SCRIPT_DEFAULT_MS;
    const sandbox = new CodemodeSandbox({
      timeoutMs: limit,
      memoryLimitBytes: SCRIPT_MEMORY_BYTES,
      globals: [{
        name: COMPUTER_CALL_GLOBAL,
        spread: true,
        // The value whole, images and all: a script shows one with image(...). The JSON round trip is the isolate's.
        execute: async (given, context) => {
          const [op, opArgs] = given as [unknown, unknown];
          return (await guard.call(String(op), opArgs, (sent) => port.call(String(op), sent ?? {},AbortSignal.any([context.signal, ...(call.signal ? [call.signal] : [])])))) as JsonValue;
        },
      }],
    });
    try {
      // The prelude is one line, so the script's own line numbers hold.
      const result = await sandbox.execute(`${prelude}\n${code}`, call.signal ? { signal: call.signal } : {});
      if (!result.ok) {
        if (result.error.kind === "aborted" && call.signal?.aborted) throw call.signal.reason ?? new Error(result.error.message);
        const shown = answerOf(result.output, undefined);
        const why = result.error.kind === "timeout" ? `the script ran past its ${limit} ms: ${result.error.message}` : result.error.message;
        return { text: result.output.length > 0 ? shown.text : "", error: why, ...(shown.images.length > 0 ? { images: shown.images } : {}) };
      }
      const shown = answerOf(result.output, result.value);
      return { text: shown.text, ...(shown.images.length > 0 ? { images: shown.images } : {}), ...(result.value === undefined ? {} : { structured: withoutImageData(result.value) as JsonValue }) };
    } finally {
      await sandbox.close();
    }
  };
}
