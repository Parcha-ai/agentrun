---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-acp, @parcha/agentrun, @parcha/agentrun-kernel
kind: feature
---
A harness recipe now covers an outside agent's release as its vendor ships it (Google's agy CLI among them), and the owner's own sign-in, made by the agent itself:
- `.zip` releases install, unpacked in Node with no `unzip` on the host. An entry that leaves the folder (`..`, an absolute path, a backslash), a symbolic link, a device, an encrypted entry or a duplicate refuses the whole archive before anything lands.
- An archive is pinned by one digest, its `sha256` or, where the vendor's manifest lists that, its `sha512` (Google's agy CLI manifests). `release.registry` is optional, for a release that is the vendor's own rather than the ACP registry's.
- Every file the archive unpacks to is pinned, not the binary alone: the tree's sha256 is recorded at the first install (or given as the release's `treeSha256`), and a check or a sign-in refuses a sidecar that changed since.
- A release may give its own `args` per platform, over the recipe's.
- `model.id` picks a plan-billed agent's model among those its `session/new` lists (`session/set_model`); one it does not list is refused before a prompt.
- A key may be handed under the name the agent reads: `keys: [{ "name": "ANTIGRAVITY_GEMINI_API_KEY", "env": "GEMINI_API_KEY" }]`. It is read by its saved name, so the server's own `GEMINI_API_KEY` never reaches the agent. `keyMethod` is the method the agent's ACP `authenticate` signs in with on it (`gemini-api-key`).
- One list in the kernel, `launchEnv` (`LAUNCH_ENV`, `LAUNCH_ENV_PREFIXES`), names the variables that change what a process loads or runs before its own code: `PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHON*`, `BASH_*`, `ENV`, `GIT_*` and a few shells' and interpreters' start-up variables. A key is never handed under one of them, nor a recipe's `env` or `model.env` named one. The recipe loader and the ACP adapter both refuse them.
- A key's saved and handed names follow the kernel's `KEY_NAME` (capitals, digits and `_`, at most 64) in the recipe loader as in the ACP adapter, so `harness-check` no longer refuses a lowercase key name the loader took. Other variable names keep `ENV_NAME`.
- `signIn: { "args": [...], "homeArg": FLAG }` names the agent's own sign-in, as T3 Code runs agy: `agentrun harness sign-in --recipe FILE` starts the installed, unmodified agent on your terminal with its arguments, `args` (`--login`) and `homeArg` naming its own folder (`--gemini-dir DIR`). The agent prints the address, reads the code you paste and keeps its sign-in in that folder; exit 0 is signed in (`HARNESS_SIGN_IN_FAILED` otherwise).
- harness-check runs on the recipe's keys alone, never the sign-in, so a plan-billed recipe names a key beside any `signIn`. A run on the sign-in hands the agent `homeArg` and its folder, no key, nothing it prints kept.
- AgentRun never reads, refreshes or sends the sign-in's token, and has no usage reader: it never opens the folder, and a test keeps every credential file and Google account or quota endpoint out of the harness sources.
- The ACP adapter's `stderr: "none"` (`AcpRecipe`) keeps nothing an agent prints, for a run on a sign-in: a failure says its exit status and AgentRun's own code, and an error the agent answers says its JSON-RPC code alone.
