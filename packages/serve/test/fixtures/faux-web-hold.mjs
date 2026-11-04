// fetch_page's network in the run's process for the tests, as faux-web.mjs, with one more page: http://public.example/hold
// answers only once the file its `until` query names exists, so a harness's turn holds, in its own process, until the
// test lets it go.
import { existsSync } from "node:fs";
import { network } from "./fake-network.mjs";

export default function web() {
  const { lookup, fetchImpl } = network();
  return {
    lookup,
    fetchImpl: async (url, init) => {
      if (url.origin === "http://public.example" && url.pathname === "/hold") {
        const until = url.searchParams.get("until") ?? "";
        while (!existsSync(until)) await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response("Held, then let go.", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return fetchImpl(url, init);
    },
  };
}
