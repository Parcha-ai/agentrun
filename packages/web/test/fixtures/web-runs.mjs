// createWeb on fakes alone: Parallel the faux module, the network a table read through pi-browser's real guard. `steps`
// runs one fixed sequence of searches and fetches and gives what each answered: the answer, the text the model reads,
// and the receipt with each try's timing zeroed (the one field a clock decides).
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import { createWeb, searchText, webFetchText } from "../../dist/index.js";
import fakeParallel, { CANARY, resetFauxParallel } from "./faux-parallel.mjs";
import { network } from "./fake-network.mjs";

export const PUBLIC = "http://public.example/";

/** A web on the fakes, with `extra` config (a decider, its bounds) laid over. */
export function fakeWeb(extra = {}) {
  resetFauxParallel();
  const net = network();
  const guard = {
    fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }),
    check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }),
    html: readPage,
  };
  return createWeb({
    order: { search: ["parallel"], fetch: ["parallel", "direct"] },
    keys: { parallel: CANARY },
    send: { parallel: fakeParallel },
    guard,
    now: () => Date.parse("2026-11-24T12:00:00Z"),
    ...extra,
  });
}

const steady = (receipt) => ({ ...receipt, tries: receipt.tries.map((t) => (t.ms === undefined ? t : { ...t, ms: 0 })) });

/** The fixed sequence on `web`, each step's answer, model text and receipt. */
export async function steps(web) {
  const out = [];
  const search = async (query, options) => {
    const { answer, receipt } = await web.search(query, options);
    out.push({ op: "search", answer, text: searchText(answer), receipt: steady(receipt) });
  };
  const fetch = async (url, options) => {
    const { answer, receipt } = await web.fetch(url, options);
    out.push({ op: "fetch", answer, text: webFetchText(answer), receipt: steady(receipt) });
  };
  await search("widgets delaware", { n: 4 });
  await search("   ");
  await fetch(PUBLIC);
  await fetch(PUBLIC, { offset: 10, maxChars: 200 });
  await fetch("http://evil.example/");
  await fetch(PUBLIC, { maxChars: 10 });
  return out;
}
