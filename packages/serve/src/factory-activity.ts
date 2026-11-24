// Factory metadata is an observation of an existing run, never a second lifecycle or a GitHub authorization grant.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationRecord } from "@earendil-works/pi-durable";
import type { RunLaunch } from "./run-launch.js";
import type { JournalRecords } from "./runner/journal-reader.js";
import type { Store } from "./store/store.js";
import { githubPullOf, githubTargetOf } from "./github.js";
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
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Only an explicit launch binding or the server's trusted GitHub event wrapper establishes a repository. Owner
 * prose, task titles and arbitrary tool results are never searched for URLs or issue numbers. */
export function factoryGithub(launch: RunLaunch | undefined, redact: (text: string) => string): FactoryGithub | null {
  if (!launch) return null;
  const binding = (): FactoryGithub | null => {
    if (typeof launch.repo !== "string") return null;
    const repository = redact(launch.repo);
    return REPOSITORY.test(repository) && repository === launch.repo ? { repository, issue: null, pull_request: null, head_sha: null, provenance: "launch" } : null;
  };
  if (!launch.trigger || launch.inputOrigin?.kind !== "trigger" || launch.inputOrigin.source !== "github" || launch.inputOrigin.trigger_id !== launch.trigger.id || launch.inputOrigin.owner) return binding();
  const content = isObject(launch.input) ? launch.input.content : undefined;
  if (typeof content !== "string") return binding();
  const wrapper = /<trigger-payload [^>]*>/.exec(content);
  if (!wrapper || !/\bsource="github"/.test(wrapper[0])) return binding();
  // Give the helpers the tag alone: their owner-URL fallback must never infer a repository from surrounding prose.
  const target = githubTargetOf(wrapper[0], { payload: true });
  if (!target || !REPOSITORY.test(target.repo) || redact(target.repo) !== target.repo) return binding();
  // Preserve the explicit binding if two independently recorded sources disagree; never attach another repo's PR.
  if (launch.repo !== undefined && launch.repo.toLowerCase() !== target.repo.toLowerCase()) return binding();
  const pull = githubPullOf(wrapper[0], { payload: true });
  let issue: number | null = null;
  let pull_request: number | null = pull?.number ?? null;
  // An issue_comment may refer to an issue or a PR. Only its structured signed payload distinguishes them; a cut or
  // malformed body keeps just the repository, never a guessed issue type. The server limits the kept payload already.
  const end = content.indexOf("</trigger-payload>", wrapper.index + wrapper[0].length);
  if (end >= 0) {
    try {
      const body: unknown = JSON.parse(content.slice(wrapper.index + wrapper[0].length, end));
      if (isObject(body) && isObject(body.issue) && positive(body.issue.number)) {
        if (isObject(body.issue.pull_request)) pull_request ??= body.issue.number;
        else issue = body.issue.number;
      }
    } catch { /* A truncated event still has its trusted repository and, for a PR event, head metadata. */ }
  }
  return { repository: target.repo, issue, pull_request, head_sha: pull && redact(pull.head) === pull.head ? pull.head : null, provenance: "github_trigger" };
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

export async function factoryObservation(store: Store, launch: RunLaunch | undefined, live: boolean, lastTick: number | undefined, now: () => number): Promise<FactoryActivity["observation"]> {
  if (launch?.sdk) return { basis: "unreported", status: "unreported", last_seen_at: null };
  if (launch?.native?.remote) return { basis: "connector", ...await new RemoteConnectors(store, now).health(launch.native.remote.connector_id) };
  return { basis: "runner", status: live ? "current" : "unreported", last_seen_at: lastTick === undefined ? null : new Date(lastTick).toISOString() };
}
