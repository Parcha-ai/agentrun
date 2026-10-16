# Set up the issue-triage demo

Paste this into your coding agent. It sets the demo up on your machine and runs it on scripted fakes first, which needs no key and spends nothing.

You are setting up the AgentRun issue-triage demo from a clone of the repository. Work from the repository root.

1. Check `node --version`: Node 22.19 or later is required. If it is older, tell me and stop; do not install a Node version for me.
2. Run `npm ci --ignore-scripts && npm run build`.
3. Run `npm run demo:issue-triage`. It triages twenty fictional issues on scripted fakes: no key, no network, $0. It prints each issue's type, whether it is a good first issue, whether it is actionable, and the agreement with the maintainers' type labels ("Jev agreed with the maintainers' type label on 17 of 20"). Show me that output.
4. Run `npm run demo:issue-triage -- --kill`. It kills the process inside a typed question and resumes the run in a fresh one. Show me that the resumed run repeated no paid call.

Stop here unless I ask for a live run. A live run spends real money (about $1.50 for one take) and needs Jev's key. Do not ask me to paste a key into this chat. Tell me to set `TYPESAFE_API_KEY` in my own shell (my key is at https://console.typesafe.ai/keys), or `OPENROUTER_API_KEY` to reach Jev through OpenRouter (https://openrouter.ai/keys), and then run `npm run demo:issue-triage -- --live`. Also tell me to set `GITHUB_TOKEN` in my own shell if I have one (a token with no scopes reads public repositories; without it GitHub allows 60 requests an hour, which twenty issues overrun). The demo only reads: it never writes to GitHub. If neither Jev key is set, the run stops before anything starts and says which is missing.
