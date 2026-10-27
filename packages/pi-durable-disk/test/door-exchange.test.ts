// The serve door with no hook: a recorded exchange of every route (submit, abort, status, events) and its refusals
// (401, 400, 404, 409, 503) must answer what it answered before the door hook existed. The answers are kept in
// fixtures/door-exchange.json; `PDA_RECORD_DOOR=1` writes them again. Only the date header, the clock's values
// (timestamps, ISO dates, durations) and the faux model's random api tag are masked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { serveRun, type RunServer } from "../src/serve.ts";
import { lifecycleApp, LocalDisk, newCounters, openOn, until } from "./_lifecycle.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "door-exchange.json");
const TOKEN = "door-exchange-token";
const REF = { disk: "dsk-local", region: "local", id: "door-exchange" };

/** The clock's values (epoch milliseconds, ISO dates, durations) and the faux provider's random api tag. */
const mask = (text: string) =>
  text
    .replace(/"faux:\d+:[a-z0-9]+"/g, '"faux:<tag>"')
    .replace(/"durationMs":\d+/g, '"durationMs":<ms>')
    .replace(/\b1[0-9]{12}\b/g, "<ms>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<iso>");

type Answer = { route: string; status: number; headers: Record<string, string>; body: string };

async function exchange(server: RunServer, method: "GET" | "POST", path: string, body?: unknown, token: string | null = TOKEN): Promise<Answer> {
  const res = await fetch(new URL(path, server.url), {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const headers = Object.fromEntries([...res.headers].filter(([k]) => k !== "date").sort(([a], [b]) => a.localeCompare(b)));
  return { route: `${method} ${path}`, status: res.status, headers, body: mask(await res.text()) };
}

test("with no hook, the door answers a recorded exchange as it did before the hook", async () => {
  const disk = new LocalDisk("door-exchange");
  const counters = newCounters();
  const answers: Answer[] = [];
  try {
    const app = lifecycleApp(counters);
    const server = await serveRun({ root: { agent: app.agent }, token: TOKEN });
    answers.push(await exchange(server, "GET", "/status"));
    const run = await openOn(disk, REF, app);
    server.attach(run);
    answers.push(await exchange(server, "GET", "/status", undefined, null));
    answers.push(await exchange(server, "POST", "/submit", { requestId: "has space", content: "x" }));
    answers.push(await exchange(server, "POST", "/submit", "{not json"));
    answers.push(await exchange(server, "POST", "/submit", { requestId: "x1", content: "hello", wait: true }));
    answers.push(await exchange(server, "POST", "/submit", { requestId: "x1", content: "hello", wait: true }));
    answers.push(await exchange(server, "POST", "/submit", { requestId: "x1", content: "hello", conversationId: 999 }));
    answers.push(await exchange(server, "GET", "/status"));

    // The events stream: its snapshot, the batches of one answered submit, its end when the run is released.
    let text = "";
    const req = httpRequest(new URL("/events", server.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    const streamHeaders = new Promise<Record<string, string>>((resolve) =>
      req.on("response", (res) => {
        res.setEncoding("utf8").on("data", (c: string) => (text += c));
        resolve(Object.fromEntries(Object.entries(res.headers).filter(([k]) => k !== "date").sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>);
      }),
    );
    req.end();
    const headers = await streamHeaders;
    await until("the snapshot", () => text.includes("event: snapshot\n"));
    answers.push(await exchange(server, "POST", "/submit", { requestId: "e1", content: "streamed", wait: true }));
    await until("the answer's batch", () => text.includes("echo: streamed"));
    const streamed = text;
    req.destroy();

    answers.push(await exchange(server, "POST", "/submit", { requestId: "g1", content: "gate" }));
    await until("the gate tool", () => counters.gate === 1);
    answers.push(await exchange(server, "GET", "/status"));
    answers.push(await exchange(server, "POST", "/submit", { requestId: "b1", content: "hello", whenBusy: "reject" }));
    answers.push(await exchange(server, "POST", "/abort", {}));
    answers.push(await exchange(server, "POST", "/abort", { submissionId: 12345 }));
    answers.push(await exchange(server, "GET", "/nope"));
    const resume = server.pause();
    answers.push(await exchange(server, "POST", "/submit", { requestId: "p1", content: "hello" }));
    resume();
    await run.release();
    answers.push(await exchange(server, "POST", "/submit", { requestId: "r1", content: "hello" }));
    await server.close();

    const events = { route: "GET /events", headers, frames: mask(streamed).split("\n\n").filter(Boolean) };
    const recorded = { answers, events };
    if (process.env.PDA_RECORD_DOOR === "1") writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof recorded;
    assert.deepEqual(answers, expected.answers);
    assert.deepEqual(events, expected.events);
  } finally {
    disk.remove();
  }
});
