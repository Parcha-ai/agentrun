# Setup prompt for a coding agent

Paste the text between the lines into a coding agent (Claude Code, Codex, Cursor, or any agent that can run shell commands in a terminal) on the machine you will run the audit on. It sets the demo up and runs it on localhost. Nothing is deployed; the page you may have seen is a static replay of a recorded run.

---

Set up and run the AgentRun dependency audit on this machine. Do it step by step, and stop and ask me when a step needs something only I can give you.

1. Check what is installed: Node 22.19 or later (`node -v`), npm, git, and Docker (`docker version`). Docker is optional: without it the audit skips each dependency's install-in-a-box step and says so. If Node is older, tell me and stop.

2. Get the code: clone `https://github.com/Parcha-ai/agentrun`, then in the clone run `npm ci --ignore-scripts` and `npm run build`.

3. Ask me for these, one at a time, and never print them back, write them to a file, or put them on a command line. I will set them as environment variables in this terminal myself; you only check that each one is set (for example `test -n "$NAME"`):
   - A model key for ONE provider, and which provider it is: `OPENAI_API_KEY` (platform.openai.com, API keys), `ANTHROPIC_API_KEY` (console.anthropic.com, API keys) or `GEMINI_API_KEY` (aistudio.google.com, Get API key). A "Sign in with ChatGPT" option is planned; until it exists the audit takes one of these.
   - Optional, a cloud browser: `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` (browserbase.com, Settings, API Keys; the project id is on the same page). Without them the audit drives a Chrome on this machine, so Chrome must be installed (set `CHROME_PATH` if it is not found).
   - Optional: `GITHUB_TOKEN`, a personal access token with no scopes at all (github.com/settings/tokens). It only raises GitHub's limit for unauthenticated reads from 60 to 5,000 requests an hour.

4. Pick what to audit and tell me what you picked. Either a `package.json` on this machine (`--package ./package.json`, its `package-lock.json` beside it is used when there is one) or a public repository at a commit (`--package owner/repo@<commit>`). Start small: add `--limit 3`.

5. Run it from the clone's root. The provider is the one whose key I set; `<model>` is a model that provider offers (for OpenAI, `gpt-6-luna` is a small one):

   ```
   npm run demo:audit -- --live --package <what I picked> --model <provider>/<model> --limit 3 --max-usd 0.50 --record ./audit-recording
   ```

   Add `--browser browserbase` only if I set the two Browserbase variables. `--max-usd` stops the run if the model has billed past that amount; `--record` keeps the run as a recording you can replay.

6. When it ends, tell me: the status, what it cost (the recording's `manifest.json`, `cost`), and show me the report (`<dir>/out/record.json`, its `report_markdown`; the run's directory is printed). If the run printed that the recording holds something it should not, do not share the recording and tell me what the message says.

Each fact in the report cites a receipt the run filed. The audit describes pinned versions at one commit; it never judges a package or its maintainers. A cost is real money on my account: ask me before you raise `--limit` or `--max-usd`.

---

Notes for the person pasting this:

- Your keys stay in your terminal's environment. The audit forwards only the model and browser variables above (and `GITHUB_TOKEN`) to the process that runs the job.
- A run reads public registries and GitHub pages. It installs nothing on your machine: with Docker, each dependency is installed in a throwaway container whose network connections are traced, and install scripts never run outside it.
- The recording's manifest says `providers: real` for a live run and records what it cost; a recorded `scripted` run costs nothing and uses no key.
