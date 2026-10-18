# Changelog

## [Unreleased]

- New held package `@parcha/agentrun-serve`: the Agentrun v2 API (`agentrun.v2/0`, the contract the hosted API serves) on
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
- A run that a restarted server adopted now ends final after it answers. The server read the run's store as soon as the run said it was released, while the run's process could still hold the store's exclusive lock until it exited; that read failed with `database is locked`, was not retried, and left the run `completed` but never final until the next start. The server now reads an adopted run's store once its process has exited (it reads anyway, and says so, if the process lives on 30 s after it released the run), retries a store that another connection holds within the same bounded retries as a busy agent home, and writes each wait and a run it could not settle or recover to stderr.
- `packages/serve`: the recovery tests' stand-in run writes `run.json` whole, through a temporary file and a rename, as a run does. A plain rewrite let the server's 500 ms read land on a half-written record, read it as no record, and settle the adopted run early, which failed "an adopted run that released is read only once its process has exited" about once in a loaded full run.
