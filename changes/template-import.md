---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
A template package can be installed from GitHub: `POST /v2/templates/import {source, dry_run?, trust_publisher?}` reads `github:<owner>/<repo>[/<path>][@<ref>]` (or a `https://github.com/<owner>/<repo>/tree/<ref>/<path>` address), resolves the ref to a full commit SHA first, downloads that commit's tarball from GitHub's hosts alone, and checks the package with the same checker the bundled ones pass. Nothing in it runs.
- A dry run answers the package whole (its instructions and every skill file) and stores nothing. A stored import is listed by `GET /v2/templates` beside the bundled packages under its own id, `github:<owner>/<repo>[/<path>]`; importing the id again replaces it, and `DELETE /v2/templates/{id}` removes it.
- The first package from a publisher (the GitHub owner) is stored only with `trust_publisher: true`; the server remembers the trust.
- A link, a special file, an oversized package or archive, a redirect off GitHub, or a source on another host is refused, storing nothing. The server reads GitHub with its GitHub App's token when it has one, else anonymously, and its rate-limit error says which.
- Each template in `GET /v2/templates` now has `id`, `bundled`, `source`, `sha` and `publisher`; `POST /v2/templates/{id}/apply` takes the id (a bundled package's id is its name, as before). An agent applied from a template carries `template: {id, version, sha}` (`sha` null for a bundled one).
- CLI: `agentrun template install <source> [--dry-run] [--trust]` imports one and prints the console page that applies it.
- Console: an "Add from URL" box on Templates and a `#/templates/install?src=` page that shows the publisher, the commit, the instructions and every skill file before anything is stored, with an "I trust <owner>" tick for a new publisher.
- The store keeps imported packages in a new `imported_templates` table: on SQLite a server adds it at its open, with no schema version change; on Postgres it is migration 0010.
