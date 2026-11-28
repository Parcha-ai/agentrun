---
packages: @parcha/agentrun-serve, @parcha/agentrun-import, @parcha/agentrun-client
kind: fix
---
Wrapped no longer says "0.0 h at work" for sessions that keep no time for each request (Cursor's chat store dates every request at the chat's start). `GET /v2/wrapped` and `wrappedHome` count those requests as `time_unknown_requests` (`timeUnknownRequests` in the importer); a reader marks its source with `untimed`. The page says "Time at work not recorded" for a year where no request has its own time, and adds "+ N requests with no recorded time" beside the hours it knows; the hours card reads "Unknown" time at work.
