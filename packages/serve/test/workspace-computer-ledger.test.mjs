// A provider whose sessions carry no labels of their own (the phone provider) takes a ledger serve backs by the store
// (workspace/computer-ledger.ts), in the shape of the phone provider's `ledger` option (PhoneLedger): put, get, list and
// remove a session's whole entry ({ id, labels, image, deadline }) by its id, one provider's rows only, each entry read
// back as it was put, and still there after a restart (a new store over the same file). The calls are the ones the
// provider makes: put at create and attach, get by id, list filtered by labels, remove at release.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { computerProviderMakers, storeLedger } from "../dist/workspace/index.js";
import { storeOn } from "./store-helpers.mjs";

const A = { id: "sess-a", labels: { "agentrun.run": "run-1", "agentrun.epoch": "2" }, image: "android-14", deadline: "2026-11-08T21:30:00.000Z" };
const B = { id: "sess-b", labels: { "agentrun.run": "run-2" }, image: "android-14", deadline: "2026-11-08T21:45:00Z" };

test("the store's ledger goes to every provider whose descriptor declares one, as the option it names, and to no other", async () => {
  const made = [];
  const load = async (id, options) => (made.push([id, options]), {});
  const ledger = { list: async () => [] };
  const makers = computerProviderMakers({ load, entries: [{ id: "acme-phones", ledger: { option: "sessions" } }, { id: "acme-boxes" }] });
  await makers["acme-phones"]({ apiKey: "k" }, { ledger });
  await makers["acme-boxes"]({ apiKey: "k" }, { ledger });
  assert.deepEqual(made, [["acme-phones", { apiKey: "k", sessions: ledger }], ["acme-boxes", { apiKey: "k" }]]);
  // The package's own providers: exactly those whose descriptors declare a ledger get one.
  const declared = PROVIDERS.filter((entry) => entry.ledger).map((entry) => entry.id);
  assert.ok(declared.length > 0, "a built-in provider declares a ledger");
  made.length = 0;
  const builtins = computerProviderMakers({ load });
  for (const entry of PROVIDERS) await builtins[entry.id]({}, { ledger });
  assert.deepEqual(made.filter(([, options]) => Object.values(options).includes(ledger)).map(([id]) => id), declared);
});

test("the ledger keeps a provider's whole session entry by its id, read back as put, its rows only", async (t) => {
  const { store } = await storeOn(t);
  const phone = storeLedger(store.computerLedger, "phone-harness");
  const other = storeLedger(store.computerLedger, "other");
  await phone.put(A);
  await phone.put(B);
  await other.put({ ...A, labels: { "agentrun.run": "run-9" } });
  assert.deepEqual(await phone.get("sess-a"), A);
  assert.equal(await phone.get("sess-none"), undefined);
  assert.deepEqual(await phone.list(), [A, B]);
  assert.deepEqual((await phone.list()).filter((one) => one.labels["agentrun.run"] === "run-2").map((one) => one.id), ["sess-b"], "the provider's attach by labels");
  await phone.put({ ...A, deadline: "2026-11-08T22:00:00.000Z" });
  assert.equal((await phone.get("sess-a")).deadline, "2026-11-08T22:00:00.000Z", "a put again replaces it in place");
  await phone.remove("sess-b");
  assert.deepEqual((await phone.list()).map((one) => one.id), ["sess-a"]);
  assert.deepEqual((await other.list()).map((one) => [one.id, one.labels]), [["sess-a", { "agentrun.run": "run-9" }]], "another provider's rows are its own");
});

test("an entry read back is the caller's to change: the ledger's copy stays as put", async (t) => {
  const { store } = await storeOn(t);
  const phone = storeLedger(store.computerLedger, "phone-harness");
  const entry = structuredClone(A);
  await phone.put(entry);
  entry.labels["agentrun.run"] = "changed";
  (await phone.get("sess-a")).labels["agentrun.epoch"] = "changed";
  assert.deepEqual(await phone.get("sess-a"), A);
});

test("a restart keeps the ledger: a new store over the same file still lists the session's entry", async (t) => {
  const first = await storeOn(t);
  await storeLedger(first.store.computerLedger, "phone-harness").put(A);
  await first.store.flush();
  await first.store.close();
  const again = await storeOn(t, { file: first.file });
  assert.deepEqual(await storeLedger(again.store.computerLedger, "phone-harness").list(), [A]);
});
