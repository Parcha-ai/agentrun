// The tab's runtime in Node, against a pipe on a local directory (no Archil) and the real model endpoint: one turn
// where the agent writes a file and runs it. Checks that the file reached the pipe's work/ and the turn the store.
//   DEMO_MODEL_URL (an OpenAI-compatible endpoint with the Responses API), DEMO_MODEL
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Wasmer } from "@wasmer/sdk/node";
import { localServer } from "../test/_local.ts";
import { PipeClient, type Attached } from "../tab/pipe-client.ts";
import { startTab } from "../tab/runtime.ts";
import { WasmerEnv, wasmerWorkspaceFs } from "../tab/wasmer-env.ts";
import { Workspace } from "../tab/workspace.ts";

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const local = await localServer({
  model: { baseUrl: process.env.DEMO_MODEL_URL!, model: process.env.DEMO_MODEL!, budgetTokens: 300_000 },
});
const { id, secret } = await local.server.createRun("node-tab");
const wasmer = new Wasmer({ cache: { directory: process.env.WASMER_CACHE ?? ".wasmer-cache" } });
await wasmer.ready();
const [edge] = await wasmer.packages.loadMany(["wasmer/edgejs"]);
const sandbox = await wasmer.sandboxes.create({ packages: [edge!], shell: edge!.command("bash"), env: { LANG: "C.UTF-8" } });
console.log(JSON.stringify({ at: ms(), event: "sandbox" }));
const client = new PipeClient({ url: local.url, run: id, token: secret, tab: "node", mode: "write" });
const attached = (await client.ready) as Attached;
const env = new WasmerEnv(sandbox as never, { id: `wasmer:${id}`, env: { HOME: "/workspace", LANG: "C.UTF-8", TERM: "dumb" } });
const tab = await startTab({ client, attached, env, workspace: new Workspace(wasmerWorkspaceFs(env)) });
console.log(JSON.stringify({ at: ms(), event: "harness", restored: tab.restored }));
const prompt = process.argv[2] ?? "Create a file hello.js that prints the sum of the numbers 1 to 100, run it with node, and save its output to result.txt.";
const submission = await tab.root.submit({ type: "input", content: prompt, requestId: "q1" }, ctx);
const settled = await submission.wait(ctx);
console.log(JSON.stringify({ at: ms(), event: "settled", status: settled.status }));
const page = await tab.root.entries({}, 200, undefined, ctx);
for (const entry of [...page.items].reverse()) {
  const model = (entry as unknown as { model?: { role: string; content: unknown }[] }).model;
  const text = JSON.stringify(model ?? entry.data ?? null).slice(0, 600);
  console.log(JSON.stringify({ kind: entry.kind, text }));
}
const work = join(local.root, "runs", id, "work");
for (const name of ["hello.js", "result.txt"]) console.log(JSON.stringify({ file: name, onDisk: existsSync(join(work, name)), text: existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8").slice(0, 200) : null }));
console.log(JSON.stringify({ syncs: tab.syncs, commits: client.timings.commit.length, files: client.timings.files }));
await tab.close();
client.close();
await sandbox.close();
await wasmer.close();
await local.remove();
