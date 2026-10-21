// The tools a definition may name here: the harness's vocabulary (`agentTools`) on the host a run gets from this
// server's environment (`hostFromEnv`), and serve's own `ask_person`. The server reads it once, before it serves; each
// run's app builds the same host from the same environment, so what a run start checks is what the run offers.
import { join } from "node:path";
import { agentApp, agentTools, hostFromEnv, type AgentTool, type RunPlace } from "@parcha/agentrun-harness";
import { ASK_TOOL } from "./app.js";

/** `features.browser` in capabilities. */
export type BrowserKind = "chrome" | "browserbase" | "none";

export type ToolOffer = {
  /** Every name the harness knows on this host, with what it needs and, when this host cannot offer it, why. */
  vocabulary: AgentTool[];
  /** The names a definition may give here: the harness's tools this host offers, then `ask_person`. */
  bound: string[];
  /** The browser the host drives: none unless the vocabulary offers the browser's tools. */
  browser: BrowserKind;
  /** Why a definition's tools cannot run here, in the harness's words; undefined when every one is bound. */
  refusal(tools: readonly string[]): Promise<string | undefined>;
};

/**
 * The tool offer of a host built from `env`. Its place (`root`) is never made: this host is only asked what it offers,
 * and nothing it would write is written.
 */
export async function toolOffer(env: NodeJS.ProcessEnv, root: string): Promise<ToolOffer> {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const place: RunPlace = { id: "offer", root, work: join(root, "work"), store: join(root, "store") };
  // A local Chrome only: a Browserbase session is billed, and serve counts no browser charge against max_cost_usd yet.
  const host = await hostFromEnv(place, { models: createModels(), lead: { provider: "none", modelId: "none" }, env, browserbase: false });
  const vocabulary = await agentTools(place, host);
  const bound = [...vocabulary.filter((tool) => !tool.unmet).map((tool) => tool.name), ASK_TOOL];
  const browsing = vocabulary.some((tool) => tool.plane === "browser" && !tool.unmet);
  const browser: BrowserKind = browsing ? "chrome" : "none";
  return {
    vocabulary,
    bound,
    browser,
    async refusal(tools) {
      if (tools.every((name) => bound.includes(name))) return undefined;
      // agentApp refuses the first name it cannot offer; its message is the one a run's app would fail with.
      return agentApp(place, host, { instructions: "", tools: tools.filter((name) => name !== ASK_TOOL) }).then(
        () => undefined,
        (error: Error) => error.message,
      );
    },
  };
}
