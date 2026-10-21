---
packages: repo
kind: fix
---
**`examples/issue-triage`: the host counts the agreement whatever shape the agent's workflow returns**
- The session counted the type agreement only when the workflow's result was an object with `rows`; a workflow that returned the list itself got no agreement and a result blob with numbered keys. The rows are now the result itself when it is a list, else its `rows`, and the recording's result holds `{ rows, agreement }` either way.
- The summary line reads the spend before the recording is finished (the spool is removed then), so `spentUsd` is the run's spend and not 0.
