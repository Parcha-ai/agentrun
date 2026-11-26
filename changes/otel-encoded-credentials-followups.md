---
packages: @parcha/agentrun-serve
kind: fix
---
OTLP redaction now holds three more credential shapes in `OTEL_EXPORTER_OTLP_HEADERS`, so a line quoting one, as written or decoded, no longer prints it or a piece of it:
- a credential in a list joined by `%3B`, such as a cookie, including one with a `%20`, quotes or a `%26` in it;
- the part of a quoted credential before an encoded comma, when the closing quote comes after the comma;
- a credential with an encoded space in it, followed by another encoded space and the next pair.

A malformed header no longer cuts commas, a literal `%27` or single letters from the tracer's own lines, and a pair like `theme=dark-mode` after an empty first `;` is no longer held.
