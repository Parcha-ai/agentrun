---
packages: @parcha/pi-agent-learn
kind: feature
---
New held package `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of
`@parcha/pi-git-remote`. `agentLearn()` is a pi-durable extension with one tool, `learn({ type, text, evidence?, id? })`,
which stores one candidate per call id in the run's store, is replay safe and makes no model call, and the `<learned>`
prompt section: the rules win, the active learnings at the commit the run was seeded from (most used first, at most
4,096 bytes, with the count of those that did not fit), the workflows to try, and when to call `learn`. `seedLearning()`
is the host step at run start: it resolves a ref, records `learn.seed` (the sha and the derived index) in the run's store
once, and copies the active learnings into the run's working directory. One learning is one file
(`learnings/<id>.md`, frontmatter then the rule; `renderLearning`, `parseLearning`, `learningId`), and `agent.json` and
`AGENTS.md` are locked against every writer (`RULES_LOCKED`, `isRulesLocked`). `Guard`, `Candidate` and `WorkflowHint`
fix the contract for the guard, proposing and workflow trials that come next. Its pi-durable and chord peers accept 1.1
to 1.3.x.
