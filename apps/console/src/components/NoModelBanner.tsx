/** The bar every page but the first screen shows while capabilities' `models.ready` is false (the first screen has the key
 *  card, ModelKeyCard): no agent that names no model runs here yet, and what would fix it. `needs` `model`: the server's
 *  AGENT_MODEL names a model it does not run, which no key fixes. `settings`: the server keeps keys (its key routes), so
 *  one can be added in Settings, which the bar leads with: a saved key reaches the next run with no restart. */
export function NoModelBanner({ needs, settings }: { needs?: "key" | "model" | null; settings: boolean }) {
  return (
    <p role="status" aria-label="No model" className="border-b bg-card px-5 py-3 text-[13px] text-warning-text md:px-8">
      {needs === "model" ? (
        "This server's default model doesn't run here: set AGENT_MODEL to a model it knows, and restart."
      ) : (
        <>
          No model yet.{" "}
          {settings ? (
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
