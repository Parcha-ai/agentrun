// Where the page's API lives. The obsession page is served at /obsession/ by the show server and, packaged with the agent's tab on one origin, at /show/obsession/ by the 03 server: its API
// calls are relative to where it is served, never to the origin's root (and the stage as the 03 server mounts it has its index at /show/). `?api=<url>` points them at another server (an http or https URL; anything else is ignored).
export function apiRoot(pageHref: string, apiParam: string | null): string {
  if (apiParam !== null) {
    try {
      const u = new URL(apiParam);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.search = "";
        u.hash = "";
        if (!u.pathname.endsWith("/")) u.pathname += "/";
        return u.toString();
      }
    } catch {
      // not a URL: the page's own server
    }
  }
  const u = new URL(pageHref);
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/obsession(\/(index\.html)?)?$/, "/").replace(/\/index\.html$/, "/");
  return u.toString();
}

export const apiUrl = (root: string, path: string): string => new URL(path.replace(/^\//, ""), root).toString();

/** The page's settings: the query, then the fragment over it. The fragment is not sent to a server or a service worker, so with the settings there the page's URL stays the plain one the agent's offline copy has cached. */
export function pageParams(href: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(new URL(href).search);
  for (const [k, v] of new URLSearchParams(hash.replace(/^#/, ""))) params.set(k, v);
  return params;
}
