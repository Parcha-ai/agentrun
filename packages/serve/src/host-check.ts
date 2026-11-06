// The Host check of a server on loopback (server.ts), the guard against DNS rebinding: a page on a name of its own, its
// address rebound to 127.0.0.1, calling this server from the person's browser. The name is what tells that page apart, so
// the check is on the name alone. The port is not part of it: through a tunnel (`ssh -L 8080:localhost:7340`), a proxy in
// front, or a server that took the next free port, a browser sends the port it opened, which is not the server's, and a
// page that rebound its name gains nothing from any port.

/** The name a Host header gives, lowercased and without its port (an IPv6 address keeps its brackets). Undefined for a
 *  header that is not `name` or `name:port`: no user part, no path, no empty or non-numeric port. */
export function hostName(header: string | undefined): string | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/.exec(String(header ?? "").trim().toLowerCase());
  return match && (match[2] === undefined || Number(match[2]) <= 65535) ? match[1] : undefined;
}

/** The names a server listening on loopback `host` answers to: this machine's (localhost, 127.0.0.1, [::1], and `host`
 *  itself), each --allow-host name, and the name of the address people open (AGENTRUN_PUBLIC_URL), which a proxy in
 *  front of it sends. */
export function loopbackNames(host: string, allowHosts: readonly string[] = [], publicUrl?: string): Set<string> {
  const own = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const names = ["localhost", "127.0.0.1", "[::1]", own, ...allowHosts];
  if (publicUrl !== undefined && URL.canParse(publicUrl)) names.push(new URL(publicUrl).hostname);
  return new Set(names.map(hostName).filter((name): name is string => name !== undefined));
}

/** What a refused request is told: the names that work and how to add one, its tunnel example on this server's own `port`
 *  (the one the request reached). It never repeats the Host it was sent. */
export const hostFix = (port: number) =>
  `this server answers at localhost or 127.0.0.1, on any port (a tunnel such as ssh -L ${port}:localhost:${port} works); to serve it at a name of its own, start it with AGENTRUN_PUBLIC_URL=https://<name> or --allow-host <name>`;

/** The page a browser gets for a refused Host: fixed text, under the console's CSP (page.ts). Its addresses carry no
 *  scheme: a published package names no loopback URL (scripts/verify-packages.mjs). */
export const hostRefusedPage = (port: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AgentRun: open it at localhost</title></head>
<body>
<h1>Open AgentRun at localhost</h1>
<p>This AgentRun server answers only at a name on its own machine, so it refused the address this page was opened at.</p>
<p>Open it at <code>localhost:&lt;port&gt;</code> or <code>127.0.0.1:&lt;port&gt;</code>, with the port you reached it on. From another computer, a tunnel works at any local port: <code>ssh -L ${port}:localhost:${port} &lt;server&gt;</code>, then open <code>localhost:${port}</code> in the browser.</p>
<p>To serve it at a name of its own (behind HTTPS, for example), start it with <code>AGENTRUN_PUBLIC_URL=https://&lt;name&gt;</code>, or add the name with <code>--allow-host &lt;name&gt;</code>.</p>
</body></html>
`;
