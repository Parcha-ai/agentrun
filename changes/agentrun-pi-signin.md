---
packages: @parcha/agentrun-pi
kind: feature
---
New entry `@parcha/agentrun-pi/signin`: sign in, pick a model, check keys, for a demo or your own app before its first model call. `@earendil-works/pi-ai` is a new optional peer at `*`; only this entry loads it, and every other entry imports and runs without it.
- `checkKeys(spec, options)` reports what a run needs and what is missing (keys by env name and where to create them, programs on `PATH` with their platforms and minimum versions, packages with the exact `npm install --no-save` line), with exit code 2 and no request sent when a required item is missing. `checkSetupPrompt(spec, text)` checks a demo's setup prompt against its spec, and `scripts/check-setup-prompts.mjs` runs it in CI.
- `resolveModel(spec, options)`: an explicit provider and model with that provider's env key wins; else a stored ChatGPT sign-in with the model chosen from the account's `GET /v1/models` by capability; else `signIn`. The eyes model resolves the same way or is refused naming the gap.
- `signIn(options)` runs pi-ai's own Sign in with ChatGPT with this app's name and a persisted host id, and fails at once with a clear message when port 1455 is taken. It refuses a pi-ai that ignores the app name (before 1.1).
- The token lives in `$AGENTRUN_HOME/auth.json` (default `~/.config/agentrun/`, directory 0700, file 0600, written whole and renamed). Refreshes are serialized across processes by an operating-system lock (an exclusive SQLite transaction on `auth.json.lock`) that a killed process never leaves behind, so a rotating refresh token is never sent twice.
- The ChatGPT plan's usage limit maps to `UsageLimitError` and is never retried.
