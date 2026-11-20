// web_save's network in the run's process, for the tests: one public CDN host serving a PNG and a redirect to it, every
// other name unknown. No socket: names resolve from a table and each answer is made here.
/** A PNG: its eight-byte signature, then every byte value once, so a body decoded as text anywhere would not survive. */
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 256 }, (_, i) => i)]);

export default function web() {
  return {
    lookup: async (host) => {
      if (host === "cdn.example") return ["93.184.216.40"];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    },
    fetchImpl: async (url) => {
      if (url.href === "https://cdn.example/files/cat.png") return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
      if (url.href === "https://cdn.example/r/cat") return new Response(null, { status: 302, headers: { location: "/files/cat.png" } });
      return new Response("Not here.", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}
