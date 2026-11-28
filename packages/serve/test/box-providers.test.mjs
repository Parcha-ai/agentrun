// Which computer providers can be a box comes from their descriptors (place-offers.ts isBox), never a list of names: a
// sandbox place on a box is a sandbox computer on that provider with no image named, so a box is a provider that serves
// the sandbox kind, holds the run's folder, starts with no image named and keeps to places.allow (or reaches nothing). A
// vendor's box is enabled by AGENTRUN_BOXES and offered once its required keys are set; nothing asks the vendor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { BOX_IDS, enabledBoxes, placeOffers, withNetworks } from "../dist/place-offers.js";
import { placeIssues } from "../dist/place.js";

const BOXES = ["docker", "daytona", "modal", "e2b", "agent37", "morph", "cloudflare", "fly", "render", "boxd", "groundbox", "vercel"];

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
