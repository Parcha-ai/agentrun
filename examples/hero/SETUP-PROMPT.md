# Set up the hero demo for a live run

Paste this into your coding agent. It sets up the keys for `npm run demo:hero -- --live`. A run on fakes (`npm run demo:hero`) needs none of this.

You are in a checkout of the agentrun repository. Do these steps in order and stop to ask me at any step that needs a decision or a secret.

1. Run `node --version`. It must be 22.19 or newer. If it is not, tell me and stop.
2. Run `npm ci --ignore-scripts && npm run build`.
3. This demo needs one browser service, Browserbase. Ask me for two values: my Browserbase API key and my Browserbase project id. Tell me to create them at my Browserbase account if I have none. The names are `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`. Both are needed together; one alone is not used.
4. Export both in my shell for this session only. Never write them into a file in the repository, a commit or a log, and never print them.
5. The models come from the shared sign-in or a provider key of mine; this demo names none. Ask me which I use.
6. Run `npm run demo:hero -- --live --max-usd 15`. The run stops at the cap. It refuses to start if a name above is missing, and says which. Until the demo supplies its live parts it says so and runs nothing; tell me, and stop.
7. Nothing here needs sudo or a system change. If a step seems to, stop and ask me; never run one yourself.

When it finishes, show me the path of `snapshot.html` and the recording directory if I passed `--record`.
