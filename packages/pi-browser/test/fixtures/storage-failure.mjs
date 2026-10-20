// What the tests of a release the store cannot record share: a storage whose commits fail on demand, a driver factory that counts closes, and a durable
// browser extension on a Harness whose model takes one snapshot.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as durable from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";

const { createRegistry, Harness } = durable;
// From pi-durable 1.2 the first error a Storage method throws fails the whole Session, and every later call with it,
// and the Session ends "failed". Before 1.2 a failed read fails only its call, and a failed commit poisons the Session
// with no sign of it.
export const FAILS_SESSION = typeof durable.SessionFailed === "function";

export const START = "https://shop.example.test/";
export const PAGE = { url: START, title: "Shop", text: "Raspberry Pi 5 8GB costs $80", html: "<html><body><h1>Shop</h1><p>Raspberry Pi 5 8GB costs $80</p></body></html>" };
export const CONFIG = { label: "node-a", run: "run-storage", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
export const AGENT = { model: { provider: "faux", modelId: "faux-1" } };
export const init = (browser) => async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); };
export const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
export const toolUse = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${randomUUID().slice(0, 8)}` })], { stopReason: "toolUse" });

/** `storage` whose commits fail on demand: `releaseFails` commits that create a browser release task, then every commit
 *  once `failAll` is set. A refused commit stores none of its writes. The next commit that creates a release task waits
 *  for `held` when it is set, with `waiting` true meanwhile. */
export function failing(storage) {
  const knobs = { releaseFails: 0, failAll: false, refused: 0, held: null, waiting: false };
  const releaseTask = (write) => write.type === "task" && write.value?.kind === "browser.release";
  const commit = async (writes, context) => {
    if (knobs.held && writes.some(releaseTask)) {
      const held = knobs.held;
      knobs.held = null;
      knobs.waiting = true;
      await held;
      knobs.waiting = false;
    }
    if (knobs.failAll || (knobs.releaseFails > 0 && writes.some(releaseTask))) {
      if (!knobs.failAll) knobs.releaseFails -= 1;
      knobs.refused += 1;
      throw new Error("the storage refused the write");
    }
    return storage.commit(writes, context);
  };
  // A Proxy, not Object.create: a class storage's members read its private fields, so each is bound to it.
  return { knobs, storage: new Proxy(storage, { get: (target, key) => key === "commit" ? commit : typeof target[key] === "function" ? target[key].bind(target) : target[key] }) };
}

/** A driver factory that counts the drivers it opened and how many were closed. */
export function counted(open) {
  const drivers = { opened: 0, closed: 0 };
  const driver = async (...args) => {
    const d = await open(...args);
    drivers.opened += 1;
    return { ...d, close: async () => { await d.close(); drivers.closed += 1; } };
  };
  return { drivers, driver };
}

/** A driver over no browser at all, for a provider whose attach target nothing here drives. */
export const stubDriver = async () => ({
  snapshot: async () => "- heading \"Shop\" [ref=e1]",
  run: async () => null,
  url: async () => START,
  screenshot: async () => ({ data: "", mimeType: "image/png" }),
  page: async () => PAGE,
  close: async () => {},
});

export async function until(check, ms = 3_000) {
  for (const end = Date.now() + ms; !(await check()) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 25));
  return check();
}

export async function open(storage, { provider, driver, responses, ...extra }) {
  const browser = createBrowserExtension({ provider: () => provider, driver, evidence: { file: async (label, record) => ({ path: `evidence/${label}/${record.tool}.md`, bodyLine: 1 }) }, ...extra });
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(responses);
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(storage, { models, registry }, ctx);
  // A run opens with a reconcile of every open lease, as the host's does.
  const report = await browser.reconcile(harness, () => true, ctx);
  return { harness, browser, report };
}

/** The conversation takes one snapshot and stops. */
export const browsesOnce = () => Array.from({ length: 10 }, () => async (context) => context.messages.at(-1).role === "toolResult" ? fauxAssistantMessage([fauxText("Seen.")], { stopReason: "stop" }) : toolUse("snapshot", {}));
