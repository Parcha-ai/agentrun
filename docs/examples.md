# Runnable examples

Start with the [support quickstart](../README.md#quickstart). All examples below use fictional inputs and scripted adapters by default. They exercise the interpreter without model credentials; they do not measure model quality.

After `npm ci --ignore-scripts` and `npm run build`:

| Example | Run | What to change |
| --- | --- | --- |
| [Support answers](support-quickstart.md) | `npm run demo:support` | Connect your search tool and agent; check an answer before returning it. |
| [Typed research](authoring.md) | `npm run demo` | Reuse one research component across questions and stop when evidence is missing. |
| [Standalone TypeScript app](../examples/starter/README.md) | Follow the app's install steps, then `npm test` and `npm start` | Build outside this checkout with public package imports. |

Each example includes a failure or uncertainty path. `npm run demo:support -- unresolved` and `npm run demo -- --no-evidence` exit with code `2` after escalation.

To connect models, follow [support integration](support-quickstart.md) or [research integration](live-research.md). Your application supplies tool permissions, credentials and cancellation. Scripted answers remain fixed when you edit a prompt.
