// Other local clients probing a test server's port are not the browser. A request is set aside only when it is exactly such a probe: GET /, the User-Agent
// "Go-http-client/1.1" and no Cookie header. Every other request counts, whatever its User-Agent.
export const isPortProbe = (req) => req.method === "GET" && req.url === "/" && req.headers["user-agent"] === "Go-http-client/1.1" && req.headers.cookie === undefined;
/** The path to record for a request the browser could have made, or null for a probe. */
export const countedPath = (req) => (isPortProbe(req) ? null : new URL(req.url, "http://x").pathname);
