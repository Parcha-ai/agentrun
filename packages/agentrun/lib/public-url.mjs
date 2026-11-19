// `--public-url URL` (`npx @parcha/agentrun`, `agentrun service install`): the address people open the server at, through
// a proxy in front of it (`tailscale serve`, a reverse proxy). The launcher hands it to the server as AGENTRUN_PUBLIC_URL,
// the one way the server takes it: its links name it, its Host check on loopback takes its name, and its first visit asks
// for the setup code.

/** The names an http:// address may have: this machine's, where nothing crosses a network in clear text. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** The server's own form of an address, as it reads AGENTRUN_PUBLIC_URL: parsed, with no trailing slash. */
const same = (value) => (URL.canParse(value) ? new URL(value).href.replace(/\/+$/, "") : value);

/** `{ url }`, `value` as the server's root address (`https://name/`), or `{ error }` saying what is wrong with it: an
 *  https address, or http on this machine only; no user name or password; no path beyond `/`, no query or fragment. */
export function publicUrlOf(value, name = "--public-url") {
  const example = `such as https://box.tailnet.example/`;
  // A value that is no address is repeated only when it has no "@": one with user info in it may hold a password, and an
  // address that fails to parse has not been checked for one yet.
  if (typeof value !== "string" || value === "" || !URL.canParse(value)) return { error: `${name} takes the https address people open AgentRun at, ${example}${value && !value.includes("@") ? `, not ${value}` : ""}.` };
  const url = new URL(value);
  // Never repeated: a password in the address is the one part that must not reach a log.
  if (url.username !== "" || url.password !== "") return { error: `${name} takes an address with no user name or password in it, ${example}.` };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: `${name} takes an https address, ${example}, not ${url.protocol} ${value}.` };
  if (url.protocol === "http:" && !LOOPBACK.test(url.hostname)) {
    return { error: `${name} takes an https address: over http:// the password and the session cross the network in clear text, so http is taken only for this machine (localhost, 127.0.0.1). Put HTTPS in front (tailscale serve, a reverse proxy) and give its https:// address, not ${value}.` };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { error: `${name} takes the address of the server's root, ${url.origin}/, with no path, query or fragment: AgentRun is served at the root of its own name, not at ${value}.` };
  }
  return { url: url.href };
}

/** The public address a start runs with: `--public-url` (`flag`) or AGENTRUN_PUBLIC_URL (`env`), `{ url }` (undefined
 *  with neither), or `{ error }` when the flag is not one or the two name different addresses. */
export function chosenPublicUrl(flag, env) {
  if (flag === undefined) return { url: env || undefined };
  const checked = publicUrlOf(flag);
  if (checked.error !== undefined) return checked;
  if (env && same(env) !== same(checked.url)) {
    return { error: `AGENTRUN_PUBLIC_URL names another address than --public-url ${checked.url}, and the server takes one. Give one of them.` };
  }
  return checked;
}
