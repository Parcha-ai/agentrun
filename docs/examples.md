# Runnable examples

Start with the [support quickstart](../README.md#quickstart). All examples below use fictional inputs and scripted adapters by default. They exercise the interpreter without model credentials; they do not measure model quality.

After `npm ci --ignore-scripts` and `npm run build`:

| Example | Run | What to change |
| --- | --- | --- |
| [Support answers](support-quickstart.md) | `npm run demo:support` | Connect your search tool and agent; check an answer before returning it. |
| [Typed research](authoring.md) | `npm run demo` | Reuse one research component across questions and stop when evidence is missing. |
| [Rank a list](../examples/rank-candidates.mjs) | `npm run demo:rank` | Score candidates against your brief, drop duplicates, cap each bucket, keep the top k; call it from another workflow. |
| [Standalone TypeScript app](../examples/starter/README.md) | Follow the app's install steps, then `npm test` and `npm start` | Build outside this checkout with public package imports. |

The ranking example is a reusable workflow built from existing nodes, not a node of its own. A `sift` scores every candidate with a leveled question, and the continuous score in `<as>.answers[i].answers.<question>.score` orders them. Sorting, the minimum score, per-bucket quotas and the cut-off are a `code` step. A second `sift` over pairs finds near-duplicates. A long list needs no batching in the workflow: a `sift` over the host's per-request limits splits itself. `npm run demo:rank -- --live --input request.json` ranks your own list with Jev.

Each example includes a failure or uncertainty path. `npm run demo:support -- unresolved` and `npm run demo -- --no-evidence` exit with code `2` after escalation.

To connect models, follow [support integration](support-quickstart.md) or [research integration](live-research.md). Your application supplies tool permissions, credentials and cancellation. Scripted answers remain fixed when you edit a prompt.
