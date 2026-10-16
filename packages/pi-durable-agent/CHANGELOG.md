# Changelog

## [Unreleased]

- New held package `@parcha/pi-durable-agent`: an agent you can carry, as one directory of pi-durable stores
  (`agent.sqlite`, and one run store per run). `createAgentHome` and `openAgentHome` keep the agent's identity, its
  definition (no model or thinking level: the host picks them), its skills, and each host's alias and tool bindings.
  Each run is a `@parcha/pi-durable-disk` run directory, `runs/<id>/` with `store/run.sqlite` and `work/`, so
  `pi-durable-disk run --dir` runs it; `runPaths` gives its paths. `startRun` seeds a run's store and workspace from the
  home and takes the save lease on each browser profile no live run holds; only the lease holder gets a profile's saved
  sign-in, and another run gets it `held`, with no `ref`, and signs in on its own. `durableProfileStore` is pi-browser's
  `ProfileStore` over the run's `browser.profiles`; `carryBack` copies back the profiles the run may save, releases its
  leases and completes its entry in the runs index, once per run. Writers queue on the home's `owner.lock` and fail with
  `AgentHomeError` (`busy`) after 5 seconds.
- New subpath `@parcha/pi-durable-agent/timeline`: one human-readable timeline of a pi-durable run, with no dependency and no Node built-in, so a page, the run viewer and a harness can import the same code.
  `timelineOf(entries)` turns a stored conversation into rows shaped as Grep's public `TimelineEvent` (its 13 fields and caps), plus the open kinds `user_message`, `waiting` and `usage` and the optional fields `seq`, `conversation_id`, `round`, `parent_tool_use_id`, `session`, `path` (the file a "Saved" row is about) and `usage`. `timelineReducer().apply(events)` does the same live from `watchEvents` batches, as `pi-durable-disk` serves them on `GET /events`; both go through one per-entry function, so live and replay give equal rows.
  `groupTimeline(rows)` pairs calls by `tool_use_id`, groups them by round, folds adjacent calls of one tool, nests a call's inner calls and a subagent's rows under it, and never dedupes a call. `renderText` prints rows or groups as plain text. `registerLabel` adds a host's own tool labels. A row never carries a live-view URL, a context id or a cookie, and every summary, preview and text (a person's own message excepted) keeps a URL's origin, path and query keys but drops its query values, fragment and userinfo, as pi-browser does for the URLs a model sees.
