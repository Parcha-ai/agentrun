<!-- agent-sticky:autoqa-report -->
# autoqa report: Parcha-ai/agentrun @ claude/marketplace-api on local scratch servers

**Head:** `f1cabd736760c0be5fc29386bedf702b6fbca9e3`
**Date:** 2026-11-24  **Instance:** scratch `agentrun-serve` servers on loopback, built from the head (Node 24.22.3), plus a fake marketplace on loopback  **Evidence:** [`pr-assets/3663` → `autoqa/f1cabd736/`](https://github.com/Parcha-ai/agentrun/tree/pr-assets/3663/autoqa/f1cabd736)

## Bottom line

**Ship.** All 17 rows pass, re-run at this head (main merged in, and `agentrun service install --env` now takes `AGENTRUN_MARKETPLACE`). `GET /v2/templates/marketplace` reads the real marketplace.agentrun.ai list (90 entries), marks the 5 bundled packages and an imported one with `here`, and answers the same list through the CLI, the TypeScript client and the Python client. Every failure mode answers 200 with the documented state: `off`, `unreachable` (redirect, 500, not JSON, no answer in 10 s), and `stale` with the last good list. A bad `AGENTRUN_MARKETPLACE` value stops the start with a message naming the value. No console page calls the route in this PR (the Templates page change is in the next layer), so no UI rows.

## Scope

PR pass as `docs/AUTOQA.md` fixes it for unattended runs: the diff cases, plus health and auth. No model runs, so no model spend. Coverage: BASE 2 (health, auth), DIFF 15; rows 17; untested 0. Scoped pass, not the full catalog.

## Verdict table

| # | Source | Feature | Modality | Entry point | Check | Result | Witness |
|---|--------|---------|----------|-------------|-------|--------|---------|
| 1 | BASE | Boot + health | API | `GET /v2/health` | 200, store and disk ok | PASS | `r01-health.txt` |
| 2 | BASE | Auth on the new route | API | `GET /v2/templates/marketplace` | no token → 401; wrong token → 401 | PASS | `r02-auth.txt` |
| 3 | DIFF | OpenAPI | API | `GET /v2/openapi.json` | `listMarketplaceTemplates`, `x-agentrun-serve: marketplace/1` | PASS | `r03-openapi.json` |
| 4 | DIFF | Default: the public marketplace | API | `GET /v2/templates/marketplace`, `AGENTRUN_MARKETPLACE` unset | 200, `state: read`, 90 entries, `here` on the 5 bundled packages | PASS | `r04-default.json` |
| 5 | DIFF | `here` for an imported entry | API | `POST /v2/templates/import` with an entry's `source`, then the list | 201; the entry's `here` is the imported id; same `read_at` (no new read) | PASS | `r05-import-here.txt` |
| 6 | DIFF | CLI | CLI | `agentrun local list-marketplace-templates` | exit 0, same list and `here` ids as row 5 | PASS | `r06-cli.txt` |
| 7 | DIFF | TypeScript client | API | `new AgentRun().local.listMarketplaceTemplates()` | same list and `here` ids | PASS | `r07-ts-client.txt` |
| 8 | DIFF | Python client | API | `AgentRun().local.list_marketplace_templates()` | same list and `here` ids | PASS | `r08-py-client.txt` |
| 9 | DIFF | Entry checks and the 5-minute cache | API | list from a fake site | bad name, duplicate and non-object dropped; bad tag, harness, category, source and off-site URL dropped per field; control chars made spaces; summary cut at 300; 3 asks → 1 read | PASS | `r09-fields-cache.txt` |
| 10 | DIFF | Stale list through a failed read | API | same server, site stops answering, asked after 5 min | 200 `stale`, the last good list and its original `read_at`, `problem` says no answer in 10 s; 1 read, none on the next ask | PASS | `r10-stale.txt` |
| 11 | DIFF | `AGENTRUN_MARKETPLACE=off` | API | the route | 200, `state: off`, `url: null`, empty list | PASS | `r11-off.txt` |
| 12 | DIFF | Redirect, 500, not JSON | API | the route on fresh servers | 200, `unreachable`, empty list, `problem` names the cause (redirect names its target) | PASS | `r12-unreachable.txt` |
| 13 | DIFF | 10 s deadline and 1-minute retry | API | site that never answers | first ask 200 `unreachable` in 10.0 s; second ask 0.5 ms and no new read | PASS | `r13-deadline-retry.txt` |
| 14 | DIFF | A bad value stops the start | CLI | `agentrun-serve` with `http://example.com`, `maybe`, an https URL with a query | the server exits; each message names the value | PASS | `r14-bad-value.txt` |
| 15 | DIFF | `--faux` | API | the route under `--faux` | unset → `off`; an address → `read` from it | PASS | `r15-faux.txt` |
| 16 | DIFF | One read however many ask | API | 5 concurrent asks on a fresh server, site that never answers | all 200 in 10.0 s; 1 upstream read | PASS | `r16-one-read.txt` |
| 17 | DIFF | A service keeps `AGENTRUN_MARKETPLACE` | CLI | `agentrun service install --env AGENTRUN_MARKETPLACE=off` | `off`, then an address, go into the unit and stay through a re-install; `KEY=` removes it (scripted service manager: no real service installed on a shared host) | PASS | `r17-service-env.txt` |

## Before / After

| Check | Before | After |
|:--|:------:|:-----:|
| `GET /v2/templates/marketplace` | no such route on the base branch | rows 3 and 4 |

Before: none (no base instance). After: scratch servers at `f1cabd736`.

## Failures: triage

None.

## Coverage notes

- No UI rows: nothing in this PR's console code calls the route yet; the console change is in the next stack layer.
- The real-network rows (4 to 8) read the live marketplace.agentrun.ai and one public package from GitHub (row 5).
- Row 17 runs the CLI's install against a scripted systemd and launchd, not a real service: installing one would change this shared host.

## Created resources and cleanup

| Resource | ID | Cleanup result |
|---|---|---|
| Scratch servers (13 starts per run; 3 refused to start on purpose in row 14) and their data dirs | loopback ports 7541 to 7549 | stopped (SIGTERM to the exact PIDs); no listener left |
| Imported template on the scratch server | `github:Parcha-ai/agentrun-templates/templates/battlecard` | removed with its data dir |
| Fake marketplace | loopback port 7551 | stopped (SIGTERM to the exact PIDs); no listener left |

## Instance health after run

Both long-lived servers answered `GET /v2/health` 200 (store and disk ok) before they were stopped:

```
port 7541: {"status":"ok","checks":{"store":"ok","disk":"ok"}} HTTP 200
port 7542: {"status":"ok","checks":{"store":"ok","disk":"ok"}} HTTP 200
```

No shared instance was touched.

<details><summary>Earlier heads</summary>

- `dc879c258` 2026-11-24T18:05Z ship: 16 of 16 rows pass

</details>
