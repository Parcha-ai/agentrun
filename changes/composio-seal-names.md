---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
More of a Composio trigger's config credentials are now sealed.
- The name rule reads each word as its singular, so `tokens`, `secrets`, `api_keys` and `private_keys` are sealed. It also takes `hapikey`, `pat`, `pwd`, `passcode`, `jwt`, `dsn` and `connection_string`. Names such as `key_id`, `keyword`, `status`, `pattern`, `path` and `address` stay as they are. The rule errs toward sealing, so a count named `max_tokens` is sealed too.
- A field that the event's schema marks with `format: "password"` or `writeOnly: true` is sealed whatever its name, and the events list names it under `sealed`. To check this, the create now reads the event's schema from Composio.
- A number in a credential's field is sealed like a string, at any depth. Composio still gets it as a number, and answers show `"[sealed]"`. A PATCH that leaves it out keeps it. A run's output is cut of its decimal text when that text is 8 characters or more.
- On SQLite, the cleanup after the start-time sealing waits briefly and tries once more when another connection is writing to the store. If it still can't finish, the log says `store_scrub_not_done` and the next start finishes it.
- Deleting a trigger retires its sealed values into a sealed row until the runs that saw them end. The docs used to say the values are removed.
