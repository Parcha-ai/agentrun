// What a server of another package takes to serve the store's page as its own: STORE_PAGE_FILES, the files the page is,
// and storeApi, the read-only JSON behind its /api/* paths; and page.js's one seam, window.agentStoreHost, which a
// script loaded before page.js sets to draw routes of its own and add to the agent page. Without one nothing changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { serveStore, STORE_PAGE_FILES, storeApi } from "../dist/serve/index.js";
import { buildSampleStore } from "./fixtures/store-sample.mjs";
import { all, assertInert, mount } from "./page-dom.mjs";
import { request, scratch } from "./support.mjs";

const classOf = (el) => el.getAttribute("class") ?? "";

test("STORE_PAGE_FILES are the files serveStore serves, each at its path with its type", async () => {
  const { root } = await buildSampleStore(await scratch());
  const served = await serveStore({ dir: root });
  try {
    assert.deepEqual(Object.keys(STORE_PAGE_FILES).sort(), ["/", "/graph.js", "/page.css", "/page.js"]);
    for (const [route, { path, type }] of Object.entries(STORE_PAGE_FILES)) {
      const res = await request(served.url, { target: route });
      assert.equal(res.status, 200, route);
      assert.equal(res.headers["content-type"], type, route);
      assert.equal(res.body, readFileSync(path, "utf8"), route);
    }
  } finally {
    await served.close();
  }
});

test("storeApi answers every /api path as serveStore does, a refusal included, and a folder with no store.sqlite is an answer, not a throw", async () => {
  const { root, ids, revisions } = await buildSampleStore(await scratch());
  const served = await serveStore({ dir: root });
  const api = storeApi({ dir: root });
  try {
    const targets = ["/api/store", "/api/agents/company-researcher", "/api/agents/mcc-classifier", "/api/runs", "/api/runs?agent=inbox-triage", `/api/runs?revision=${revisions.B.id}`, `/api/runs/${ids.a1}`, `/api/runs/${ids.c2}`, `/api/runs/${ids.m2}`, "/api/agents/nobody", "/api/runs/not%20an%20id", "/api/runs?agent=..", "/api/nothing"];
    for (const target of targets) {
      const url = new URL(target, "http://127.0.0.1");
      const res = await request(served.url, { target });
      const answer = await api(url.pathname, url.searchParams);
      assert.deepEqual({ status: answer.status, value: JSON.parse(JSON.stringify(answer.value)) }, { status: res.status, value: JSON.parse(res.body) }, target);
    }
  } finally {
    await served.close();
  }
  const empty = await storeApi({ dir: await scratch() })("/api/store", new URLSearchParams());
  assert.deepEqual(empty, { status: 404, value: { error: "there is no store.sqlite in that folder" } });
});

const REV = (id, current) => ({ id: id.repeat(64), kind: "agentic", current, createdAt: "2026-10-22T10:00:00.000Z", parent: null, parentKind: null, diff: null, body: { instructions: "Answer.", tools: [], skills: {} } });
const AGENT = { agent: { id: "calc", name: "Calc", createdAt: "2026-10-21T09:00:00.000Z", current: "b".repeat(64) }, revisions: [REV("b", true), REV("a", false)] };
const API = { "api/store": { agents: [] }, "api/agents/calc": AGENT, "api/runs?agent=calc": [] };

/** A host that records what it was given and draws "#/mine" itself. */
function recordingHost() {
  const seen = { kits: [], hashes: [], tokens: [] };
  const host = (kit) => {
    seen.kits.push(kit);
    return {
      name: "My server",
      route(hash, token) {
        seen.hashes.push(hash);
        seen.tokens.push(token);
        if (hash !== "#/mine") return false;
        kit.crumb([["Mine", "#/mine"]]);
        kit.titled("Mine");
        kit.show(kit.el("section", { class: "card mine" }, kit.kicker("Mine"), kit.el("p", null, kit.plural(2, "run"))));
        return true;
      },
      agent: (agent, revisions) => kit.el("p", { class: "host-agent" }, `${agent.id} has ${revisions.length}`),
      revision: (agent, revision) => (revision.current ? null : kit.el("span", { class: "host-revision" }, `${agent.id}:${kit.short(revision.id)}`)),
      cards: (agent, revisions, filter) => kit.el("section", { class: "card host-card" }, `${agent.id}: ${revisions.length} revisions, filter ${filter ?? "none"}`),
      empty: () => kit.el("p", { class: "host-empty" }, "Nothing here: make one"),
    };
  };
  return { seen, host };
}

