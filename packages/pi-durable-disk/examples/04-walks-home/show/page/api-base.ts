// Where the page's API lives. The obsession page is served at /obsession/ by the show server and, packaged with the agent's tab on one origin, at /show/obsession/ by the 03 server: its API
// calls are relative to where it is served, never to the origin's root. `?api=<url>` points them at another server (an http or https URL; anything else is ignored).
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
  u.pathname = u.pathname.replace(/\/obsession(\/(index\.html)?)?$/, "/");
  return u.toString();
}

export const apiUrl = (root: string, path: string): string => new URL(path.replace(/^\//, ""), root).toString();
