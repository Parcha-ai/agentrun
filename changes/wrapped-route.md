---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
`GET /v2/wrapped?year=YYYY` (and `agentrun wrapped --year`) reads a year of the work under this machine's home (Claude Code, Codex, pi and any other source the import package reads) as numbers: tokens, requests, days, hours of the day, weekdays and time at work, by model, harness and source, each bucketed by its request's time in the server's local zone, with the runs imported here beside it. It holds no prompt, title, path or project. Only a server on loopback with no public URL, reached by a loopback Host (localhost, 127.x, [::1]), answers it (any other, a Host name an operator allowed included, and the API-only profile, is 403), and the answer is kept for a minute. A year number is four digits from 1000, and `unread_files` counts the session files that could not be read (a number, no path), so a partial year is not shown as a whole one.
