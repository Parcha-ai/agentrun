// Which computer providers can be a box comes from their descriptors (place-offers.ts isBox), never a list of names: a
// sandbox place on a box is a sandbox computer on that provider with no image named, so a box is a provider that serves
// the sandbox kind, holds the run's folder, starts with no image named and keeps to places.allow (or reaches nothing). A
// vendor's box is enabled by AGENTRUN_BOXES and offered once its required keys are set; nothing asks the vendor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { providerFromEnv } from "../dist/computer-keys.js";
import { keyReader } from "../dist/key-meta.js";
import { BOX_IDS, enabledBoxes, placeOffers, withNetworks } from "../dist/place-offers.js";
import { placeIssues } from "../dist/place.js";

const BOXES = ["docker", "daytona", "modal", "e2b", "agent37", "morph", "cloudflare", "fly", "render", "boxd", "groundbox", "vercel", "sprites", "instabox", "northflank"];

test("every provider whose descriptor gives a box's needs is a box, in Settings' order; one that can't hold a run's shell and folder is not", () => {
  assert.deepEqual([...BOX_IDS], BOXES);
  // A browser and a phone serve no sandbox, Orgo serves desktops alone, and smol cloud's machines take no run's folder
  // (their own disk sits where it would be).
  const not = ["orgo", "phone-harness", "browserbase", "kernel", "local-chrome", "smolcloud"];
  for (const id of not) assert.ok(!BOX_IDS.includes(id), `${id} is not a box`);
  assert.deepEqual(PROVIDERS.map((entry) => entry.id).filter((id) => !BOX_IDS.includes(id)), not, "every other provider is a box");
});

test("a place may name any box, and no provider that is not one", () => {
  assert.deepEqual(placeIssues({ mode: "sandbox", box: "e2b" }, "definition.place"), []);
  const [refused] = placeIssues({ mode: "sandbox", box: "browserbase" }, "definition.place");
  assert.deepEqual([refused.reason, refused.message], ["not_an_option", `definition.place.box is one of ${BOXES.join(", ")}`]);
});

test("a vendor's box is enabled by AGENTRUN_BOXES and offered once its required keys are set, asking the vendor nothing", async () => {
  const asked = [];
  const keyOf = async (name) => (asked.push(name), name === "E2B_API_KEY" ? "fake-test-key" : undefined);
  const offers = await placeOffers({ AGENTRUN_BOXES: "e2b,fly" }, { keyOf });
  assert.deepEqual(offers.find((offer) => offer.id === "e2b"), { id: "e2b", available: true, reason: "configured; not probed at start" });
  assert.deepEqual(offers.find((offer) => offer.id === "fly"), { id: "fly", available: false, reason: "needs FLY_API_TOKEN and FLY_APP" });
  assert.deepEqual(offers.find((offer) => offer.id === "morph"), { id: "morph", available: false, reason: "not enabled on this server: start AgentRun with AGENTRUN_BOXES=e2b,morph,fly" });
  assert.deepEqual(asked.sort(), ["E2B_API_KEY", "FLY_API_TOKEN", "FLY_APP"], "only the listed boxes' required keys are read");
  assert.ok(!JSON.stringify(offers).includes("fake-test-key"), "no key's value in an offer");
  assert.throws(() => enabledBoxes({ AGENTRUN_BOXES: "e2b,browserbase" }), new RegExp(`AGENTRUN_BOXES names browserbase, which is not a box: list any of ${BOXES.join(", ")}`));
});

test("what a vendor's box reaches is its descriptor's: the host list where its computers keep to one, nothing where they have no network", async () => {
  const offers = await placeOffers({ AGENTRUN_BOXES: "e2b,boxd", E2B_API_KEY: "fake-test-key", BOXD_API_KEY: "fake-test-key" });
  const by = (list) => Object.fromEntries(list.filter((offer) => offer.available).map((offer) => [offer.id, offer]));
  const listed = by(withNetworks(offers, ["pypi.org"]));
  assert.deepEqual(listed.e2b, { id: "e2b", available: true, reason: "configured; not probed at start", network: "allowlist" });
  assert.deepEqual(listed.boxd, { id: "boxd", available: true, reason: "configured; not probed at start", network: "none", network_reason: "boxd's computers run with no network, whatever AGENTRUN_BOX_ALLOW lists" });
  const none = by(withNetworks(offers, "none"));
  assert.deepEqual([none.e2b.network, none.e2b.network_reason, none.boxd.network, none.boxd.network_reason], ["none", undefined, "none", undefined]);
});