test("a host takes the routes it draws itself, with this page's parts: page.js fetches nothing for them and draws every other route as before", async () => {
  const { seen, host } = recordingHost();
  const page = mount(API, "#/mine", { serve: "store", window: { agentStoreHost: host } });
  await page.settle();
  assert.equal(seen.kits.length, 1, "the host is made once");
  for (const name of ["el", "show", "crumb", "get", "failed", "later", "live", "kicker", "pill", "kindPill", "when", "ago", "took", "usd", "cost", "clip", "short", "plural", "agentHref", "timeline", "storeRunPage", "openCalls", "reopen", "route", "titled"]) assert.equal(typeof seen.kits[0][name], "function", name);
  assert.deepEqual(page.fetched, []);
  assert.equal(all(page.app).filter((el) => classOf(el) === "card mine").length, 1);
  assert.match(page.app.textContent, /2 runs/);
  assert.equal(page.document.title, "Mine · My server", "the host's own view, under the host's name");
  assert.deepEqual(all(page.document.getElementById("crumbs")).filter((el) => el.tagName === "A").map((el) => el.textContent), ["Agents", "Mine"]);
  assert.equal(seen.kits[0].live(seen.tokens[0]), true, "the view's token is live while it is shown");

  await page.go("#/");
  assert.deepEqual(seen.hashes, ["#/mine", "#/"]);
  assert.equal(seen.kits[0].live(seen.tokens[0]), false, "and not once another view is");
  assert.deepEqual(page.fetched, ["api/store"], "page.js drew the picker");
  assert.match(page.app.textContent, /0 agents/);
  assert.equal(all(page.app).find((el) => classOf(el) === "host-empty").textContent, "Nothing here: make one", "an empty store says what the host says");
  assert.ok(!page.app.textContent.includes("No agents in this store yet."));
  assert.equal(page.document.title, "My server", "page.js's own views take the host's name");
});

test("a host adds to the agent card and to each revision's head, given the agent; without a host the agent page is drawn as before", async () => {
  const { host } = recordingHost();
  const page = mount(API, "#/agents/calc", { serve: "store", window: { agentStoreHost: host } });
  await page.settle();
  const card = all(page.app).find((el) => classOf(el) === "card agent");
  assert.equal(all(card).find((el) => classOf(el) === "host-agent").textContent, "calc has 2");
  assert.equal(page.document.title, "Calc · My server");
  const heads = all(page.app).filter((el) => classOf(el) === "rev-head");
  assert.deepEqual(heads.map((head) => all(head).filter((el) => classOf(el) === "host-revision").map((el) => el.textContent)), [[], ["calc:aaaaaaaaaaaa"]]);

  const plain = mount(API, "#/agents/calc", { serve: "store" });
  await plain.settle();
  assertInert(plain.app);
  assert.equal(all(plain.app).filter((el) => /^host-/.test(classOf(el))).length, 0);
  assert.equal(plain.app.textContent, page.app.textContent.replace("calc has 2", "").replace("calc:aaaaaaaaaaaa", "").replace("calc: 2 revisions, filter none", ""));
  assert.equal(plain.document.title, "Calc · agent store");
});

test("a host adds cards after the agent card, given the revision filter", async () => {
  const { host } = recordingHost();
  const page = mount({ ...API, [`api/runs?agent=calc&revision=${"a".repeat(64)}`]: [] }, `#/agents/calc?revision=${"a".repeat(64)}`, { serve: "store", window: { agentStoreHost: host } });
  await page.settle();
  const cards = all(page.app).filter((el) => el.tagName === "SECTION").map(classOf);
  assert.deepEqual(cards, ["card agent", "card host-card", "card runs", "card revs"], "the host's cards sit between the agent card and its runs");
  assert.equal(all(page.app).find((el) => classOf(el) === "card host-card").textContent, `calc: 2 revisions, filter ${"a".repeat(64)}`);
});

test("an agent home's page takes no host: the script is the store page's only", async () => {
  const { seen, host } = recordingHost();
  const page = mount({ "api/agent": { identity: { id: "calc", name: "Calc" }, definition: {}, skills: [], prompts: [] }, "api/runs": [] }, "#/mine", { window: { agentStoreHost: host } });
  await page.settle();
  assert.equal(seen.kits.length, 0);
  assert.deepEqual(page.fetched, ["api/agent", "api/runs"]);
});
