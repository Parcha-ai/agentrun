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

On the switch line, GET /v2/runs/{id}/learning/diff answers from the store again (it answered 501): a merge from the agent's learning folder, the kept proposal's notes against its seed, or no file against the launch's seed. The runner's learning end now refuses every key saved on the server, as the server's own check did, besides the runner's secrets, the claim's keys and the handed sign-in pointers.

Upgrading: drop `reflectTimeoutMs` from a `startServe` call; the end-of-run turn's deadline is the runner's (`REFLECT_TIMEOUT_MS`).
