// The node runner's kernel: one attempt of an LLM node as one conversation, found again after a crash.
//
// An attempt has an identity, its session id. In one commit the runner looks that id up in the node index and,
// when it is absent, creates the conversation, configures its agent and records it. It then submits the node's
// input under a request id drawn from the session id and waits. A process that died anywhere after that commit
// finds the same conversation under the same id, the same request id returns the same submission, and pi resumes
// what was in flight by itself: a turn that committed is never requested again. The node's record is read from the
// conversation's record document, never from its transcript, and an attempt that already delivered one makes no
// request at all.
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  configure, defineDocFamily, type AgentChange, type ConversationId, type DocumentReader, type InputSubmissionDraft, type Submission,
  type TaskId, type Tx,
} from "@earendil-works/pi-durable";
import type { Disagreement } from "./record.js";
import { deliveredRecord } from "./record-tool.js";

/** The node index: an attempt's conversation by its session id, the digest of what it was bound to, when it started,
 *  and whether its owner closed it without a record. */
export const NodeIndex = defineDocFamily<{ conversation: number | null; digest: string | null; startedMs: number | null; closed: boolean }, null>({
  kind: "agentrun.nodes", version: 1, scope: "session", family: true, initial: () => ({ conversation: null, digest: null, startedMs: null, closed: false }),
});

/** Where a node's conversation lives and who writes there: a workflow task's runtime, a tool call's api, or the
 *  Harness. `owner` is the task that owns the conversation (aborting it aborts the node); absent, nobody does. */
export type NodeScope = {
  commit(write: (tx: Tx) => Promise<void>, context: Context): Promise<void>;
  conversation(id: ConversationId, context: Context): Promise<{ submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>; abort(context: Context): Promise<void> } | undefined>;
  snapshot: DocumentReader["snapshot"];
  owner?: TaskId;
};

/** A task's runtime as a node scope: the task owns the conversations its nodes run in. */
export function taskScope(runtime: {
  taskId: TaskId; snapshot: DocumentReader["snapshot"]; conversation: NodeScope["conversation"];
  commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<void>;
}): NodeScope {
  return {
    owner: runtime.taskId,
    snapshot: runtime.snapshot.bind(runtime) as DocumentReader["snapshot"],
    conversation: (id, context) => runtime.conversation(id, context),
    commit: (write, context) => runtime.commit(async (tx) => { await write(tx); return undefined; }, context),
  };
}

/** The Harness as a node scope: the host drives the node, and no task owns its conversation. */
export function hostScope(harness: {
  snapshot: DocumentReader["snapshot"]; conversation: NodeScope["conversation"];
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}): NodeScope {
  return {
    snapshot: harness.snapshot.bind(harness) as DocumentReader["snapshot"],
    conversation: (id, context) => harness.conversation(id, context),
    commit: (write, context) => harness.commit(write, context),
  };
}

export type NodeAttempt = {
  /** The attempt's identity: the key of its index entry, and of its request (`node:<session>`). */
  session: string;
  /** A digest of what the attempt is bound to. An attempt found under another digest is refused, never continued. */
  digest: string;
  /** The agent the attempt's conversation is created with: model, thinking, extensions, tools, instructions. */
  agent: AgentChange;
  /** The node's input: the conversation's one user turn. */
  user: string;
  /** Written in the commit that creates the conversation: the documents the conversation's tools and sections read. */
  init?(tx: Tx, conversationId: ConversationId): void | Promise<void>;
  /** Run in the commit that finds the conversation an earlier process created, with its index entry as stored (an
   *  older build's entry holds more fields): what a conversation that older build opened needs to run here. */
  adopt?(tx: Tx, conversationId: ConversationId, stored: Readonly<Record<string, unknown>>): void | Promise<void>;
  /** Called, and awaited, once the conversation exists and before its request: the host attaches what observes it.
   *  `resumed` says an earlier process created it, `startedMs` when. */
  onOpen?(at: { conversationId: ConversationId; resumed: boolean; startedMs: number }): void | Promise<void>;
};

