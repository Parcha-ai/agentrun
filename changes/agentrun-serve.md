---
packages: @parcha/agentrun-serve
kind: feature
---
New held package `@parcha/agentrun-serve`: the Agentrun v2 API (`agentrun.v2/0`, the contract the hosted API serves) on
your own machine. `agentrun-serve` serves `http://127.0.0.1:7340/v2` over agent homes of `@parcha/pi-durable-agent` in a
data directory (default `~/.local/share/agentrun/agents`, `--data`), with a bearer token it writes there at mode 0600 and
prints at start with `AGENTRUN_BASE_URL`. It binds loopback only, refuses a `Host` that is not a loopback name, and sends
no CORS headers. It serves capabilities, agents (create, list, read), runs (start, list, read, the timeline as JSON pages
with the change-number cursor and as server-sent events, messages that steer, answer or follow up, stop, cancel), a
run's files under `work/`, and usage as an estimate. Each run is a child process of `pi-durable-disk run`, read through
its door while it is live and from its released store after; a run that answered is carried back to its home and is
finished. A run's tools are the ones its definition names, of `read`, `write`, `edit` and `ask_person`, which ends the
turn until a message answers it. With an `output_schema`, a run's output is its final answer parsed as a JSON object,
and an answer that is not one ends it `failed` (`output_invalid`). `--faux MODULE` answers every model request from a module, with no key and no network; without it the model is
an OpenAI Responses endpoint named in `AGENT_MODEL_BASE_URL` and `AGENT_MODEL`. Home export and import, definition
updates, uploads, quotes and kill answer `501 unsupported_here`, and capabilities say so.
