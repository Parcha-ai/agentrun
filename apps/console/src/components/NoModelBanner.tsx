import type { Capabilities } from "@/lib/client";

/** The bar every page but the first screen shows while capabilities' `models.ready` is false (the first screen has the key
 *  card, ModelKeyCard), unless Claude Code's login on this machine is on and signed in, which is a model (App): no agent that names no model runs here yet, and what would fix it. `needs` `model`: the server's
 *  AGENT_MODEL names a model it does not run, which no key fixes. `settings`: the server keeps keys (its key routes), so
 *  one can be added in Settings, which the bar leads with: a saved key reaches the next
 *  run with no restart. `model`: the server's default model (`models.default`); when one is named, only its provider's key
 *  runs it, so the bar names it and makes no OpenRouter promise, and no Settings one: Settings holds only some providers'
 *  keys. `source` `gateway` (`models.source`: the server sends its
 *  models to AGENT_MODEL_BASE_URL): the bar says what the server's own message does, name the gateway's model in
 *  AGENT_MODEL, or add a model key in Settings (its default goes to the gateway), with no OpenRouter promise. `chatgpt`:
 *  the server offers Sign in with ChatGPT and is not signed in, so the bar offers it first (on the first screen, and in
 *  Settings → Model keys), then a key. `source` `chatgpt`: signed in, with no key; what the bar says is then `needs`'s
 *  alone. */
export function NoModelBanner({ needs, settings, model, source, chatgpt = false }: { needs?: "key" | "model" | null; settings: boolean; model?: string | null; source?: Capabilities["models"]["source"]; chatgpt?: boolean }) {
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
          ) : chatgpt && settings ? (
            <>
              <a href="#/settings/keys" className="underline underline-offset-2">Continue with ChatGPT</a> in Settings → Model keys: Codex and pi
              agents run on your ChatGPT plan. Add a key there for the rest (one OpenRouter key gives every harness its model), and it takes
              effect at once.
            </>
          ) : settings ? (
            <>
              <a href="#/settings/keys" className="underline underline-offset-2">Add a key in Settings → Model keys</a> (one OpenRouter key
              gives every harness its model), and it takes effect at once. Or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY,
              OPENAI_API_KEY or PARTICLE_API_KEY where AgentRun starts, and restart.
            </>
          ) : (
            "Set OPENROUTER_API_KEY (one key gives every harness its model), ANTHROPIC_API_KEY, OPENAI_API_KEY or PARTICLE_API_KEY, and restart."
          )}
        </>
      )}
    </p>
  );
}
