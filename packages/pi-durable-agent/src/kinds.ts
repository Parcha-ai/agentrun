import type { Draft, JsonValue } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";

// The kinds, versions and field names below are the stored format of an agent home and a run store.

export const FORMAT_VERSION = 1;

/** `agent.identity`: the agent's own id, never a host's. */
export type AgentIdentity = { id: string; name: string; formatVersion: number };

/** `agent.definition`. No model and no thinking level: the host picks them. */
export type AgentDefinition = {
  id: string;
  version: number;
  name: string;
  description?: string;
  instructions: string;
  /** Skill names. */
  skills: string[];
  /** Tool names; where each runs is a host's binding. */
  tools: string[];
  input_schema?: JsonObject;
  output_schema?: JsonObject;
  /** An AgentRun workflow document (no model in it). */
  workflow?: JsonObject;
  max_cost_usd?: number;
};

/** `agent.skills`, keyed by the skill file's path under `.agents/skills/`. */
export type SkillFile = { content: string; sha256: string };
/** The host's rule for picking an overlay: the Jev choice `question`, the `option` this variant needs, and the least
 *  probability (`threshold`, 0 to 1) for that option. */
export type PromptRule = { question: string; option: string; threshold: number };
/** `agent.prompts`, keyed by variant id: one `base`, one `generic` and any number of `overlay`s, each with a `label` and
 *  its `text`; only an overlay has a `when`. Choosing a variant is the host's. */
export type PromptVariant = { role: "base" | "overlay" | "generic"; label: string; text: string; when?: PromptRule };
/** `agent.aliases`, keyed by host: the agent's id in that host. */
export type AgentAlias = { externalId: string };
/** `agent.bindings`, keyed by host: where each tool name runs there. */
export type ToolBindings = Record<string, string>;
/** `agent.source`: the repo commit the cached definition and skills were read from, written in the same commit as
 *  them. Absent for a home not tied to a repo. */
export type AgentSource = { sha: string; refreshedAt: string };
/** `agent.runs`, keyed by run id. `path` is relative to the agent home; `sha` is the home's `agent.source` when the run
 *  started, so it names the skills the run's workspace got; `prompt` is the variant the host chose for it, and why. */
export type RunRecord = { path: string; host: string; startedAt: string; sha?: string; prompt?: { id: string; reason: string }; endedAt?: string; outcome?: string; finalAnswer?: JsonValue; cost?: number };
/** `agent.leases`, keyed by profile key: the one run that may save that profile back. */
export type ProfileLease = { runId: string; expiresAt: string };
/** `browser.profiles`, keyed by profile key, in the agent store and in each run store. `ref` is the provider's saved
 *  sign-in (a Browserbase context id, for one); `state` is `ready` once `ref` names one, and `held` in a run store when
 *  another run (`heldBy`) holds the save lease, so this run got no `ref`. Sign-in state: it reaches a run only through
 *  the host (`startRun`, `durableProfileStore`), and no tool ever reads or returns a profile. */
export type BrowserProfile = { provider: string; ref: string; state: string; startUrl?: string; allowedOrigins?: string[]; verifiedAt?: string; heldBy?: string };

const defined: string[] = [];
/** Every kind this package defines, in definition order. Each must be on exactly one of `./export.ts`'s two lists. */
export const DEFINED_KINDS: readonly string[] = defined;

const session = { version: FORMAT_VERSION, scope: "session" } as const;
const singleton = (kind: string) => {
  defined.push(kind);
  return defineDoc<JsonObject>({ kind, ...session, initial: () => ({}) });
};
const family = (kind: string) => {
  defined.push(kind);
  return defineDocFamily<JsonObject, null>({ kind, ...session, family: true, initial: () => ({}) });
};

export const IdentityDoc = singleton("agent.identity");
export const DefinitionDoc = singleton("agent.definition");
export const SourceDoc = singleton("agent.source");
export const SkillsDoc = family("agent.skills");
export const PromptsDoc = family("agent.prompts");
export const AliasesDoc = family("agent.aliases");
export const BindingsDoc = family("agent.bindings");
export const RunsDoc = family("agent.runs");
export const LeasesDoc = family("agent.leases");
export const ProfilesDoc = family("browser.profiles");

/** JSON with sorted keys: one text for one value. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Make `draft` equal `value` as JSON (an absent or undefined field is no field). */
export function put(draft: Draft<JsonObject>, value: object): void {
  const next = JSON.parse(JSON.stringify(value)) as JsonObject;
  for (const key of Object.keys(draft)) if (!Object.hasOwn(next, key)) delete draft[key];
  Object.assign(draft, next);
}
