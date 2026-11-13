// A workflow run on the runner whose store fails a commit while a model node's attempt is out (a commit refused as an
// fsync failure, SQLITE_IOERR_FSYNC). The DSL's recovery driver admits the node's next attempt only after its record is
// durable, so the flush before that attempt fails, and the node runner is not called again in this process: a model node
// run twice is a model request paid twice. The control case shows the same node is retried when the store is healthy, so
// the count of one is the failure's doing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { nodeRunner } from "../dist/workflow/node-runner.js";
import { taskScope } from "../dist/workflow/node.js";
import { storeOn } from "./store-helpers.mjs";
import { answerFlow, FAUX } from "./support.mjs";

const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { runModels, FAUX_ENV } = await import("../dist/model.js");

const INPUT = { question: "What is six times seven?" };

/** An error shaped like node:sqlite's for a commit whose fsync failed. */
const fsyncFailed = () => Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 1034, errstr: "disk I/O error" });

/** `journal` whose commits throw as an fsync failure once `state.failing` is set; it counts the commits it refused. */
const failingJournal = (journal, state) => new Proxy(journal, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "commit") return async (...args) => {
      if (state.failing) {
        state.refused += 1;
        throw fsyncFailed();
      }
      return value.apply(target, args);
    };
    return typeof value === "function" ? value.bind(target) : value;
  },
});

/** `promise`, or a rejection when it has not settled within `ms`. */
const within = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

/** One claimed run of a one-node workflow, its loop's model node failing its first attempt after `onFirst(state)`. */
async function runWithFirstAttemptFailing(t, onFirst) {
  const { store } = await storeOn(t);
  const workflow = answerFlow();
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const state = { failing: false, refused: 0, runs: 0 };
  const specOf = async () => {
    const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
    return {
      models, workflow, input: INPUT, tools: inspectWorkflow(workflow).requires.tools, agentId: "agent-1", revisionId: "rev-1",
      build: () => {
        const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
        return {
          extensions: [nodes.extension],
          host: { run: ({ runtime, context }) => {
            const runNode = nodes.on(taskScope(runtime), context).runNode;
            return { durableNodes: true, adapters: { runNode: async (params) => {
              state.runs += 1;
              if (state.runs === 1) {
                onFirst(state);
                throw new Error("the first attempt failed");
              }
              return runNode(params);
            } } };
          } },
        };
      },
    };
  };
  const loop = createWorkflowLoop(specOf)({
    journal: (held) => failingJournal(store.journal(held), state),
    flush: async () => {
      if (state.failing) throw fsyncFailed();
      return store.flush();
    },
    signal: new AbortController().signal,
  });
  const settled = await within(loop.start(claim).then((outcome) => ({ outcome }), (error) => ({ error })), 30_000, "the loop's start");
  return { state, settled, run: await store.runs.get("run-1") };
}

test("control: on a healthy store a model node whose first attempt fails is run again, and the run ends", async (t) => {
  const { state, settled, run } = await runWithFirstAttemptFailing(t, () => {});
  assert.equal(state.runs, 2, "the node's second attempt ran");
  assert.deepEqual(settled.outcome, { state: "ended" }, JSON.stringify(settled.error?.message ?? settled.outcome));
  assert.equal(run.summary, "answer");
});

test("a store commit that fails while a model node's attempt is out: the node runner is not called again, and the run does not end completed in this process", async (t) => {
  const { state, settled, run } = await runWithFirstAttemptFailing(t, (s) => {
    s.failing = true;
  });
  assert.ok(state.refused >= 1, "the store refused a commit after the failure");
  assert.equal(state.runs, 1, "the node runner is not called for the next attempt");
  assert.notEqual(run.summary, "answer", `the run does not end with the node's answer: ${JSON.stringify({ run: [run.state, run.outcome, run.summary], settled: settled.error?.message ?? settled.outcome })}`);
});
