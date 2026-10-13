// What a demo layered on the cloud app can add without the app knowing about it: `DEMO_APP_EXTRA` names a module (in the box's bundle) whose default export
// is `(context) => AppExtra`. The shared tools and the move stay the app's; the extra adds tools, a default tool selection and an environment wrapper.
import type { HarnessSettings, Registry } from "@earendil-works/pi-durable";
import type { AppOptions } from "@parcha/pi-durable-disk";
import { appendInstructions, replaceInstructions, type agentModels } from "./agent.ts";
import type { CloudLink, ThreadsOf } from "./cloud-link.ts";

export interface AppExtraContext {
  /** The link to the demo server (undefined when the host reaches its model directly). */
  readonly link: CloudLink | undefined;
  /** The run's work directory on the mounted disk. */
  readonly work: string;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
}

export interface AppExtra {
  /** Installed in the registry after the shared tools. */
  install?(registry: Registry): void;
  /** Merged over the app's settings (`extensions`: the root's default tool selection). */
  settings?: Partial<HarnessSettings>;
  wrapEnv?: AppOptions["wrapEnv"];
  /** Called once with the app's own model registry, right after the app builds it and before the root agent is used: an extra adds a provider (a model the conversation can switch to). */
  models?(models: ReturnType<typeof agentModels>): void;
  /**
   * The text the extra gives the root agent's instructions, and what it does to the base ones (set before the root agent is built). `mode` is required, never a default:
   * "replace": the root agent gets exactly `text`; the base ones are the robot page's and would contradict another page, so nothing of them (the model line, the host's extra) is kept.
   * "append": `text` follows the base, the model line and the host's extra.
   * Absent: the base, the model line and the host's extra, as before.
   */
  instructions?: { readonly mode: "replace" | "append"; readonly text: string };
  /**
   * Names of installed extensions the app removes from its registry once `install` has run (the shared ones a page does not want the agent to have: `robot-tools`, `switch-environment`, `offline-tools`, `computer`, `coding`...).
   * The host applies this and logs it (`app-extra.without-extensions`, with the tools that went); a name that is not installed is an error naming what is. It is this host's registry only: a run that moves mid-call of a dropped tool
   * resumes on a host that must still have its definition, so a page drops tools only where the run does not leave while they are in use.
   */
  withoutExtensions?: readonly string[];
  /** The host's own listing of its teaching threads (the cluster's typed one): with it the link relays each thread's conversation to viewers. */
  threadsOf?: ThreadsOf;
}

export type AppExtraModule = (context: AppExtraContext) => AppExtra | Promise<AppExtra>;

/** Apply an extra's `instructions` (the agent's text before the root agent is built). A bad mode or text is an error: the module is untyped JavaScript once it is on the box. */
export function applyExtraInstructions(instructions: AppExtra["instructions"]): void {
  if (instructions === undefined) return;
  const given = instructions as { mode?: unknown; text?: unknown } | null;
  if (given === null || typeof given !== "object" || typeof given.text !== "string") throw new Error("app extra instructions must be { mode, text } with a text string");
  if (given.mode === "replace") replaceInstructions(given.text);
  else if (given.mode === "append") appendInstructions(given.text);
  else throw new Error(`app extra instructions mode ${JSON.stringify(given.mode)} is not "replace" or "append"`);
}

/** Remove the named extensions from the registry and log it: the names, and the tools that went with them. */
export function dropExtensions(registry: Registry, names: readonly string[] | undefined, log: AppExtraContext["log"]): void {
  if (names === undefined) return;
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw new Error("app extra withoutExtensions must be an array of extension names");
  const dropped: string[] = [];
  const tools: string[] = [];
  for (const name of names) {
    const snapshot = registry.snapshot();
    const extension = snapshot.extension(name);
    if (!extension) throw new Error(`app extra withoutExtensions: ${name} is not installed (installed: ${snapshot.installed().map((e) => e.name).join(", ")})`);
    tools.push(...snapshot.tools().filter((t) => t.extension.name === name).map((t) => t.tool.name));
    registry.uninstall(extension);
    dropped.push(name);
  }
  log("app-extra.without-extensions", { extensions: dropped, tools });
}
