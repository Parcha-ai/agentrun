---
packages: @parcha/agentrun-serve
kind: fix
---
The console's first visit says where the setup code is, and gets a new one without a restart. Someone whose coding agent deployed the server reached the Setup code field with no way to find the code, or with one past its 30 minutes.
- Under the field, a server at a Render address (`*.onrender.com`) names the service's Environment tab (`AGENTRUN_TOKEN`) and its Logs tab; any other server names the log line (`Set up this server: ...#code=`), where that log is (the terminal, `docker logs`, Render's Logs tab) and the API token that stands in for the code. Both say that a code works once and lasts 30 minutes, as the refusals of an expired or wrong code now do.
- **Get a new code**, under the field, and the new route behind it, `POST /v2/setup/code`, taken with no credential: the server prints a new `Set up this server:` line to its log when the last code is expired or spent, and keeps one that is still good, so no visitor voids a link someone holds. It answers `{printed, expires_at}` and never the code; 403 once the owner is set or where setup takes no code; its asks count with the address's sign-in tries (429 past ten in 15 minutes). The console then says where the new line is and until what time it works. The page still never holds the code.
- The setup skill (`docs/SKILL.md`) has the assistant give the person the code's place, or the newest setup link, in the same message as the console address, saying in it that the link works once, when it expires and how to replace an expired one; it renews with `POST /v2/setup/code` rather than a restart, and never pastes the API token into the chat.
- `deploy/README.md` has a section, "The first visit's setup code", with the same places and the renewal.
