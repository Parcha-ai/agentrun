# Merge preservation review

Candidate `d9ff826df3195a2fb94530ad95d39186168341c8`, main `bc18a59f7d7275726ec42cd70d4adca96140493d`.

- App keeps provider-owned typed capabilities, session identity/generation remounting and client cache/auth invalidation. It does not restore a duplicate capabilities request or the old capability cast.
- Active and archived agent name lists are paginated. Explicit `agents.list:false` skips and clears the lookup; `archive.agents:false` skips the unsupported archived listing. Newest-read and cleanup guards discard stale results. Partial failures preserve successful names and keep missing names unknown until the lookup is complete.
- The upstream create/run regression follows administration → exact pinned API playground → native request → run detail, preserving the chosen administration design. Archived-agent and partial-archived-read tests remain.
- Native upload preparation, workspace cwd, keyless-search wiring and timeline recovery changes coexist with the unchanged additive result/file-availability summaries. OpenAPI and generated console types contain uploads and both optional nullable availability fields. README retains upload `file_ids` and accurate bounded-metadata-scan documentation.
- No substantive merge preservation regression was found in this bounded source review. Local focused proof: 41 App/provider/playground tests and typecheck passed during resolution. Root subsequently reported all 400 console tests and typecheck passing at this head. Earlier 01970/12fc browser/native/container receipts are historical until the new build is proven.
