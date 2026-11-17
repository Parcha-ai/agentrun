---
packages: @parcha/agentrun-serve
kind: fix
---
A first agent that needs no shell starts at once, and a local model's reasoning stays out of its answer.
- A new agent with no place whose tools need no shell (`tools: []`, or tools such as `read`, `write` and `web_fetch`) is saved with no place and runs on the runner. It used to get the Docker box, so its first run waited for a container it never used. An agent with no tools named still gets the box and bash, and so does one that names `bash` or a background tool. A revision with no place resolves the same way at each run.
- A model the catalog doesn't list (a local model behind `AGENT_MODEL_BASE_URL`, or a gateway's own alias), run with no thinking level, is no longer sent `reasoning: {effort: "none"}`. It now thinks at its lowest level, so a model that reasons anyway gets its reasoning split out of the answer. On Ollama with a thinking model such as `qwen3:4b`, that reasoning used to come back at the start of the answer text. A run that sets a thinking level is sent that level, as before.
- The README said a Docker run's container is made on its first `bash` call. It is made when a runner takes the run, and the README now says so.
