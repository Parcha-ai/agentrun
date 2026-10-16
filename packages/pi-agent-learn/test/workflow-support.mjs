import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceFiles } from "@parcha/agentrun-dsl/recovery";
import { createWorkflowExtension } from "@parcha/agentrun-pi/durable";
import { WorkflowStore } from "@parcha/agentrun-pi/workflows";
import { scratch } from "./support.mjs";

/**
 * A workflow with no code in it: it escalates when `amount` reaches `limit`, else asks one tool for a quote. A new `limit`
 * is a new document and so a new digest. `country` adds a required field with an enumeration.
 */
export function workflowDoc({ name = "registry-lookup", limit = 100, country = false, code = false } = {}) {
  return {
    v: 2, name,
    schemas: {
      In: {
        type: "object", additionalProperties: false,
        required: ["sku", "amount", ...(country ? ["country"] : [])],
        properties: {
          sku: { type: "string" }, amount: { type: "number", minimum: 0, maximum: 1000 },
          ...(country ? { country: { enum: ["us", "ca"] } } : {}),
        },
      },
      Quote: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Quote", path: "quote" },
    root: {
      node: "chain",
      steps: [
        { node: "escalate", label: "too big", when: { predicate: "gte", path: "amount", n: limit }, kind: "review", stage: "gate", summary: "needs a person" },
        { node: "call", label: "quote", via: "tool", tool: "prices.quote", args: { sku: "{sku}" }, out: "Quote", as: "quote", deadline_s: 20 },
        ...(code ? [{ node: "code", label: "double", code: "s => ({ doubled: s.quote.price * 2 })" }] : []),
      ],
    },
  };
}

/** A run's working directory holding `workflows` (name to document) in the DSL's own store; returns the directory. */
export async function workDirWith(workflows = {}) {
  const dir = path.join(await scratch(), "work");
  await mkdir(dir, { recursive: true });
  const store = new WorkflowStore(dir);
  const saved = {};
  for (const [name, doc] of Object.entries(workflows)) saved[name] = (await store.save(name, doc)).digest;
  return { dir, store, saved };
}

/**
 * One curate pass over main: the checkout curate would make, what `fn` writes into it, and one commit of exactly the files
 * `fn` returns as changed (a null deletes). Returns the new main, and `fn`'s result.
 */
export async function curateStep(repo, fn, message = "curate") {
  await repo.fetch();
  const main = await repo.resolve("main");
  const dir = path.join(await scratch(), "checkout");
  await mkdir(dir);
  await repo.checkout("main", { into: dir });
  const result = await fn(dir);
  const files = result.files ?? {};
  if (!Object.keys(files).length) return { sha: main, result };
  const { sha } = await repo.commitTo("main", { files, message });
  await repo.push(sha, "main");
  return { sha, result };
}

/**
 * A finished run's store file: one workflow task per entry of `runs`, run by the DSL's durable host with a tool that answers or,
 * for `fail`, is down. `stop: "pause"` leaves the task pending, `stop: "cancel"` ends it aborted, `again` starts a finished key once more. Returns the file.
 */
export async function runStoreWith(runs) {
  const root = await scratch();
  await mkdir(path.join(root, "store"));
  await mkdir(path.join(root, "cwd"));
  const file = path.join(root, "store", "run.sqlite");
  const failing = new Set(runs.filter((run) => run.fail).map((run) => run.key));
  const flow = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(path.join(root, "cwd")) }),
    run: ({ key }) => ({ adapters: { runEffect: async () => { if (failing.has(key)) throw new Error("the registry is down"); return { price: 21 }; } } }),
  });
  const registry = createRegistry();
  registry.install(flow.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry, models: {} }, ctx);
  try {
    for (const run of runs) {
      const started = await flow.start(harness, { key: run.key, workflow: run.workflow, input: run.input }, ctx, run.stop ? { stop: { action: run.stop, source: "test" } } : undefined);
      if (run.stop === "pause") {
        let answer = "not-live";
        for (let i = 0; i < 200 && answer === "not-live"; i += 1) {
          answer = await flow.stop(harness, run.key, "pause", ctx);
          if (answer === "not-live") await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } else {
        await started.wait(ctx);
        if (run.again) await (await flow.start(harness, { key: run.key, workflow: run.workflow, input: run.input }, ctx)).wait(ctx);
      }
    }
  } finally {
    await harness.close(ctx);
  }
  return file;
}
