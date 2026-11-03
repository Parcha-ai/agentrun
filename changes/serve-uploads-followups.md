---
packages: @parcha/agentrun-serve
kind: fix
---
Uploads: a reservation that names no `content_type` takes its path's extension's type, as a run's files are served (`plan.md` is `text/markdown; charset=utf-8`; an unknown extension stays `application/octet-stream`; a named type still wins). `upload.expires_at`, which the contract requires, is documented as advisory and not enforced in this release: a later `PUT` is still taken. The refusals that point at an upload route name it in full: `POST /v2/files`, `PUT /v2/files/<id>`. The extension table resolves only its own extensions: a run's file named `x.constructor` or `x.__proto__` is listed with no type and served as `application/octet-stream`, where it was listed without a `content_type` and could not be read, and an upload so named takes its bytes.
