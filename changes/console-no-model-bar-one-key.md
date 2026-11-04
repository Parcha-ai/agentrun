---
packages: repo
kind: fix
---
The console's no-model bar leads with saving a key in Settings where the server keeps keys: "Add a key in Settings → Model keys (one OpenRouter key gives every harness its model), and it takes effect at once. Or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY where AgentRun starts, and restart." Where the server keeps no keys it reads "Set OPENROUTER_API_KEY (one key gives every harness its model), or ANTHROPIC_API_KEY or OPENAI_API_KEY, and restart." The bar for an `AGENT_MODEL` the server does not run is unchanged.
