// An agent's own computer: the one its computer setting asks for with `persistent: true`, kept between its runs. The
// provider keeps it under an owner (the computer package's spec.owner: this server's id and the agent's), and this
// server keeps one record per agent in its store's settings (agent_computer:<agent id>): the provider, the
// configuration's image, the computer, and whether a run holds it. The claim writes the record (computer-for-claim.ts),
// the agent's view shows it (Settings → the agent's computer), and reconcileAgentComputer deletes the computer once the
// agent has no use for it: archived, persistent turned off, or a setting on another provider or image. The janitor asks
// the same question of an owner it lists (ownerGoneOf). Nothing here knows a vendor: a provider is made by the caller.
import { randomBytes } from "node:crypto";
import { type ComputerOwner, type ComputerProvider, type ComputerSettingKind, configurationOf, PROVIDERS, serves } from "@parcha/agentrun-computer";
import type { Store } from "../store/index.js";

/** The settings key of this server's id. */
export const SERVER_ID_KEY = "server_id";

/** This server's id: 12 hex digits, made once and kept in its store (the first writer wins a race), so its agents'
 *  computers keep their owner across restarts and are told apart from another server's on one vendor account. */
export async function serverIdOf(store: { settings: Pick<Store["settings"], "putIfAbsent"> }): Promise<string> {
  const kept = await store.settings.putIfAbsent(SERVER_ID_KEY, { v: 1, id: randomBytes(6).toString("hex") });
  const id = (kept as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) throw new Error(`this server's store keeps a ${SERVER_ID_KEY} that does not read as one`);
  return id;
}

/** Where an agent's computer is: held by a run, detached between runs, or being deleted (with why it is not yet, when a
 *  delete failed). */
export type AgentComputerState = "held" | "detached" | "deleting";

/** An agent's computer as this server records it. `image`: the configuration's, absent for the provider's default. */
export interface AgentComputerRecord {
  readonly v: 1;
  readonly provider: string;
  readonly image?: string;
  readonly id: string;
  readonly name: string;
  readonly state: AgentComputerState;
  /** The run that holds it, while held. */
  readonly run?: string;
  /** When it took this state, ISO time. */
  readonly at: string;
  /** Why a delete has not happened yet, in the provider's words. */
  readonly why?: string;
}

type Settings = { settings: Pick<Store["settings"], "get" | "put" | "remove"> };

const recordKey = (agentId: string): string => `agent_computer:${agentId}`;
const STATES: readonly AgentComputerState[] = ["held", "detached", "deleting"];

/** The agent's computer as recorded, or undefined when it has none (or the row does not read as one). */
export async function agentComputerOf(store: Settings, agentId: string): Promise<AgentComputerRecord | undefined> {
  const row = (await store.settings.get(recordKey(agentId))) as Partial<AgentComputerRecord> | null | undefined;
  if (typeof row !== "object" || row === null || row.v !== 1) return undefined;
  if (typeof row.provider !== "string" || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.at !== "string" || !STATES.includes(row.state as AgentComputerState)) return undefined;
  return row as AgentComputerRecord;
}

/** Records the agent's computer in `state` now: held by `run`, or detached or deleting with none. */
export async function keepAgentComputer(
  store: Settings,
  agentId: string,
  computer: { readonly provider: string; readonly image?: string | undefined; readonly id: string; readonly name: string },
  state: AgentComputerState,
  extra: { readonly run?: string; readonly why?: string } = {},
): Promise<void> {
  const record: AgentComputerRecord = {
    v: 1,
    provider: computer.provider,
    ...(computer.image === undefined ? {} : { image: computer.image }),
    id: computer.id,
    name: computer.name,
    state,
    ...(state === "held" && extra.run !== undefined ? { run: extra.run } : {}),
    at: new Date().toISOString(),
    ...(extra.why === undefined ? {} : { why: extra.why }),
  };
  await store.settings.put(recordKey(agentId), record);
}

type Holding = { settings: Pick<Store["settings"], "get" | "putIfAbsent" | "put" | "remove"> };
const holdKey = (agentId: string): string => `agent_computer_hold:${agentId}`;
const takeoverKey = (agentId: string, from: string): string => `agent_computer_takeover:${agentId}:${from}`;

/** Why a run cannot have the agent's computer: another run, still going, holds it. */
const heldBy = (holder: string): Error => new Error(`this agent's own computer is held by run ${holder}, which is still going: an agent's own computer serves one run at a time. Start this run again once that one ends`);

/**
 * Takes the agent's computer for `run`, before anything is listed or made, so two runs of one agent that claim at once
 * never both make one. The hold is one settings row per agent, taken with the store's putIfAbsent (one statement: of two
 * writers the first wins), naming the run. A hold of `run`'s own (a later claim of the same run) is kept. A hold of
 * another run still going (`isLive`) refuses this one in words naming it. A hold of a run that ended is taken over: the
 * takeover from that run is itself one putIfAbsent row, so of two runs that find the same ended holder only one takes
 * it, and the other is refused naming it. Takeover rows are kept: one removed could be won again by a run that read the
 * ended holder long before.
 */
