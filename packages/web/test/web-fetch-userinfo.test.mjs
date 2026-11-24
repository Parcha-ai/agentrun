// A URL's user name and password, wherever a provider's answer or error quotes one: kept out of the page web_fetch
// returns, the text the model reads, the receipt's turns and the log. Each error here quotes a URL holding them where
// a cut of its words ends inside them, so a cut made before the scrub would leave part of them behind. The network is a
// table (fixtures/fake-network.mjs) and each provider's send a stub: no socket leaves the machine, no real key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { firecrawlFetch, parallelExtract, webFetchText } from "../dist/index.js";
import { network } from "./fixtures/fake-network.mjs";
import { webFetch } from "./support.mjs";

const PUBLIC = "http://public.example/";

/** PUBLIC with `path`, holding a user name and a password: synthetic, built in code. */
const credentialed = (path = "") => {
  const url = new URL(`${PUBLIC}${path}`);
  url.username = "web-user";
  url.password = "not-a-secret";
  return url.href;
};
/** Words quoting credentialed() after `pad` characters. */
const quoting = (pad) => `${"x".repeat(pad)}${credentialed()}`;
/** `words` cut at `cut` keeps the user name and loses the "@" after the password. */
const straddles = (words, cut) => {
  const user = words.indexOf("web-user");
  return user >= 0 && user + "web-user".length <= cut && words.indexOf("@", user) >= cut;
};
/** A send failing with `words`, as a transport's error would. */
const failing = (words) => async () => { throw new TypeError(words); };
/** The names in `where` (a name for each value) whose value holds any part of the user name or the password. */
const leaking = (where) => Object.entries(where).filter(([, what]) => /web-user|not-a-secr/.test(typeof what === "string" ? what : JSON.stringify(what))).map(([at]) => at);
const turns = (tries) => tries.map((one) => [one.provider, one.outcome]);

/** web_fetch of PUBLIC with `given` (a client, the order): the page, the receipt's turns and the log. */
async function fetched(given) {
  const tries = [];
  const logs = [];
  const page = await webFetch(PUBLIC, { ...network(), ...given, tried: (one) => tries.push(one), log: (event, fields) => logs.push({ event, fields }) });
  return { page, tries, logs };
}
/** Where a fetch by `provider` could quote them: the receipt's turns, the page, the text the model reads, the log. */
const places = (provider, { page, tries, logs }) => ({ [`${provider}: the receipt turns`]: tries, [`${provider}: the page`]: page, [`${provider}: the text the model reads`]: webFetchText(page), [`${provider}: the log`]: logs });

test("an error a provider gives that quotes a URL with a user name and password past where it is cut: no part of them reaches the receipt's turns, the page the model reads, or the log", async () => {
  // Firecrawl's client keeps these words whole after its "failed: "; web_fetch cuts what Firecrawl said at 300.
  const firecrawlWords = quoting(250);
  assert.ok(straddles(`Firecrawl's fetch failed: ${firecrawlWords}`, 300), "the cut of what Firecrawl said ends inside them");
  // Parallel's client cuts these words at 200 after its "failed: ".
  const parallelWords = quoting(180);
  assert.ok(straddles(parallelWords, 200), "the cut of Parallel words ends inside them");
  const rows = [
    ["firecrawl-keyless", { firecrawl: firecrawlFetch({ send: failing(firecrawlWords) }) }],
    ["parallel", { parallel: parallelExtract("not-a-secret", failing(parallelWords)) }],
  ];
  const leaks = [];
  for (const [provider, client] of rows) {
    const read = await fetched({ ...client, order: [provider, "direct"] });
    assert.deepEqual(turns(read.tries), [[provider, "error"], ["direct", "ok"]], `${provider}: the turns`);
    assert.match(read.tries[0].error, /failed: x{100}/, `${provider}: the turn says it failed`);
    leaks.push(...leaking(places(provider, read)));
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
});
