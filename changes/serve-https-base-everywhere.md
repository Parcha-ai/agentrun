---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
A key no longer leaves the server, or a suggested agent's client, for a base URL with a user or password, a query or a fragment. The refusal names the URL's origin at most, never its password or query.
- A suggested agent's client (TypeScript, JavaScript and Python) refuses an `AGENTRUN_BASE_URL` with a user, a password, a query or a fragment before it sends anything, as AgentRun's SDK does. Before, it sent the request, and a failed fetch printed the whole URL, password included. A client file written before this release still takes such an address.
- A tool key's check sends no key to a `BROWSERBASE_BASE_URL`, `KERNEL_BASE_URL` or `TYPESAFE_BASE_URL` that `httpsBase` refuses, or to an `ANTHROPIC_BASE_URL` the model path's gateway rule refuses. The key is kept as not checked, and the reason names the variable. An `ANTHROPIC_BASE_URL` ending in `/v1` is checked at `<base>/v1/models`, where runs send, not at `<base>/v1/v1/models`.
- A saved sign-in's Browserbase and Kernel calls refuse a `BROWSERBASE_BASE_URL` or `KERNEL_BASE_URL` that `httpsBase` refuses, naming the variable, before any call.
- A browser session's attach refuses a `BROWSERBASE_CONNECT_BASE_URL` that is not https or wss, or has a user, a password, a query or a fragment, naming the variable. Before, an unparsable one quietly fell back to Browserbase's own host, and any other went into use.
- The OTLP trace export refuses an `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` with a user, a password, a query or a fragment, and tracing is off with one log line naming the variable. http stays allowed there, as OTLP allows it, so a local collector keeps working.
- `agentrun native connect` refuses a server URL (`--url`, `AGENTRUN_BASE_URL`, `AGENTRUN_URL` or the recorded one) with a user, a password, a query or a fragment, naming where it came from, before it sends the server's token.
- `@parcha/agentrun-computer` exports `httpsBase`, and `keyBase`, the same rule over a list of schemes.
- Breaking: the key check and the sign-in calls now take `BROWSERBASE_BASE_URL`, `KERNEL_BASE_URL` and `TYPESAFE_BASE_URL` only as https URLs, and `BROWSERBASE_CONNECT_BASE_URL` only as https or wss, with no user, password, query or fragment; the OTLP endpoints and native connect's server URL refuse a user, password, query or fragment. An http gateway set in one of the first four used to be accepted; point it at https, and move a credential in an OTLP endpoint to `OTEL_EXPORTER_OTLP_HEADERS`.
