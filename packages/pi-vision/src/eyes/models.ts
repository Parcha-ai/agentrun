// Eyes on pi's `Models`: a look is one `completeSimple` request through the host's own catalog, credentials and request
// transforms, on the model `eyesModel` names. pi-durable 1.1 or later hands every tool and hook its `Models` as
// `api.models`; on 1.0 there is no such door (`modelsOf` finds none) and a host without its own eyes gets a typed miss.
// A look always thinks: `off` or no level is `low` on a model that reasons. The types are pi-ai's, declared
// structurally, so nothing here loads a pi package; `./durable` exports it.
import type { Eyes, EyesAnswer, Usage } from "../core/host.js";
import { resolveLimits, SEE_TIMEOUT_MS, type LimitsOverride } from "../core/limits.js";
import type { Part } from "../core/plan.js";

/** A catalog entry, as far as a look reads it. */
type CatalogModel = {
  readonly id: string;
  readonly input?: readonly string[];
  readonly reasoning?: boolean;
  readonly cost?: { readonly input: number; readonly output: number };
};

type Block = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** The answer of one request, as far as a look reads it. */
type Answer = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly model: string;
  readonly responseModel?: string;
  readonly usage: Usage;
  readonly stopReason: string;
  readonly errorMessage?: string;
};

/** The part of pi-ai's `Models` a look uses. */
export type ModelsDoor = {
  getModel(provider: string, id: string): CatalogModel | undefined;
  completeSimple(model: CatalogModel, context: { messages: { role: "user"; content: Block[]; timestamp: number }[] }, options?: { signal?: AbortSignal; reasoning?: string }): Promise<Answer>;
};

export type ModelsEyesOptions = {
  /** pi's thinking level for the look; `off` and absent are `low`. */
  readonly thinking?: string;
  /** Default `SEE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Over the model's own `inputLimits`. */
  readonly limits?: LimitsOverride;
  /** What the route takes beyond the catalog's `input`: a route that takes video, or a PDF. */
  readonly accepts?: Partial<Eyes["accepts"]>;
};

/** `api.models` when the pi-durable that built `api` has it (1.1 or later), else undefined. */
export function modelsOf(api: unknown): ModelsDoor | undefined {
  const models = (api as { models?: Partial<ModelsDoor> } | null)?.models;
  return typeof models?.getModel === "function" && typeof models.completeSimple === "function" ? (models as ModelsDoor) : undefined;
}

/** A user message's blocks: the context, each part after the line that names its fragment, then the question. */
function blocks(parts: readonly Part[], ask: string, context: string | undefined): Block[] {
  const named = parts.flatMap((part): Block[] => {
    const label: Block[] = part.fragment ? [{ type: "text", text: `[${part.fragment}]` }] : [];
    return [...label, part.type === "text" ? { type: "text", text: part.text } : { type: "image", data: part.data, mimeType: part.mimeType }];
  });
  return [...(context ? [{ type: "text" as const, text: context }] : []), ...named, { type: "text", text: ask }];
}

/** Eyes on `eyesModel` through `models`, or undefined when the catalog has no such model or it takes no images. */
export function modelsEyes(models: ModelsDoor, eyesModel: { readonly provider: string; readonly modelId: string }, options: ModelsEyesOptions = {}): Eyes | undefined {
  const model = models.getModel(eyesModel.provider, eyesModel.modelId);
  if (!model?.input?.includes("image")) return undefined;
  const name = `${eyesModel.provider}/${model.id}`;
  const level = options.thinking && options.thinking !== "off" ? options.thinking : "low";
  const priced = (model.cost?.input ?? 0) > 0 || (model.cost?.output ?? 0) > 0;
  return {
    model: name,
    accepts: { image: true, video: false, pdf: false, ...options.accepts },
    limits: resolveLimits(model, options.limits),
    async see(request, signal): Promise<EyesAnswer> {
      const cut = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? SEE_TIMEOUT_MS)]);
      const answer = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: blocks(request.parts, request.ask, request.context), timestamp: Date.now() }] },
        { signal: cut, ...(model.reasoning ? { reasoning: level } : {}) },
      );
      if (answer.stopReason === "error" || answer.stopReason === "aborted") {
        throw new Error(`${name} ${answer.stopReason === "aborted" ? "was cut" : "failed"}: ${(answer.errorMessage ?? "no reason given").split("\n")[0]}`);
      }
      const text = answer.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n").trim();
      return { text, model: name, usage: answer.usage, costUsd: priced ? answer.usage.cost.total : null };
    },
  };
}
