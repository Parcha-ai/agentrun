// A run's purge (DELETE /runs/{id}) rewrites its agent's learning history (learn/purge.ts forgetRunText), so every
// commit's id changes. Each other run's learning diff, read by run id through GET /runs/{id}/learning/diff (the route the
// console reads), is still its own merge: the route finds it by the run's marker (.agentrun/runs/<run>) in the rewritten
// history, never by the commit id its learning end recorded. The purged run's diff is gone (410 purged, its tombstone).
// On the local folder and on code.storage (over its fake) alike.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { learningStoreOf, useLearningStore } from "../dist/learn/store-of.js";
import { codeStorageFake } from "./fixtures/code-storage-fake.mjs";
import { fedBack, LEARN, learner, made } from "./learn-support.mjs";
import { serve } from "./support.mjs";

/** Each store's settings for the server's data directory: none (the local folder), or code.storage over a fake. */
const STORES = {
  local: () => undefined,
  "code.storage": () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fake = codeStorageFake({ name: "example-org", publicKey });
    return { name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => "0123456789ab" };
  },
};

for (const [kind, settingsOf] of Object.entries(STORES)) {
  test(`${kind}: runs A, B and C merged, then B purged: A's and C's learning diffs, read by run id through the console's route, are each its own merge in the rewritten history, and B's is gone`, { timeout: 240_000 }, async (t) => {
    const { api, data } = await serve(t, { learning: "on", faux: LEARN });
    const settings = settingsOf();
    if (settings) {
      useLearningStore(data, settings);
      t.after(() => useLearningStore(data, undefined));
    }
    await made(api, learner("keeper"));
    // Each run's owner corrected it: its feedback round merged one line of corrections.md, its own words.
    const runs = {};
    for (const word of ["ALPHA", "BRAVO", "CHARLIE"]) {
      const { view } = await fedBack(api, "keeper", { content: `Question ${word.toLowerCase()}.`, label: `Say ${word} first.` });
      assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
      // The merge its learning end recorded (GET /runs/{id}/learning's `merged`).
      const kept = await api("GET", `/runs/${view.run_id}/learning`);
      assert.match(kept.body?.merged ?? "", /^[0-9a-f]{40}$/, JSON.stringify(kept.body));
      runs[word] = { id: view.run_id, merged: kept.body.merged };
    }
    const diffOf = (word) => api("GET", `/runs/${runs[word].id}/learning/diff`);
    const charlie = await diffOf("CHARLIE");
    assert.equal(charlie.status, 200, JSON.stringify(charlie.body));
    assert.equal(charlie.body.head, runs.CHARLIE.merged);
    assert.match(JSON.stringify(charlie.body), /BRAVO/, "before the purge C's diff shows B's line as context");

    assert.equal((await api("DELETE", `/runs/${runs.BRAVO.id}`)).status, 204);
    const learning = learningStoreOf(data, "keeper");
    const history = new Set(((await learning.log(await learning.head())) ?? []).map((commit) => commit.sha));
    for (const word of ["ALPHA", "CHARLIE"]) {
      const got = await diffOf(word);
      assert.equal(got.status, 200, `${word}: ${JSON.stringify(got.body)}`);
      assert.notEqual(got.body.head, runs[word].merged, `${word}: the purge moved its merge`);
      assert.ok(history.has(got.body.head) && history.has(got.body.base), `${word}: its merge and its parent are commits of the rewritten history: ${JSON.stringify(got.body)}`);
      const patch = got.body.files.find((file) => file.path === "corrections.md")?.patch ?? "";
      assert.match(patch, new RegExp(`^\\+.*Say ${word} first\\.$`, "m"), `${word}: its own line, added`);
      assert.doesNotMatch(JSON.stringify(got.body), /BRAVO/, `${word}: no word of B's`);
    }
    const gone = await diffOf("BRAVO");
    assert.deepEqual([gone.status, gone.body?.error?.code], [410, "purged"], JSON.stringify(gone.body));
  });
}
