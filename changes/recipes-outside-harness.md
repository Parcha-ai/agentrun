---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-acp, @parcha/agentrun
kind: feature
---
A harness recipe now covers an outside agent's release as its registry ships it (Google Antigravity's among them), and its sign-in as its vendor's terms allow it:
- `.zip` releases install, unpacked in Node with no `unzip` on the host. An entry that leaves the folder (`..`, an absolute path, a backslash), a symbolic link, a device, an encrypted entry or a duplicate refuses the whole archive before anything lands.
- Every file the archive unpacks to is pinned, not the binary alone: the tree's sha256 is recorded at the first install (or given as the release's `treeSha256`), and a check or a sign-in refuses a sidecar that changed since.
- A release may give its own `args` per platform (Antigravity's linux `--uid=`), over the recipe's.
- `model.id` picks a plan-billed agent's model among those its `session/new` lists (`session/set_model`); one it does not list is refused before a prompt.
- A key may be handed under the name the agent reads: `keys: [{ "name": "ANTIGRAVITY_GEMINI_API_KEY", "env": "GEMINI_API_KEY" }]`. It is read by its saved name, so the server's own `GEMINI_API_KEY` never reaches the agent. `keyMethod` is the method the agent's ACP `authenticate` signs in with on it (`gemini-api-key`).
- `signIn: { "method", "homeEnv", "runs": "attended" }` names a person's own sign-in (Antigravity's `oauth-personal`). `agentrun harness sign-in --recipe FILE` starts the installed, unmodified agent in your terminal with `homeEnv` pointing at its own folder: the agent prints the address to open, your browser comes back to the agent's own loopback server (on a remote server, `ssh -L` the port in its redirect_uri first), and the agent keeps its sign-in in that folder. AgentRun reads none of what it prints and opens nothing it writes.
- harness-check, and every run its one owner is not at, runs on the recipe's keys alone: a recipe with a sign-in and no key is refused with `HARNESS_SIGN_IN_ATTENDED`, naming the key route.
- The ACP adapter's `stderr: "none"` (`AcpRecipe`) keeps nothing an agent prints, for a run on a person's sign-in: a failure says its exit status and AgentRun's own code, and an error the agent answers says its JSON-RPC code alone. `signInAgent` hands the agent the person's terminal as its stderr and reads none of it.
