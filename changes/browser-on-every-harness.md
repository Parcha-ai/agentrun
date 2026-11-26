---
packages: @parcha/agentrun-serve
kind: feature
---
An agent on claude-agent, codex or another CLI harness now gets the browser, the same way it gets web_fetch. Before, granting `browser` to such an agent came back with "browser runs on pi here; on <harness> it is not bound yet", and a run of an agent whose computer is a browser was refused at its claim with "This agent's computer is a browser, which only the pi harness drives here". Now neither is refused. The harness is handed the browser's tools (`snapshot`, `run`, `screenshot` and the rest) as host tools. They drive the same session pi's would: the agent's browser computer, or else the vendor its tool plane picks. They use the same live view, the same spend held under the run's cap, and the same release when the run is let go.
- A browser call in flight when its runner stops or crashes is answered as interrupted ("may or may not have taken effect") when the run resumes, and is never sent to the browser again; the model goes on from that answer. Each browser call's memo is its own, so nothing it kept carries into another call. The next claim takes back the session it opened, and the session is released once when the run ends.
- `subagent`, `pdf_pages` and `llm` still run on pi only.
- `capabilities.tools` lists every harness under the browser's `harnesses`, not `pi` alone.