export async function holdAgentComputer(store: Holding, agentId: string, run: string, isLive: (run: string) => Promise<boolean>): Promise<void> {
  const mine = { v: 1, run, at: new Date().toISOString() };
  for (let tries = 0; tries < 3; tries++) {
    const held = (await store.settings.putIfAbsent(holdKey(agentId), mine)) as { run?: unknown } | null;
    const holder = typeof held?.run === "string" ? held.run : undefined;
    if (holder === run) return;
    if (holder !== undefined && (await isLive(holder))) throw heldBy(holder);
    // An ended run's hold (or a row that names none): taken over by one run alone.
    const won = (await store.settings.putIfAbsent(takeoverKey(agentId, holder ?? "unreadable"), mine)) as { run?: unknown } | null;
    const winner = typeof won?.run === "string" ? won.run : undefined;
    if (winner === run) {
      await store.settings.put(holdKey(agentId), mine);
      return;
    }
    if (winner !== undefined && (await isLive(winner))) throw heldBy(winner);
    // The run that took it over has ended too: read the hold again.
  }
  throw new Error("this agent's own computer changed hands three times while this run claimed it: start this run again");
}

/** Lets go of the agent's computer, where `run` holds it: its hold row goes, so the agent's next run takes it at once. */
export async function letGoAgentComputer(store: Holding, agentId: string, run: string): Promise<void> {
  const held = (await store.settings.get(holdKey(agentId))) as { run?: unknown } | null | undefined;
  if (held?.run === run) await store.settings.remove(holdKey(agentId));
}

/** Forgets the agent's computer: its next persistent run makes a new one. */
export async function forgetAgentComputer(store: Settings, agentId: string): Promise<void> {
  await store.settings.remove(recordKey(agentId));
}

/** The agent's computer as GET /agents/{agent_id} shows it, or null when it has none. */
export function agentComputerView(record: AgentComputerRecord | undefined): Record<string, unknown> | null {
  if (!record) return null;
  return {
    provider: record.provider,
    ...(record.image === undefined ? {} : { image: record.image }),
    id: record.id,
    name: record.name,
    state: record.state,
    ...(record.run === undefined ? {} : { run_id: record.run }),
    since: record.at,
    ...(record.why === undefined ? {} : { why: record.why }),
  };
}

type Agents = { agents: Pick<Store["agents"], "get" | "revision"> };

/** The image of the configuration a setting of `kind` on `provider` selects with `image` (the default one where it names
 *  none), as the claim records it: two settings that select one configuration are one computer. */
function configurationImage(provider: string, kind: string, image: string | undefined): string | undefined {
  const entry = PROVIDERS.find((one) => one.id === provider);
  if (!entry) return image;
  const settingKind = kind as ComputerSettingKind;
  return configurationOf(entry.capabilities.filter((one) => serves(one, settingKind)), image, entry.defaultImage?.[settingKind])?.image ?? image;
}

/** The persistent setting the agent's current revision asks for (its provider and the image of the configuration it
 *  selects), or undefined when it asks for none (or the agent is archived, or this store has no such agent). */
async function wantedSetting(store: Agents, agentId: string): Promise<{ readonly provider: string; readonly image?: string } | undefined> {
  const agent = await store.agents.get(agentId);
  if (!agent || agent.archivedAt != null || agent.currentRevision === null) return undefined;
  const body = (await store.agents.revision(agent.currentRevision))?.body as { computer?: { kind?: string; provider?: string; image?: string; persistent?: boolean } } | undefined;
  const computer = body?.computer;
  if (computer?.persistent !== true || typeof computer.provider !== "string" || typeof computer.kind !== "string" || computer.kind === "none") return undefined;
  const image = configurationImage(computer.provider, computer.kind, computer.image);
  return { provider: computer.provider, ...(image === undefined ? {} : { image }) };
}

/** Whether the agent still has a use for a computer of `provider` and `image`: it is here, not archived, and its current
 *  setting is persistent on that provider and image. */
export async function wantsComputer(store: Agents, agentId: string, provider: string, image: string | undefined): Promise<boolean> {
  const wanted = await wantedSetting(store, agentId);
  return wanted !== undefined && wanted.provider === provider && wanted.image === image;
}

/**
 * The janitor's ownerGone for this server and one provider: an owner another server names is never gone to this one; one
 * of this server's is gone when its agent has no use for a computer of this provider (gone from the store, archived, or
 * its setting not persistent here). An owner with no server is no agent's of this server's, so it is never gone here.
 */
export function ownerGoneOf(store: Agents, serverId: string, provider: string): (owner: ComputerOwner) => Promise<boolean> {
  return async (owner) => {
    if (owner.server !== serverId) return false;
    return (await wantedSetting(store, owner.agent))?.provider !== provider;
  };
}

/**
 * Deletes the agent's computer when the agent has no use for it any more (wantsComputer): its record goes once the
 * provider has deleted it. A delete that fails keeps the record as deleting, with the provider's words, for the next
 * reconcile or the janitor. `makeProvider` builds the computer's provider; it throws, in words, when it cannot. Answers
 * what happened, or undefined when there was nothing to do.
 */
export async function reconcileAgentComputer(
  store: Settings & Agents,
  agentId: string,
  makeProvider: (provider: string, image: string | undefined) => Promise<Pick<ComputerProvider, "release">>,
): Promise<{ readonly deleted: string } | { readonly failed: string } | undefined> {
  const record = await agentComputerOf(store, agentId);
  if (!record || (await wantsComputer(store, agentId, record.provider, record.image))) return undefined;
  await keepAgentComputer(store, agentId, record, "deleting");
  let why: string;
  try {
    const provider = await makeProvider(record.provider, record.image);
    const released = await provider.release({ id: record.id, name: record.name }, "delete");
    if (released.ok) {
      await forgetAgentComputer(store, agentId);
      return { deleted: record.name };
    }
    why = released.error.message;
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  await keepAgentComputer(store, agentId, record, "deleting", { why });
  return { failed: why };
}
