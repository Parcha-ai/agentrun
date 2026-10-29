// A network for fetch_page's tests, with no socket: names resolve from a table, and a fetch answers from a table and
// records what it was asked to dial. Every hostile name here resolves to a private address.
const PAGE = `<html><head><title>Public page</title></head><body><h1>Hello</h1><p>The answer is forty-two.</p>
<a href="/about">About</a> <a href="https://other.example/x#part">Other</a> <a href="mailto:someone@other.example">Mail</a></body></html>`;

const NAMES = {
  "public.example": ["93.184.216.34"],
  "redirect.example": ["93.184.216.35"],
  "renamed.example": ["93.184.216.36"],
  "evil.example": ["127.0.0.1"],
  "mixed.example": ["93.184.216.37", "10.0.0.5"],
};

/** `{ lookup, fetchImpl }` for publicFetch, and `dialled`, every URL fetchImpl was asked for; `onDial` sees each too. */
export function network(onDial = () => undefined) {
  const dialled = [];
  return {
    dialled,
    lookup: async (host) => {
      if (!Object.hasOwn(NAMES, host)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return NAMES[host];
    },
    fetchImpl: async (url) => {
      dialled.push(url.href);
      onDial(url.href);
      if (url.href === "http://public.example/") return new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.href === "http://public.example/notes.txt") return new Response("Plain notes.", { status: 200, headers: { "content-type": "text/plain" } });
      if (url.href === "http://public.example/image.png") return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
      if (url.href === "http://redirect.example/") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9421/v1/models" } });
      if (url.href === "http://renamed.example/") return new Response(null, { status: 301, headers: { location: "http://evil.example/" } });
      return new Response("Not here.", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}
