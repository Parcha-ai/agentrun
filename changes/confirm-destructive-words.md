---
packages: @parcha/agentrun-serve
kind: fix
---
The 422 for allowing a destructive MCP call without `confirm_destructive` now reads as one sentence that says what to send: "The tool call <id> is one its MCP server marks destructive. To allow it, confirm a second time and send the allow again with confirm_destructive: true." Before, a generated ", e.g. true" was tacked on after the sentence ended. The field's issue still carries `example: true`.
