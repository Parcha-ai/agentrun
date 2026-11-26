---
packages: @parcha/agentrun-serve
kind: fix
---
OTLP redaction now holds a credential-named pair's value in `OTEL_EXPORTER_OTLP_HEADERS` at every boundary, so a line quoting the credential, as written or decoded, no longer prints it or a piece of it, whatever separators are in the key or around it. The value is held up to each `&`, `;`, comma or space after its `=`, raw or percent-encoded, and whole to the end, each out of its quotes too. This covers, among others:
- a credential in a list joined by `%3B`, such as a cookie, including one with a `%20`, quotes or a `%26` in it;
- a credential with an encoded space in it between pairs joined by different separators, such as `%3B` before it and `%26` after it;
- the part of a quoted credential before an encoded comma, when the closing quote comes after the comma;
- a quoted credential with an encoded space in it, followed by another encoded space and the next pair;
- a credential longer than 4,096 characters with a separator in it, such as `%3B`, ended by a separator of another kind.

A malformed header no longer cuts commas, `&`, a literal `%27` or single letters from the tracer's own lines, and a pair like `theme=dark-mode` after an empty first `;` is no longer held.
