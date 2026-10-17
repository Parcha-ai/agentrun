import { defineExtension, type Extension, type PromptSection } from "@earendil-works/pi-durable";
import { renderSection } from "./section.js";
import { SeedDoc } from "./seed.js";
import { learnTool, type LearnToolOptions } from "./tool.js";

export type AgentLearnOptions = LearnToolOptions & {
  /** The extension's name in the registry; default `learn`. */
  readonly name?: string;
};

/**
 * The pi-durable extension: the `learn` tool and the `<learned>` section. The section renders from the run's
 * `learn.seed` record, so a run that `seedLearning` has not seeded has no section, and a seeded one shows the same text
 * on every request.
 */
export function agentLearn(options: AgentLearnOptions = {}): Extension {
  const tool = learnTool(options);
  const learned: PromptSection = {
    key: "learned",
    async render(input, context) {
      const seed = await input.read.snapshot(SeedDoc, context);
      if (!seed?.sha) return undefined;
      return renderSection(seed, { canLearn: input.agent.tools.some((t) => t.name === tool.name) });
    },
  };
  return defineExtension({ name: options.name ?? "learn", tools: [tool], sections: [learned] });
}
