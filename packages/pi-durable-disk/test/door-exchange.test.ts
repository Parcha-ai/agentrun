// The serve door with no hook: a recorded exchange of every route (submit, abort, status, events) and its refusals
// (401, 400, 404, 409, 503) must answer what it answered before the door hook existed. The answers are kept in
// fixtures/door-exchange.json; `PDA_RECORD_DOOR=1` writes them again. Only the date header, the clock's values
// (timestamps, ISO dates, durations) and the faux model's random api tag are masked. A door on a unix socket answers the
// same exchange, byte for byte.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Agent, request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { serveRun, type RunServer, type ServeOptions } from "../src/serve.ts";
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

type Wire = { type?: string; inputs?: unknown; record?: unknown; message?: { role?: string }; entry?: { kind?: string; id?: number }; entries?: { kind?: string; id?: number }[] };
/** The door's own envelope of a frame: its event; each event's type and the door's fields; pi's messages and entries by
 *  their role, kind and id only. */
const envelope = (frame: string) => {
  const data = JSON.parse(frame.slice(frame.indexOf("data: ") + 6).replace(/<ms>/g, "0")) as Wire | Wire[];
  const event = (e: Wire) => ({
    type: e.type,
    ...(e.inputs !== undefined ? { inputs: e.inputs } : {}),
    ...(e.record !== undefined ? { record: e.record } : {}),
    ...(e.message ? { message: e.message.role } : {}),
    ...(e.entry ? { entry: [e.entry.kind, e.entry.id] } : {}),
  });
  return { event: frame.slice(0, frame.indexOf("\n")), data: Array.isArray(data) ? data.map(event) : { type: data.type, entries: (data.entries ?? []).map((e) => [e.kind, e.id]) } };
};

type Answer = { route: string; status: number; headers: Record<string, string>; body: string };

/** A response's headers but the date, sorted by name. */
const kept = (headers: Iterable<[string, string]>) => Object.fromEntries([...headers].filter(([k]) => k !== "date").sort(([a], [b]) => a.localeCompare(b)));
const flat = (headers: IncomingHttpHeaders) => Object.entries(headers).map(([k, v]): [string, string] => [k, String(v)]);

/** A door on loopback is asked with fetch, as before; a door on a socket with node:http's `socketPath`, kept alive as fetch is. */
const socketOf = (server: RunServer) => (server.url.startsWith("unix:") ? server.url.slice("unix:".length) : undefined);
const keepAlive = new Agent({ keepAlive: true });

async function exchange(server: RunServer, method: "GET" | "POST", path: string, body?: unknown, token: string | null = TOKEN): Promise<Answer> {
  const headers: Record<string, string> = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === null ? {} : { authorization: `Bearer ${token}` }) };
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const socketPath = socketOf(server);
  if (socketPath === undefined) {
    const res = await fetch(new URL(path, server.url), { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    return { route: `${method} ${path}`, status: res.status, headers: kept(res.headers), body: mask(await res.text()) };
  }
  const sent = { ...headers, ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }) };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method, headers: sent, agent: keepAlive }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ route: `${method} ${path}`, status: res.statusCode!, headers: kept(flat(res.headers)), body: mask(text) }));
    });
    req.once("error", reject).end(payload);
  });
}

/** `GET /events` held open: over loopback by URL, over a socket by its path. */
const eventsRequest = (server: RunServer, headers: Record<string, string>): ClientRequest => {
  const socketPath = socketOf(server);
  return socketPath === undefined ? httpRequest(new URL("/events", server.url), { headers }) : httpRequest({ socketPath, path: "/events", headers, agent: keepAlive });
};

/** The recorded exchange against a door that `where` places (loopback by default), compared with the fixture. */
async function recordedExchange(name: string, where: (disk: LocalDisk) => Pick<ServeOptions, "socket"> = () => ({})): Promise<void> {
  const disk = new LocalDisk(name);
  const counters = newCounters();
  const answers: Answer[] = [];
  try {
    const app = lifecycleApp(counters);
    const server = await serveRun({ ...where(disk), root: { agent: app.agent }, token: TOKEN });
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
    const req = eventsRequest(server, { authorization: `Bearer ${TOKEN}` });
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
    // pi-durable's own payloads (messages, entries, usage, the snapshot's state) pass through the door, and each pi
    // version shapes them a little differently (1.0.4 has no durationMs, 1.2 adds the snapshot's nestedTools). So the
    // door's envelope is compared on every pi the peers accept: each frame's event, each event's type and the door's
    // own fields, pi's messages and entries by their role, kind and id. The whole exchange is compared byte for byte on
    // the pi it was recorded with.
    const piDurable = (createRequire(import.meta.url)("@earendil-works/pi-durable/package.json") as { version: string }).version;
    const recorded = { piDurable, answers, events };
    if (process.env.PDA_RECORD_DOOR === "1" && !socketOf(server)) writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof recorded;
    assert.deepEqual(answers, expected.answers);
    assert.deepEqual({ ...events, frames: events.frames.map(envelope) }, { ...expected.events, frames: expected.events.frames.map(envelope) });
    if (piDurable === expected.piDurable) assert.deepEqual(events, expected.events);
  } finally {
    disk.remove();
  }
}

test("with no hook, the door answers a recorded exchange as it did before the hook", () => recordedExchange("door-exchange"));

test("a door on a unix socket answers the same recorded exchange: submit, events, abort, status and every refusal", () =>
  recordedExchange("door-exchange-socket", (disk) => ({ socket: join(disk.base, "door.sock") })),
);

after(() => keepAlive.destroy());
