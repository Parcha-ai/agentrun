# Standalone console architecture

The console is an administration and observation layer over AgentRun Server's native `/v2` contract. Mission Control is the entry point. Agents, revision management, run history, live run detail and Settings are local core surfaces. Building or editing an agent through an external coding application uses a copyable skill onboarding/task prompt. Desktop applications and CLIs remain distinct choices.

## Boundaries

`apps/console/src/AgentRunProvider.tsx` owns the host boundary: a typed client, an authenticated session, capabilities, optional workspace and explicit extension routes. Identity/server changes invalidate the mounted console state. Enterprise identity policy belongs to the embedding application; local-owner setup belongs to the standalone entry.

`apps/console/src/lib/client.ts` owns HTTP transport. Cookie mode sends same-origin JSON mutations; explicit bearer mode supports SDK callers without browser cookies. ETags, stable caller-owned idempotency keys, typed failures and timeline cursors remain visible. The client never retries a mutation automatically.

Agent revision bodies use native agentic/workflow definitions and text skill bundles. Form edits preserve configuration they do not expose. Unsupported workflow controls are hidden. A run entry names its loaded or selected immutable revision. Editing a revision does not change an existing run.

`LiveRun` observes actual records and timeline pages. Network errors preserve the visible history and expose reconnection; server reset/drop instructions determine which rows remain. Command acceptance never substitutes for observed cancellation or interruption. Artifact listing completeness is independent of whether the listing is empty. File retrieval preserves bytes; preview policies restrict active content.

Mission Control combines whole-store statistics with bounded operational lists. Pagination and freshness are explicit. Active work, human input, failure, useful results and unknown usage remain distinct.

## Design and source inventory

| Surface | Public implementation and provenance |
| --- | --- |
| Navigation and shell | Native console shell, composed through the provider. No hosted auth or chat imports. |
| Agent editor and revisions | Native definitions, native capability offers, ETag saves and immutable revisions. |
| Coding-agent actions | Public AgentRun skill documentation plus native server URLs and caller-selected context; no credential copying. |
| Timeline and files | Native `/v2` records, cursors and authenticated bytes. No hosted workspace viewer. |
| Mission Control | Native `/v2/stats` and paginated run records, with bounded-list labels. |
| Visual tokens | Dark neutrals, orange accent, 8px controls, 12px cards and 14px composer. Fonts retain their package licenses. |
| Fixtures | Scripted native faux server responses and synthetic agents/runs; no customer data. |

The administration layout and visual behavior follow the AgentRun console design. Code is composed from the reviewed public console and native server; the hosted application, backend and Git history are not copied into this repository. Provider identity, teams, billing, remote Runner fleets, deployments, swarms, managed evaluation dashboards and hosted connectors are optional private extensions outside core.

## Menu controls

Application, run-state and API playground selectors use a shared select-only combobox. Its dark menu shows the selected value with an orange check mark. Keyboard navigation highlights enabled options; Enter, Space or a pointer selection commits the value. Escape dismisses the menu without changing the value, and Tab follows the page's normal focus order.

Menus stay within the visible viewport and scroll when their options exceed the available height. A menu opened inside a modal belongs to that dialog's top layer. Embedded menus inherit the console's theme. Mission Control keeps its searchable agent filter for longer agent lists.

## Builds and acceptance

The root build first builds the standalone static page and embeddable library, then copies the page, exact asset manifest and notices into the native server. Browser runtime dependencies are reviewed independently from development tooling. Compiled assets are scanned for private integrations, and the source export includes the browser lockfile in its runtime inventory.

The embeddable package remains held. Build, source export and verification commands perform no publication. Native packages follow the repository's reviewed release policy.

Verification uses small deterministic tests at the public React/client seams, a real typed client against the actual native faux server and run child processes, and a browser pass on a loopback server. Live provider/model certification is separate evidence. Native interpreter and recovery behavior remains covered by its existing suites and models.
