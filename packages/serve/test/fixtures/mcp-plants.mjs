// MCP's plants for the planted-secret harness (planted-secrets.mjs): a saved server's bearer token, a header's value, and
// an OAuth sign-in with a pre-registered client whose secret is planted, finished through the callback so the refresh
// token its authorization server gives is kept (sealed) too. MCP mints nothing a person copies: no answer may show any.
// The fake MCP and OAuth servers stay up until the harness has read everything (cleanup).
import { registerPlant, plantedValue } from "./planted-secrets.mjs";
import { startFakeMcp } from "./fake-mcp-server.mjs";
import { startFakeOAuth } from "./fake-oauth-server.mjs";

const saved = (res, what) => {
  if (res.status !== 200) throw new Error(`${what} was not saved: ${res.status} ${res.text}`);
};

registerPlant({
  name: "MCP bearer token",
  write: async ({ owner }) => {
    const value = plantedValue("mcp-bearer");
    const mcp = await startFakeMcp({ token: value });
    saved(await owner("PUT", "/v2/settings/mcp-servers/plant-bearer", { url: mcp.url, auth: { type: "bearer", token: value } }), "the bearer server");
    return { values: [value], ids: { name: "plant-bearer" }, cleanup: () => mcp.close() };
  },
});

registerPlant({
  name: "MCP header value",
  write: async ({ owner }) => {
    const value = plantedValue("mcp-header");
    const mcp = await startFakeMcp();
    saved(await owner("PUT", "/v2/settings/mcp-servers/plant-headers", { url: mcp.url, auth: { type: "headers", headers: { "x-api-key": value } } }), "the headers server");
    return { values: [value], ids: { name: "plant-headers" }, cleanup: () => mcp.close() };
  },
});

registerPlant({
  name: "MCP OAuth refresh token and client_secret",
  write: async ({ owner }) => {
    const clientSecret = plantedValue("mcp-client-secret");
    const as = await startFakeOAuth({ clients: { "plant-client": clientSecret } });
    const mcp = await startFakeMcp({ token: as.accepts, oauth: as.issuer });
    const started = await owner("POST", "/v2/settings/mcp-servers/plant-oauth/oauth/start", { url: mcp.url, client_id: "plant-client", client_secret: clientSecret });
    if (started.status !== 200) throw new Error(`the sign-in did not start: ${started.status} ${started.text}`);
    // The owner's browser: the start's cookie, the authorization server's approval, and the way back to the callback.
    const cookie = String(started.headers?.["set-cookie"] ?? "").split(";")[0];
    const asked = await fetch(started.json.authorization_url, { redirect: "manual" });
    const back = await fetch(asked.headers.get("location"), { redirect: "manual", headers: { cookie } });
    if (!/sign_in=ok/.test(back.headers.get("location") ?? "")) throw new Error(`the sign-in did not finish: ${back.status} ${back.headers.get("location")}`);
    const tokens = as.issued.filter((value) => /^(access|refresh)-/.test(value));
    if (!tokens.some((value) => value.startsWith("refresh-"))) throw new Error("no refresh token was given");
    return { values: [clientSecret, ...tokens], ids: { name: "plant-oauth" }, cleanup: () => Promise.all([mcp.close(), as.close()]) };
  },
});

registerPlant({
  name: "MCP bearer token through a token caller's preview",
  write: async ({ owner, token }) => {
    const value = plantedValue("mcp-preview");
    const mcp = await startFakeMcp({ token: value });
    // A preview keeps nothing and is never a secret write: the token may make one, inline with the bearer, and by name
    // for a server the owner saved with it. Neither answer, nor the log, nor the journal, may show it.
    saved(await owner("PUT", "/v2/settings/mcp-servers/plant-preview", { url: mcp.url, auth: { type: "bearer", token: value } }), "the previewed server");
    for (const [what, body] of [["inline", { url: mcp.url, auth: { type: "bearer", token: value } }], ["by name", { name: "plant-preview" }]]) {
      const res = await token("POST", "/v2/settings/mcp-servers/preview", body);
      if (res.status !== 200) throw new Error(`the token's preview ${what} did not list: ${res.status} ${res.text}`);
    }
    return { values: [value], ids: { name: "plant-preview" }, cleanup: () => mcp.close() };
  },
});
