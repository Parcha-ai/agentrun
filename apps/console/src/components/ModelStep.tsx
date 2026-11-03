import { KeyRound } from "lucide-react";

/** The first step when no harness here has a model to run: how to give the server one. Mission Control's start-here
 *  panel shows it in place of its templates; it is one component so a model-key card in the console can take its place. */
export function ModelStep() {
  const env = "font-mono text-[12px] text-foreground";
  return (
    <div className="border bg-background p-5">
      <p className="flex items-center gap-2 text-[16px] font-semibold"><KeyRound className="size-4 text-primary" aria-hidden />Add a model key</p>
      <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-muted-foreground">
        This server has no model to run an agent on yet. Start agentrun-serve with the model to run in its environment,
        <span className={env}>AGENT_MODEL</span>=provider/model-id, and that provider's key
        (<span className={env}>ANTHROPIC_API_KEY</span>, <span className={env}>OPENAI_API_KEY</span> or <span className={env}>OPENROUTER_API_KEY</span>).
        Or name a gateway: <span className={env}>AGENT_MODEL_BASE_URL</span> and <span className={env}>AGENT_MODEL_API_KEY</span>, with
        the gateway's model in <span className={env}>AGENT_MODEL</span>. Then reload this page, and the templates here run in one click.
      </p>
    </div>
  );
}
