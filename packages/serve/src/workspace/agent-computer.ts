// An agent's own computer: the one its computer setting asks for with `persistent: true`, kept between its runs. The
// provider keeps it under an owner (the computer package's spec.owner: this server's id and the agent's), and this
// server keeps one record per agent in its store's settings (agent_computer:<agent id>): the provider, the
// configuration's image, the computer, and whether a run holds it. The claim writes the record (computer-for-claim.ts),
// the agent's view shows it (GET /agents/{agent_id}'s own_computer), and reconcileAgentComputer deletes the computer
// once the agent has no use for it: archived, persistent turned off, or a setting on another provider or image. The
// janitor asks the same question of an owner it lists (ownerGoneOf). Nothing here knows a vendor: a provider is made by the caller.
import { randomBytes } from "node:crypto";
import { type ComputerOwner, type ComputerProvider, type ComputerSettingKind, configurationOf, PROVIDERS, type Result, serves } from "@parcha/agentrun-computer";
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

type Settings = { settings: Pick<Store["settings"], "get" | "put"> };

const recordKey = (agentId: string): string => `agent_computer:${agentId}`;
const STATES: readonly AgentComputerState[] = ["held", "detached", "deleting"];

/** The agent's computer as recorded, or undefined when it has none (or the row does not read as one). */
export async function agentComputerOf(store: { settings: Pick<Store["settings"], "get"> }, agentId: string): Promise<AgentComputerRecord | undefined> {
  const row = (await store.settings.get(recordKey(agentId))) as Partial<AgentComputerRecord> | null | undefined;
  if (typeof row !== "object" || row === null || row.v !== 1) return undefined;
  if (typeof row.provider !== "string" || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.at !== "string" || !STATES.includes(row.state as AgentComputerState)) return undefined;
  return row as AgentComputerRecord;
}

type Computer = { readonly provider: string; readonly image?: string | undefined; readonly id: string; readonly name: string };

