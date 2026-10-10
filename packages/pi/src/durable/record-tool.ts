// The record core on pi-durable: the `submit` tool of a node's conversation, its two documents, and the nudge of a
// yield without a record.
//
// The tool's `prepareArguments` repairs transport spellings before the Harness validates, and carries every call's
// arguments to `execute` under a wrapper the parameters do not type, so no call is refused before the core counts
// it: every submit is a delivery attempt. Each decision is one commit on the conversation's documents, written
// before the model is answered, so a crash cannot grant an attempt or the second reading's round twice. The tool is
// `replay: "safe"`: a call cut after its commit runs again and finds what it wrote.
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc, defineTool, GenerationTask, hook, type ConversationId, type DocumentReader, type HookRegistration, type ToolExecutionApi,
  type ToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";
import {
  DELIVERY_ATTEMPTS, deliver, deliveryTerminates, deliveryText, fileSubmission, mixedFileSubmission, nudgeText, repairRecord,
  type Delivery, type Disagreement, type RecordContract, type RecordStore,
} from "./record.js";

/** The record a conversation delivered, or null while it has not, and the delivery attempts it has spent. */
export const RecordDoc = defineDoc<{ record: JsonValue | null; attempts: number }>({
  kind: "agentrun.record", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ record: null, attempts: 0 }),
});

/** The gate's own state beside the record: whether the second reading's round was spent, and what it still
 *  disagreed with in the delivered record. */
export const GateDoc = defineDoc<{ bounced: boolean; disagreements: Disagreement[] }>({
  kind: "agentrun.gate", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ bounced: false, disagreements: [] }),
});

/** Where `prepareArguments` carries a call's arguments to `execute`. A record's own fields are never read as it. */
const RAW = "_raw";

/** The core's store on a conversation's two documents, written through a tool call's commits. */
export function recordStore(api: Pick<ToolExecutionApi, "commit" | "snapshot" | "conversationId">, context: Context): RecordStore {
  const id = api.conversationId;
  return {
    read: async () => ({
      record: (await api.snapshot(RecordDoc, id, context)) ?? { record: null, attempts: 0 },
      gate: (await api.snapshot(GateDoc, id, context)) ?? { bounced: false, disagreements: [] },
    }),
    reject: () => api.commit(async (tx) => { const state = await tx.doc(RecordDoc, id); state.attempts += 1; return state.attempts; }, context),
    bounce: () => api.commit(async (tx) => {
      (await tx.doc(GateDoc, id)).bounced = true;
      const state = await tx.doc(RecordDoc, id);
      state.attempts += 1;
      return state.attempts;
    }, context),
    accept: (record, disagreements) => api.commit(async (tx) => {
      const state = await tx.doc(RecordDoc, id);
      state.record = record as JsonValue;
      state.attempts += 1;
      if (disagreements.length) (await tx.doc(GateDoc, id)).disagreements = disagreements;
    }, context),
  };
}

