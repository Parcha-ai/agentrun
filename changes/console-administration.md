---
packages: @parcha/agentrun-serve, repo
kind: feature
---
The standalone console exposes a reusable React provider and native typed client, external coding-agent handoffs, revision skill bundles, pinned run entry, reconnectable timelines and byte-preserving artifact previews. Mission Control shows bounded active/attention/failure activity with freshness and pagination, and Settings exposes the server's connection and capabilities. The rounded UI builds with dependency boundary checks, exact asset manifests and third-party notices while retaining the UI library's publication hold.

Run summaries report result and file availability, with unknown values explicit. Imported and archived histories expose their supported native actions, and coding-agent handoffs retain the configured API endpoint.

Sidebar selections use orange text and a subtle background.

Selected navigation labels use semibold text.

Agent-card stat labels stay on one line, with card actions grouped on a separate row.

Mission Control's agent filter offers searchable options, selection markers and keyboard navigation. A run's breadcrumb links to its agent's run history.

Sending a follow-up opens its timeline and acknowledges acceptance until the saved message appears. Failed sends preserve the draft.

The API playground keeps its request and response tabs vertically centered at the same height when switching between Code and Response.

Tab indicators use straight underlines throughout the console, including the API playground's request, response and language tabs.

Application choices, run-state filters and API playground selectors use dark menus with clear selected options, keyboard navigation and viewport-aware placement.

Console reads keep pending data distinct from empty results. Navigation and pagination ignore stale responses, activity lists deduplicate runs, and pinned Playground routes retain their requested agent. Editor validation follows current tool grants and revision identity; unsupported history actions stay hidden. Failed sends and clipboard operations preserve usable controls and report their failure. Start and message submissions reject duplicate in-flight actions while retaining retry drafts and request identity. Workflow outputs retain valid false, zero and empty-string values. Agent fields have accessible names, and input composition does not submit a message.

Local owner sessions label their global sign-out explicitly. Production builds reject console fixture, sample, mock, story and test modules.

Console builds reject common credential formats in emitted assets, notices and manifests without echoing matched values. Embedding guidance requires a restrictive host CSP, runtime-only secret configuration and a dedicated hostname.

The console updates its sanitizer and build/test dependencies to patched releases, including a scoped Storybook documentation dependency override. Native URI parsing and transport test tooling receive compatible patch updates.
