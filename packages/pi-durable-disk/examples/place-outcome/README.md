# place-outcome: how a run ended

A supervisor of your own needs to know how a run ended without learning the package's vocabulary. A place (`localPlace`
here, `archilPlace` on a disk) starts a run's instance and, when it ends, says how: a `PlaceOutcome`. Its `status` is the
run's word, `complete` when the run finished and delivered a record and `failed` for anything else, with the generation, the
app's `record`, or its `code` and `message`, and the `models` the run used.

This example runs two runs through `localPlace`. One delivers a result and one gives up, and the outcomes say so.

No disk, no key: `localPlace` runs `pi-durable-disk run --dir` as a child on a directory of this machine, and the model is
pi-ai's faux provider. It needs `@parcha/pi-durable-disk` 0.1.0-beta.16 or later (a failed run's models in its outcome first
shipped in it), on Linux with Node 22.19 or later.

## The code

Two files, `main.ts` (the supervisor) and `app.ts` (the app the instance runs). A test keeps both copies identical to the
files.

`main.ts`:

```ts
// A place's outcome: how a run ended, in the run's own words. `localPlace` starts the run as an instance on a directory of
// this machine (`pi-durable-disk run --dir`), and when it ends its `exited` carries a `PlaceOutcome`: `complete` when the
// run finished and delivered a record, `failed` for anything else, with the generation, the app's record or its code and
// message, and the models it used. No disk, no key. The app is app.ts, beside this file.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localPlace } from "@parcha/pi-durable-disk";
import type { PlaceOutcome } from "@parcha/pi-durable-disk";

const base = join(process.cwd(), "place-outcome-run");
rmSync(base, { recursive: true, force: true });
console.log(`the runs are under ${base}`);

const app = fileURLToPath(new URL("./app.ts", import.meta.url));
const ended: Record<string, PlaceOutcome | undefined> = {};
for (const [name, env] of [["delivers", {}], ["gives up", { GIVE_UP: "1" }]] as const) {
  const root = join(base, name.replace(" ", "-"));
  const place = localPlace({ app })({ paths: { id: name.replace(" ", "-"), root, work: join(root, "work"), store: join(root, "store") } });
  const runner = await place.start({ gen: 1, env });
  const exit = await runner.exited; // the instance's exit, and its outcome
  await place.release();
  console.log(`${name}: exit ${exit.exit}, outcome ${JSON.stringify(exit.outcome)}`);
  ended[name] = exit.outcome;
}

const { delivers, "gives up": gaveUp } = ended;
const models = { lead: "faux-1" };
if (
  delivers?.status !== "complete" || delivers.generation !== 1 || JSON.stringify(delivers.record) !== '{"total":42}' || JSON.stringify(delivers.models) !== JSON.stringify(models) ||
  gaveUp?.status !== "failed" || gaveUp.code !== "GAVE_UP" || gaveUp.message !== "no total could be made" || JSON.stringify(gaveUp.models) !== JSON.stringify(models)
) {
  console.error(`not ok: ${JSON.stringify(ended)}`);
  process.exit(1);
}
console.log("ok: two runs, two outcomes: the one that delivered is complete with its record, the one that gave up is failed with its code and message, and both name the models they used");
```

`app.ts`:

```ts
// The app a place's instance runs (`pi-durable-disk run --app app.ts`): one turn of pi-ai's faux model, then the run's last
// word. An app that wants its supervisor to have its result puts it in that last status: `record` is the result, `models`
// the models it used, and a run that gives up says why in `code` and `message`.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { AppOptions } from "@parcha/pi-durable-disk";

export default function app(): AppOptions {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("The invoice total is 42.")));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return {
    models,
    registry: createRegistry(),
    async onOpen(run) {
      const chat = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
      await (await chat.submit({ type: "input", content: "Total the invoice", requestId: "job-1" }, ctx)).wait(ctx);
      const used = { lead: model.id };
      if (process.env.GIVE_UP) await run.setStatus("failed", { code: "GAVE_UP", message: "no total could be made", models: used });
      else await run.setStatus("done", { record: { total: 42 }, models: used });
      await run.release();
      process.exit(0);
    },
  };
}
```

## Run it

**From an install** (an empty directory; save both files from GitHub at the tag of the version you installed):

```sh
npm init -y && npm pkg set type=module
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
# save main.ts and app.ts here, then
node main.ts
```

**From a checkout:**

```sh
npm ci --ignore-scripts && npm run build   # once, from the repository root; builds dist/
cd packages/pi-durable-disk
node examples/place-outcome/main.ts        # about two seconds
```

It writes `place-outcome-run/` under the current directory and prints:

```
the runs are <this directory>/place-outcome-run
delivers: exit 0, outcome {"status":"complete","generation":1,"code":null,"record":{"total":42},"models":{"lead":"faux-1"}}
gives up: exit 0, outcome {"status":"failed","generation":1,"code":"GAVE_UP","message":"no total could be made","models":{"lead":"faux-1"}}
ok: two runs, two outcomes: the one that delivered is complete with its record, the one that gave up is failed with its code and message, and both name the models they used
```

## How it works

- `localPlace({ app })` returns `(ctx) => Place`. `ctx.paths` is the run's id and directory as the supervisor computed them.
  `place.start({ gen, env })` starts the instance as a child in its own process group, with only `PATH` and the order's `env`,
  and `runner.exited` settles when it ends, with its exit and its `outcome`. `place.release()` stops anything still running.
- The outcome is the instance's `{"outcome":...}` line on stdout when it prints one, else `run.json` as the run left it. This
  app prints none, so it is `run.json`'s: the app's last `setStatus` carries the result. `done` with a `record` is `complete`;
  `failed`, or `done` with no record, is `failed`. An app that wants its supervisor to have its result puts it in that last
  status, and the models it used under `models` (kept only when they are a plain object of strings).
- The faux model answers one turn so the run has something to deliver; the supervisor never sees the conversation, only
  the outcome.

## What it does not show

On a disk, `archilPlace` reads the same outcome from `run.json` over S3, because a box's stdout is out of reach, and
`status()`, the takeover and `recordHome` are there too ([Places](../../docs/reference.md#places-where-a-runs-instance-starts-and-ends)).
A place is also what a supervisor kills and brings back, which this example does not do.
