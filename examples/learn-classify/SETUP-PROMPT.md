# Set up learn-classify for a live pass

Paste this into your coding agent. It sets up a live pass of `examples/learn-classify/runner.mjs`. A scripted pass
(`--scripted`) needs none of this and costs nothing.

You are in a checkout of the agentrun repository. Do these steps in order and stop to ask me at any step that needs a
decision or a secret.

1. Run `node --version`. It must be 22.19 or newer, and `git --version` 2.40 or newer. If either is older, tell me and stop.
2. Run `npm ci --ignore-scripts && npm run build`.
3. Ask me for the model gateway: its address goes in `LEARN_CLASSIFY_GATEWAY` (the root, or its OpenAI base URL ending in
   `/v1`), and its key, if it wants one, in `LEARN_CLASSIFY_GATEWAY_KEY`. The gateway serves the agent's model, the vision
   model and Jev.
4. The v2 job browses and searches on Browserbase. Ask me for two values: my Browserbase API key and my Browserbase
   project id, named `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`. Both are needed together. Without them the browser
   is a local headless Chrome (`CHROME_PATH`) and web search is off.
5. Export them in my shell for this session only. Never write them into a file in the repository, a commit or a log, and
   never print them. A recording replaces each of them wherever it finds one.
6. Run the pass in a container that has no access to my files or my network, with only its output directory writable.
   The agent has no command tool, and the pass checks that before its first job.
7. Run `node examples/learn-classify/runner.mjs --set v2 --live --out <a new directory> --jobs 10 --cap-usd 10 --run-cap-usd 1.5`.
   The pass stops at the cap, and before its first job if its browser does not refuse a redirect to sec.gov.
8. Nothing here needs sudo or a system change. If a step seems to, stop and ask me; never run one yourself.

When it finishes, show me `<out>/runs.jsonl`, `<out>/curve.html` and `<out>/selftest.json`.
