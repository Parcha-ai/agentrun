// The origins an API-only server's token may save an MCP server at (AGENTRUN_MCP_TOKEN_ORIGINS), as its operator lists
// them: a comma-separated list of exact origins, each https://host[:port], or one loopback http origin with its port
// (SHAPE below spells each form). A loopback entry counts only where AGENTRUN_MCP_ALLOW_LOOPBACK is on. An entry
// that is not one of these is refused in words at the start (a TypeError), never skipped. Unset, none: the token's save of
// a server at an address is refused. The token saves a per_run server alone there (server.ts saveMcpServer), which keeps
// no credential; each run's start checks the origin of a server it saved again against the server's list (server.ts
// runnable), and each claim against the runner's own (runner/mcp-claim.ts), with the one check below (tokenOriginListed).
// Imports nothing: the CLI and the runner read it at their start, before the server loads.

/** The variable that lists the origins. */
export const MCP_TOKEN_ORIGINS_ENV = "AGENTRUN_MCP_TOKEN_ORIGINS";

/** The loopback hosts an http entry may name (as URL writes them). */
const HTTP_LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
/** Whether `hostname` (as URL writes it) is this machine's loopback, for an entry's switch. */
const onLoopback = (hostname: string): boolean => hostname === "localhost" || hostname.endsWith(".localhost") || /^127\./.test(hostname) || hostname === "[::1]";

// Each form in words, never as a loopback URL: this text ships in the package, whose check refuses one.
const SHAPE = "each https://host[:port], or one loopback origin (http on 127.0.0.1 or [::1], with its port), comma-separated, with no path, query, fragment, user or wildcard";

/** One entry's origin (URL's own normalising: scheme and host lowercased, a default port dropped), or why it is none. */
function entryOrigin(entry: string): { origin: string; loopback: boolean } | { why: string } {
  if (entry === "") return { why: "is empty" };
  if (entry.includes("@")) return { why: "holds a user or password" };
  if (entry.includes("*")) return { why: "holds a wildcard: list each origin whole" };
  const scheme = /^(https?):\/\//i.exec(entry);
  if (!scheme) return { why: "is not https://host[:port]" };
  const authority = entry.slice(scheme[0].length);
  if (authority === "" || /[/?#\\\s]/.test(authority)) return { why: "is not an origin alone (scheme, host and port): it has a path, query or fragment" };
  const url = URL.parse(entry);
  if (!url) return { why: "is not a URL" };
  if (url.protocol === "https:") return { origin: url.origin, loopback: onLoopback(url.hostname) };
  if (!HTTP_LOOPBACK.has(url.hostname)) return { why: "is http to a host other than 127.0.0.1 or [::1]: use https" };
  if (!/:\d+$/.test(authority)) return { why: "is http on loopback without its port: name its port" };
  return { origin: url.origin, loopback: true };
}

/** The origins `env` lists that count here: every entry checked, then a loopback one kept only when `loopback` (this
 *  process's AGENTRUN_MCP_ALLOW_LOOPBACK). Unset or blank: none. A bad entry, or a second http loopback one, is refused
 *  in words naming the variable (a TypeError), and named by its place in the list alone: no entry's text is ever echoed,
 *  since an operator may have pasted a key in one (a user, a path, a query), and the start prints the refusal. */
export function mcpTokenOriginsFrom(env: NodeJS.ProcessEnv = process.env, loopback = false): readonly string[] {
  const given = env[MCP_TOKEN_ORIGINS_ENV]?.trim() ?? "";
  if (given === "") return [];
  const entries = given.split(",").map((entry) => entry.trim());
  const origins: string[] = [];
  let httpLoopback = 0;
  entries.forEach((entry, at) => {
    const read = entryOrigin(entry);
    const named = `entry ${at + 1}`;
    if ("why" in read) throw new TypeError(`${MCP_TOKEN_ORIGINS_ENV} lists origins (${SHAPE}): ${named} ${read.why}.`);
    if (read.origin.startsWith("http:") && ++httpLoopback > 1) throw new TypeError(`${MCP_TOKEN_ORIGINS_ENV} lists one http loopback origin at most (${SHAPE}): ${named} is a second.`);
    if (loopback || !read.loopback) origins.push(read.origin);
  });
  return origins;
}

/** The origins this process's environment lists now, for a runner's claim (read at each one, so a list its operator
 *  changed holds from the next): a list that does not read counts as none, so a server the token saved is never reached
 *  past a typo. The runner's start refused such a list already (mcpTokenOriginsFrom). */
export function tokenOriginsNow(loopback: boolean, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  try {
    return mcpTokenOriginsFrom(env, loopback);
  } catch {
    return [];
  }
}

/** Whether `url` is at one of `origins` exactly: its origin (scheme, host and port, as URL normalises them) equal to one
 *  listed, and no user or password in it. The one check: a token's save, and each run's start and claim of a server it
 *  saved. */
export function tokenOriginListed(url: string, origins: readonly string[]): boolean {
  const parsed = URL.parse(url);
  if (!parsed || parsed.username !== "" || parsed.password !== "") return false;
  return origins.includes(parsed.origin);
}

/** The refusal of the server `name` a token saved at an origin the list no longer holds here: it names the server and the
 *  variable, never an origin. */
export const tokenOriginGone = (name: string): string => `The MCP server ${name} was saved by an API token at an origin ${MCP_TOKEN_ORIGINS_ENV} does not list here, so it is not used. List its origin again, or save it at a listed one. Nothing was sent.`;

/** The save's refusal of an address at no listed origin: it names the variable, never an origin listed. */
export const TOKEN_ORIGIN_UNLISTED = `An API token saves an MCP server only at an origin this server's operator listed in ${MCP_TOKEN_ORIGINS_ENV} (exactly: scheme, host and port), and this address is at none of them.`;
