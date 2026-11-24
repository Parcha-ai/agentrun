---
packages: @parcha/agentrun-serve
kind: fix
---
A plan-billed harness recipe runs on its owner's own sign-in (`--harness-sign-in`) only for a run its owner started, under their signed-in session or the API token.
- A run with no record of who started it (a scheduled or triggered run, a learned workflow's audit shadow or replay, a start from the console of a server without an owner's account, an imported run or one from before this release) is refused at its claim, never put on the sign-in.
- The `--harness-sign-in` start is also refused on a server with no owner's account (`AGENTRUN_ACCOUNTS=0`), where whoever opens its console link would start runs.
- A run on the sign-in carries the vendor's terms warning: `sign_in_warning` on the run's read, shown on its console page.
- The check, the sign-in and a server find and check a recipe's installed pins in one place; the `.checked` note keeps only what a server compares.
