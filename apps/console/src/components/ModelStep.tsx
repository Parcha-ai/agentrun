import { KeyRound } from "lucide-react";

/** The first step when no harness here has a model to run: how to give the server one. Mission Control's start-here
 *  panel shows it in place of its templates. `keyCard`: the model-key card (ModelKeyCard) above it can save a key (the
 *  server keeps keys sealed), with no restart, so the step points there; otherwise it says what to set where the server
 *  starts. */
export function ModelStep({ keyCard = false }: { keyCard?: boolean }) {
  const env = "font-mono text-small text-foreground";
  return (
    <div className="border bg-background p-5">
      <p className="flex items-center gap-2 text-base font-semibold"><KeyRound className="size-4 text-primary-text" aria-hidden />Add a model key</p>
      <p className="mt-2 max-w-prose text-lead leading-relaxed text-muted-foreground">
        {keyCard ? "Add a model key in the card above, and the templates here run in one click." : <>
        This server has no model to run an agent on yet. Start agentrun-serve with the model to run in its
        environment, <span className={env}>AGENT_MODEL</span>=provider/model-id, and that provider's key
        (<span className={env}>ANTHROPIC_API_KEY</span>, <span className={env}>OPENAI_API_KEY</span> or <span className={env}>OPENROUTER_API_KEY</span>).
        Or name a gateway: <span className={env}>AGENT_MODEL_BASE_URL</span> and <span className={env}>AGENT_MODEL_API_KEY</span>, with
        the gateway's model in <span className={env}>AGENT_MODEL</span>. Then reload this page, and the templates here run in one click.
        </>}
      </p>
    </div>
  );
}
