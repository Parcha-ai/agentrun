// Factory metadata is an observation of an existing run, never a second lifecycle or a GitHub authorization grant.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationRecord } from "@earendil-works/pi-durable";
import type { RunLaunch } from "./run-launch.js";
import type { JournalRecords } from "./runner/journal-reader.js";
import type { Store } from "./store/store.js";
import { RemoteConnectors } from "./native/remote.js";
import { isObject } from "./validate.js";

export type FactoryGithub = {
  repository: string; issue: number | null; pull_request: number | null; head_sha: string | null;
  provenance: "launch" | "github_trigger";
};
export type FactoryChild = { id: string; conversation_id: number; parent_call_id: string; status: "active" | "completed"; label: string | null };
export type FactoryActivity = {
  lifecycle_version: string;
  source: "managed" | "native" | "sdk"; runtime: string; control: "managed" | "observed";
  controls: { stop: boolean; cancel: boolean; approve: boolean };
  observation: { basis: "runner" | "connector" | "unreported"; status: "current" | "offline" | "revoked" | "unreported"; last_seen_at: string | null };
  last_activity_at: string | null;
  github: FactoryGithub | null;
  children: FactoryChild[];
};

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,14}$/;
const SHA = /^[0-9a-f]{40}$/;
const unescapeAttr = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Whether a payload tag's attribute text (` name="value"` each, then ` untrusted`) is the one the server writes for a
 *  GitHub firing with the saved attributes `attrs` (triggers.ts tagAttrs: a value cut to 200 characters, its line breaks
 *  made spaces, escaped). Every saved attribute and no other: an example tag, or one a sender wrote, lacks the delivery
 *  id GitHub gave this event. */
