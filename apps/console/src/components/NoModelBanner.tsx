/** The bar every page but the first screen shows while capabilities' `models.ready` is false (the first screen has the key
 *  card, ModelKeyCard): no agent that names no model runs here yet, and what would fix it. `needs` `model`: the server's
 *  AGENT_MODEL names a model it does not run, which no key fixes. `settings`: the server keeps keys (its key routes), so
 *  one can be added in Settings. */
export function NoModelBanner({ needs, settings }: { needs?: "key" | "model" | null; settings: boolean }) {
  return (
    <p role="status" aria-label="No model" className="border-b bg-card px-5 py-3 text-[13px] text-warning-text md:px-8">
      {needs === "model" ? (
        "This server's default model doesn't run here: set AGENT_MODEL to a model it knows, and restart."
      ) : (
        <>
          No model yet. Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY or OPENAI_API_KEY) and restart
          {settings ? <>, or <a href="#/settings/keys" className="underline underline-offset-2">add a key in Settings → Model keys</a></> : null}.
        </>
      )}
    </p>
  );
}
