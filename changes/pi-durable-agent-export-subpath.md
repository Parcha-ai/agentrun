---
packages: @parcha/pi-durable-agent
kind: feature
---
New subpath `@parcha/pi-durable-agent/export`: `EXPORTABLE_KINDS`, `SECRET_KINDS` and `projectForExport`, the same module the root re-exports, with no import at all. A writer that only filters kinds loads it with `node:sqlite` alone, where the root loads pi-durable, chord and pi-ai; `examples/web`'s replay writer now does.
