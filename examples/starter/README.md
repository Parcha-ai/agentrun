# Research evidence in your own TypeScript app

**Can we require documentation approval without blocking emergency fixes?**

Keep the policy and its emergency exception. Drop the marketing claim. If no evidence survives, stop and ask for more research.

```text
Search → Jev screens each passage → Return the evidence
                     │
                     └─ No evidence? Stop.
```

This app uses the real interpreter and Jev adapter with fictional documents and an injected, scripted client. It needs no agent, API key or model access. It tests execution, not the quality of real Jev decisions.

## Install outside the checkout

Requires Node 22.19+ and npm. The packages are not published yet. From the AgentRun repository root:

```sh
npm ci --ignore-scripts
npm run build
agentrun_checkout="$PWD"
mkdir -p .release/npm
npm pack --workspace @parcha/agentrun-dsl --ignore-scripts --pack-destination .release/npm
npm pack --workspace @parcha/agentrun-jev --ignore-scripts --pack-destination .release/npm
cp -R examples/starter ../my-evidence-workflow
cd ../my-evidence-workflow
npm install --ignore-scripts \
  "$agentrun_checkout/.release/npm/parcha-agentrun-dsl-0.1.0-beta.1.tgz" \
  "$agentrun_checkout/.release/npm/parcha-agentrun-jev-0.1.0-beta.1.tgz"
npm test
npm start
```

Choose an unused destination directory. Install both tarballs together so npm resolves the unpublished DSL dependency locally. These are regular installed packages, not workspace links. Keep the tarballs available for later `npm ci`: npm records their paths in this app's lockfile. Commit the generated lockfile with your application.

The output retains `review-policy` and `incident-policy`, then prints:

```text
2 passages retained. The exception stays with the rule.
```

After installation, all commands above except installation itself run offline. The four tests cover retained evidence, missing evidence, invalid input before search, and the evidence selector alone.

```sh
npm start -- --no-evidence
```

This returns `Needs research: ...` and exits with code `2`. No report is invented.

## Make a change

In `src/workflow.ts`, change `gte: 0.8` to `gte: 0.99`, then run `npm run build && npm start`. The scripted probabilities are `0.95`, so the same workflow now stops. Restore `0.8` before running the unchanged tests.

- `src/workflow.ts` defines the contracts, evidence rubric and stop condition.
- `src/offline.ts` supplies fictional search results and fixed Jev answers. Changing a question or rubric does **not** make these fixtures adapt.
- `src/main.ts` runs the workflow and receives a typed list of sources.
- `src/workflow.test.ts` tests the whole workflow and the screening step separately.

## Connect real evidence

Replace `runEffect` with your search implementation, returning `{ sources: [{ id, text }] }`. Replace the injected client with `createJevRunner()` after configuring `TYPESAFE_API_KEY` or your approved transport. Keep search results and their original source identifiers; Jev selects evidence, it does not fetch or authenticate sources.

Evaluate the rubric and threshold against independently labeled passages before relying on real decisions. This workflow returns evidence, not a verified answer. You can pass its output to a writing agent or reuse the workflow inside a larger research map.

The checkout's `docs/authoring.md` explains composition and `packages/jev/README.md` documents transport and cancellation options. The app imports only the published package entry points and can be moved outside the checkout.
