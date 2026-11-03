# Current CI success for PR #1408

Candidate `cf668bea326996da873c755bab7dbc3e356932aa`: [Package checks run 41572842831](https://github.com/Parcha-ai/agentrun/actions/runs/41572842831) completed **success**, updated `2026-11-03T03:48:32Z`. Full paginated job and check-run readback at `2026-11-03T03:49:29.571429+00:00` independently confirms:

| Evidence | Result |
|---|---|
| Workflow jobs | **74 successful, 0 failed, 0 pending** |
| Commit check-runs | **74 successful, 0 failed, 0 pending** |
| Reviews | 5 inline threads resolved; 0 unresolved; all 7 reviews and 3 issue comments read |
| Fresh Greptile rating | Absent; historical 5/5 explicitly reviews `3573f4a6` |
| Main | `c8307c987088b174a42623635753bb2e27a9ac6b`, already included and unchanged at final readback |
| Queue | Empty; approved-only #1377 conflicts with main before this candidate |

The [Node24 examples-2 job](https://github.com/Parcha-ai/agentrun/actions/runs/41572842831/job/125709510912) passed all 162 tests; its actual log confirms the earlier carry-count case passed. Every native durable leg, compatibility leg, console gate, verify gate and Lean job succeeded.

The prior `23bf2743` workflow ended with 70 passed and four failed jobs: one examples carry-count assertion plus three downstream verify gates. Its clean-main Node24 diagnostic runs passed and did not establish a failure cause. That historical diagnosis and baseline evidence are preserved separately. They are not the current candidate's CI result.

The current head adds only test/changelog changes over the production-proved `23bf2743`. The root's complete diff receipt confirms identical runtime/UI source, build inputs, package manifests, dependency locks and declarations. This read-only monitor ran no new feature suite, baseline search or reproduction, changed no source/index/head, and issued no CI rerun, review trigger, approval, merge, PR comment or Slack message. The owned local monitor stopped after terminal success was verified.