/** How an attempt's submission ended: answered, or not, with pi's reason (`aborted`, `failed`, ...) and detail. */
export type NodeSettlement = { status: "done" } | { status: "unanswered"; reason: string; detail?: JsonValue };

/** How an attempt came out. `delivered` is the record its conversation committed, if it did; `settled` is how the
 *  submission ended, absent when the record was already there and no request was made. */
export type NodeOutcome = {
  conversationId: ConversationId;
  resumed: boolean;
  settled?: NodeSettlement;
  delivered?: { record: JsonValue; disagreements: Disagreement[] };
};

/** An attempt found bound to something else than it is asked to run under. */
export class NodeBindingMismatch extends Error {
  readonly code = "NODE_BINDING_MISMATCH";
  constructor(readonly session: string, readonly stored: string | null, readonly asked: string) {
    super(`node attempt ${session} is bound to ${stored ?? "nothing"}, not ${asked}: it is not continued under another binding`);
    this.name = "NodeBindingMismatch";
  }
}

/** Run one attempt. */
export async function runNodeAttempt(scope: NodeScope, attempt: NodeAttempt, context: Context): Promise<NodeOutcome> {
  let found: { conversationId: ConversationId; digest: string | null; resumed: boolean; startedMs: number } | undefined;
  await scope.commit(async (tx) => {
    const entry = await tx.doc(NodeIndex, attempt.session, null);
    if (entry.conversation !== null) {
      found = { conversationId: entry.conversation as unknown as ConversationId, digest: entry.digest, resumed: true, startedMs: entry.startedMs ?? 0 };
      // An attempt under another binding is refused below, untouched.
      if (entry.digest === attempt.digest) await attempt.adopt?.(tx, found.conversationId, entry as unknown as Record<string, unknown>);
      return;
    }
    const conversation = await tx.createConversation({ ownership: scope.owner !== undefined ? { kind: "task", taskId: scope.owner } : { kind: "ownerless" } });
    await configure(tx, conversation.id, attempt.agent);
    await attempt.init?.(tx, conversation.id);
    entry.conversation = Number(conversation.id);
    entry.digest = attempt.digest;
    entry.startedMs = Date.now();
    found = { conversationId: conversation.id, digest: attempt.digest, resumed: false, startedMs: entry.startedMs };
  }, context);
  const { conversationId, digest, resumed, startedMs } = found!;
  if (digest !== attempt.digest) throw new NodeBindingMismatch(attempt.session, digest, attempt.digest);
  await attempt.onOpen?.({ conversationId, resumed, startedMs });
  // A record the attempt already delivered is the node's record: nothing is requested for it.
  const already = await deliveredRecord(scope, conversationId, context);
  if (already) return { conversationId, resumed, delivered: already };
  const handle = await scope.conversation(conversationId, context);
  if (!handle) throw new Error(`node attempt ${attempt.session} names conversation ${String(conversationId)}, which does not exist`);
  const submission = await handle.submit({ type: "input", content: attempt.user, requestId: `node:${attempt.session}` }, context);
  const ended = await submission.wait(context);
  const settled: NodeSettlement = ended.status === "unanswered"
    ? { status: "unanswered", reason: ended.reason, ...(ended.detail !== undefined ? { detail: ended.detail } : {}) } : { status: "done" };
  const delivered = await deliveredRecord(scope, conversationId, context);
  return { conversationId, resumed, settled, ...(delivered ? { delivered } : {}) };
}

/** An attempt its owner closed without a record: the mark a reader tells it from one still running by. */
export async function closeNodeAttempt(scope: Pick<NodeScope, "commit">, session: string, context: Context): Promise<void> {
  await scope.commit(async (tx) => { const entry = await tx.doc(NodeIndex, session, null); if (entry.conversation !== null) entry.closed = true; }, context);
}
