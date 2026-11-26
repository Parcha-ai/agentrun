---
packages: @parcha/agentrun-serve
kind: feature
---
An agent on claude-agent, codex or another CLI harness now gets the browser, the same way it gets web_fetch. Before, granting `browser` to such an agent came back with "browser runs on pi here; on <harness> it is not bound yet", and a run of an agent whose computer is a browser was refused at its claim with "This agent's computer is a browser, which only the pi harness drives here". Now neither is refused. The harness is handed the browser's tools (`snapshot`, `run`, `screenshot` and the rest) as host tools. They drive the same session pi's would: the agent's browser computer, or else the vendor its tool plane picks. They use the same live view, the same spend held under the run's cap, and the same release when the run is let go.
- A browser call that a crash cuts off is answered as interrupted and never run again. The next claim's reconcile picks up the session it opened.
- `capabilities.tools` lists every harness under the browser's `harnesses`, not `pi` alone.
