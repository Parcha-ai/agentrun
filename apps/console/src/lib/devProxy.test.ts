import { describe, expect, it } from "vitest";
import { devProxy, devServerOf } from "./devProxy";

// `npm run dev` works against a server on this machine with no setting at all, and against any other by
// AGENTRUN_BASE_URL, the name AgentRun's client and CLI read. Its key goes by their rule too: AGENTRUN_API_KEY to the
// server that is named, AGENTRUN_TOKEN to a server on this machine and no other.
const LOCAL = "http://127.0.0.1:7340"; // key-gate: loopback-rule serve on this machine at its default port, the npm run dev default only
const OTHER = "https://agentrun.example.test";
const TOKEN = "fake-test-local-token";
const KEY = "fake-test-api-key";
const v2 = (env: Parameters<typeof devProxy>[0]) => devProxy(env)["/v2"];

describe("devProxy", () => {
  it("with no AGENTRUN_BASE_URL, proxies /v2 to the AgentRun Server on this machine, at serve's default port", () => {
    expect(v2({}).target).toBe(LOCAL);
    expect(v2({ AGENTRUN_BASE_URL: "" }).target).toBe(LOCAL);
  });

  it("AGENTRUN_BASE_URL names another server, with or without /v2, and wins over the default", () => {
    for (const [given, server] of [
      [OTHER, OTHER], [`${OTHER}/`, OTHER], [`${OTHER}/v2`, OTHER], [`${OTHER}/v2/`, OTHER], [`${OTHER}/v2//`, OTHER],
      [`${OTHER}/behind/a/proxy`, `${OTHER}/behind/a/proxy`], [`${OTHER}/behind/a/proxy/v2`, `${OTHER}/behind/a/proxy`],
      // What a server on this machine prints when it starts.
      [`${LOCAL}/v2`, LOCAL],
    ] as const) {
      expect(devServerOf(given), given).toBe(server);
      expect(v2({ AGENTRUN_BASE_URL: given }).target, given).toBe(server);
    }
  });

  it("refuses an address that is no server's, by the variable's name and never by its value", () => {
    const secret = "fake-test-password";
    // An address that carries a user and a password, made here so no line of this file holds one.
    const withPassword = Object.assign(new URL(`${OTHER}/v2`), { username: "owner", password: secret }).href;
    expect(withPassword).toContain(secret);
    for (const given of ["agentrun.example.test", "localhost:7340", "ftp://agentrun.example.test", `${OTHER}/v2?x=1`, `${OTHER}#v2`, withPassword]) {
      const refused = (() => { try { devProxy({ AGENTRUN_BASE_URL: given }); return ""; } catch (error) { return String(error); } })();
      expect(refused, given).toContain("AGENTRUN_BASE_URL must be an http or https URL with no query, fragment, user or password");
      expect(refused, given).not.toContain(secret);
    }
    // The page asks for /v2/… itself: an address whose v2 is not its last segment has nowhere to go.
    for (const given of [`${OTHER}/v2/more`, `${OTHER}/v2/v2`]) expect(() => devProxy({ AGENTRUN_BASE_URL: given }), given).toThrow("AGENTRUN_BASE_URL must end at /v2 or hold none");
  });

  it("sends AGENTRUN_API_KEY to the server it names, and AGENTRUN_TOKEN only to a server on this machine", () => {
    expect(v2({ AGENTRUN_BASE_URL: OTHER, AGENTRUN_API_KEY: KEY }).headers).toEqual({ authorization: `Bearer ${KEY}` });
    expect(v2({ AGENTRUN_BASE_URL: OTHER, AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({ authorization: `Bearer ${KEY}` });
    // A local server's token never leaves this machine.
    expect(v2({ AGENTRUN_BASE_URL: OTHER, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({});
    expect(v2({ AGENTRUN_BASE_URL: `${OTHER}/v2`, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({});
    // On this machine, by default or by name, in each of the three ways a client says so.
    expect(v2({ AGENTRUN_TOKEN: TOKEN }).headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    for (const local of [`${LOCAL}/v2`, "http://localhost:7340", "http://[::1]:7340/v2"]) { // key-gate: loopback-rule the hosts AGENTRUN_TOKEN may go to
      expect(v2({ AGENTRUN_BASE_URL: local, AGENTRUN_TOKEN: TOKEN }).headers, local).toEqual({ authorization: `Bearer ${TOKEN}` });
    }
    expect(v2({ AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN }).headers).toEqual({ authorization: `Bearer ${KEY}` });
    // With neither, the page signs in as the served one does.
    expect(v2({}).headers).toEqual({});
    expect(v2({ AGENTRUN_BASE_URL: OTHER }).headers).toEqual({});
  });

  it("says when a token was set and not sent, naming the server and never the token", () => {
    const said = (env: Parameters<typeof devProxy>[0]) => { const notes: string[] = []; devProxy(env, (words) => notes.push(words)); return notes; };
    const notes = said({ AGENTRUN_BASE_URL: `${OTHER}/v2`, AGENTRUN_TOKEN: TOKEN });
    expect(notes).toEqual([`AGENTRUN_TOKEN is not sent to ${OTHER}: it goes only to a server on this machine. Set AGENTRUN_API_KEY for this server, or sign in on the page.`]);
    expect(notes.join("\n")).not.toContain(TOKEN);
    for (const env of [{}, { AGENTRUN_TOKEN: TOKEN }, { AGENTRUN_BASE_URL: OTHER }, { AGENTRUN_BASE_URL: OTHER, AGENTRUN_API_KEY: KEY, AGENTRUN_TOKEN: TOKEN }]) expect(said(env), JSON.stringify(Object.keys(env))).toEqual([]);
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