/** The record a conversation delivered, or undefined while it has not, with what its second reading still disagreed with. */
export async function deliveredRecord(reader: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<{ record: JsonValue; disagreements: Disagreement[] } | undefined> {
  const state = await reader.snapshot(RecordDoc, conversationId, context);
  if (state?.record == null) return undefined;
  return { record: state.record, disagreements: [...((await reader.snapshot(GateDoc, conversationId, context))?.disagreements ?? [])] };
}

export type RecordToolOptions = {
  /** The record schema the tool's parameters are drawn from: its top-level fields with their plain types and
   *  descriptions, none required, since a partial record is an attempt the core counts. */
  schema: Record<string, unknown>;
  /** What the model is told the tool delivers ("the summary record"). */
  label: string;
  /** The key a record may be delivered under as a workspace file; the description offers the envelope when set. */
  fileKey?: string;
  /** The delivery contract of the conversation that called: its schema, reviewers, host checks and file reader. It is
   *  read on every call, so a host may resolve it late (a conversation pi resumed before its owner reached it again). */
  contract(conversationId: ConversationId, context: Context): RecordContract | Promise<RecordContract>;
  /** Told each delivery after its commit: a host writes its own rows from it. A throw is the caller's own failure. */
  onDelivery?(delivery: Delivery, conversationId: ConversationId): void | Promise<void>;
  /** Whether an error is the host's own failure. Such an error ends the node's run with `fatalText`, and the host is
   *  told through `onFatal`; any other error is the tool's and is thrown. */
  fatal?: (error: unknown) => boolean;
  onFatal?(error: unknown, conversationId: ConversationId): void;
  fatalText?: string;
};

/** The `submit` tool for one record schema. */
export function recordTool(options: RecordToolOptions): ToolRegistration {
  const { schema, fileKey } = options;
  const declared = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, { description?: unknown; type?: unknown }> : {};
  const parameters = { type: "object", additionalProperties: true, properties: {
    ...Object.fromEntries(Object.entries(declared).filter(([key]) => key !== RAW).map(([key, property]) =>
      [key, { ...(typeof property?.type === "string" ? { type: property.type } : {}), ...(typeof property?.description === "string" ? { description: property.description } : {}) }])),
    ...(fileKey ? { [fileKey]: { type: "string", description: "Workspace-relative path to the complete JSON record" } } : {}) } };
  const answer = (delivery: Delivery, maxAttempts: number): ToolExecutionResult => ({
    ...(delivery.status === "rejected" || delivery.status === "bounced" ? { isError: true } : {}),
    content: [{ type: "text", text: deliveryText(delivery, maxAttempts) }],
    ...(deliveryTerminates(delivery) ? { control: { terminate: true } } : {}),
  });
  return defineTool({
    name: "submit",
    description: fileKey
      ? `Deliver ${options.label}. Submit it inline, or for a large record write JSON in the workspace and pass {"${fileKey}":"relative/path.json"}. It ends the run.`
      : `Deliver ${options.label}. Submit it inline as the tool arguments. It ends the run.`,
    parameters: parameters as unknown as TSchema,
    // The record repaired as a transport spelling; a file submission is carried as it is.
    prepareArguments: (args: unknown) => {
      if (fileKey && (fileSubmission(args, fileKey) !== null || mixedFileSubmission(args, schema, fileKey))) return { [RAW]: args } as never;
      // The reserved file key beside inline fields is the transport's, never the record's.
      const inline = fileKey && args && typeof args === "object" && !Array.isArray(args) ? (({ [fileKey]: _reserved, ...rest }) => rest)(args as Record<string, unknown>) : args;
      return { [RAW]: repairRecord(inline, schema) } as never;
    },
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      try {
        const contract = await options.contract(api.conversationId, context);
        const delivery = await deliver({ ...contract, ...(options.fatal ? { fatal: options.fatal } : {}) }, recordStore(api, context), (args as { [RAW]?: unknown })[RAW]);
        await options.onDelivery?.(delivery, api.conversationId);
        return answer(delivery, contract.maxAttempts ?? DELIVERY_ATTEMPTS);
      } catch (error) {
        if (!options.fatal?.(error)) throw error;
        options.onFatal?.(error, api.conversationId);
        return { isError: true, content: [{ type: "text", text: options.fatalText ?? "The run cannot record this submission; the run stops." }], control: { terminate: true } };
      }
    },
  }) as ToolRegistration;
}

export type RecordNudgeOptions = {
  /** What is owed, as the nudge names it; undefined for a conversation this hook does not nudge (it owes no record). */
  label(conversationId: ConversationId, context: Context): string | undefined | Promise<string | undefined>;
  /** Counts one delivery attempt on the conversation's record, durably, before the model is nudged. A hook cannot
   *  commit, so the conversation's owner supplies the write. */
  spend(conversationId: ConversationId, context: Context): Promise<void>;
  /** Delivery attempts the conversation gets (default `DELIVERY_ATTEMPTS`). */
  maxAttempts?: number;
};

/** The nudge: a yield with the record still owed continues the run with a reminder, each nudge one delivery attempt;
 *  past the attempts the run ends. */
export function recordNudge(options: RecordNudgeOptions): HookRegistration {
  return hook(GenerationTask, {
    onYield: async (_answer, api, context) => {
      const state = await api.snapshot(RecordDoc, api.conversationId, context);
      if (state?.record != null) return undefined;
      const label = await options.label(api.conversationId, context);
      if (label === undefined || (state?.attempts ?? 0) >= (options.maxAttempts ?? DELIVERY_ATTEMPTS)) return undefined;
      await options.spend(api.conversationId, context);
      return { continue: nudgeText(label) };
    },
  });
}

/** One nudge's delivery attempt, as a commit on the conversation's record. */
export const spendNudge = async (tx: { doc(token: typeof RecordDoc, conversationId: ConversationId): Promise<{ attempts: number }> }, conversationId: ConversationId): Promise<void> => {
  (await tx.doc(RecordDoc, conversationId)).attempts += 1;
};
