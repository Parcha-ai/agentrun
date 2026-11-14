---
packages: @parcha/agentrun-serve
kind: fix
---
Four tool-plane fixes found by a QA walk of the tools.
- Behavior: a call waiting for your approval whose tool you then set to deny is refused, and the run says why. The record keeps your answer: an allow sent after the deny is taken and kept as the answer the setting overrode. The call's rows read "Not run: its tool is now set to deny on this server", its approval row reads "Denied by the tool's setting on this server", and the outcome reads "You allowed <tool>, but it is now set to deny on this server, so it was not run". Before, the rows said the run had ended while the call waited and the ask was withdrawn, and the allow was never recorded. The refused call ends as an error on every harness, as before.
- Behavior: Settings → Tools lists each saved MCP server's tools, read from the MCP servers list, with the permissions the server offers for each (allow, ask, deny). The owner sets a server-wide permission for a tool, and choosing its default again removes it. A server's `mcp:<server>/*` wildcard shows as its tools' default. Tools the server offers no permission for (the meta tools) are not listed.
- Behavior: a call you allowed, or one its setting allowed while it waited, shows what it did and its result like any call once it ran, with "(ran once you allowed it)" or "(ran, as its setting allows it)" after its result. It no longer reads "Held for your approval" after it ran. A declined call still reads "Held for your approval".
- Behavior: on Claude Code and OpenCode, `tools_call` and `codemode` each have their own row ("Tools call", "Ran a script") with their result, as on pi, and the calls they make read after it.
