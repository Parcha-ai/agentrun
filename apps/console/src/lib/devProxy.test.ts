import { describe, expect, it } from "vitest";
import { devProxy, devServerOf, ownRequest } from "./devProxy";

// `npm run dev` works against a server on this machine with no setting at all, and against any other by
// AGENTRUN_BASE_URL, the name AgentRun's client and CLI read. Its key: AGENTRUN_API_KEY to the server that is named,
// AGENTRUN_TOKEN to a server on this machine and no other.
const LOCAL = "http://127.0.0.1:7340"; // key-gate: loopback-rule serve on this machine at its default port, the npm run dev default only
const OTHER = "https://agentrun.example.test";
const TOKEN = "fake-test-local-token";
const KEY = "fake-test-api-key";
type Env = Parameters<typeof devProxy>[0];
const v2 = (env: Env) => devProxy(env)["/v2"];
const said = (env: Env) => { const notes: string[] = []; devProxy(env, (kind, words) => notes.push(`${kind}: ${words}`)); return notes; };

describe("devProxy", () => {
  it("with no AGENTRUN_BASE_URL, proxies /v2 to the AgentRun Server on this machine, at serve's default port", () => {
    expect(v2({}).target).toBe(LOCAL);
    expect(v2({ AGENTRUN_BASE_URL: "" }).target).toBe(LOCAL);
  });

  it("AGENTRUN_BASE_URL names another server, with or without /v2, and wins over the default", () => {
    for (const [given, server] of [
      [OTHER, OTHER], [`${OTHER}/`, OTHER], [`${OTHER}/v2`, OTHER], [`${OTHER}/v2/`, OTHER], [`${OTHER}/v2//`, OTHER],
      [`${OTHER}/behind/a/proxy`, `${OTHER}/behind/a/proxy`], [`${OTHER}/behind/a/proxy/v2`, `${OTHER}/behind/a/proxy`], [`${OTHER}//v2`, OTHER],
      // What a server on this machine prints when it starts.
      [`${LOCAL}/v2`, LOCAL],
      // A host that is itself called v2 keeps its name.
      ["http://v2", "http://v2"], ["http://v2/v2/", "http://v2"],
    ] as const) {
      expect(devServerOf(given), given).toBe(server);
      expect(v2({ AGENTRUN_BASE_URL: given }).target, given).toBe(server);
    }
  });

  it("gives the proxy the address as the URL parser spells it, so the host the key rule reads is the host it connects to", () => {
    // The proxy reads its target with an older parser, which finds no host in the first three and hands the next three
    // to the resolver as names. Spelled by the one parser, each is the host the key rule saw.
    for (const [given, server] of [
      ["http:localhost:7340", "http://localhost:7340"], ["http:/localhost:7340/v2", "http://localhost:7340"], ["http:///localhost:7340", "http://localhost:7340"],
      ["http://127.1:7340", LOCAL], ["http://0x7f.0.0.1:7340/v2", LOCAL], ["http://2130706433:7340", LOCAL],
      ["HTTP://LOCALHOST:7340/v2", "http://localhost:7340"], [`${OTHER}/a/../v2`, OTHER], [` ${OTHER}/v2 `, OTHER],
    ] as const) {
      expect(devServerOf(given), given).toBe(server);
    }
  });

  it("refuses an address that is no server's, by the variable's name and never by its value", () => {
    const secret = "fake-test-password";
    // Addresses that carry a user or a password, made here so no line of this file holds one.
    const withPassword = Object.assign(new URL(`${OTHER}/v2`), { username: "owner", password: secret }).href;
    const hostAsUser = Object.assign(new URL(`${OTHER}/v2`), { username: "127.0.0.1" }).href;
    expect(withPassword).toContain(secret);
    for (const given of ["agentrun.example.test", "localhost:7340", "ftp://agentrun.example.test", `${OTHER}/v2?x=1`, `${OTHER}#v2`, withPassword, hostAsUser]) {
      const refused = (() => { try { devProxy({ AGENTRUN_BASE_URL: given, AGENTRUN_TOKEN: TOKEN }); return ""; } catch (error) { return String(error); } })();
      expect(refused, given).toContain("AGENTRUN_BASE_URL must be an http or https URL with no query, fragment, user or password");
      expect(refused, given).not.toContain(secret);
    }
    // The page asks for /v2/… itself: an address whose v2 is not its last segment has nowhere to go.
    for (const given of [`${OTHER}/v2/more`, `${OTHER}/v2/v2`]) expect(() => devProxy({ AGENTRUN_BASE_URL: given }), given).toThrow("AGENTRUN_BASE_URL must end at /v2 or hold none");
  });

  it("sends AGENTRUN_API_KEY to the server AGENTRUN_BASE_URL names, and AGENTRUN_TOKEN only to a server on this machine", () => {
    expect(v2({ AGENTRUN_BASE_URL: OTHER, AGENTRUN_API_KEY: KEY }).headers).toEqual({ authorization: `Bearer ${KEY}` });
    expect(v2({ AGENTRUN_BASE_URL: OTHER, AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({ authorization: `Bearer ${KEY}` });
    expect(v2({ AGENTRUN_BASE_URL: `${LOCAL}/v2`, AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({ authorization: `Bearer ${KEY}` });
    // A local server's token never leaves this machine.
    expect(v2({ AGENTRUN_BASE_URL: OTHER, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({});
    expect(v2({ AGENTRUN_BASE_URL: `${OTHER}/v2`, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({});
    // On this machine, by default or by name, in each of the three ways a client says so.
    expect(v2({ AGENTRUN_TOKEN: TOKEN }).headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    for (const local of [`${LOCAL}/v2`, "http://localhost:7340", "http://[::1]:7340/v2", "http://127.1:7340"]) { // key-gate: loopback-rule the hosts AGENTRUN_TOKEN may go to
      expect(v2({ AGENTRUN_BASE_URL: local, AGENTRUN_TOKEN: TOKEN }).headers, local).toEqual({ authorization: `Bearer ${TOKEN}` });
    }
    // With no key, the page signs in as the served one does.
    expect(v2({}).headers).toEqual({});
    expect(v2({ AGENTRUN_BASE_URL: OTHER }).headers).toEqual({});
  });

  it("keeps AGENTRUN_API_KEY here when no address names its server: a shell that exports it for the CLI signs in on the page as before", () => {
    expect(v2({ AGENTRUN_API_KEY: KEY })).toEqual({ target: LOCAL, changeOrigin: true, headers: {} });
    expect(v2({ AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(said({ AGENTRUN_API_KEY: KEY })).toEqual([]);
  });

  it("a host that only looks like this machine gets no token", () => {
    for (const host of ["http://127.0.0.2:7340", "http://0.0.0.0:7340", "http://localhost.:7340", "http://localhost.example.test", "http://127.0.0.1.example.test", "http://[::ffff:127.0.0.1]:7340", "http://l\u043ecalhost:7340"]) { // key-gate: loopback-rule hosts that are not the three AGENTRUN_TOKEN may go to
      expect(v2({ AGENTRUN_BASE_URL: host, AGENTRUN_TOKEN: TOKEN }).headers, host).toEqual({});
    }
  });

  it("says once where it proxies and with which variable's key, or that a token was not sent, and never a key", () => {
    expect(said({})).toEqual([]);
    expect(said({ AGENTRUN_TOKEN: TOKEN })).toEqual([`info: Proxying /v2 to ${LOCAL} with AGENTRUN_TOKEN.`]);
    expect(said({ AGENTRUN_BASE_URL: `${OTHER}/v2`, AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN })).toEqual([`info: Proxying /v2 to ${OTHER} with AGENTRUN_API_KEY.`]);
    expect(said({ AGENTRUN_BASE_URL: `${OTHER}/behind/v2` })).toEqual([`info: Proxying /v2 to ${OTHER}/behind with no key.`]);
    expect(said({ AGENTRUN_BASE_URL: `${OTHER}/v2`, AGENTRUN_TOKEN: TOKEN })).toEqual([`warn: AGENTRUN_TOKEN is not sent to ${OTHER}: it goes only to a server on this machine. Set AGENTRUN_API_KEY for this server.`]);
    for (const env of [{ AGENTRUN_TOKEN: TOKEN }, { AGENTRUN_BASE_URL: OTHER, AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN }, { AGENTRUN_BASE_URL: OTHER, AGENTRUN_TOKEN: TOKEN }]) {
      expect(said(env).join("\n")).not.toMatch(new RegExp(`${TOKEN}|${KEY}`));
    }
  });

  it("refuses the older AGENTRUN_URL by name rather than look at another server unnoticed", () => {
    expect(() => devProxy({ AGENTRUN_URL: OTHER })).toThrow("AGENTRUN_URL is no longer read. Name the server with AGENTRUN_BASE_URL");
    expect(() => devProxy({ AGENTRUN_URL: OTHER, AGENTRUN_TOKEN: TOKEN })).toThrow("AGENTRUN_URL is no longer read");
    // A shell that sets both is read by the new name alone.
    expect(v2({ AGENTRUN_URL: OTHER, AGENTRUN_BASE_URL: `${LOCAL}/v2` }).target).toBe(LOCAL);
  });

  it("fetches the matching public setup skill from the same target without adding a key", () => {
    expect(devProxy({})["/skills/agentrun-serve/SKILL.md"]).toEqual({ target: LOCAL, changeOrigin: true, headers: {} });
    expect(devProxy({ AGENTRUN_TOKEN: TOKEN })["/skills/agentrun-serve/SKILL.md"]).toEqual({ target: LOCAL, changeOrigin: true, headers: {} });
    expect(devProxy({ AGENTRUN_BASE_URL: `${OTHER}/v2`, AGENTRUN_API_KEY: KEY })["/skills/agentrun-serve/SKILL.md"]).toEqual({ target: OTHER, changeOrigin: true, headers: {} });
  });
});

describe("ownRequest", () => {
  const host = "127.0.0.1:5173"; // key-gate: loopback-rule the dev server's own address, as a browser names it
  it("is the console page's own request, or one no browser sent", () => {
    expect(ownRequest({ host, origin: `http://${host}`, "sec-fetch-site": "same-origin" })).toBe(true);
    expect(ownRequest({ host, "sec-fetch-site": "same-origin" })).toBe(true);
    // An address typed into the browser.
    expect(ownRequest({ host, "sec-fetch-site": "none" })).toBe(true);
    // A command line, or a browser too old to say where a request came from.
    expect(ownRequest({ host })).toBe(true);
    expect(ownRequest({ host, origin: `http://${host}` })).toBe(true);
  });

  it("is not another site's request, nor another page's on this machine", () => {
    expect(ownRequest({ host, origin: "https://elsewhere.example.test", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(ownRequest({ host, "sec-fetch-site": "cross-site" })).toBe(false);
    // Another port of this machine is the same site and another origin.
    expect(ownRequest({ host, origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-site" })).toBe(false); // key-gate: loopback-rule another page on this machine
    // What the browser says wins over an Origin that agrees with the host.
    expect(ownRequest({ host, origin: `http://${host}`, "sec-fetch-site": "cross-site" })).toBe(false);
    expect(ownRequest({ host, origin: "https://elsewhere.example.test" })).toBe(false);
    expect(ownRequest({ host, origin: "null" })).toBe(false);
    expect(ownRequest({ origin: "http://127.0.0.1:5173" })).toBe(false); // key-gate: loopback-rule the dev server's own address, with no Host to compare
    expect(ownRequest({ host, "sec-fetch-site": ["same-origin", "cross-site"] })).toBe(false);
  });
});
