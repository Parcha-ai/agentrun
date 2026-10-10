// A workflow's LLM nodes on pi-durable, behind `runNode`: each attempt is one conversation (node.ts), and one
// extension serves them all.
//
// What differs per node lives with its conversation: the agent the host chose for it, and its configuration document
// (its system text, and the record it owes: label, schema, file key). The `task` section renders the system text from
// that document. A conversation an older build opened has no such document: the runner writes it when it reaches the
// node, with the system text that build kept on the node's index entry, and gives the conversation its agent. `submit` is registered once with open parameters; each request presents it with the node's own label
// and fields, and each call is decided against the node's schema. What cannot be stored (the node's reviewers, the
// host's checks, a committer for the nudge) is attached when the runner reaches the node, and a request, a call or a
// yield that pi resumed first waits for it, so nothing of a node runs before its host observes it.
import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  configure, defineDoc, defineExtension, GenerationTask, hook, section, type AgentChange, type ConversationId, type Extension, type HookApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { WorkflowDeps } from "@parcha/agentrun-dsl";
import { canonicalSha256, runStopOf, type RecoveryNodeParams } from "@parcha/agentrun-dsl/recovery";
import { closeNodeAttempt, runNodeAttempt, type NodeScope } from "./node.js";
import { DELIVERY_ATTEMPTS, lintRecordSchema, submitFooter, type Disagreement, type RecordContract, type Reviewer } from "./record.js";
import { workspaceRecordFile } from "./record-file.js";
import { RecordDoc, recordNudge, recordTool, spendNudge, submitDefinition, type RecordToolOptions } from "./record-tool.js";

/** A node's configuration: what its conversation's prompt and `submit` tool are drawn from. */
export const NodeDoc = defineDoc<{ system: string; label: string; schema: JsonValue | null; fileKey: string | null }>({
  kind: "agentrun.node", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ system: "", label: "", schema: null, fileKey: null }),
});

/** A node as the host is asked about it: the interpreter's request, and the attempt it runs as, with the sessions of
 *  the attempts before it (a host that refuses to repeat a call an earlier attempt left unknown reads them). */
export type NodeRequest = Omit<Parameters<NonNullable<WorkflowDeps["runNode"]>>[0], "review" | "signal"> & { sessionId: string; attempt: number; earlierSessionIds: readonly string[] };

/** What a host says of a node's record beside its schema. */
export type NodeRecord = Pick<RecordContract, "contracts" | "checks"> & {
  /** What the model is told it delivers (default: `the <label> record`). */
  label?: string;
  /** The host's own delivery instructions, said with the contract that ends the node's task. */
  instructions?: string;
  /** The record may be delivered as a JSON file the node wrote in `workspace`, named under `key`. */
  file?: { key: string; workspace: string };
};

export type NodeHost = {
  /** The agent a node's conversation runs with: its model, thinking level, working directory and the host's own
   *  extensions and tools. The runner adds its extension and `submit` where the host did not place them. */
  agent(node: NodeRequest): AgentChange | Promise<AgentChange>;
  /** Duty text for a node's system prompt, after the interpreter's. `offered` names the tools the agent lists. */
  stance?(node: NodeRequest, offered: { tools: readonly string[] }): string | undefined;
  record?(node: NodeRequest): NodeRecord | Promise<NodeRecord>;
  /** A second reading of a node's record, before the node's own verify clause: what it disagrees with. */
  verify?(record: unknown, node: NodeRequest, context: { round: boolean }): Disagreement[] | Promise<Disagreement[]>;
  /** Called, and awaited, when a node's conversation exists and before any request of this process reaches a model:
   *  the host attaches its observers to that conversation. */
  onNodeOpen?(node: NodeRequest & { conversationId: ConversationId; resumed: boolean }): void | Promise<void>;
  /** Delivery attempts a node gets (default `DELIVERY_ATTEMPTS`). */
  maxAttempts?: number;
  /** The host's part in every `submit` call: its rows, and which errors are its own failure. The one delivery it may
   *  be told before `onNodeOpen` is `already`, the answer of a call that a process died inside after its commit. */
  submit?: Pick<RecordToolOptions, "onDelivery" | "fatal" | "onFatal" | "fatalText">;
  /** The digest an attempt is bound by. Absent, one of the node's label, path, kind, item and attempt. */
  digest?(node: NodeRequest): string;
};

