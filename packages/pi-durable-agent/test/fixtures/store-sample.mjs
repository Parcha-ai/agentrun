// A small agent store for looking at `pi-durable-agent serve` on a store, written through the store's own API: three
// agents, the first with three revisions (A agentic with prompt A, B agentic with prompt B, C a workflow), runs in every
// state, one with no cost, one still running and one whose directory is gone. Each workflow run is run for real with
// scripted tools, as a host runs one, so ./workflow's readWorkflowRun reads it from its own store.
// `node test/fixtures/store-sample.mjs <dir>` builds it in <dir>/my-agents and serves it, printing the address.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceFiles } from "@parcha/agentrun-dsl/recovery";
import { createWorkflowExtension } from "@parcha/agentrun-pi/durable";
import { openStore } from "../../dist/index.js";
import { runWorkflowRevision } from "../../dist/workflow.js";
import { append, assistant, call, research, user } from "./serve-sample.mjs";

export const PROMPT_A = [
  "You research one company and write a short brief about it.",
  "Start with a web search for the company's name.",
  "Read its own site and one news page.",
  "Write brief.md: what it does, its size, its latest news.",
].join("\n");
export const PROMPT_B = [
  "You research one company and write a short, cited brief about it.",
  "Start with a web search for the company's name.",
  "Read its own site, its investor or filings page, and one news page.",
  "Write brief.md: what it does, its size, its latest news.",
  "Cite every fact to a page you fetched; say so when a fact has no page.",
].join("\n");
/** In a skill's text, which serve never sends. */
export const SKILL_MARKER = "SKILL-TEXT-MARKER-5512";

const object = (required, properties) => ({ type: "object", required, properties });
const SCHEMAS = {
  In: object(["site"], { site: { type: "string" } }),
  Page: object(["kind"], { kind: { enum: ["public", "private"] }, employees: { type: "number" } }),
  Filing: object(["brief"], { brief: { type: "string" } }),
  Answer: object(["code"], { code: { type: "string" } }),
};
const step = (label, tool, as, out, args = { site: "{site}" }) => ({ node: "call", label, via: "tool", tool, args, out, as, deadline_s: 30 });
const workflow = (name, output, steps) => ({ v: 2, name, schemas: SCHEMAS, input: { schemaId: "In" }, output, root: { node: "chain", steps } });

export const BRIEF_WORKFLOW = workflow("company-brief", { schemaId: "Filing", path: "filing" }, [
  step("Read the site", "web.fetch", "page", "Page"),
  { node: "route", label: "Jev: public or private", valuePath: "page.kind", branches: {
    public: { body: step("Check the filing", "filings.search", "filing", "Filing") },
    private: { body: { node: "escalate", label: "No public record", when: { predicate: "gte", path: "page.employees", n: 0 }, kind: "review", stage: "check", summary: "nothing public to cite" } },
  } },
]);
export const MCC_WORKFLOW_1 = workflow("mcc", { schemaId: "Answer", path: "answer" }, [
  step("Read the site", "web.fetch", "page", "Page"),
  step("Pick the MCC", "mcc.pick", "mcc", "Answer"),
  step("Format the answer", "mcc.format", "answer", "Answer"),
]);
export const MCC_WORKFLOW_2 = workflow("mcc", { schemaId: "Answer", path: "answer" }, [
  step("Read the site", "web.fetch", "page", "Page"),
  step("Is it a marketplace", "market.check", "market", "Answer"),
  step("Pick the MCC", "mcc.pick", "mcc", "Answer", { site: "{site}", hint: "a marketplace is 5399" }),
  step("Answer", "mcc.report", "answer", "Answer"),
]);
export const PRIVATE = "/root/steps/1/branches/private/body";

/** What each scripted tool answers; a run's page (`web.fetch`) is its own. */
const ANSWERS = { "filings.search": { brief: "Caterpillar Inc. makes heavy machinery; its 10-K is cited." }, "mcc.pick": { code: "5732" }, "mcc.format": { code: "5732" }, "market.check": { code: "no" }, "mcc.report": { code: "5399" } };
const PUBLIC_PAGE = { kind: "public", employees: 4_000 };

/** A started workflow run, run to its end as a host runs one: ./workflow's runWorkflowRevision on the run's own store,
 *  with scripted tools that answer `page` for the site and ANSWERS for the rest. With `stopAt`, the run is stopped when
 *  that tool is called. Resolves to what carryBack takes. */
async function recordWorkflow(started, { page = PUBLIC_PAGE, stopAt } = {}) {
  let stopping;
  const workflows = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(started.workspace) }),
    run: () => ({
      adapters: {
        runEffect: async ({ node }) => {
          if (node.tool === stopAt) stopping ??= workflows.stop(harness, started.runId, "cancel", ctx);
          return node.tool === "web.fetch" ? page : ANSWERS[node.tool];
        },
      },
    }),
  });
  const registry = createRegistry();
  registry.install(workflows.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(started.storePath), { registry, models: {} }, ctx);
  try {
    const { carry } = await runWorkflowRevision({ harness, workflows, context: ctx, run: started, input: { site: "https://example.org" }, tools: started.revision.body.tools });
    await stopping;
    return carry;
  } finally {
    await harness.close(ctx);
  }
}

