---
packages: @parcha/agentrun-serve
kind: feature
---
The first visit needs nothing looked up: `--open` (on by default in `npx @parcha/agentrun`) opens the setup page while the server has no owner, with the setup code already filled in when setup takes one, and Settings → Webhook copies its signing secret with one press. Before, the browser opened the console's front page and the person had to find the code in the server's log, and the webhook secret shown once had to be selected by hand.
- The opener gets the same link the log prints (`Set up this server: <address>/setup#code=<code>`), or `<address>/setup` on loopback, where setup takes no code. The code works once and lasts 30 minutes, so the opener's arguments and the browser's history hold nothing that outlasts the setup; the API token still never goes to the opener. Once the owner is set, `--open` opens the console's address as before.
- The setup skill (`docs/SKILL.md`) has the assistant open that link in the person's browser itself, with `open`, `xdg-open` or `start` on their computer or with its client's browser tool, instead of handing over a link to click or a command that prints the code. It sends the link only when it can open no browser. The quickstart command no longer passes `--no-open`.
- **Copy secret** beside the secret in Settings → Webhook says Copied, or, where the browser won't copy, to select the text. The console's copy button is now the `CopyButton` primitive, shared with the webhook trigger's Copy URL and Copy secret.
