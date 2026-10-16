# Set up the issue-triage demo

Paste this into your coding agent. It sets the demo up on your machine and runs it on scripted fakes first, which needs no key and spends nothing.

You are setting up the AgentRun issue-triage demo from a clone of the repository. Work from the repository root.

1. Check `node --version`: Node 22.19 or later is required. If it is older, tell me and stop; do not install a Node version for me.
2. Run `npm ci --ignore-scripts && npm run build`.
3. Run `npm run demo:issue-triage`. It triages twenty fictional issues on scripted fakes: no key, no network, $0. It prints each issue's label, whether it is a good first issue, and the agreement with the maintainers' labels ("Jev agreed with the maintainers on 17 of 20"). Show me that output.
4. Run `npm run demo:issue-triage -- --kill`. It kills the process inside a typed question and resumes the run in a fresh one. Show me that the resumed run repeated no paid call.

Stop here unless I ask for a live run. A live run spends real money (about $1.50 for one take) and needs Jev's key. Do not ask me to paste a key into this chat. Tell me to set `TYPESAFE_API_KEY` in my own shell (my key is at https://console.typesafe.ai/keys), or `OPENROUTER_API_KEY` to reach Jev through OpenRouter (https://openrouter.ai/keys), and then run `npm run demo:issue-triage -- --live`. If neither is set, the run stops before anything starts and says which is missing.
