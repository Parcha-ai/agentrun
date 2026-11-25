---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
A key no longer leaves the server, or a suggested agent's client, for a base URL with a user or password, a query or a fragment. The refusal names the URL's origin at most, never its password or query.
- A suggested agent's client (TypeScript, JavaScript and Python) refuses an `AGENTRUN_BASE_URL` with a user, a password, a query or a fragment before it sends anything, as AgentRun's SDK does. Before, it sent the request, and a failed fetch printed the whole URL, password included. A client file written before this release still takes such an address.
- A tool key's check sends no key to a `BROWSERBASE_BASE_URL`, `KERNEL_BASE_URL` or `TYPESAFE_BASE_URL` that `httpsBase` refuses, or to an `ANTHROPIC_BASE_URL` the model path's gateway rule refuses. The key is kept as not checked, and the reason names the variable. An `ANTHROPIC_BASE_URL` ending in `/v1` is checked at `<base>/v1/models`, where runs send, not at `<base>/v1/v1/models`.
- A saved sign-in's Browserbase and Kernel calls refuse a `BROWSERBASE_BASE_URL` or `KERNEL_BASE_URL` that `httpsBase` refuses, naming the variable, before any call.
- `httpsBase` is exported from `@parcha/agentrun-computer`, and refuses a user or password, a query or a fragment.
- Breaking: the key check and the sign-in calls now take `BROWSERBASE_BASE_URL`, `KERNEL_BASE_URL` and `TYPESAFE_BASE_URL` only as https URLs with no user, password, query or fragment, as the Browserbase and Kernel computer providers already did. An http gateway set there used to be accepted; point it at https.
