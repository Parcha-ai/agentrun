# Scoped OSS console verification

Target: public AgentRun checkout; isolated loopback faux server with fresh synthetic data.
Scope: caller selected changed public console behavior and real client/server seams. No paid models, production data, cloud boxes, external fetches or deployment. One headless Chromium; desktop plus 390px viewport. Up to 12 agents/24 runs; 20 minutes. Cleanup closes exact server/browser processes and removes synthetic data.

Required baseline inventory:
1. BASE health and capability discovery.
2. BASE authentication bootstrap, wrong credential and session protection.

Diff inventory:
3. DIFF agent creation/revisions/skills/conflict and pinned run identity.
4. DIFF real run timeline, question/answer, stop/follow-up, cancellation and failure.
5. DIFF binary artifact download, safe media/HTML preview and failed-read retry.
6. DIFF timeline disconnect/reconnect cursor and server restart/reopen.
7. DIFF Mission activity/attention/failed/recent, explicit pagination and freshness.
8. DIFF reusable public client/provider and standalone console assets.
9. DIFF narrow-screen/keyboard routes and loading/empty/error presentation.

| Row | Source | Modality | Entry point | Check / pass criterion | Witness |
|---|---|---|---|---|---|
| 1 | BASE | API | GET /v2/health, capabilities | Healthy store/disk; available pi faux | HTTP JSON |
| 2 | BASE | API + UI | Console setup/sign-in; createClient bearer | Setup/session works; wrong token 401; protected data unavailable signed out | screenshot + typed-client TAP |
| 3 | DIFF | API + UI | New agent/editor; createClient definitions | Skill text retained; equivalent save one revision; stale edit 412; selected revision executed; duplicate key same run | typed-client TAP + screenshot |
| 4 | DIFF | API + UI | Agent run entry, RunDetail composer/actions | Child faux processes finish; question answered once; stop continuable; cancel terminal; real failure shown; completed archived/imported history offers no continuation; active archived controls retained | typed-client TAP + run screenshot |
| 5 | DIFF | API + UI | RunDetail Files tab/dialog | Binary bytes exact; WAV/WebM decode and advance playback through native MIME; HTML iframe sandbox without scripts; failed read retry succeeds | file response + dialog screenshot |
| 6 | DIFF | API + UI | Reconnect button + reopen route | Prior rows/cursor retained on retry; server restart reopens records/reset cursor | component receipt + typed-client TAP + screenshot |
| 7 | DIFF | UI | Mission Control navigation/status sections/Load more/Refresh | Attention older than recent page visible; counts from stats; incomplete data labeled; actual result/file availability captions without per-run file-list reads; Load more pages retained through Refresh; a read held across the 15s poll settles and the next poll resumes; disconnected snapshot retained | screenshot + response JSON |
| 8 | DIFF | API | Exported console library client/provider | Public built exports import and call actual server; provider-host handoffs preserve arbitrary API prefix and pinned run operation; no private service dependency | typed-client TAP + build receipt |
| 9 | DIFF | UI | Console navigation, file modal and controls | 390px no horizontal overflow; focusable controls; Escape closes modal; loading/empty/error visible | desktop/narrow screenshots + assertions |

All executable rows use traced user routes or exported client methods. Before: none (no base instance supplied). Existing deterministic focused test receipts remain distinct from live browser witnesses. Unsupported real-model/provider rows are out of scope.
