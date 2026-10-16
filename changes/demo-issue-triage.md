---
packages: repo
kind: feature
---
**`examples/issue-triage`: a demo that triages a repository's issues with Jev**
- `npm run demo:issue-triage` runs, on scripted fakes ($0, no key, no network), a map over twenty fictional issues: a research agent with read-only tools, a Jev choice among five labels (bug, feature, docs, question, needs-info), a Jev good-first-issue judgment against a stated rubric, and the agreement with the maintainers' labels. It runs through the reference entry (`--record`, `--kill`), so the viewer's map panel replays it.
- `workflow.json` is the reference workflow (it validates and dry-runs clean); `AUTHOR-PROMPT.md` is what a user says to the drafting agent; `SETUP-PROMPT.md` and `demo.json` are the setup prompt and its spec, held to each other by `scripts/check-setup-prompts.mjs`.
