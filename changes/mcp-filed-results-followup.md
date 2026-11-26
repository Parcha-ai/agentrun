---
packages: @parcha/agentrun-serve
kind: fix
---
A tool with a `file` setting now files more of what its server sends, and its summary says more about errors without showing their words.
- A protocol-level error is filed like any other answer. This covers a JSON-RPC error, or an HTTP error the client throws. The tool's result is the same summary with `isError: true`. Before, the result showed the first 300 characters of the server's message.
- An error answer's summary ends with one more line, built from the error's structure and never from its words. The line gives the HTTP status, the JSON-RPC code, and when to retry. The retry time comes from a `retry_after`, `retryAfter`, `retry_after_seconds`, `retry_after_ms` or `retryAfterMs` field of a JSON error, or from the Retry-After header. A 429 or 503 with no retry time says to retry later. When the error has none of these, as with a plain-text error, the line says `Error: no status or retry time given.`
- The shape names a key only when it reads as a plain name: lowercase words joined by `_` (`has_more`), or camelCase (`pageInfo`), with any leading `_`, at most 32 characters. Keys with digits or capitals after a prefix (`cus_NffrFeUfNV2Hib`, `txn_1Q0001`) and all-capitals keys are counted instead. A key that is data but looks like a plain word, such as a username like `marisol_q`, is still named.

Upgrading: a runner on a release from before `file` existed ignores the setting. Such a runner shows a filed tool's answers to the model whole, as if the setting weren't there, and the server raises no error or warning about it. Before applying a template that relies on `file`, update every runner that can claim its runs to this release. A runner that has `file`, but runs a release older than the server that wrote the setting, refuses every call of the tool, naming the setting. That runner also needs the update.
