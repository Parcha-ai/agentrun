// The dark-content judge: the verdict for clean, dark and broken judge answers (every failure is a refusal), and the
// route the page calls (the run's secret, body checks, the text never logged, no route without a judge).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { DARK_RUBRIC, JUDGE_ANSWER_MAX, judgeAnswer } from "../pipe/judge.ts";
import { localServer } from "./_local.ts";

/** A judge endpoint whose behaviour the answer text picks: DARK, GARBAGE, SLOW, HTTP500, or clean. */
async function judgeStub(): Promise<{ url: string; requests: Record<string, unknown>[]; close(): Promise<void> }> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text) as { messages: { content: string }[] };
      requests.push(body as unknown as Record<string, unknown>);
      const user = body.messages[1]!.content;
      const reply = (content: string) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content } }] }));
      if (user.includes("HTTP500")) return void res.writeHead(500).end("boom");
      if (user.includes("GARBAGE")) return reply("this is not json");
      if (user.includes("WRONGSHAPE")) return reply(JSON.stringify({ dark: "yes" }));
      if (user.includes("SLOW")) return void setTimeout(() => reply(JSON.stringify({ dark: false, dark_quote: "" })), 1_000);
      if (user.includes("DARK")) return reply(JSON.stringify({ dark: true, dark_quote: "the DARK part" }));
      reply(JSON.stringify({ dark: false, dark_quote: "" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

describe("judgeAnswer", () => {
  let stub: Awaited<ReturnType<typeof judgeStub>>;
  before(async () => (stub = await judgeStub()));
  after(() => stub.close());
  const opts = () => ({ baseUrl: stub.url, model: "judge-stub", timeoutMs: 300 });

  it("shows a clean answer, and asks with the rubric and a strict schema", async () => {
    const v = await judgeAnswer({ prompt: "Tell me a joke.", answer: "Why did the bridge blush? Fog." }, opts());
    assert.equal(v.verdict, "show");
    assert.equal(v.dark, false);
    const sent = stub.requests.at(-1) as { model: string; messages: { content: string }[]; response_format: { type: string; json_schema: { strict: boolean } }; stream?: boolean };
    assert.equal(sent.model, "judge-stub");
    assert.equal(sent.messages[0]!.content, DARK_RUBRIC);
    assert.match(sent.messages[1]!.content, /USER ASKED:\nTell me a joke\.\n\nANSWER:\nWhy did the bridge blush/);
    assert.equal(sent.response_format.type, "json_schema");
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.equal(sent.stream, undefined);
  });

  it("refuses a dark answer and gives the quote", async () => {
    const v = await judgeAnswer({ prompt: "Who are you?", answer: "DARK" }, opts());
    assert.deepEqual([v.verdict, v.dark, v.quote], ["refuse", true, "the DARK part"]);
  });

  for (const [what, answer, error] of [
    ["an answer that does not parse", "GARBAGE", /did not parse/],
    ["an answer of the wrong shape", "WRONGSHAPE", /did not match the schema/],
    ["an error status", "HTTP500", /answered 500/],
    ["a judge slower than the timeout", "SLOW", /timed out/],
  ] as const) {
    it(`refuses on ${what}`, async () => {
      const v = await judgeAnswer({ prompt: "p", answer }, opts());
      assert.equal(v.verdict, "refuse");
      assert.equal(v.dark, null);
      assert.match(v.error ?? "", error);
    });
  }

  it("refuses when the endpoint cannot be reached", async () => {
    const v = await judgeAnswer({ prompt: "p", answer: "a" }, { baseUrl: "http://127.0.0.1:9/v1", model: "m", timeoutMs: 1_000 });
    assert.equal(v.verdict, "refuse");
    assert.match(v.error ?? "", /failed/);
  });
});

describe("POST /api/runs/<id>/judge", () => {
  let stub: Awaited<ReturnType<typeof judgeStub>>;
  let local: Awaited<ReturnType<typeof localServer>>;
  let plain: Awaited<ReturnType<typeof localServer>>;
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const http = (l: { url: string }) => l.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
  const post = (l: { url: string }, id: string, token: string, body: unknown) =>
    fetch(`${http(l)}/api/runs/${id}/judge`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  before(async () => {
    stub = await judgeStub();
    local = await localServer({ judge: { baseUrl: stub.url, model: "judge-stub", timeoutMs: 300 }, log: (event, data) => void logs.push({ event, data }) });
    plain = await localServer();
  });
  after(async () => {
    await local.remove();
    await plain.remove();
    await stub.close();
  });

  it("answers the verdict to the page that holds the run's secret, and logs no text", async () => {
    const { id, secret } = await local.server.createRun("judge-ok");
    const ok = await post(local, id, secret, { prompt: "Tell me a joke.", answer: "A bridge walks into a bar." });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { verdict: string }).verdict, "show");
    const dark = await post(local, id, secret, { prompt: "Who are you?", answer: "secret words DARK" });
    const v = (await dark.json()) as { verdict: string; quote: string };
    assert.deepEqual([v.verdict, v.quote], ["refuse", "the DARK part"]);
    const judged = logs.filter((l) => l.event === "judge");
    assert.equal(judged.length, 2);
    assert.ok(!JSON.stringify(judged).includes("secret words"), "the answer's text must not reach the log");
  });

  it("refuses (still 200) when the judge fails, so the page shows the refusal line", async () => {
    const { id, secret } = await local.server.createRun("judge-fail");
    const r = await post(local, id, secret, { prompt: "p", answer: "SLOW" });
    assert.equal(r.status, 200);
    const v = (await r.json()) as { verdict: string; error: string };
    assert.equal(v.verdict, "refuse");
    assert.match(v.error, /timed out/);
  });

  it("answers 404 to a wrong secret or an unknown run, and to every run when the server has no judge", async () => {
    const { id, secret } = await local.server.createRun("judge-auth");
    assert.equal((await post(local, id, "wrong", { prompt: "p", answer: "a" })).status, 404);
    assert.equal((await post(local, "no-such-run", secret, { prompt: "p", answer: "a" })).status, 404);
    const other = await plain.server.createRun("no-judge");
    assert.equal((await post(plain, other.id, other.secret, { prompt: "p", answer: "a" })).status, 404);
  });

  it("answers 400 to a body that is not JSON or lacks the strings, and 413 to an answer over the limit", async () => {
    const { id, secret } = await local.server.createRun("judge-body");
    assert.equal((await post(local, id, secret, "{not json")).status, 400);
    assert.equal((await post(local, id, secret, { prompt: "p" })).status, 400);
    assert.equal((await post(local, id, secret, { prompt: 1, answer: "a" })).status, 400);
    assert.equal((await post(local, id, secret, { prompt: "p", answer: "x".repeat(JUDGE_ANSWER_MAX + 1) })).status, 413);
  });
});
