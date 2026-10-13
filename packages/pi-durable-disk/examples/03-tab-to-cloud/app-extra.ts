// What a demo layered on the cloud app can add without the app knowing about it: `DEMO_APP_EXTRA` names a module (in the box's bundle) whose default export
// is `(context) => AppExtra`. The shared tools and the move stay the app's; the extra adds tools, a default tool selection and an environment wrapper.
import type { HarnessSettings, Registry } from "@earendil-works/pi-durable";
import type { AppOptions } from "@parcha/pi-durable-disk";
import type { agentModels } from "./agent.ts";
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
  /** REPLACES the root agent's instructions (agent.ts's `replaceInstructions`), before the root agent is built: the base ones are the robot page's and would contradict another page, so the root agent gets exactly this text. Absent: the base, the model line and the host's extra, as before. */
  instructions?: string;
  /** The host's own listing of its teaching threads (the cluster's typed one): with it the link relays each thread's conversation to viewers. */
  threadsOf?: ThreadsOf;
}

export type AppExtraModule = (context: AppExtraContext) => AppExtra | Promise<AppExtra>;
