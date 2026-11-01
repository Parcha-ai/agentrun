import { describe, expect, it } from "vitest";
import { devProxy } from "./devProxy";

// `npm run dev` works against a server on this machine with no setting at all, and against any other by AGENTRUN_URL.
const LOCAL = "http://127.0.0.1:7340"; // key-gate: loopback-rule serve on this machine at its default port, the npm run dev default only
const OTHER = "https://agentrun.example.test";

describe("devProxy", () => {
  it("with no AGENTRUN_URL, proxies /v2 to the AgentRun Server on this machine, at serve's default port", () => {
    expect(devProxy({})?.["/v2"].target).toBe(LOCAL);
    expect(devProxy({ AGENTRUN_URL: "" })?.["/v2"].target).toBe(LOCAL);
  });

  it("AGENTRUN_URL names another server, and wins over the default", () => {
    expect(devProxy({ AGENTRUN_URL: OTHER })?.["/v2"].target).toBe(OTHER);
  });

  it("sends AGENTRUN_TOKEN as a bearer header, and no header without one", () => {
    expect(devProxy({ AGENTRUN_URL: OTHER, AGENTRUN_TOKEN: "t0" })?.["/v2"].headers).toEqual({ authorization: "Bearer t0" });
    expect(devProxy({ AGENTRUN_URL: OTHER })?.["/v2"].headers).toEqual({});
  });
});
