import type { Capabilities } from "@/lib/client";
/** The bar every page but the first screen shows while capabilities' `models.ready` is false (the first screen has the key
 *  card, ModelKeyCard): no agent that names no model runs here yet, and what would fix it. `needs` `model`: the server's
 *  AGENT_MODEL names a model it does not run, which no key fixes. `settings`: the server keeps keys (its key routes, and a
 *  seal key: `at_rest` "sealed"), so one can be added in Settings, which the bar leads with: a saved key reaches the next
 *  run with no restart. `model`: the server's default model (`models.default`); when one is named, only its provider's key
 *  runs it, so the bar names it and makes no OpenRouter promise, and no Settings one: Settings holds only some providers'
 *  keys. `source` `gateway` (`models.source`: the server sends its
 *  models to AGENT_MODEL_BASE_URL): the bar says what the server's own message does, name the gateway's model in
 *  AGENT_MODEL, or add a model key in Settings (its default goes to the gateway), with no OpenRouter promise. */
export function NoModelBanner({ needs, settings, model, source }: { needs?: "key" | "model" | null; settings: boolean; model?: string | null; source?: NonNullable<Capabilities["models"]>["source"] }) {
  return (
    <p role="status" aria-label="No model" className="border-b bg-card px-5 py-3 text-body text-warning-text md:px-8">
      {needs === "model" ? (
        "This server's default model doesn't run here: set AGENT_MODEL to a model it knows, and restart."
      ) : (
        <>
          No model yet.{" "}
          {source === "gateway" ? (
            <>
              This server sends its models to a gateway: name the gateway's model in AGENT_MODEL where AgentRun starts, and restart
              {settings ? <>, or <a href="#/settings/keys" className="underline underline-offset-2">add a model key in Settings → Model keys</a></> : null}.
            </>
          ) : model ? (
            `This server's default model is ${model}: set its provider's key where AgentRun starts, and restart.`
          ) : settings ? (
            <>
              <a href="#/settings/keys" className="underline underline-offset-2">Add a key in Settings → Model keys</a> (one OpenRouter key
              gives every harness its model), and it takes effect at once. Or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or
              OPENAI_API_KEY where AgentRun starts, and restart.
            </>
          ) : (
            "Set OPENROUTER_API_KEY (one key gives every harness its model), or ANTHROPIC_API_KEY or OPENAI_API_KEY, and restart."
          )}
        </>
      )}
    </p>
  );
}
