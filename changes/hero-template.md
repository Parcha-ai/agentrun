---
packages: repo
kind: feature
---
The hero demo moves onto the showcase template: `demo.json` (title, targets, claim, models, keys, kills, panels, tools, expected cost), `job.ts` as data (a workflow and its default input, which now names the operators to read), `fakes.ts`, a short `run.ts` on the reference entry, `SETUP-PROMPT.md` and a README in the template's shape. `npm run demo:hero` takes the standard flags; `--kill` replaces `--kill1`, and `--input` takes a subset of operators. The reference entry gains `Fakes.backend` (a demo shapes what its fake browser serves) and exports `keepBlob`.
