import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { localSites, useWebsite, useWebsiteContract } from "../dist/index.js";
import { makeSentinels } from "../dist/testing/index.js";

const LISTING = [
  { site: "shop", title: "The shop", description: "Prices and stock of the store's products." },
  { site: "billing", title: "Billing portal", description: "Invoices of the account." },
];
const signal = () => new AbortController().signal;
const parse = (out) => JSON.parse(out.content[0].text);
const fakePort = (answer) => {
  const calls = [];
  return { calls, port: { list: async () => LISTING, use: async (input, ctx) => { calls.push({ input, ctx }); return typeof answer === "function" ? answer(input) : answer; } } };
};
const call = (port, args) => useWebsite(args, port, LISTING, { signal: signal(), runChild: async () => "unused" });
const leaks = (out, s) => Object.values(s).filter((secret) => JSON.stringify(out).includes(secret));

test("use_website forwards nothing back but the declared shape: a port's extra fields are dropped, a mixed or empty answer is refused", async () => {
  const s = makeSentinels();
  const requestId = randomUUID();
  const args = { site: "shop", request_id: requestId, instructions: "Find the price of the 8 GB board." };

  const report = await call(fakePort({ report: "The 8 GB board costs $80.", capability: s.brokerCapability, live_view_url: s.bbLiveViewUrl, token: s.runToken }).port, args);
  assert.deepEqual(parse(report), { ok: true, site: "shop", request_id: requestId, report: "The 8 GB board costs $80." });
  assert.deepEqual(leaks(report, s), []);

  const run = await call(fakePort({ run: { id: "job_123", state: "queued", grant: s.brokerCapability, live_view_url: s.kernelLiveViewUrl }, interaction: { url: s.pageUrl } }).port, args);
  const ran = parse(run);
  assert.deepEqual(Object.keys(ran).sort(), ["next", "ok", "request_id", "run", "site"]);
  assert.deepEqual(ran.run, { id: "job_123", state: "queued" });
  assert.match(ran.next, /started/);
  assert.deepEqual(leaks(run, s), []);

  for (const [name, answer] of Object.entries({
    "both a run and a report": { run: { id: "job_1", state: "queued" }, report: s.runToken },
    "neither": { capability: s.brokerCapability },
    "a report that is not text": { report: { text: s.runToken } },
    "a run without an id": { run: { state: "queued", url: s.pageUrl } },
    "a run whose state is not a plain word": { run: { id: "job_1", state: s.pageUrl } },
    "no answer at all": null,
  })) {
    const out = await call(fakePort(answer).port, args);
    assert.equal(out.isError, true, name);
    assert.equal(parse(out).code, "command_failed", name);
    assert.deepEqual(leaks(out, s), [], name);
  }
});

test("use_website refuses an unknown site, a request_id that is not a UUID and empty instructions without calling the port", async () => {
  const { calls, port } = fakePort({ report: "never" });
  for (const args of [
    { site: "elsewhere", request_id: randomUUID(), instructions: "Do it." },
    { site: "shop", request_id: "not-a-uuid", instructions: "Do it." },
    { site: "shop", request_id: randomUUID(), instructions: "   " },
    { site: "shop", request_id: randomUUID(), instructions: "x".repeat(16_001) },
  ]) {
    const out = await call(port, args);
    assert.deepEqual([out.isError, parse(out).code], [true, "refused"], JSON.stringify(args).slice(0, 80));
  }
  assert.match(parse(await call(port, { site: "elsewhere", request_id: randomUUID(), instructions: "Do it." })).message, /shop, billing/);
  assert.equal(calls.length, 0);
});

test("a port that fails says the call may be repeated with the same request_id, and none of its text reaches the result", async () => {
  const s = makeSentinels();
  const out = await call({ list: async () => LISTING, use: async () => { throw new Error(`broker said no: ${s.brokerCapability} ${s.pageUrl}`); } }, { site: "billing", request_id: randomUUID(), instructions: "List the last invoice." });
  const failure = parse(out);
  assert.deepEqual([out.isError, failure.code, failure.retryable, failure.effect], [true, "command_failed", true, "possibly_effected"]);
  assert.match(failure.message, /same request_id/);
  assert.match(failure.message, /may repeat/, "a failed task can have changed the site before it failed");
  assert.doesNotMatch(failure.message, /is safe|never runs/);
  assert.deepEqual(leaks(out, s), []);
});

test("the contract promises no rerun only for a finished request, and warns that retrying a failed one may repeat what it did", () => {
  const { description } = useWebsiteContract(LISTING);
  assert.match(description, /finished/);
  assert.match(description, /may repeat/);
  assert.doesNotMatch(description, /never runs the task twice/);
});

test("the use_website contract renders each site from the listing, so the text depends on configuration only", () => {
  const contract = useWebsiteContract(LISTING);
  assert.deepEqual([contract.name, contract.effect, contract.replay, contract.listedWhen], ["use_website", "effect", "safe", "sites"]);
  assert.deepEqual(contract.parameters.properties.site.enum, ["shop", "billing"]);
  for (const site of LISTING) for (const text of [site.site, site.title, site.description]) assert.ok(contract.description.includes(text), text);
  assert.deepEqual(contract.parameters.required, ["site", "request_id", "instructions"]);
  assert.equal(contract.parameters.additionalProperties, false);
  assert.deepEqual(useWebsiteContract(LISTING), contract);
});

test("localSites runs one child per request: it names the site's start page, answers the child's report, and runs a request_id once", async () => {
  const sites = localSites({ shop: { title: "The shop", description: "Prices of the store's products.", startUrl: "https://shop.example.test/" } });
  assert.deepEqual(await sites.list(signal()), [{ site: "shop", title: "The shop", description: "Prices of the store's products." }]);
  const tasks = [];
  let fail = true;
  const runChild = async (task) => { tasks.push(task); if (fail) { fail = false; throw new Error("the child's model failed"); } return `report ${tasks.length}`; };
  const requestId = randomUUID();
  const input = { site: "shop", requestId, instructions: "Find the price of the 8 GB board." };
  await assert.rejects(sites.use(input, { signal: signal(), runChild }), /model failed/);
  assert.deepEqual(await sites.use(input, { signal: signal(), runChild }), { report: "report 2" }, "a failed run is tried again");
  assert.deepEqual(await sites.use(input, { signal: signal(), runChild }), { report: "report 2" }, "a finished request is answered, not rerun");
  assert.equal(tasks.length, 2);
  assert.deepEqual([tasks[1].site, tasks[1].requestId], ["shop", requestId]);
  for (const text of ["https://shop.example.test/", "The shop", "Find the price of the 8 GB board."]) assert.ok(tasks[1].prompt.includes(text), text);
  await sites.use({ ...input, requestId: randomUUID() }, { signal: signal(), runChild });
  assert.equal(tasks.length, 3, "another request_id runs another child");
  await assert.rejects(sites.use({ ...input, site: "elsewhere" }, { signal: signal(), runChild }), /no site named elsewhere/);
  assert.throws(() => localSites({ bad: { title: "Bad", description: "x", startUrl: "javascript:alert(1)" } }), /http/);
});
