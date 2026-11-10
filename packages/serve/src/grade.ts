// The grader as a call of this process (judgeProposal): learn/grade.ts' gradePrompt asked as one bounded completion
// against main as the caller read it (each active note's index line, the whole text only of the notes the proposal
// supersedes, and what the user said in the run, so the prompt is bounded whatever the folder holds: GRADE_CAPS). It
// runs on the model the server names for grading (learning.ts gradeModelOf: `--grade-model`, else its strong tier), else
// on the agent's own. Its answer is read by parseVerdict, which fails closed. A call cut off at its bound spent what
// nobody knows: the grade's cost is then unknown, never $0. No injection screen runs before it: a page classifier cannot
// see where a note came from, and dropped a preference the user stated (it reads like an instruction); the grader's
// Planted question decides, with what the user said in view.
// A run's proposal is graded and merged by the runner's built-in learning run (runner/learning-loop.ts: the same prompt
// and verdict, its call through the kernel's proxy and cap, its merge through learn/commit.ts learningCommit). This
// call is the learning evals' (test/learn-eval.test.mjs) and the grader-credential checks', on a model of this process.
import { gradedItems, type IndexEntry, type NoteText, type Verdict } from "./learn/index.js";
import { harnessOf } from "./harness-table.js";
import { type Provider, providerFor } from "./provider.js";
import { NO_TOKENS, type Tokens } from "./learning.js";
import { type Complete, completer } from "./llm.js";
import { type ModelRef, runModels, thinkingOf } from "./model.js";

/** How long the grader may take (unless the server names another), and the most it may write. */
const GRADE_TIMEOUT_MS = 180_000;
const GRADE_MAX_TOKENS = 16_000;
/** What a grade spent: the grader's calls. The dollars, null when any call's are unknown, and the tokens,
 *  null when any call's are. */
export type GradeCost = { usd: number | null; tokens: Tokens | null };
export type Judged = { cost: GradeCost } & ({ verdict: Verdict; unread?: string } | { reason: "grade_failed"; error: Error });
/** The agentic revision the run ran: its standing instructions, and what its model is. */
export type Agent = { instructions: string; harness?: string; model?: string; thinking?: string };


/** What a grade reads of main: each active note as the index lists it, the whole text of the ones the proposal
 *  supersedes, and the blob each of those was on main then (`graded`, by file), which its merge checks. */
export type GradeMain = { active: IndexEntry[]; superseded: NoteText[]; graded: Record<string, string> };

/** Counts one call in `cost`: its dollars and tokens, each null when unknown (a call that failed, or reported none). */
const counter = (cost: GradeCost) => (usd: number | null, tokens: Tokens | null) => {
  cost.usd = usd !== null && Number.isFinite(usd) && cost.usd !== null ? cost.usd + usd : null;
  cost.tokens = tokens && cost.tokens ? { input: cost.tokens.input + tokens.input, cache_read: cost.tokens.cache_read + tokens.cache_read, cache_write: cost.tokens.cache_write + tokens.cache_write, output: cost.tokens.output + tokens.output } : null;
};

/** `work`, given a signal that aborts at `ms` or with `outer`, and rejected then whether or not it listens. A call cut
 *  off so, before it settled, spent what nobody knows: `cost` turns unknown (null dollars and tokens), never the zeros
 *  it started from, and a late answer leaves it unknown. */
