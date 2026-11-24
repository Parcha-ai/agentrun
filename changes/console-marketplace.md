---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Templates and Build pages list the marketplace's templates beside this server's own (GRE-4834), as `GET /v2/marketplace/templates` answers them: this server's packages first, then the marketplace's others under the same search. Install opens the install page (the package read whole, its publisher trusted once) when the list names a source, else the template's marketplace page.
- The two pages list what the marketplace lists, in its order. The bundled `agent-scout`, which the Suggested page runs and the marketplace does not list, is no longer on either page; the API playground and `GET /v2/templates` still list it. A card's title is its display name up to its first parameter ("Code review", not "Code review: …/…"), and a card the marketplace lists reads the marketplace's one-line summary.
- A marketplace card leads with its harness's icon and lists its harnesses, as this server's cards do, when the list gives them.
- A marketplace that fails, or that the server could not read just now, is said on both pages with Try again; this server's own templates stay listed.
