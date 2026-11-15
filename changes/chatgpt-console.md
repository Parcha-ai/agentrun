---
packages: @parcha/agentrun-ui, @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
The console signs in with ChatGPT and says what runs without a key.
- The first screen offers "Continue with ChatGPT" beside "Add a key". The sign-in opens OpenAI's page in a new tab, finishes by itself on the same computer, and takes the pasted address of the sign-in tab from a server elsewhere. A wrong address, an expired sign-in or a taken port reads in the server's words.
- Signed in, the console says who is signed in and on which plan, with OpenAI's words on usage and a "Manage usage" link to ChatGPT's settings.
- Settings → Model keys has a ChatGPT plan row: its state, account, plan and models, and a sign-out that asks first.
- "What runs here" lists each harness, whether it runs on this server and what it needs, on the first screen and in Settings. The no-model bar offers the ChatGPT sign-in first.
- A run on the plan says its tokens and "Using ChatGPT plan", never $0.00 or unknown; a run that also spent dollars says them, then "+ ChatGPT plan". Plan models read "<model> · ChatGPT plan" in the Model picker, and an agent's spend cap says it counts dollars only.
- Serve: a run's `cost` gains `plan` (`requests`, `tokens`) for its requests on the plan, which leave `unpriced`, so a run on the plan alone has a known cost.
