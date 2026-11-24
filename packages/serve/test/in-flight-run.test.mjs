// A live run's page names the model request it waits on while the model has not answered (GRE-4835): on a real server,
// a scripted model held until the test lets it answer. The page lists the request from when it was sent, and nothing once
// the run is over.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("while the model has not answered, the run's page names its request, from when it was sent; then nothing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "in-flight-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gate = join(dir, "answer-now");
  const held = join(dir, "faux-held.mjs");
  await writeFile(held, `import { existsSync } from "node:fs";
import base from ${JSON.stringify(new URL("./fixtures/faux-model.mjs", import.meta.url).pathname)};
// Holds each answer until the test writes its gate file, as a slow local model reads its prompt.
export default async function reply(context, faux) {
  while (!existsSync(${JSON.stringify(gate)}) && !faux.signal?.aborted) await new Promise((r) => setTimeout(r, 20));
  return base(context, faux);
}
`);
  const { api } = await serve(t, { faux: held });
  assert.equal((await api("POST", "/agents", agent("slow"))).status, 201);
  const before = Date.now();
  const run = await api("POST", "/agents/slow/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  let page;
  for (let i = 0; i < 300; i++) {
    page = (await api("GET", `/runs/${run.body.run_id}/timeline?after=0`)).body;
    if (page.in_flight?.some((f) => f.kind === "model")) break;
    await sleep(50);
  }
  const waiting = page.in_flight.find((f) => f.kind === "model");
  assert.ok(waiting, `the page names the request: ${JSON.stringify(page.in_flight)}`);
  assert.equal(waiting.name, "faux-1", "the model, by the id its request names (the server default faux/faux-1)");
  assert.ok(waiting.input_tokens_max > 0, "with the input it was admitted with");
  const sent = Date.parse(waiting.started_at);
  assert.ok(sent >= before - 1_000 && sent <= Date.now(), `sent while the test watched: ${waiting.started_at}`);
  assert.ok(!existsSync(gate));
  await writeFile(gate, "");
  const { last } = await follow(api, run.body.run_id, ["completed"]);
  assert.equal(last.status, "completed");
  const after = (await api("GET", `/runs/${run.body.run_id}/timeline?after=0`)).body;
  assert.deepEqual(after.in_flight, [], "nothing in flight once the run is over");
});
