// The subagent tool (a revision names `subagent` in its tools): one call runs a fresh conversation of the run's own,
// owned by the call, on the agent's own model (or one of its model tiers, when the call names one), with a subset of the
// tools the agent was granted, and answers
// with that conversation's final text. The engine offers only "this prompt, in a fresh context, with these tools": what
// to ask, how to split the work and how to merge the answers are the agent's own instructions', never this module's.
//
// What holds a child to the run's rules: it is a conversation of the run's own Harness, so every request of its model
// goes through a model proxy on the session's one booking (adapters/pi.ts `tiers`), under the run's one cap, and every
// tool call it makes passes the session's gate (the session extension's beforeTool hook, which the child keeps). Its
// tools are exactly the subset the call names (the child's enabled tools), and its bash, when it has bash, is held to the
// agent's own bash policy (read-only) by that same gate. Its model is the agent's own, or a tier the agent declares when
// the call names one (never a model the call names); it has no subagent tool of its own (depth 1), and at most
// SUBAGENT_PARALLEL children of a run work at once; a call past that waits for one to end.
import type { Context } from "@earendil-works/chord";
import { configure, defineExtension, defineTool, type Extension, type ModelRef, ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";
import { ASK_TOOL } from "../tools.js";
import { HOST_TOOL_OUTPUT } from "./adapters/pi.js";

export const SUBAGENT_TOOL = "subagent";
/** The tiers a call may name for its child (its definition's model_tiers, else this server's tier); a call that names
 *  none runs its child on the agent's own model. */
export const SUBAGENT_TIERS = ["fast", "strong"] as const;
export type SubagentTier = (typeof SUBAGENT_TIERS)[number];
/** How many of a run's children work at once; a call past it waits for a slot. */
export const SUBAGENT_PARALLEL = 4;
/** Tools no child is given: a subagent of its own (depth 1), and the person, whom only the run's own conversation asks. */
const NEVER_GIVEN: readonly string[] = [SUBAGENT_TOOL, ASK_TOOL];
/** A child's instructions: the call's prompt is its whole task. Nothing of the parent's prompt is carried over. */
export const SUBAGENT_INSTRUCTIONS = "You are a subagent. The message you are given is your whole task: do it with the tools you have, then answer. Your last message is returned, as it is, to the agent that called you.";

/** A tier's model in this run: its ref in the run's models (adapters/pi.ts tierProvider), or why the tier has none here. */
export type TierModel = { readonly ref: ModelRef } | { readonly why: string };

export type SubagentOptions = {
  /** The tools the agent was granted, by catalog name (`read`, `mcp:github/get_file_contents`): a call's subset of them. */
  readonly granted: readonly string[];
  /** A granted tool's names in the run's session (catalog.ts wireName; the browser's registrations for `browser`). */
  readonly sessionNames: (catalog: string) => readonly string[];
  /** The tier's model, resolved at the claim. */
  readonly tier: (tier: SubagentTier) => TierModel;
  /** Words before a child's own instructions (the environment line), when the host has any. */
  readonly preamble?: string;
};

type Args = { prompt: string; tools?: string[]; model?: SubagentTier };

/** One counter of free slots for the run's children (SUBAGENT_PARALLEL), handed out in call order. */
function slots(count: number) {
  let free = count;
  const waiting: (() => void)[] = [];
  return {
    async take(signal?: AbortSignal): Promise<() => void> {
      if (free > 0) free -= 1;
      else {
        await new Promise<void>((resolve, reject) => {
          const go = () => {
            signal?.removeEventListener("abort", stop);
            resolve();
          };
          const stop = () => {
            const at = waiting.indexOf(go);
            if (at >= 0) waiting.splice(at, 1);
            reject(signal?.reason ?? new Error("aborted"));
          };
          waiting.push(go);
          signal?.addEventListener("abort", stop, { once: true });
        });
      }
      let given = false;
      return () => {
        if (given) return;
        given = true;
        const next = waiting.shift();
        if (next) next();
        else free += 1;
      };
    },
  };
}

/** The text of an assistant message: its text parts, joined. */
const textOf = (message: { content?: unknown } | undefined): string =>
  Array.isArray(message?.content) ? message.content.map((part: { type?: string; text?: string }) => (part?.type === "text" ? (part.text ?? "") : "")).join("") : typeof message?.content === "string" ? message.content : "";

/** `text` within the host's bound on a tool result (HOST_RESULT_MAX_CHARS), saying where it was cut. */
export function boundedAnswer(text: string): string {
  if (text.length <= HOST_RESULT_MAX_CHARS) return text;
  const note = `\n[the subagent's answer was cut at ${HOST_RESULT_MAX_CHARS.toLocaleString("en-US")} of its ${text.length.toLocaleString("en-US")} characters]`;
  return text.slice(0, HOST_RESULT_MAX_CHARS - note.length) + note;
}

/** The catalog names of `asked` (each a catalog or session name of a granted tool), or what is wrong with them. */
export function chosenTools(asked: readonly string[], options: Pick<SubagentOptions, "granted" | "sessionNames">): { catalog: string[] } | { refused: string } {
  const catalog: string[] = [];
  const offered = options.granted.filter((name) => !NEVER_GIVEN.includes(name));
  for (const name of asked) {
    if (NEVER_GIVEN.includes(name)) return { refused: `subagent: a subagent is never given ${name}${name === SUBAGENT_TOOL ? " (subagents go one level deep)" : " (only the run itself asks its person)"}. Nothing ran.` };
    const found = options.granted.find((granted) => granted === name || options.sessionNames(granted).includes(name));
    if (found === undefined) return { refused: `subagent: ${name} is not one of this agent's tools, so no subagent may have it. A subagent may be given ${offered.length ? offered.join(", ") : "no tool here"}. Nothing ran.` };
    if (!catalog.includes(found)) catalog.push(found);
  }
  return { catalog };
}

/** The subagent tool and its extension. Install the extension in the run's root agent (adapters/pi.ts `extensions`). */
export function subagentExtension(options: SubagentOptions): Extension {
  const free = slots(SUBAGENT_PARALLEL);
  let extension: Extension;
  const tool = defineTool({
    name: SUBAGENT_TOOL,
    description: `Run a subagent: a fresh conversation that starts with nothing but your prompt, on your own model (or the model tier you name: ${SUBAGENT_TIERS.join(" or ")}), with only the tools you list (a subset of your own), and get its final answer back as text. Write the prompt self-contained: the subagent sees none of your conversation. Several calls in one turn run at once, at most ${SUBAGENT_PARALLEL} at a time; more wait their turn. A subagent cannot start subagents of its own.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, description: "The subagent's whole task, self-contained: it sees nothing else." },
        tools: { type: "array", items: { type: "string" }, uniqueItems: true, description: "The tools it may use, each one of your own tools by name. Absent or empty: none." },
        model: { enum: [...SUBAGENT_TIERS], description: "The model tier it runs on, one of this agent's own tiers. Absent: your own model." },
      },
      required: ["prompt"],
    } as never,
    // A rerun after a crash finds the same child (it is owned by this call's task) and the same submission (its request
    // id), so the child's work is never started twice.
    replay: "safe",
    executionMode: "parallel",
    outputLimits: HOST_TOOL_OUTPUT,
    execute: async (given, api, context: Context) => {
      const args = given as Args;
      const fail = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
      // Depth 1: a child has no subagent tool (its agent drops this extension); and only the run's own conversation calls it.
      if (Number(api.conversationId) !== Number(ROOT_CONVERSATION_ID)) return fail("subagent: a subagent cannot start subagents of its own. Nothing ran.");
      const model = args.model === undefined ? undefined : options.tier(args.model);
      if (model && "why" in model) return fail(`subagent: the ${args.model} tier has no model here: ${model.why} Nothing ran.`);
      const chosen = chosenTools(args.tools ?? [], options);
      if ("refused" in chosen) return fail(chosen.refused);
      // The registrations the parent's agent enables, by session name: exactly these are the child's.
      const names = new Set(chosen.catalog.flatMap((name) => options.sessionNames(name)));
      const parent = await api.agent(context);
      const tools = parent.tools.filter((registration) => names.has(registration.name));
      const missing = [...names].filter((name) => !tools.some((registration) => registration.name === name));
      if (missing.length) return fail(`subagent: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not bound in this run, so no subagent may have ${missing.length === 1 ? "it" : "them"}. Nothing ran.`);
      const release = await free.take(context.abortSignal);
      try {
        const child = await api.commit(async (tx) => {
          // The ownership index remembers the child: a rerun of this call reuses it.
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId } as never, 1)).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, {
            // The tier's model, else the parent's own (its route through the session's proxy and booking).
            model: model?.ref ?? parent.model,
            extensions: { remove: [extension] },
            tools: tools as unknown as ToolRegistration[],
            modelTools: null,
            instructions: [options.preamble, SUBAGENT_INSTRUCTIONS].filter(Boolean).join("\n\n"),
          });
          return created.id;
        }, context);
        // The call's details name its child: the run's timeline nests the child's rows under this call.
        const details = { conversationId: Number(child), ...(args.model ? { model: args.model } : {}), tools: chosen.catalog };
        await api.details(details as never, context);
        const handle = await api.conversation(child, context);
        if (!handle) return { ...fail("subagent: its conversation could not be opened. Nothing ran."), details };
        const submission = await handle.submit({ type: "input", content: args.prompt, requestId: `subagent:${String(api.taskId)}` }, context);
        const settled = await submission.wait(context);
        if (settled.status === "done" && settled.answer !== undefined) {
          const answer = await api.commit((tx) => tx.entry(settled.answer!), context);
          const message = answer?.model?.findLast((each) => each.role === "assistant");
          return { output: [{ type: "text" as const, text: boundedAnswer(textOf(message as never) || "(the subagent answered with no text)") }], details };
        }
        // Unanswered: its own words for why (a request the cap refused, a provider's error), from its last answer.
        const last = await api.commit(async (tx) => (await tx.scanEntries({ conversationId: child, order: "descending" } as never, 20)).items.flatMap((entry) => entry.model ?? []).find((each) => each.role === "assistant"), context);
        const why = (last as { errorMessage?: string } | undefined)?.errorMessage ?? settled.reason ?? "it stopped";
        return { ...fail(boundedAnswer(`subagent: it stopped before it answered: ${why}`)), details };
      } finally {
        release();
      }
    },
  });
  extension = defineExtension({ name: SUBAGENT_TOOL, tools: [tool as ToolRegistration] });
  return extension;
}
