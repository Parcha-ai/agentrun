# PR1408 read-only stack trial

Checked: 2026-11-02 17:02:51 PST. Public `ship-pr` step 6; syntax/merge trial only, not runtime or CI qualification.

- Candidate: [#1408](https://github.com/Parcha-ai/agentrun/pull/1408), `0d1fb055e1263e0bce99af1fc87bbca6415c941e`; 75 changed paths.
- Fresh `origin/main`: `1961a96fcbbfbe89d5b5e0de9704289d2538037d`. It is the candidate's merge base and ancestor; **0 new main commits, no new main file changes touching this PR**.
- Enumerated all open PRs and all queue entries without pagination remaining: **12 approved PRs, the same 12 queued PRs**. Every complete file list and head was rechecked against the queue snapshot.
- Candidate against current main: `git merge-tree --write-tree` **exit 0**, tree `8bb7f908c755158250e3508bbd051e0085e1e4e2`.
- Result is a **named future merge gate**, not a current implementation failure: the candidate conflicts after queued #1400 lands. No source was integrated from an unmerged PR.

## All approved/queued heads

| Queue | PR / title | Pinned head | Changed / shared paths | Candidate after that PR |
|---|---|---|---|---|
| 1 (AWAITING_CHECKS) | [#1400](https://github.com/Parcha-ai/agentrun/pull/1400) fix(console): an agent made here shows its name at once | `bcecd9010d717cea1fdcddbef173dcd4bf1b70b4` | 3 / 2 | CONFLICT (exit 1) |
| 2 (MERGEABLE) | [#1399](https://github.com/Parcha-ai/agentrun/pull/1399) docs(serve): the console's build is the root build's, and a webhook may reach your own machine or network | `c3da329e96fd6c0ffab5f2265a382f573a7654d8` | 4 / 1 | CLEAN (exit 0) |
| 3 (AWAITING_CHECKS) | [#1387](https://github.com/Parcha-ai/agentrun/pull/1387) fix(scripts): a script's command line refuses, loudly, on a Node with no import.meta.main | `d8f0bfa63f750623e2760b02b18ac9521d4ce04a` | 26 / 1 | CLEAN (exit 0) |
| 4 (MERGEABLE) | [#1358](https://github.com/Parcha-ai/agentrun/pull/1358) fix(pi-durable-agent, serve): a workflow's decision requests count in its run metrics | `ca4cc5b3f10855de032e3327795faca8bec18e1f` | 8 / 0 | CLEAN (exit 0) |
| 5 (UNMERGEABLE) | [#1401](https://github.com/Parcha-ai/agentrun/pull/1401) test(serve): an adopted run's wait counts webhook-ids, not receipts | `9b843648fa95a411c209276d7b862c4443ef369c` | 1 / 0 | CLEAN (exit 0) |
| 6 (AWAITING_CHECKS) | [#1376](https://github.com/Parcha-ai/agentrun/pull/1376) fix(serve): one number per imported run, every subagent request counted once | `d79e4b099cc5e5683a2a5ff353cb6178c1cbf8fe` | 5 / 0 | CLEAN (exit 0) |
| 7 (AWAITING_CHECKS) | [#1403](https://github.com/Parcha-ai/agentrun/pull/1403) fix(adapters, serve): the Claude and Codex CLIs run in the run's workspace, and tool errors name paths relative to it | `efbcfcc36acd5ed71858aebabd1419db17000d7f` | 17 / 0 | CLEAN (exit 0) |
| 8 (AWAITING_CHECKS) | [#1406](https://github.com/Parcha-ai/agentrun/pull/1406) fix(serve): a stop works on a run that is working but still reads queued | `f5d12649e9599f1b462b93e803b724ddfc5b6c65` | 5 / 0 | CLEAN (exit 0) |
| 9 (QUEUED) | [#1404](https://github.com/Parcha-ai/agentrun/pull/1404) feat(serve): web_search on pi with no key, through Exa's keyless endpoint | `485debedf3928a189cdecebe95d06adef0984210` | 15 / 0 | CLEAN (exit 0) |
| 10 (QUEUED) | [#1323](https://github.com/Parcha-ai/agentrun/pull/1323) feat(serve): uploads: a file reserved and sent through the API, and a run's file_ids copied into its workspace | `ffd4037845fff8b971a7f4d27b7693365ab6858b` | 10 / 3 | CLEAN (exit 0) |
| 11 (QUEUED) | [#1321](https://github.com/Parcha-ai/agentrun/pull/1321) feat(codex): an option turns on Codex's own web search, live, admitted by the model proxy and booked per search | `06c9af5a797767bf5f3a5902d3e9eb9cf304227b` | 12 / 0 | CLEAN (exit 0) |
| 12 (QUEUED) | [#1402](https://github.com/Parcha-ai/agentrun/pull/1402) fix(timeline): an interrupted call sits after its call, so a relaunched run that answered ends | `d42565b7185efdf50ef1bde8156792de9e7ede26` | 3 / 0 | CLEAN (exit 0) |

Every individual earlier PR also merges cleanly onto the pinned main before the candidate is tested. These independent pair trials cover all 12, including the final queue item that the combined trial cannot reach.

## Shared paths

- **#1400:** `apps/console/src/App.test.tsx`, `apps/console/src/App.tsx`.
- **#1399:** `packages/serve/src/page.ts`.
- **#1387:** `scripts/build-console.mjs`.
- **#1323:** `packages/serve/src/openapi.ts`, `packages/serve/src/page.ts`, `packages/serve/test/openapi.test.mjs`.

## Actual combined trials

- Full queue order was **1400 → 1399 → 1387 → 1358 → 1401 → 1376 → 1403 → 1406 → 1404 → 1323 → 1321 → 1402**.
- Queue positions **1–10 merged cleanly** using `merge-tree --write-tree` and unreferenced `commit-tree` objects with both parents.
- Position **11, #1321**, then returned exit 1 in `packages/run-adapters-codex/README.md`; this happens **before #1408 is applied**. Position 12 and an all-12 final candidate merge were not claimed or fabricated.
- Applying #1408 after the complete clean prefix (positions 1–10) returns exit 1 in `apps/console/src/App.tsx`.
- The overlapping-only trial **1400 → 1399 → 1387 → 1323** was clean for all four earlier PRs; appending #1408 returned the same App.tsx conflict.

## Future conflict with #1400

**[fix(console): an agent made here shows its name at once](https://github.com/Parcha-ai/agentrun/pull/1400)** refreshes names when run views open, reads both active and archived agents, discards superseded reads, retains partial successful names, and shows an ID only once a complete name lookup proves the agent absent. Its added cases cover a newly created agent without reload, an archived agent, and an archived-list failure.

The candidate also refreshes names after navigation, but its shared-provider extraction, capability gates, synchronous hash/address state and fallback differ. `App.test.tsx` auto-merges textually; its #1400 embedded-run-bar scenario must still be adapted to the candidate's API-playground administration flow.

Actual conflicting hunks from merge-tree output (the left marker names an unreferenced main+#1400 trial commit; the right names #1408):

### App.tsx trial-tree lines 140–179

```tsx
<<<<<<< a2f9f043e66854a335652b0f385a77c2e7f57c79
  const go = (hash: string) => { location.hash = hash; };
  useEffect(() => { const on = () => setWhere(route()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => { v2.capabilities().then(setCaps).catch(() => {}); }, [v2]);
  // The agents' names, every page of the active ones and of the archived: read at the start, and again each time a runs
  // view opens (the list, one agent's runs, a run's page), so an agent made since, here or elsewhere, is named at once.
  // Only the newest read lands.
  useEffect(() => {
    if (namesAsked.current && where.section !== "runs") return;
    const n = ++namesAsked.current;
    setNamesRead(false);
    void Promise.allSettled([false, true].map((archived) => allPages((cursor) => v2.listAgents({ archived, cursor }), (p) => p.agents))).then((reads) => {
      if (n !== namesAsked.current) return;
      const fresh = Object.fromEntries(reads.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((x) => [x.agent_id, x.definition.name ?? x.agent_id]));
      // Each read's answer is kept. Both landed: the names are theirs. One failed: what came back goes over the names
      // held, and the lookup is not complete, so a name it lacks (an agent the failed read would have named) shows as
      // nothing yet, never as an id read as gone; the next runs view reads again.
      const whole = reads.every((r) => r.status === "fulfilled");
      setNames((held) => (whole ? fresh : { ...held, ...fresh }));
      setNamesRead(whole);
    });
  }, [v2, where]);
=======
  const go = (hash: string) => { location.hash = hash; setAddress(hash); };
  useEffect(() => { const on = () => setAddress(location.hash); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => {
    if (!caps || caps.features.agents?.list === false) return;
    // Every page of agents, for their names.
    (async () => {
      const all: Record<string, string> = {};
      for (let c: string | null | undefined = undefined, i = 0; i < 50; i++) {
        const page = await v2.listAgents({ cursor: c });
        for (const x of page.agents) all[x.agent_id] = x.definition.name ?? x.agent_id;
        if (!page.next_cursor) break;
        c = page.next_cursor;
      }
      setNames(all);
    })().catch(() => {});
  }, [v2, caps, where.section, where.agent, where.run]);
>>>>>>> 0d1fb055e1263e0bce99af1fc87bbca6415c941e
```

### App.tsx trial-tree lines 189–197

```tsx
<<<<<<< a2f9f043e66854a335652b0f385a77c2e7f57c79
  }, [v2, where]);
  // A name the lookup lacks while a read of it is under way shows as nothing yet, never as the id.
  const agentName = (id: string) => names[id] ?? (namesRead ? id : "");
  const c = caps as unknown as { harnesses: EditorCaps["harnesses"]; tools?: unknown; features?: { thinking?: string[] }; models?: { default?: string; source?: string } } | null;
=======
  }, [v2, where, caps]);
  const agentName = (id: string) => names[id] ?? id;
>>>>>>> 0d1fb055e1263e0bce99af1fc87bbca6415c941e
```

### Resolution plan after #1400 reaches main

1. Fetch main and integrate it under the owner's branch policy; do not copy or cherry-pick unmerged #1400 into the current branch. Recheck all pinned queue heads first.
2. Keep #1408's `AgentRunProvider` as the capability/session owner; keep synchronous `address`/`go` navigation and the `caps` dependencies/explicit list restrictions. Do not restore the old `setWhere`, private `setCaps`, duplicated capability fetch or cast-only capability model.
3. Preserve #1400's behavior within that provider scope: active and supported archived pagination, newest-request guard, complete-versus-partial names state, merging partial successful results and distinguishing loading/unknown from a proven missing agent. Do not query explicitly unsupported agent/archive lists; an incomplete lookup must not imply an agent is gone. Keep session-generation invalidation and state reset.
4. Preserve all three name regressions. Adapt the new-agent case to create → exact pinned API playground → run detail; retain archived-name and partial-list-failure cases, plus existing capability/session/pinning tests.
5. Run affected App/provider/playground tests, console typecheck/build and native auth/client checks. Regenerate the OpenAPI client and dependency inventory if the refreshed main includes #1323 or other schema/package changes. Repeat the full queued stack trial and CI on the new candidate SHA before a merge handoff.

## Unrelated queue conflict

**[#1321 — feat(codex): an option turns on Codex's own web search, live, admitted by the model proxy and booked per search](https://github.com/Parcha-ai/agentrun/pull/1321)** is individually clean against main and against #1408. In the actual preceding queue stack, it conflicts in `packages/run-adapters-codex/README.md`, where its live-web-search documentation meets earlier queued workspace/cwd documentation. That path is **not changed by #1408**. The earlier queue owners should reconcile those descriptions and revalidate the queue; this is separate from the #1400 future gate.

## Reproduction/evidence

Commands executed through git plumbing (no checkout, index merge, branch rewrite, push, approval or external message):

```sh
git fetch --no-tags origin main
git merge-tree --write-tree <pinned-main-or-trial-commit> <pinned-earlier-head>
git commit-tree <clean-tree> -p <previous-trial> -p <earlier-head> -m "Temporary read-only stack trial"
git merge-tree --write-tree <clean-trial-commit> 0d1fb055e1263e0bce99af1fc87bbca6415c941e
```

- Complete file lists/head metadata: [stack-prs.json](stack-prs.json).
- All-open approval and queue-order snapshot: [stack-snapshot.json](stack-snapshot.json).
- Every merge exit code, tree hash, temporary commit hash, raw conflict output and extracted hunk: [stack-trial.json](stack-trial.json).
- HEAD remains `0d1fb055e1263e0bce99af1fc87bbca6415c941e`; tracked worktree status remained unchanged. Only temporary local objects/FETCH_HEAD were used.
- Main or queue movement invalidates this snapshot; refresh before acting.
