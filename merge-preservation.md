# Merge preservation review

Candidate `23bf2743349e38461601fd6e959d6801b99df46e`, including main `0ca81bce2d7cf7db398080efe2427d296a552a4d`.

The completed ordinary main merges preserve both the administration console and the native server changes. No unmerged PR implementation was imported, no history rewrite was used, and no registry release or deployment was performed.

- Provider-owned typed capabilities, session identity/generation remounting and client cache/auth invalidation remain. Active and archived name lists are paginated with capability restrictions, newest-read guards, successful partial results and explicit unknown names. The create/run regression follows administration → pinned API playground → native request → run detail.
- Native uploads, workspace paths, keyless search, metrics, timeline recovery and Stop/webhook corrections coexist with additive optional nullable result/file availability. Generated console types include the current native home-path identity restrictions. Existing HTTP run-summary regression strictly asserts all keys and actual completed/failed availability values.
- Both static and library builds use one guarded emitter calling canonical `noticesFor`. Actual chunk modules, asset provenance and explicit font roots supply notices; OFL filenames and Windows path separators are covered. Dependency allowlists, missing-license refusal, private emitted-text checks, exact manifest/copying and both source-hash input sets remain.
- Installed native-console checks retain exact manifest/assets plus React, ReactDOM, each font and native NOTICE assertions. Native serve/decisions follow upstream’s reviewed release policy. The new UI library remains `private: true`; build, pack and verify commands do not publish.

Independent source review found and corrected one Windows font-root parsing concern, with its nearest existing regression observed red then green. All twelve reviewed packaging source files match the final committed bytes. Focused packaging checks passed 56/56 before the final contract regeneration; final 400-test console suite, typecheck, current-contract check, strict installed UI consumer and fresh public source verification passed afterward. Clean public container checks passed 8/8 at the final commit. Full repository/CI gates are tracked separately in [gate status](gate-status.md).

The older App/README preservation review at `d9ff826d` is included above semantically; its prior receipt did not qualify the later packaging changes. Fresh queue and reviewer snapshots are in [stack trial](stack-trial.md) and [review report](review-report.md).
