---
packages: @parcha/agentrun-serve
kind: feature
---
A run's tools now come from `@parcha/agentrun-harness`: each run's app is `agentApp` on the host `hostFromEnv` builds from the server's environment, with the definition's instructions and skills, the model the server binds and exactly the tools the definition names. A definition may name any tool of the harness's vocabulary that the host offers (`read`, `write`, `edit`, `bash`, `code`, and the browser's tools when `CHROME_PATH` or both Browserbase keys are set) and `ask_person`, which stays serve's own. Before, only `read`, `write`, `edit` and `ask_person` were bound.
- A command the agent runs, through `bash` or `code`, runs in the run's `work/` with the user's rights and gets only `PATH`, `HOME`, `TMPDIR` and `LANG` from the server's environment. There is no command sandbox yet.
- The server reads what its host offers once, when it starts. A definition that names a tool it does not offer is still created, and a run of it is refused before it starts with `409 agent_not_runnable`, the harness's message (`the definition names the tool teleport, which this host does not offer (it offers ...)`, or `... and this host has no browser: set CHROME_PATH or both BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID`) and `details: {bound, unbound}`.
- Capabilities say which browser the host offers: `features.browser` is `chrome`, `browserbase` or `none`, from the same vocabulary the run check uses.
- `BOUND_TOOLS` is no longer exported; `toolOffer(env, root)` returns the vocabulary, the names a definition may give, and the browser.
- The quick start in the README is a walk with plain `fetch`: an agent with `bash` on a faux model writes a file, and the walk prints the run's status, its answer and the file. CI runs it from the packed tarballs as the `agentrun-serve` stranger test.
- The release order puts serve after the reference host, which it now depends on, and the preflight checks that serve uses the exact harness, pi-durable-agent and pi-durable-disk versions.
