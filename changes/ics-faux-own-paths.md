---
packages: @parcha/agentrun-serve
kind: fix
---
The fake calendar (`startIcsFaux`, which calendar tests and a template's eval read) counts the requests for its own paths only: the calendars it serves, the paths it moves and their targets. A request for any other path is answered 404 and not counted, so a host process that polls every loopback listener (GET /) no longer fails a test that counts the calendar's reads.
