# OSS console verification

Candidate: `0d1fb055e1263e0bce99af1fc87bbca6415c941e`.

**PASS for the selected console scope.** All 9 selected matrix rows passed, with 23 browser checkpoints and 7 real public-client/server scenarios (8 node:test results). No selected row is untested. Optional paid-model, cloud-box, production and deployment checks were excluded explicitly.

The target was a fresh standalone AgentRun server on loopback with real run child processes using the repository's scripted faux model. It needed no Grep service, hosted identity, private package credential, external model call or spending cap. The plan and traced entry points are in [autoqa-plan.md](autoqa-plan.md).

The final browser tested `assets/index-bLQbTIIJ.js`, SHA-256 `da22a54cff6a4641bc19504e649f146d987b816e3636ba7a5e26eca9f86e257c`; source build hash `8ff5e87f9691422965089c986e9484025ec33f1bcaf59c31c170c9b6265a93c4`. All 23 browser checkpoints and all 8 real-client test results were rerun after the final artifact rebuild. Exact run/agent IDs and checkpoint outcomes are in [browser-result.json](autoqa-evidence/browser-result.json).

CSS artifact `assets/index-MZWl1iOl.css`, SHA-256 `bf50c1d29c09f394dbd98026fef8f8c8cae60514718ac97b42d0ea5b6daf512f`. Metric cards computed **12px** border radius at both 1440px desktop and 390px narrow widths; those assertions are recorded in browser checkpoints 12 and 14.

| Row | Source | Modality | Result | Witness and observed behavior |
|---|---|---|---|---|
| 1 | BASE | API | PASS | [health.json](autoqa-evidence/health.json): HTTP 200, healthy store/disk; [client-contract.tap](autoqa-evidence/client-contract.tap): available pi capability. |
| 2 | BASE | API + UI | PASS | [empty/auth](autoqa-evidence/01-empty-and-auth.png): owner bootstrap entered Mission; [contract](autoqa-evidence/client-contract.tap): wrong bearer and file read refused with 401. |
| 3 | DIFF | API + UI | PASS | [skill editor at 390px](autoqa-evidence/02a-agent-skills-narrow.png), [created agent](autoqa-evidence/02-agent-created.png), [coding-agent handoff](autoqa-evidence/02b-coding-agent-handoff.png). Two skill files persisted; copied Codex CLI prompt contained pinned context, no credential, and started zero runs. [Contract](autoqa-evidence/client-contract.tap) proves retained skills, stale edit 412, equivalent save stability and pinned/idempotent run creation. |
| 4 | DIFF | API + UI | PASS | [question](autoqa-evidence/07-input-required.png), [answer](autoqa-evidence/08-answer-result.png), [stopped](autoqa-evidence/10-stopped-continuable.png), [cancelled](autoqa-evidence/11-cancelled.png). Actual child processes handled answer once, follow-up after stop and terminal cancellation. [Contract](autoqa-evidence/client-contract.tap) also proves native workflow refusal and real failed run. |
| 5 | DIFF | API + UI | PASS | [Markdown](autoqa-evidence/03-report-preview.png), [PNG](autoqa-evidence/04-binary-preview-download.png), [sandbox](autoqa-evidence/05-sandboxed-html.png), [file outage](autoqa-evidence/06-file-error.png). Downloaded PNG bytes matched the original Buffer exactly; HTML had empty iframe sandbox, sanitized content and no parent script execution; retry recovered the same modal. |
| 6 | DIFF | API + UI | PASS | [disconnect](autoqa-evidence/09-disconnected.png); reconnect restored progress, then stop/follow-up completed. [Contract](autoqa-evidence/client-contract.tap) proves persisted completed/cancelled records, result/file reopening and old-cursor reset after real server restart. Deterministic frontend tests separately cover cursor retention/reset/drop/dedup and partial file listing. |
| 7 | DIFF | UI | PASS | [totals](autoqa-evidence/12-mission-desktop.png), [activity](autoqa-evidence/12a-mission-activity.png), [pagination](autoqa-evidence/13-mission-pagination.png), [retained disconnect](autoqa-evidence/16-mission-disconnected-retained.png). Mission found the older waiting run outside the latest ten, showed active/failed state with revision/elapsed/usage, loaded all 19 server runs and retained the prior snapshot on injected failure. |
| 8 | DIFF | API | PASS | [contract](autoqa-evidence/client-contract.tap) imports the built public console library and uses its exported client against the actual standalone server. Parent build/package gates provide the separate artifact-boundary evidence. |
| 9 | DIFF | UI | PASS | [Mission 390px](autoqa-evidence/14-mission-narrow.png), [keyboard menu](autoqa-evidence/14a-keyboard-navigation.png), [run 390px](autoqa-evidence/15-run-narrow.png), [file 390px](autoqa-evidence/15a-file-narrow.png), [Settings](autoqa-evidence/17-server-settings.png), [loading](autoqa-evidence/00-loading.png). No page horizontal overflow; Enter navigated the mobile menu; Escape closed file modal and restored focus; real loading/empty/error states were witnessed. |

## Before / after

No base instance was supplied. Before: **none (no base instance)** for every changed UI row. The screenshots above witness the candidate; no pristine checkout or second server was manufactured as a baseline.

## Error triage

No unexpected page exception or selected feature failure occurred. Seven browser console errors were captured: one benign missing favicon (404), three expected CSP refusals from the malicious HTML fixture (inline handler twice and remote image), one injected file 503, one deliberate offline disconnection, and one injected Mission network failure. The sandbox fixture did not execute code in its parent.

## Cleanup and practical limits

The final browser and server exited successfully; the final synthetic directory was removed. It held exactly 3 agents and 19 runs, whose IDs are recorded in [browser-result.json](autoqa-evidence/browser-result.json). Earlier caught attempts also closed their processes and removed their data. The loading-only aborted attempt created no agents/runs; its exact scratch directory was moved to trash reversibly, and no orphan browser/server process remains.

This establishes standalone faux-model console behavior and public client compatibility. It makes no claim of qualification on a paid provider or production deployment. The candidate is ready for the parent implementation's remaining repository gates and review.
