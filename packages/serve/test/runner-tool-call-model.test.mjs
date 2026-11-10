// A pi run's file and shell tools on the runner know the calling model and stream their output, as pi's own tools did on
// main (main's coding tools ran in pi's tool task, whose api.agent() is the calling agent and whose api.output streams
// into the running tool's live slot):
//   - the model's image facts (its input, its limits) reach both pi-ai's request, so a model without image input is sent
//     pi-ai's placeholder in place of an image, and pi's read, which notes it and holds an image to the model's limits
//     (the runner's read has no image processor, as main's runner place had none: an image over the limits is refused in
//     pi's words, never sent);
//   - a running tool's output reaches the run's live view while it runs.
// Through the real loop: startRunner over createDispatchLoop and the adapter spec (adapterRunSpecFromLaunch), on a real
// store, the run's Workspace its Mode 1 folder; the model is the shared scripted origin, its route carrying the catalog's
// facts for the model (`like`).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { runFolder } = await import("../dist/workspace/paths.js");
const { streamingSandbox } = await import("./fixtures/streaming-sandbox.mjs");
const { routeOf } = await import("../dist/runner/model-route.js");
after(closeOpenSessions);

const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** pi-ai's words for a tool's image a model without image input is sent instead (transform-messages.ts). */
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
/** pi's read's note when the calling model takes no images (pi-durable tools/read.ts). */
const READ_NO_VISION_NOTE = "The current model does not support images";

/** A valid `width` x `height` RGB PNG, all grey. */
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let row = 0; row < height; row += 1) rows[row * (1 + width * 3)] = 0; // filter: none
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** run-1, an agentic pi run granted `tools`, its model's route carrying `like` (the catalog's facts for the model), the
 *  model playing `script`; `files` laid in the run's folder before its claim. `during(server, folder)` runs while the run
 *  goes. Its row once it rests, and the requests the model was sent. */
