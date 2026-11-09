---
packages: @parcha/agentrun-kernel
kind: fix
---
A provider's error no longer hands a harness the provider's credential. The session's model proxy relayed every answer as it came, so a provider that echoes the key it was sent ("Incorrect API key provided: <key>") gave it to the harness, which on a CLI harness runs in the sandbox. Now, in an answer with an error status, and in an error event inside a streamed answer (Messages' `error`; Responses' `error` and `response.failed`), the credential the proxy sent and the values of the headers it added are cut out ("[redacted]") as sent, JSON-escaped, and with "/" escaped. Then the host's redactor runs, when it gives one (`ModelProxyOptions.redact`). Healthy streamed answers pass byte for byte, and an error body still reaches the client as it comes.