/** The record of `computer` in `state` now: held by `run`, or detached or deleting with none. */
function recordOf(computer: Computer, state: AgentComputerState, extra: { readonly run?: string; readonly why?: string } = {}): AgentComputerRecord {
  return {
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
}

/** Records the agent's computer in `state` now, by the run that holds it (agentComputerHold): held by `run`, or detached. */
export async function keepAgentComputer(store: Settings, agentId: string, computer: Computer, state: AgentComputerState, extra: { readonly run?: string; readonly why?: string } = {}): Promise<void> {
  await store.settings.put(recordKey(agentId), recordOf(computer, state, extra));
}

type Holding = { settings: Pick<Store["settings"], "get" | "putIfAbsent" | "replaceIf" | "removeIf"> };
const holdKey = (agentId: string): string => `agent_computer_hold:${agentId}`;

/** How long a hold that is letting go (its run detaching the computer at its end, or this server deleting it) keeps every
 *  other run off: the most a provider's detach or delete is waited on. A holder that died while letting go is taken over
 *  after it. */
export const HOLD_RELEASE_MS = 15 * 60_000;

/** The holder a delete of this server's takes the hold under (reconcileAgentComputer, the janitor): no run's id. */
const DELETER = "delete:";

/** A run state in which the run still holds what it claimed. */
const LIVE_RUN = new Set(["queued", "running", "parked"]);

/** Whether a holder is a run still going, by the store's run rows. With no run rows to read, every run is: never two runs
 *  on one agent's computer. A delete's hold is no run's: its letting-go time alone keeps others off. */
export function liveHolderOf(store: { readonly runs?: Pick<Store["runs"], "get"> | undefined }): (holder: string) => Promise<boolean> {
  const { runs } = store;
  return async (holder) => !holder.startsWith(DELETER) && (!runs || LIVE_RUN.has((await runs.get(holder))?.state ?? ""));
}

/** The hold row: its holder, when it took it, and while it is letting go, until when it keeps others off. */
type HoldRow = { readonly v: 1; readonly run: string; readonly at: string; readonly until?: string };

/** Why a run cannot have the agent's computer: another run, still going, holds it, or a holder is letting it go. */
class HeldComputer extends Error {}
const heldBy = (holder: string): Error => new HeldComputer(`this agent's own computer is held by run ${holder}, which is still going: an agent's own computer serves one run at a time. Start this run again once that one ends`);
const lettingGo = (holder: string): Error =>
  new HeldComputer(`this agent's own computer is being ${holder.startsWith(DELETER) ? "deleted by this server" : `detached by run ${holder}, which ended`}: start this run again in a moment`);

/** A run's hold on the agent's computer (holdAgentComputer). */
export interface AgentComputerHold {
  readonly run: string;
  /** Whether the hold row is still this one. */
  holds(): Promise<boolean>;
  /** Marks the hold as letting go, before the computer is detached at the run's end: no other run takes it over until it
   *  lets go, or HOLD_RELEASE_MS passes. False, with nothing marked, when another run has taken it over since: the
   *  computer is that run's now, and is left as it is. */
  releasing(): Promise<boolean>;
  /** The hold row goes, where it is still this one, so the agent's next run takes the computer at once. */
  letGo(): Promise<void>;
}

/**
 * Takes the agent's computer for `run`, before anything is listed or made, so two runs of one agent that claim at once
 * never both make one. The hold is one settings row per agent naming its holder, taken with the store's putIfAbsent (of
 * two writers the first wins). A hold of `run`'s own (a later claim of the same run) is kept. A hold of another run
 * still going (`isLive`), or one letting go (until its time), refuses this one in words naming it. A hold of a run that
 * ended is taken over with the store's replaceIf on the row as read: of two runs that find the same ended holder only
 * one replaces it, and one that finds the row changed (taken, or let go) reads it again. `until`: a hold that keeps
 * others off until then from the start (a delete's).
 */
export async function holdAgentComputer(store: Holding, agentId: string, run: string, isLive: (holder: string) => Promise<boolean>, { until }: { readonly until?: number } = {}): Promise<AgentComputerHold> {
  const key = holdKey(agentId);
  let mine: HoldRow = { v: 1, run, at: new Date().toISOString(), ...(until === undefined ? {} : { until: new Date(until).toISOString() }) };
  const hold: AgentComputerHold = {
    run,
    holds: async () => JSON.stringify((await store.settings.get(key)) ?? null) === JSON.stringify(mine),
    async releasing() {
      const next: HoldRow = { ...mine, until: new Date(Date.now() + HOLD_RELEASE_MS).toISOString() };
      if (!(await store.settings.replaceIf(key, mine, next))) return false;
      mine = next;
      return true;
    },
    async letGo() {
      await store.settings.removeIf(key, mine);
    },
  };
  for (let tries = 0; tries < 3; tries++) {
    const held = (await store.settings.putIfAbsent(key, mine)) as Partial<HoldRow> | null | undefined;
    const holder = typeof held?.run === "string" ? held.run : undefined;
    if (holder === run) {
      mine = held as HoldRow;
      return hold;
    }
    if (holder !== undefined && typeof held?.until === "string" && Date.parse(held.until) > Date.now()) throw lettingGo(holder);
    if (holder !== undefined && (await isLive(holder))) throw heldBy(holder);
    // An ended run's hold (or a row that names none): replaced only while it is still the row read.
    if (await store.settings.replaceIf(key, held ?? null, mine)) return hold;
  }
  throw new Error("this agent's own computer changed hands three times while this run claimed it: start this run again");
}

/**
 * `remove` (a provider's delete of the agent's computer `id`) under the agent's hold, taken as a delete of this server's,
 * so no run attaches the computer while it goes and none has it deleted from under it; then the agent's record goes,
 * where it still names that computer. Not taken (a run holds it): refused in words, and nothing is deleted. `due` is
 * asked again under the hold, since what decided the delete was read before it: an agent that wants its computer again
 * meanwhile (unarchived, persistent turned back on) keeps it, refused in words.
 */
export async function deleteUnderHold(
  store: Holding & { readonly runs?: Pick<Store["runs"], "get"> | undefined },
  agentId: string,
  id: string,
  due: () => Promise<boolean>,
  remove: () => Promise<Result<void>>,
): Promise<Result<void>> {
  let hold: AgentComputerHold;
  try {
    hold = await holdAgentComputer(store, agentId, `${DELETER}${randomBytes(6).toString("hex")}`, liveHolderOf(store), { until: Date.now() + HOLD_RELEASE_MS });
  } catch (error) {
    if (error instanceof HeldComputer) return { ok: false, error: { code: "refused", message: error.message } };
    throw error;
  }
  try {
    if (!(await due())) return { ok: false, error: { code: "refused", message: `the agent ${agentId} wants its computer again, so it is kept` } };
    const removed = await remove();
    if (removed.ok) {
      const record = await agentComputerOf(store, agentId);
      if (record?.id === id) await store.settings.removeIf(recordKey(agentId), record);
    }
    return removed;
  } finally {
    await hold.letGo();
  }
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

type Runs = { readonly runs?: Pick<Store["runs"], "get"> | undefined };

/** Whether the agent's hold keeps others off now: a run still going holds it, or a holder is letting it go. */
async function heldNow(store: Holding & Runs, agentId: string): Promise<boolean> {
  const held = (await store.settings.get(holdKey(agentId))) as Partial<HoldRow> | null | undefined;
  if (typeof held?.run !== "string") return false;
  return (typeof held.until === "string" && Date.parse(held.until) > Date.now()) || (await liveHolderOf(store)(held.run));
}

/**
 * The janitor's ownerGone for this server and one provider: an owner another server names is never gone to this one; one
 * of this server's is gone when its agent has no use for a computer of this provider (gone from the store, archived, or
 * its setting not persistent here) and no run holds its computer now (heldNow): a run's computer is never deleted from
 * under it, and that run's end deletes it. An owner with no server is no agent's of this server's, so never gone here.
 */
export function ownerGoneOf(store: Agents & Holding & Runs, serverId: string, provider: string): (owner: ComputerOwner) => Promise<boolean> {
  return async (owner) => {
    if (owner.server !== serverId) return false;
    if (await wantsOn(store, owner.agent, provider)) return false;
    return !(await heldNow(store, owner.agent));
  };
}

/** Whether the agent still has a use for a computer of `provider`: it is here, not archived, and persistent there. */
export async function wantsOn(store: Agents, agentId: string, provider: string): Promise<boolean> {
  return (await wantedSetting(store, agentId))?.provider === provider;
}

/**
 * Deletes the agent's computer when the agent has no use for it any more (wantsComputer), under the agent's hold: given
 * `hold` (the run that holds it, at its end), under that one; else taken as a delete of this server's, and where a run
 * holds it, nothing is done now: that run's end reconciles again. The record is moved to deleting, and goes once the
 * provider has deleted the computer, each a replaceIf or removeIf on the record as read, so a record a later run wrote
 * (a replacement) is never erased. A delete that fails keeps it deleting, with the provider's words, for the next
 * reconcile or the janitor. `makeProvider` builds the computer's provider; it throws, in words, when it cannot. Answers
 * what happened, or undefined when there was nothing to do now.
 */
export async function reconcileAgentComputer(
  store: Settings & Agents & Holding & Runs,
  agentId: string,
  makeProvider: MakeProvider,
  hold?: AgentComputerHold,
): Promise<Reconciled | undefined> {
  if (!(await unwantedRecord(store, agentId))) return undefined;
  if (hold !== undefined) return (await hold.holds()) ? deleteUnwanted(store, agentId, makeProvider) : undefined;
  let own: AgentComputerHold;
  try {
    own = await holdAgentComputer(store, agentId, `${DELETER}${randomBytes(6).toString("hex")}`, liveHolderOf(store), { until: Date.now() + HOLD_RELEASE_MS });
  } catch (error) {
    if (error instanceof HeldComputer) return undefined;
    throw error;
  }
  try {
    return await deleteUnwanted(store, agentId, makeProvider);
  } finally {
    await own.letGo();
  }
}

type MakeProvider = (provider: string, image: string | undefined) => Promise<Pick<ComputerProvider, "release">>;
type Reconciled = { readonly deleted: string } | { readonly failed: string };

/** The agent's record, where the agent has no use for its computer any more; else undefined. */
async function unwantedRecord(store: Settings & Agents, agentId: string): Promise<AgentComputerRecord | undefined> {
  const record = await agentComputerOf(store, agentId);
  return record && !(await wantsComputer(store, agentId, record.provider, record.image)) ? record : undefined;
}

/** reconcileAgentComputer's delete, once the caller holds the agent's computer: the record read again under the hold. */
async function deleteUnwanted(store: Settings & Agents & Holding, agentId: string, makeProvider: MakeProvider): Promise<Reconciled | undefined> {
  const record = await unwantedRecord(store, agentId);
  if (!record) return undefined;
  const deleting = recordOf(record, "deleting");
  if (!(await store.settings.replaceIf(recordKey(agentId), record, deleting))) return undefined;
  let why: string;
  try {
    const provider = await makeProvider(record.provider, record.image);
    const released = await provider.release({ id: record.id, name: record.name }, "delete");
    if (released.ok) {
      await store.settings.removeIf(recordKey(agentId), deleting);
      return { deleted: record.name };
    }
    why = released.error.message;
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  await store.settings.replaceIf(recordKey(agentId), deleting, recordOf(record, "deleting", { why }));
  return { failed: why };
}