/** A node that delivered no record. `final` says a second attempt would spend the same again: the model did not
 *  answer, or the delivery attempts are spent. `detail` is pi's own account of an unanswered submission. */
export class NodeFailure extends Error {
  readonly code = "NODE_NOT_DELIVERED";
  constructor(message: string, readonly node: string, readonly final: boolean, readonly executionPath?: string, readonly detail?: JsonValue) {
    super(message);
    this.name = "NodeFailure";
  }
}

type Attached = { contract: RecordContract; commit: NodeScope["commit"] };
const listed = <T>(value: unknown): value is readonly T[] => Array.isArray(value);
const isSubmit = (tool: { name: string }) => tool.name === "submit";

/** The node runner over a host. Install `extension` in the registry before the Harness opens; `on` binds the runner
 *  to where its conversations live (`taskScope`, `hostScope`). */
export function nodeRunner(host: NodeHost, options: { name?: string } = {}): {
  extension: Extension;
  /** The extension a conversation an older build opened still selects, under that build's name for it: the system
   *  text that build kept as the `task` section, and this runner's `submit`. Each of its requests and calls waits for
   *  the runner to reach the node, which then moves the conversation to `extension`. Install one for each node an
   *  older build left unfinished, before the Harness resumes. */
  legacy(entry: { extension: string; system: string | null }): Extension;
  on(scope: NodeScope, context: Context): { runNode(params: RecoveryNodeParams): Promise<unknown>; closeStepSession(sessionId: string): Promise<void> };
} {
  const maxAttempts = host.maxAttempts ?? DELIVERY_ATTEMPTS;
  const attached = new Map<number, Attached>();
  const waiting = new Map<number, Set<(found: Attached) => void>>();
  /** What the runner attached to a conversation, once it has: the wait ends with the caller's own abort. */
  const reached = (id: ConversationId, context: Context): Promise<Attached> => {
    const found = attached.get(Number(id));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiters = waiting.get(Number(id)) ?? new Set();
      waiting.set(Number(id), waiters);
      const signal = context.abortSignal;
      const take = (value: Attached) => { signal?.removeEventListener("abort", stopped); resolve(value); };
      const stopped = () => { waiters.delete(take); reject(signal?.reason ?? new Error("the node was stopped before its runner reached it again")); };
      waiters.add(take);
      if (signal?.aborted) stopped(); else signal?.addEventListener("abort", stopped, { once: true });
    });
  };
  const attach = (id: ConversationId, value: Attached): (() => void) => {
    attached.set(Number(id), value);
    for (const take of waiting.get(Number(id)) ?? []) take(value);
    waiting.delete(Number(id));
    return () => { if (attached.get(Number(id)) === value) attached.delete(Number(id)); };
  };

  /** The contract of a `submit` call: a call cut after its record was committed is answered from the record and
   *  waits for nobody; any other waits for the runner. Only a conversation of an older build's node may be reached
   *  with no configuration document yet. */
  const contractOf = (legacy: boolean): RecordToolOptions["contract"] => async (api, context) => {
    if ((await api.snapshot(RecordDoc, api.conversationId, context))?.record != null) return { schema: {} };
    if (!legacy && !(await api.snapshot(NodeDoc, api.conversationId, context))?.schema) throw new Error("submit was called in a conversation that is no workflow node");
    return (await reached(api.conversationId, context)).contract;
  };
  /** Each request presents `submit` as the node's own record's tool. */
  const present = async (request: { readonly messages: readonly Message[] }, api: Pick<HookApi, "conversationId" | "snapshot">, context: Context) => {
    const node = await api.snapshot(NodeDoc, api.conversationId, context);
    if (!node?.schema) return undefined;
    await reached(api.conversationId, context);
    const shown = submitDefinition({ schema: node.schema as Record<string, unknown>, label: node.label, ...(node.fileKey ? { fileKey: node.fileKey } : {}) });
    return { messages: request.messages.map((message) => message.role === "system" && message.toolsAdded?.some(isSubmit)
      ? { ...message, toolsAdded: message.toolsAdded.map((offered) => isSubmit(offered) ? { ...offered, ...shown } as typeof offered : offered) } : message) };
  };
  const nudge = recordNudge({
    maxAttempts,
    label: async (api, context) => (await api.snapshot(NodeDoc, api.conversationId, context))?.label || undefined,
    spend: async (id, context) => (await reached(id, context)).commit((tx) => spendNudge(tx, id), context),
  });
  const tool = recordTool({ ...host.submit, contract: contractOf(false) });
  const extension = defineExtension({
    name: options.name ?? "agentrun-nodes",
    tools: [tool],
    sections: [section("task", async (input, context) => (await input.read.snapshot(NodeDoc, input.conversationId, context))?.system || undefined, { tag: false })],
    hooks: [hook(GenerationTask, { beforeRequest: present }), nudge],
  });
  /** The host's agent with the runner's extension first and `submit` last, unless the host placed them. */
  const withNodes = (agent: AgentChange): AgentChange => ({
    ...agent,
    extensions: listed<Extension>(agent.extensions)
      ? (agent.extensions.some((selected) => selected.name === extension.name) ? agent.extensions : [extension, ...agent.extensions])
      : { ...agent.extensions, add: [extension, ...(agent.extensions?.add ?? [])] },
    ...(listed<ToolRegistration>(agent.tools) && !agent.tools.some(isSubmit) ? { tools: [...agent.tools, tool] } : {}),
  });

  return {
    extension,
    legacy: (entry) => defineExtension({
      name: entry.extension,
      tools: [recordTool({ ...host.submit, contract: contractOf(true) })],
      sections: entry.system === null ? [] : [section("task", () => entry.system ?? undefined, { tag: false })],
      hooks: [hook(GenerationTask, { beforeRequest: async (request, api, context) => { await reached(api.conversationId, context); return present(request, api, context); } }), nudge],
    }),
    on: (scope, base) => ({
      closeStepSession: (sessionId) => closeNodeAttempt(scope, sessionId, base),
      runNode: async (params) => {
        const { review, signal, step, ...asked } = params;
        // An attempt the driver admitted is found again by its session; any other call is a conversation of its own.
        const node: NodeRequest = { ...asked, sessionId: step?.sessionId ?? `unjournaled:${randomUUID()}`, attempt: step?.attempt ?? 0, earlierSessionIds: step?.earlierSessionIds ?? [] };
        const fail = (message: string, final: boolean, detail?: JsonValue) => new NodeFailure(message, node.label, final, node.executionPath, detail);
        const lint = lintRecordSchema(node.schema);
        if (lint.length) throw fail(`${node.kind} node "${node.label}" cannot deliver a record of its schema: ${lint.join("; ")}`, true);
        const agent = await host.agent(node);
        const record = await host.record?.(node) ?? {};
        const label = record.label ?? `the ${node.label} record`;
        const offered = (listed<ToolRegistration>(agent.tools) ? agent.tools : listed<Extension>(agent.extensions) ? agent.extensions.flatMap((selected) => selected.tools ?? []) : [])
          .map((offer) => offer.name).filter((name) => name !== "submit");
        const system = [...node.system, host.stance?.(node, { tools: offered })].filter(Boolean).join("\n\n");
        const reviewers: Reviewer[] = [
          ...(host.verify ? [(candidate: unknown, at: { round: boolean }) => host.verify!(candidate, node, at)] : []),
          ...(review ? [async (candidate: unknown): Promise<Disagreement[]> => {
            const verdict = await review(candidate);
            return verdict.accepted ? [] : [{ id: "verify", kind: "verify", verdict: "fails", reasons: [`/: violates "the verify clause of ${node.label}" - ${verdict.message}`] }];
          }] : []),
        ];
        // The run's stop ends the wait at once, whatever the node is doing; the attempt goes on only under a pause.
        let onStop: (() => void) | undefined;
        const stopped = new Promise<never>((_, reject) => { onStop = () => reject(signal!.reason); });
        stopped.catch(() => undefined);
        if (signal?.aborted) onStop!(); else signal?.addEventListener("abort", onStop!, { once: true });
        let opened: { conversationId: ConversationId; detach(): void } | undefined;
        const attempt = runNodeAttempt(scope, {
          session: node.sessionId,
          digest: host.digest?.(node) ?? canonicalSha256({ step: node.label, path: node.executionPath ?? null, kind: node.kind, item: node.item?.index ?? null, attempt: node.attempt }),
          agent: withNodes(agent),
          user: `${node.user}\n${submitFooter({ label, schema: node.schema, reviewed: reviewers.length > 0, ...(record.file ? { fileKey: record.file.key } : {}), ...(record.instructions ? { instructions: record.instructions } : {}) })}`,
          init: async (tx, id) => { Object.assign(await tx.doc(NodeDoc, id), { system, label, schema: node.schema as JsonValue, fileKey: record.file?.key ?? null }); },
          adopt: async (tx, id, stored) => {
            const held = await tx.doc(NodeDoc, id);
            if (held.schema !== null) return;
            Object.assign(held, { system: typeof stored.system === "string" ? stored.system : system, label, schema: node.schema as JsonValue, fileKey: record.file?.key ?? null });
            // The older build selected an extension of its own for this conversation, which is not installed here.
            const own = typeof stored.extension === "string" ? [{ name: stored.extension } as Extension] : [];
            const given = withNodes(agent);
            await configure(tx, id, { ...given, ...(listed<Extension>(given.extensions) ? {} : { extensions: { ...given.extensions, remove: [...(given.extensions?.remove ?? []), ...own] } }),
              ...(listed<ToolRegistration>(agent.tools) ? {} : { tools: null }) });
          },
          onOpen: async ({ conversationId, resumed, startedMs }) => {
            opened = { conversationId, detach: attach(conversationId, { commit: scope.commit, contract: {
              schema: node.schema, maxAttempts, ...(reviewers.length ? { reviewers } : {}),
              ...(record.contracts ? { contracts: record.contracts } : {}), ...(record.checks ? { checks: record.checks } : {}),
              ...(record.file ? { file: workspaceRecordFile({ ...record.file, notBefore: () => startedMs }) } : {}),
            } }) };
            await host.onNodeOpen?.({ ...node, conversationId, resumed });
            // A stop that landed before the node's request is submitted: nothing is asked of a model.
            if (signal?.aborted) throw signal.reason;
          },
        }, base);
        attempt.catch(() => undefined);
        try {
          const outcome = await Promise.race([attempt, stopped]);
          if (outcome.delivered) return outcome.delivered.record;
          if (outcome.settled?.status === "unanswered") throw fail(`${node.label}: the model did not answer (${outcome.settled.reason})`, true, outcome.settled.detail);
          const spent = ((await scope.snapshot(RecordDoc, outcome.conversationId, base))?.attempts ?? 0) >= maxAttempts;
          throw fail(`${node.label} did not submit (${spent ? "its delivery attempts are spent" : "it ended its run without a record"})`, spent);
        } catch (error) {
          if (!signal?.aborted) throw error;
          // A pause keeps the node's work for the process that resumes it; any other stop ends that work, and a
          // request submitted as the stop landed is withdrawn once it is known.
          const end = async () => { if (opened) await (await scope.conversation(opened.conversationId, base))?.abort(base).catch(() => undefined); };
          if (runStopOf(signal.reason)?.stop !== "pause") { await end(); void attempt.then(end, end); }
          throw signal.reason ?? error;
        } finally {
          signal?.removeEventListener("abort", onStop!);
          void attempt.then(() => opened?.detach(), () => opened?.detach());
        }
      },
    }),
  };
}
