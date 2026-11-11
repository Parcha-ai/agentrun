---
packages: @parcha/agentrun-serve
kind: breaking
---
The server's half of learning is deleted. A run's end-of-run turn, its check, the grade and the merge are the runner's (`runner/learning-end.ts`, `reflect-hook.ts`, `learning-loop.ts`).

Deleted:
- `learning-run.ts` loses the reflect and propose flow: `beforeFinish`, `onAdopt`, `onLaunch`, `beforeSettle`, `afterSettle`, `afterReopen`, recover's re-propose, `close`, `idle`, `heldLearning`, the turn's ask and wait, its check, its tool list and refusal list, and the kernel calls they needed. `LearningRuns` keeps the seed and the view: `onStart`, `copyThrew`, `onSaved`, `onLoad`, `onReopen`, recover's ledger pass, `current`, `view`, `short`, `shown`, `keysChanged`, `counts` and `ofAgent`.
- `grade.ts` is deleted (`judgeProposal`, `graderAuth`, the grader's model). The grade's prompt, caps and verdict reader stay in `learn/grade.ts`.
- `learning.ts` loses the host git (`git`, `readBlobs`, the git `readSeed`, `agentFolder` and its link checks), `keepTurn`, `readTurn`, `LEARNING_TURN`, `KEPT_LEARNING`, and the `git`, `afterMkdir` and `beforePropose` test hooks. Nothing in `serve/src` runs git now except the learning script, through the folder's Workspace.
- `runs.ts` loses its calls into that flow, the end-of-run turn's text and hearing it collected, and `toLiveDoor`. The `reflectTimeoutMs` option is gone from `ServeOptions` and `RunsOptions`.
- The stop words nothing says any more are gone (`crashedLooking`, `notAsked`, `notSetAside`).

The end-of-run turn's range in a run's record (`Reflect`, `reflects`, `labelled`, `reflecting`, `TurnOrigin`) moves to `reflect-range.ts`, for the runner's learning end, the store's reads, the store-backed view and the tool gate.

Also on the switch line: the grade model the server names (`--grade-model`, `AGENTRUN_SERVE_GRADE_MODEL`, else `AGENT_MODEL_STRONG`) travels on each run's launch (its learning start's `gradeModel`), and the runner grades on it as the strong tier, as main did; before, the runner graded every run on the default model. `GET /v2/usage`'s `learning` meter and `GET /v2/stats` read each run's grade from the store, not the learning ledger; a learning run stopped after its grade was paid keeps that cost (unknown when the grade request was cut). A run's view, its list row, its learning row and `GET /v2/runs/{id}/learning` read what it held for the owner's OK as it stands on the folder's main, a run's learning reads `seeded`, then `reflecting`, while it runs, and the notes a run read are matched before its view cuts their names. A learning run (a run's grade and merge) is no listed run: no run list, count, stat, usage line or `run.ended` notice names it. A claude-agent, codex or opencode run's end-of-run answer shows as its learning row's text, as pi's does. A grader's answer that could not be read is no longer kept with the run (main kept it, never served, in `serve.json`). `scripts/learn-eval.mjs` grades as the runner's learning run does (`gradePrompt`, `parseVerdict`).

Upgrading: drop `reflectTimeoutMs` from a `startServe` call; the end-of-run turn's deadline is the runner's (`REFLECT_TIMEOUT_MS`). Learning grades recorded before this upgrade read unknown in `/v2/usage`: their learning runs never wrote a cost, and nothing backfills them.