async function piRun(t, { tools, like, script, files = {}, during, computer }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tool-call-model-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Do it, then say done.", tools } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } } });
  const folder = runFolder(dir, "agent-1", "run-1");
  mkdirSync(folder, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(folder, name), bytes);
  const requests = [];
  const route = {
    model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"m"}` },
    fetch: scriptedOrigin(script, requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1_000,
    ...(like ? { like } : {}),
  };
  const deps = {
    env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3), routeOf: async () => route,
    // `computer`: the claim's computer for the run's folder (a run with no mounting computer has no shell, #2088).
    computerForClaim: async () => (computer ? computer(folder) : { release: async () => {} }),
  };
  // The run's live view is the runner's own (startRunner's ticker), its tick quick here.
  runner = startRunner({ store, name: "runner-a", ...TIMING, live: { tickMs: 50 }, createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) }) });
  const going = during ? during(server, folder) : Promise.resolve();
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null) {
      await going;
      return { row, requests };
    }
    if (Date.now() - from > 45_000) assert.fail(`the run never rested: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The tool results the model was sent in `request` (Messages' tool_result blocks), each as its text and its image count. */
function toolResults(request) {
  const blocks = (request?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result");
  return blocks.map((block) => {
    const parts = Array.isArray(block.content) ? block.content : [{ type: "text", text: String(block.content ?? "") }];
    return { text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"), images: parts.filter((part) => part.type === "image").length };
  });
}

const READ_PIC = { call: "read", args: { path: "pic.png" } };

test("a route carries what its catalog model takes as input, on every wire: a text-only model's route says so, an image model's says it takes images", async () => {
  const key = { OPENAI_API_KEY: `not-a-secret-${"o"}`, ANTHROPIC_API_KEY: `not-a-secret-${"a"}` };
  // o3-mini takes text alone in pi-ai's catalog: through the route's own Messages translation, and on OpenAI's Responses.
  const translated = await routeOf("openai/o3-mini", key);
  assert.deepEqual(translated.like?.input, ["text"], `the translated route says text alone: ${JSON.stringify(translated.like)}`);
  const responses = await routeOf("openai/o3-mini", key, "default", ["anthropic-messages", "openai-responses"]);
  assert.equal(responses.provider.api, "openai-responses");
  assert.deepEqual(responses.like?.input, ["text"], `the Responses route says text alone: ${JSON.stringify(responses.like)}`);
  // An Anthropic model, on Anthropic's own route, takes images.
  const anthropic = await routeOf("anthropic/claude-sonnet-4-5", key);
  assert.ok(anthropic.like?.input?.includes("image"), `the Anthropic route says it takes images: ${JSON.stringify(anthropic.like)}`);
});

test("a model without image input reading an image is sent pi-ai's placeholder, not the image, and pi's read says so", { timeout: 60_000 }, async (t) => {
  const { row, requests } = await piRun(t, { tools: ["read"], like: { input: ["text"] }, script: [READ_PIC, { say: "done" }], files: { "pic.png": png(40, 20) } });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  const [result] = toolResults(requests[1]);
  assert.ok(result, `the read's result was sent back: ${JSON.stringify(toolResults(requests[1]))}`);
  assert.equal(result.images, 0, "no image sent to a model that takes none");
  assert.ok(result.text.includes(TOOL_IMAGE_PLACEHOLDER), `pi-ai's placeholder in its place: ${result.text}`);
  assert.ok(result.text.includes(READ_NO_VISION_NOTE), `pi's read knew the calling model takes no images: ${result.text}`);
});

test("an image over the calling model's limits is held to them: pi's read refuses it in its words, never sending it at pi's defaults", { timeout: 60_000 }, async (t) => {
  const like = { input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 64, maxHeight: 64 } } } };
  const { row, requests } = await piRun(t, { tools: ["read"], like, script: [READ_PIC, { say: "done" }], files: { "pic.png": png(200, 100) } });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  const [result] = toolResults(requests[1]);
  assert.ok(result, `the read's result was sent back: ${JSON.stringify(toolResults(requests[1]))}`);
  assert.equal(result.images, 0, `the 200x100 image was not sent: ${result.text}`);
  assert.ok(result.text.includes("200x100, larger than 64x64"), `refused by the model's own limits: ${result.text}`);
});

// Its bash needs a shell: a run with no mounting computer has none (#2088), so the claim is handed a sandbox bound to the
// run's folder (fixtures/streaming-sandbox.mjs) whose processes stream as computerd's do. (#2078's skip was this fixture.)
test("a running tool's output reaches the run's live view while it runs, before it ends", { timeout: 60_000 }, async (t) => {
  // bash prints a chunk, then waits for the test's release file: the chunk must show in the live view before the test lets
  // it end. No sleep orders this: the release is written only once the chunk is seen.
  // Past the chunk, more than the tail the live view holds back while output streams (as long as the widest form of the
  // longest secret the runner holds, its environment's among them), so the chunk shows while the bash still runs.
  const command = "echo first-chunk; head -c 3000 /dev/zero | tr '\\0' y; while [ ! -e release ]; do sleep 0.05; done; echo last-chunk";
  let seen;
  let last;
  const { row } = await piRun(t, {
    tools: ["bash"], script: [{ call: "bash", args: { command } }, { say: "done" }], computer: streamingSandbox,
    during: async (server, folder) => {
      const from = Date.now();
      try {
        for (;;) {
          const [live] = await server.live.read(["run-1"]);
          if (live) last = live.state;
          const slot = live?.state?.tools?.find((tool) => tool.name === "bash");
          if (typeof slot?.output === "string" && slot.output.includes("first-chunk")) {
            seen = slot.output;
            return;
          }
          if (Date.now() - from > 20_000) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        writeFileSync(join(folder, "release"), "");
      }
    },
  });
  assert.ok(seen !== undefined, `the running bash's first chunk reached the live view while it ran: the last live state ${JSON.stringify(last)}`);
  assert.equal(seen.includes("last-chunk"), false, "seen before the tool ended");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
});