function bounded<T>(ms: number, outer: AbortSignal, cost: GradeCost, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (outer.aborted) return Promise.reject(outer.reason);
  const signal = AbortSignal.any([outer, AbortSignal.timeout(ms)]);
  let settled = false;
  const doing = work(signal).finally(() => (settled = true));
  doing.catch(() => undefined);
  const cut = new Promise<never>((_, reject) => {
    const stop = () => {
      if (settled) return;
      counter(cost)(null, null);
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([doing, cut]);
}

/** pi-ai's usage of one completion, as it reports it: `input` apart from what was read from or written to the cache. */
type PiUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
/** That usage by the platform's names; null when there is none, or a count is not a whole number. */
const tokensOf = (usage: PiUsage | undefined): Tokens | null =>
  usage && [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0) ? { input: usage.input, cache_read: usage.cacheRead ?? 0, cache_write: usage.cacheWrite ?? 0, output: usage.output } : null;
type PiModels = { getModel(provider: string, id: string): unknown; completeSimple(...args: unknown[]): Promise<{ usage?: PiUsage }> };
/** A run's provider, as providerFor returns it. Without `auth`, it takes x-api-key, as the adapter does. */
export type RunProvider = Pick<Provider, "origin" | "credential"> & { auth?: "x-api-key" | "bearer" };

/** The variable pi-ai's anthropic provider reads for each auth mode: it sends the first as `authorization: Bearer`, the
 *  second as `x-api-key`. */
const BEARER_VARIABLE = "ANTHROPIC_AUTH_TOKEN";
const X_API_KEY_VARIABLE = "ANTHROPIC_API_KEY";

/** pi-ai's auth context for a grade on `provider`, the run's: its credential under the one variable pi-ai reads for its
 *  auth mode, and no other variable of serve's env. */
export function graderAuth(provider: RunProvider) {
  const name = provider.auth === "bearer" ? BEARER_VARIABLE : X_API_KEY_VARIABLE;
  return { env: async (asked: string) => (asked === name ? (await provider.credential()) || undefined : undefined), fileExists: async () => false };
}

/** One completion for the grader: on the model the server names for grading (`named`), picked as a workflow's strong
 *  tier is (runModels: the gateway, pi-ai's providers, or the faux module); else on the agent's own model, as its run's
 *  process picks it (app.ts): one chosen on its wire's own settings sent where and as the run's own requests go
 *  (providerFor), any other by runModels. At its revision's thinking; counted in `cost` (a call that fails
 *  has an unknown cost). */
async function graderModel(env: NodeJS.ProcessEnv, agent: Agent, cost: GradeCost, named: string | undefined): Promise<Complete> {
  let chosen;
  // The agent's harness, resolved once (harness-table.ts).
  const entry = harnessOf(env, agent.harness);
  if (named) {
    // The strong tier named over `env` itself, never a copy of it: the server's keys are properties that do not list
    // (secrets.ts withSecrets), so a spread would leave every one out. runModels and pi-ai's auth read each by name.
    const tiered = Object.create(env, { AGENT_MODEL_STRONG: { value: named, enumerable: true } }) as NodeJS.ProcessEnv;
    const picked = await runModels(tiered, undefined, ["strong"]);
    chosen = { models: picked.models, model: picked.byTier.get("strong")! };
  } else if (entry?.facts && entry.onWire(env)) {
    // A harness whose model is chosen on its wire's own settings (its entry's onWire): the grade goes where the run's
    // requests go (providerFor), with the run's credential and auth mode, on the model the run runs (its entry's model,
    // then the id providerFor sends).
    const choice = await entry.model(env, agent.model, true);
    if (!choice) throw new Error(`${entry.id} does not run here.`);
    if ("why" in choice) throw new Error(choice.why);
    const sent = providerFor(entry.facts.wire, env, choice.model as ModelRef, entry.id);
    if (entry.facts.wire === "anthropic-messages") {
      // On pi-ai's anthropic provider at the run's endpoint. The catalog only prices the model.
      const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
      const catalog = builtinModels({ authContext: graderAuth(sent) }) as unknown as PiModels;
      const at = (found: unknown) => (found && typeof found === "object" ? { ...found, baseUrl: sent.origin } : found);
      chosen = { models: { getModel: (provider: string, id: string) => at(catalog.getModel(provider, id)), completeSimple: (...call: unknown[]) => catalog.completeSimple(...call) }, model: { provider: "anthropic", modelId: sent.modelId } };
    } else {
      // The Responses API through OpenRouter alone (onWire's other case): OpenRouter with its key, through pi-ai's
      // openrouter provider. The revision's own name (openai/<model>) would ask for an OpenAI key, which this route never
      // needs.
      chosen = await runModels(env, `openrouter/${sent.modelId}`);
    }
  } else chosen = await runModels(env, agent.model);
  const models = chosen.models as unknown as PiModels;
  const { model } = chosen;
  const add = counter(cost);
  return async (args, signal) => {
    // The call's tokens from pi-ai's own usage, which keeps the cache's reads and writes apart.
    let usage: PiUsage | undefined;
    const tapped: PiModels = {
      getModel: (provider, id) => models.getModel(provider, id),
      completeSimple: async (...call) => {
        const message = await models.completeSimple(...call);
        usage = message.usage;
        return message;
      },
    };
    const answer = await completer(tapped as never, () => model, thinkingOf(env, agent.thinking))(args, signal).catch((error: Error) => (add(null, null), Promise.reject(error)));
    add(answer.cost_usd, tokensOf(usage));
    return answer;
  };
}

/** The grader, on `gradeModel` when the server names one (gradeModelOf), given `asked`, what the user said in the run:
 *  its verdict, or why it gave none; with what it spent. An answer the host cannot read is asked once more, with the same
 *  prompt and under the same bound, each ask counted once in `cost`; two such answers are a drop that could not be read,
 *  with the last answer as it came (`unread`, for the caller to cut of secrets and keep). Rejects only when `signal` (the
 *  server closing) aborts it: nothing is decided then. */
export async function judgeProposal(input: { runId: string; agent: Agent; main: GradeMain; proposed: NoteText[]; files?: NoteText[]; asked?: readonly string[]; triggered?: readonly { source: string; text: string }[]; gradeModel?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; gradeTimeoutMs?: number }): Promise<Judged> {
  const { runId, agent, main, proposed, env, signal } = input;
  const files = input.files ?? [];
  const cost: GradeCost = { usd: 0, tokens: { ...NO_TOKENS } };
  try {
    const { gradePrompt, parseVerdict, UNREADABLE_REASON } = await import("./learn/index.js");
    const prompt = gradePrompt({ run: runId, instructions: agent.instructions, active: main.active, superseded: main.superseded, proposed, ...(files.length ? { files } : {}), ...(input.asked ? { asked: input.asked } : {}), ...(input.triggered ? { triggered: input.triggered } : {}) });
    const grader = await graderModel(env, agent, cost, input.gradeModel);
    const ask = () => bounded(input.gradeTimeoutMs ?? GRADE_TIMEOUT_MS, signal, cost, (grade) => grader({ prompt, maxTokens: GRADE_MAX_TOKENS }, grade));
    // The items with their texts: a note the run marked risky waits whatever the grader says (parseVerdict).
    const items = gradedItems(proposed, files);
    const first = parseVerdict((await ask()).text, items);
    if (first.reason !== UNREADABLE_REASON || first.items.length) return { verdict: first, cost };
    const again = (await ask()).text;
    const verdict = parseVerdict(again, items);
    return verdict.reason === UNREADABLE_REASON && !verdict.items.length ? { verdict, unread: typeof again === "string" ? again : "", cost } : { verdict, cost };
  } catch (error) {
    signal.throwIfAborted();
    return { reason: "grade_failed", error: error as Error, cost };
  }
}
