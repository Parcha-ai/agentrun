// POST /api/runs/<id>/brain-judge: the page's brain router asks its one question of the server's client (the key never reaches the page). Anything else is refused.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BRAIN_CRITERIA, BRAIN_QUESTION, brainRouter, type JudgeRunner } from "../brain-router.ts";
import { localServer } from "./_local.ts";

describe("the brain judge route", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let base: string;
  let id: string;
  let secret: string;
  const asked: unknown[] = [];
  let mode: "answer" | "fail" = "answer";
  before(async () => {
    const brainJudge: JudgeRunner = async (params) => {
      asked.push(params);
      if (mode === "fail") throw new Error("Jev is down");
      return { answers: { who: { type: "choice", choice: "local", probabilities: { local: 0.93, cloud: 0.07 } } }, model: "jev-test" };
    };
    local = await localServer({ brainJudge });
    base = local.url.replace(/^ws/, "http").replace(/\/ws$/, "");
    ({ id, secret } = await local.server.createRun("route"));
  });
  after(() => local.remove());
  const post = (body: unknown, token = secret, runId = id) => fetch(`${base}/api/runs/${runId}/brain-judge`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const question = (message: string) => ({ label: "brain", state: { message }, questions: { who: { type: "choice", instructions: BRAIN_QUESTION, criteria: { local: BRAIN_CRITERIA.local, cloud: BRAIN_CRITERIA.cloud } } } });

  it("runs the router's question on the server's client and answers what it answered", async () => {
    const r = await post(question("write hi.js and run it"));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { answers: { who: { type: "choice", choice: "local", probabilities: { local: 0.93, cloud: 0.07 } } }, model: "jev-test" });
    assert.equal((asked.at(-1) as { state: { message: string } }).state.message, "write hi.js and run it");
  });

  it("is what the page's router uses: a router over this route decides the tab", async () => {
    const runJudge: JudgeRunner = async (params) => (await post({ label: params.label, state: params.state, questions: params.questions })).json() as never;
    const d = await brainRouter({ runJudge }).decide("write hi.js", { online: true, localModel: { id: "1b" } });
    assert.equal(d.brain, "tab-local");
    assert.equal(d.decidedBy, "jev");
    assert.equal(d.confidence, 0.93);
  });

  it("refuses anything but the router's question, a wrong secret, an unknown run; and a failing client is a 502 the router turns into the cloud", async () => {
    const before = asked.length;
    assert.equal((await post({ ...question("x"), label: "other" })).status, 400);
    assert.equal((await post({ ...question("x"), questions: { who: { type: "boolean", instructions: "x", criteria: {} } } })).status, 400);
    assert.equal((await post({ ...question("x"), questions: { who: { type: "choice", instructions: "x", criteria: { a: "1", b: "2" } }, extra: { type: "choice", instructions: "y", criteria: {} } } })).status, 400);
    assert.equal((await post(question(""))).status, 400);
    assert.equal((await post(question("x".repeat(9000)))).status, 400);
    assert.equal((await post(question("x"), "wrong-secret")).status, 404);
    assert.equal((await post(question("x"), secret, "no-such-run")).status, 404);
    assert.equal(asked.length, before, "none of them reached the client");
    mode = "fail";
    const failing = await post(question("hello"));
    assert.equal(failing.status, 502);
    const runJudge: JudgeRunner = async (params) => {
      const r = await post({ label: params.label, state: params.state, questions: params.questions });
      if (!r.ok) throw new Error(`the server answered ${r.status}`);
      return (await r.json()) as never;
    };
    const d = await brainRouter({ runJudge }).decide("hello", { online: true, localModel: { id: "1b" } });
    assert.equal(d.brain, "cloud");
    assert.match(d.reason, /Jev failed.*502/);
  });
});
