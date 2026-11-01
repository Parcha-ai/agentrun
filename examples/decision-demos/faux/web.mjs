// Under --faux only: fetch_page's network in the run's process (AGENTRUN_SERVE_FAUX_WEB). The invented merchants in
// fixtures.mjs resolve to public-looking addresses and serve their pages; any other name does not resolve.
import { merchants } from "./fixtures.mjs";

const page = (m) => `<!doctype html><html><head><meta charset="utf-8"><title>${m.title}</title></head><body>${m.body}</body></html>`;

export default function web() {
  return {
    lookup: async (host) => {
      const m = merchants[host];
      if (!m) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return [m.ip];
    },
    fetchImpl: async (target) => {
      const url = new URL(String(target?.href ?? target?.url ?? target));
      const m = merchants[url.hostname];
      if (!m) return new Response("Not here.", { status: 404, headers: { "content-type": "text/plain" } });
      if (url.pathname === "/" || url.pathname === "") return new Response(page(m), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response(`<html><head><title>${m.name}</title></head><body><p>Page not found.</p></body></html>`, { status: 404, headers: { "content-type": "text/html" } });
    },
  };
}
