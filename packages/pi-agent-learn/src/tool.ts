import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTool, type Session, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { CAPS, LEARNING_ID } from "./layout.js";
import { type Candidate, type Guard, LEARN_TYPES, type LearnType, type Refusal } from "./types.js";

type Stored = { callId: string; type: LearnType; text: string; evidence: string[]; id?: string };
type CandidatesState = { byCall: Record<string, Stored>; order: string[] };

/** The run's candidates, one per `learn` call id, in the order they were first noted. */
export const CandidatesDoc = defineDoc<CandidatesState>({ kind: "learn.candidates", version: 1, scope: "session", initial: () => ({ byCall: {}, order: [] }) });

/** The run's candidates, in the order it noted them. A Harness is a valid `target`. */
export async function collectCandidates(target: Pick<Session, "snapshot">, context: Context = BACKGROUND_CONTEXT): Promise<Candidate[]> {
  const doc = await target.snapshot(CandidatesDoc, context);
  return doc ? doc.order.map((callId) => structuredClone(doc.byCall[callId]!) as Candidate) : [];
}

type ToolContent = { type: "text"; text: string }[];
type ToolParameters = Parameters<typeof defineTool>[0]["parameters"];

/** pi-durable 1.1 reads a tool result's `content`; 1.2 and later read `output` and show a result without it as empty.
 *  The model's text goes under both keys. */
const forModel = (text: string): { content: ToolContent; output: ToolContent } => {
  const content: ToolContent = [{ type: "text", text }];
  return { content, output: content };
};

const refused = (text: string) => ({ ...forModel(text), isError: true }) as ToolExecutionResult;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export const LEARN_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["type", "text"],
  properties: {
    type: {
      type: "string",
      enum: [...LEARN_TYPES],
      description: "lesson: a general way to do the work better. fact: something stable about the world the work touches. correction: something the agent believed that is wrong. used: a learning from the <learned> section that helped this run (give its id).",
    },
    text: { type: "string", minLength: 1, maxLength: CAPS.text, description: "The general rule, in one or two sentences. Never names, ids or data from this case." },
    evidence: {
      type: "array",
      maxItems: CAPS.evidenceItems,
      items: { type: "string", minLength: 1, maxLength: CAPS.evidence },
      description: "What in this run shows it: a tool call, a source, an error. Kept with the run, never in the learning.",
    },
    id: { type: "string", pattern: LEARNING_ID.source, description: "For used: the id of the learning that helped (L-...). For a correction: the learning it corrects, when there is one." },
  },
} as const;

const REASONS: Record<Refusal["reason"], string> = {
  secret_value: "it holds a value the host keeps secret",
  secret_shape: "it holds something shaped like a credential",
  invisible_unicode: "it holds invisible or direction-changing characters",
  rules_locked: "it would change the agent's rules",
  path_not_allowed: "it would write outside this run's files",
  case_data: "it repeats data from this case",
  too_large: "it is too long",
  too_many: "this run noted too many",
  invalid: "it is not well formed",
};

export type LearnToolOptions = {
  /** Checked on every call before anything is stored; a refused call stores nothing. The host proposes through the
   *  guard again either way. */
  readonly guard?: Guard;
  /** The host's secrets at the moment of the call, for `guard`. */
  readonly secrets?: () => Iterable<string>;
};

/** The `learn` tool: notes one candidate in the run's own store, keyed by the call id, and makes no model call. A rerun
 *  of the same call after a crash finds its candidate and stores nothing new. */
export function learnTool(options: LearnToolOptions = {}): ToolRegistration {
  return defineTool({
    name: "learn",
    description:
      "Note one thing this run learned that would help a later run of this agent: a general lesson, a stable fact, or a correction of something it believed; or mark a learning from the <learned> section that helped (type used, with its id). State the general rule, never this case's data. Costs nothing; it is reviewed before a later run sees it.",
    parameters: LEARN_PARAMETERS as unknown as ToolParameters,
    replay: "safe",
    execute: async (args, api, context) => {
      const input = args as unknown as { type: LearnType; text: string; evidence?: string[]; id?: string };
      const evidence = input.evidence ?? [];
      if (bytes(input.text) > CAPS.text) return refused(`Not noted: the text is over ${CAPS.text} bytes. Say it shorter.`);
      if (bytes(evidence.join("")) > CAPS.evidence) return refused(`Not noted: the evidence is over ${CAPS.evidence} bytes in all.`);
      if (input.type === "used" && input.id === undefined) return refused("Not noted: a used mark needs the id of the learning that helped.");
      const candidate: Candidate = { callId: api.callId, type: input.type, text: input.text, evidence, ...(input.id === undefined ? {} : { id: input.id }) };
      if (options.guard) {
        let refusals: readonly Refusal[];
        try {
          refusals = options.guard({ role: "run", candidates: [candidate], secrets: [...(options.secrets?.() ?? [])] });
        } catch {
          return refused("Not noted: the host could not check it. Nothing was stored.");
        }
        if (refusals.length) {
          const why = [...new Set(refusals.map((r) => REASONS[r.reason] ?? "it was refused"))].join("; ");
          return refused(`Not noted: ${why}. Restate it as a general rule without that.`);
        }
      }
      const noted = await api.commit(async (tx) => {
        const doc = await tx.doc(CandidatesDoc);
        const known = doc.order.indexOf(api.callId);
        if (known >= 0) return known + 1;
        const used = input.type === "used";
        const count = doc.order.filter((callId) => (doc.byCall[callId]!.type === "used") === used).length;
        if (count >= (used ? CAPS.usedPerRun : CAPS.perRun)) return 0;
        doc.byCall[api.callId] = { callId: candidate.callId, type: candidate.type, text: candidate.text, evidence: [...evidence], ...(candidate.id === undefined ? {} : { id: candidate.id }) };
        doc.order.push(api.callId);
        return doc.order.length;
      }, context);
      if (noted === 0) return refused(`Not noted: this run already noted ${input.type === "used" ? CAPS.usedPerRun : CAPS.perRun} of these.`);
      return forModel(`[noted ${noted}]`) as ToolExecutionResult;
    },
  });
}
