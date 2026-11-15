---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
The console signs in with ChatGPT and says what runs without a key.
- The first screen offers "Continue with ChatGPT" beside "Add a key". The sign-in opens OpenAI's page in a new tab, finishes by itself on the same computer, and takes the pasted address of the sign-in tab from a server elsewhere. A wrong address, an expired sign-in or a taken port reads in the server's words.
- A waiting sign-in says until when it waits, also after a reload, and says it is finishing while the server reads the plan's models. A paste that lands after the sign-in finished on its own shows the sign-in, not a refusal.
- Signed in, the console says who is signed in and on which plan, with OpenAI's words on usage and a "Manage usage" link to ChatGPT's settings.
- Settings → Model keys has a ChatGPT plan row: its state, account, plan and models, and a sign-out that asks first. A sign-out OpenAI didn't confirm still signs out here, and says so in the server's words with a link to ChatGPT's settings.
- "What runs here" lists each harness, whether it runs on this server and what it needs, on the first screen and in Settings. The no-model bar offers the ChatGPT sign-in first. On a server with no key, Codex and pi read "runs after Continue with ChatGPT".
- Serve: on a server with no key that is not signed in, capabilities' codex and pi entries say "or sign in with ChatGPT (Settings → Model keys) to run it on your ChatGPT plan" (an expired sign-in: "sign in again"), and so does a run of an agent that names no model. Each harness entry gains `needs` (`key`, `chatgpt`) where it runs nothing for want of a key; pi, which runs here with no default model, says why in its `reason`. Claude Agent and OpenCode still say they need a key. Breaking: the capabilities' harness mark is `harness/4`.
- A run on the plan says its tokens and "Using ChatGPT plan", never $0.00 or unknown; a run that also spent dollars says them, then "+ ChatGPT plan". Plan models read "<model> · on your ChatGPT plan" in the Model picker, on an agent's page (its own model, or its harness's default when that is the plan's) and on what a workflow run's node ran on, and an agent's spend cap says it counts dollars only.
- Serve: a run's `cost` gains `plan` (`requests`, `tokens`) for its requests on the plan, which leave `unpriced`, so a run on the plan alone has a known cost. `GET /settings/chatgpt` answers a waiting sign-in's `expires_at`.