function tagOf(text: string, attrs: Readonly<Record<string, string>>): boolean {
  const written = Object.entries(attrs).filter(([name]) => /^[a-z][a-z0-9_-]{0,31}$/.test(name) && name !== "source" && name !== "untrusted");
  const read = new Map([...text.matchAll(/ ([a-z][a-z0-9_-]*)="([^"]*)"/g)].map((match) => [match[1]!, unescapeAttr(match[2]!)]));
  return read.size === written.length + 1 && read.get("source") === "github" && written.every(([name, value]) => read.get(name) === value.slice(0, 200).replace(/[\r\n\t]/g, " "));
}

/** Whether issue `number` of the event is an issue or a pull request: `issue.pull_request` of the signed body, read from
 *  the server's own payload block for this firing alone (tagOf). The trigger owner's instructions come first in the input
 *  and may hold an example block, so the first block is never taken for the event. No such block, a cut or malformed
 *  body, or a body about another number says neither: an issue type is never guessed. */
function issueKind(input: unknown, attrs: Readonly<Record<string, string>>, number: number): "issue" | "pull_request" | null {
  const content = isObject(input) ? input.content : undefined;
  if (typeof content !== "string") return null;
  for (const tag of content.matchAll(/<trigger-payload( [^>]*)>/g)) {
    if (!tagOf(tag[1]!, attrs)) continue;
    const from = tag.index + tag[0].length;
    const end = content.indexOf("</trigger-payload>", from);
    if (end < 0) return null;
    try {
      const body: unknown = JSON.parse(content.slice(from, end));
      const issue = isObject(body) && isObject(body.issue) ? body.issue : undefined;
      if (!issue || issue.number !== number) return null;
      return isObject(issue.pull_request) ? "pull_request" : "issue";
    } catch { return null; /* A truncated event still has its trusted repository. */ }
  }
  return null;
}

/** Only an explicit launch binding or what the server saved of the GitHub delivery that fired the run (its firing's
 *  attributes, trigger-github.ts: the repository, the number and a pull request's head, read from the signed body)
 *  establishes a repository. Owner prose, task titles and arbitrary tool results are never searched for URLs or issue
 *  numbers, and no payload tag in the run's input is taken for the event on its place alone. */
export function factoryGithub(launch: RunLaunch | undefined, redact: (text: string) => string): FactoryGithub | null {
  if (!launch) return null;
  const binding = (): FactoryGithub | null => {
    if (typeof launch.repo !== "string") return null;
    const repository = redact(launch.repo);
    return REPOSITORY.test(repository) && repository === launch.repo ? { repository, issue: null, pull_request: null, head_sha: null, provenance: "launch" } : null;
  };
  if (!launch.trigger || launch.inputOrigin?.kind !== "trigger" || launch.inputOrigin.source !== "github" || launch.inputOrigin.trigger_id !== launch.trigger.id || launch.inputOrigin.owner) return binding();
  const attrs = launch.trigger.attrs ?? {};
  const repository = attrs.repo;
  if (repository === undefined || !REPOSITORY.test(repository) || redact(repository) !== repository) return binding();
  // Preserve the explicit binding if two independently recorded sources disagree; never attach another repo's PR.
  if (launch.repo !== undefined && launch.repo.toLowerCase() !== repository.toLowerCase()) return binding();
  const number = NUMBER.test(attrs.number ?? "") ? Number(attrs.number) : null;
  const head = SHA.test(attrs.head_sha ?? "") ? attrs.head_sha! : null;
  // A head is a pull request event's own (trigger-signatures.ts attrsOf). A number with no head is an issue's, or an
  // issue comment's, which may be on a pull request: only its signed body distinguishes them.
  const kind = number === null ? null : head !== null ? "pull_request" : issueKind(launch.input, attrs, number);
  return { repository, issue: kind === "issue" ? number : null, pull_request: kind === "pull_request" ? number : null, head_sha: kind === "pull_request" && head !== null && redact(head) === head ? head : null, provenance: "github_trigger" };
}

/** Actual journal/model timestamps only. A runner renewing a lease is not progress from an external SDK. */
export function factoryLastActivity(records: JournalRecords): string | null {
  let latest = 0;
  const take = (value: unknown) => { if (typeof value === "number" && Number.isFinite(value) && value > latest && value <= 8.64e15) latest = value; };
  for (const entry of records.entries) {
    if (isObject(entry.data)) take(entry.data.at);
    for (const message of entry.model ?? []) if (isObject(message)) take(message.timestamp);
  }
  return latest ? new Date(latest).toISOString() : null;
}

/** Child identity comes from the durable conversation's ownership edge and its actual subagent tool task. A tool
 * merely named like a child, or a nested SDK tool callback, is not an independent session. */
export async function factoryChildren(store: Store, runId: string, records: JournalRecords, redact: (text: string) => string): Promise<FactoryChild[]> {
  const journal = store.readJournal(runId);
  const conversations: ConversationRecord[] = [];
  let cursor: unknown;
  do {
    const page = await journal.scanConversations({ order: "ascending" } as never, 500, cursor as never, BACKGROUND_CONTEXT);
    conversations.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const tasks = new Map(records.tasks.map((task) => [Number(task.id), task]));
  const entries = new Map(records.entries.map((entry) => [Number(entry.id), entry]));
  return conversations.flatMap((conversation) => {
    const task = conversation.owner && tasks.get(Number(conversation.owner.taskId));
    if (!task || task.kind !== "pi.tool" || task.state.status === "terminal" || task.state.status === "completing" || !isObject(task.input)) return [];
    const { callId, assistant } = task.input;
    if (typeof callId !== "string" || typeof assistant !== "number") return [];
    const entry = entries.get(assistant);
    const content = entry?.model?.[0] && "content" in entry.model[0] ? entry.model[0].content : undefined;
    const call = Array.isArray(content) ? content.find((block) => isObject(block) && block.type === "toolCall" && block.id === callId && block.name === "subagent") : undefined;
    if (!isObject(call)) return [];
    const prompt = isObject(call.arguments) && typeof call.arguments.prompt === "string" ? call.arguments.prompt : null;
    const id = Number(conversation.id);
    if (!Number.isSafeInteger(id) || id < 0 || redact(callId) !== callId) return [];
    return [{ id: `${runId}:conversation:${id}`, conversation_id: id, parent_call_id: callId, status: "active" as const, label: prompt === null ? null : redact(prompt).slice(0, 160) }];
  });
}

/** Who a run is observed through, from its launch: nothing reports an SDK run, a remote native run is seen through its
 *  paired connector, and any other through the runner that holds it. It never changes for a run, so a listing keeps it. */
export type FactoryObserved = { readonly basis: "unreported" } | { readonly basis: "connector"; readonly connector: string } | { readonly basis: "runner" };
export const factoryObserved = (launch: RunLaunch | undefined): FactoryObserved =>
  launch?.sdk ? { basis: "unreported" } : launch?.native?.remote ? { basis: "connector", connector: launch.native.remote.connector_id } : { basis: "runner" };

/** A run's observation now: its connector's health, or whether a runner holds it (`live`) and that runner's last tick.
 *  Read at each request, never kept: a lease renewed or a connector lost writes nothing to the run. */
export async function observationOf(store: Store, observed: FactoryObserved, live: boolean, lastTick: number | undefined, now: () => number): Promise<FactoryActivity["observation"]> {
  if (observed.basis === "unreported") return { basis: "unreported", status: "unreported", last_seen_at: null };
  if (observed.basis === "connector") return { basis: "connector", ...await new RemoteConnectors(store, now).health(observed.connector) };
  return { basis: "runner", status: live ? "current" : "unreported", last_seen_at: lastTick === undefined ? null : new Date(lastTick).toISOString() };
}

export const factoryObservation = (store: Store, launch: RunLaunch | undefined, live: boolean, lastTick: number | undefined, now: () => number): Promise<FactoryActivity["observation"]> =>
  observationOf(store, factoryObserved(launch), live, lastTick, now);
