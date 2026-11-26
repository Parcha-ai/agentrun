---
packages: @parcha/agentrun-serve
kind: fix
---
OTLP redaction now also holds a credential that `OTEL_EXPORTER_OTLP_HEADERS` or an endpoint writes percent-encoded. A line quoting such a credential, as written or decoded, no longer prints it. The forms covered:
- a credential with `%2C` in it, kept whole rather than cut at the encoded comma;
- a credential before an `&` written `%26`, or with a `%20` in it before one;
- a credential inside quotes written `%22` or `%27`;
- a pair value that follows an empty first `;`.