/** The sample store in `dir/my-agents`, through openStore; resolves to its path, its revisions and each run's id by its
 *  role (a1, a2, b1, b2, c1, c2, m1 to m4, t1), as startRun minted them. */
export async function buildSampleStore(dir) {
  const root = path.join(dir, "my-agents");
  const store = openStore(root);
  try {
    const researcher = store.createAgent({ id: "company-researcher", name: "Company researcher", description: "Researches one company and writes a short, cited brief." });
    const inbox = store.createAgent({ id: "inbox-triage", name: "Inbox triage", description: "Sorts an inbox into reply, file or ignore." });
    const mcc = store.createAgent({ id: "mcc-classifier", name: "MCC classifier", description: "Names the merchant category code a site's business falls under." });
    const brief = `# Research brief\n\nWrite what it does. ${SKILL_MARKER}\n`;
    const revisions = {
      A: await store.commitRevision(researcher.id, { kind: "agentic", instructions: PROMPT_A, tools: ["web_search", "web_fetch", "write"], skills: { "research-brief/SKILL.md": brief }, model: "luna", thinking: "low", note: "Prompt A: the first brief" }, { setCurrent: true }),
      B: await store.commitRevision(researcher.id, { kind: "agentic", instructions: PROMPT_B, tools: ["web_search", "web_fetch", "write", "read"], skills: { "research-brief/SKILL.md": `${brief}Cite it.\n`, "cite/SKILL.md": "# Cite\n\nEvery fact has a page.\n" }, model: "luna", thinking: "medium", note: "Prompt B: every fact cited" }, { setCurrent: true }),
      C: await store.commitRevision(researcher.id, { kind: "workflow", workflow: BRIEF_WORKFLOW, tools: ["web.fetch", "filings.search"], note: "The cheap one: a workflow" }, { setCurrent: true }),
      M1: await store.commitRevision(mcc.id, { kind: "workflow", workflow: MCC_WORKFLOW_1, tools: ["web.fetch", "mcc.pick", "mcc.format"], note: "First cut" }, { setCurrent: true }),
      M2: await store.commitRevision(mcc.id, { kind: "workflow", workflow: MCC_WORKFLOW_2, tools: ["web.fetch", "market.check", "mcc.pick", "mcc.report"], note: "Marketplaces are 5399" }, { setCurrent: true }),
      T1: await store.commitRevision(inbox.id, { kind: "agentic", instructions: "Read the inbox and sort each message into reply, file or ignore.", tools: ["read"] }, { setCurrent: true }),
    };
    // Oldest first: each run starts after the one before.
    const runs = [
      ["m1", revisions.M1, { costUsd: 0.027 }],
      ["m2", revisions.M1, { costUsd: 0.03 }],
      ["a1", revisions.A, { state: "completed", costUsd: 0.409, summary: "Caterpillar Inc. builds heavy machinery." }, research("Caterpillar Inc.", "10-K", 0)],
      ["a2", revisions.A, { state: "failed", costUsd: 0.221, summary: "web_fetch: 403 Forbidden on the investor page" }, research("Caterpillar Inc.", "investors", 10).slice(0, 6)],
      ["b1", revisions.B, { state: "completed", costUsd: 0.312, summary: "Caterpillar Inc. builds heavy machinery; brief.md cites 6 pages." }, research("Caterpillar Inc.", "10-K", 20)],
      ["b2", revisions.B, { state: "completed", summary: "Habitat for Humanity builds homes; brief.md cites its Form 990." }, research("Habitat for Humanity", "Form 990", 30)],
      ["m3", revisions.M2, { costUsd: 0.022 }],
      ["m4", revisions.M2, { stopAt: "market.check" }],
      ["t1", revisions.T1, null, [user("Sort today's inbox.", Date.UTC(2026, 9, 23, 3, 30)), assistant([{ type: "thinking", thinking: "Forty messages; I will read them in date order." }, call("t1", "read", { path: "inbox/0001.eml" })], Date.UTC(2026, 9, 23, 3, 30, 4))]],
      ["c1", revisions.C, { costUsd: 0.041 }],
      ["c2", revisions.C, { costUsd: 0.018, page: { kind: "private", employees: 12 } }],
    ];
    const ids = {};
    for (const [role, revision, end, entries] of runs) {
      const started = await store.startRun({ agent: revision.agent, revision: revision.id });
      ids[role] = started.runId;
      if (entries) append(started.storePath, entries);
      if (revision.kind === "workflow") {
        const { state, summary } = await recordWorkflow(started, end);
        store.carryBack(started.runId, { state, ...(summary ? { summary } : {}), ...(end.costUsd !== undefined ? { costUsd: end.costUsd } : {}) });
      } else if (end) store.carryBack(started.runId, end);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    rmSync(path.join(root, "runs", ids.m2), { recursive: true });
    return { root, revisions, ids };
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!process.argv[2]) throw new Error("usage: node test/fixtures/store-sample.mjs <dir>");
  const dir = path.resolve(process.argv[2]);
  mkdirSync(dir, { recursive: true });
  const { root } = await buildSampleStore(dir);
  const { serveStore } = await import("../../dist/serve/index.js");
  const served = await serveStore({ dir: root });
  console.log(served.url);
}