// What Northflank injects into every service it runs: its runtime variables and build arguments (Northflank's docs,
// v1/application/secure/inject-secrets, "Access Northflank injected secrets").
const NORTHFLANK_INJECTED = {
  NF_HOSTS: "a.example.test",
  NF_HOSTS_CUSTOM: "b.example.test",
  NF_OBJECT_ID: "a-service",
  NF_PROJECT_ID: "a-project",
  NF_DEPLOYMENT_SHA: "0".repeat(40),
  NF_DEPLOYMENT_REPO: "example/repo",
  NF_DEPLOYMENT_BRANCH: "main",
  NF_GIT_SHA: "1".repeat(40),
  NF_GIT_BRANCH: "main",
  NF_PREVIOUS_BUILD_GIT_SHA: "2".repeat(40),
};
// What an operator's host on Northflank may carry beside them: a CLI or SDK token under NF_API_TOKEN, a project, team,
// service or region under NF_ or NORTHFLANK_ names, the CLI's config directory (NF_CONFIG_DIR, NORTHFLANK_CONFIG_DIR:
// Northflank's docs, v1/api/use-the-cli).
const OPERATOR_HOST = {
  NF_API_TOKEN: "fake-test-key-nf",
  NORTHFLANK_PROJECT_ID: "a-project",
  NF_TEAM_ID: "a-team",
  NF_SERVICE_ID: "a-service",
  NF_REGION: "a-region",
  NF_CONFIG_DIR: "config",
  NORTHFLANK_CONFIG_DIR: "config",
};

test("Northflank's own environment never turns its box on: what it injects and an operator's NF_API_TOKEN are no keys, and nothing is called; both of the box's own keys alone do", async () => {
  // As the server reads a box's keys (server.ts placeOffers, workspace/computer-deps.ts): the environment, else a saved
  // key, of which there is none here.
  const offerOf = async (env) => (await placeOffers(env, { keyOf: keyReader({ sealedKeys: { get: async () => undefined } }, undefined, env) })).find((offer) => offer.id === "northflank");
  const fetched = [];
  const fetch = async (url, init) => {
    fetched.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname} ${new Headers(init?.headers).get("authorization")}`);
    return new Response(JSON.stringify({ error: { status: 404, message: "not found" } }), { status: 404, headers: { "content-type": "application/json" } });
  };
  const hosted = { ...NORTHFLANK_INJECTED, ...OPERATOR_HOST };
  const unset = await offerOf(hosted);
  assert.deepEqual([unset.available, /not enabled/.test(unset.reason)], [false, true], "absent unless AGENTRUN_BOXES lists it");

  // Listed, on Northflank's environment alone: unavailable, and no provider is made.
  const listed = { ...hosted, AGENTRUN_BOXES: "northflank" };
  assert.deepEqual(await offerOf(listed), { id: "northflank", available: false, reason: "needs NORTHFLANK_API_TOKEN and NORTHFLANK_COMPUTER_PROJECT_ID" });
  assert.deepEqual(await providerFromEnv("northflank", listed, { fetch }), { ok: false, error: { code: "missing_key", message: "Northflank needs NORTHFLANK_API_TOKEN and NORTHFLANK_COMPUTER_PROJECT_ID saved: save them in Settings → Computers (PUT /v2/computers/northflank/keys)" } });

  // The box's token without its project: still unavailable, still no provider.
  const tokenOnly = { ...listed, NORTHFLANK_API_TOKEN: "fake-test-key-own" };
  assert.deepEqual(await offerOf(tokenOnly), { id: "northflank", available: false, reason: "needs NORTHFLANK_COMPUTER_PROJECT_ID" });
  assert.deepEqual(await providerFromEnv("northflank", tokenOnly, { fetch }), { ok: false, error: { code: "missing_key", message: "Northflank needs NORTHFLANK_COMPUTER_PROJECT_ID saved: save it in Settings → Computers (PUT /v2/computers/northflank/keys)" } });
  assert.deepEqual(fetched, [], "the Northflank API saw no request");

  // Both of the box's own keys: available, and the provider made is theirs: their project and token, never NF_'s.
  const own = { ...tokenOnly, NORTHFLANK_COMPUTER_PROJECT_ID: "my-sandboxes" };
  assert.deepEqual(await offerOf(own), { id: "northflank", available: true, reason: "configured; not probed at start" });
  const made = await providerFromEnv("northflank", own, { fetch });
  assert.equal(made.ok, true, JSON.stringify(made.error));
  assert.deepEqual(fetched, [], "turning it on and making the provider call nothing");
  assert.equal(await made.value.host.get("computer-0123456789ab", { timeoutMs: 5_000 }), undefined);
  assert.deepEqual(fetched, ["GET /v1/projects/my-sandboxes/services/computer-0123456789ab Bearer fake-test-key-own"]);
});
