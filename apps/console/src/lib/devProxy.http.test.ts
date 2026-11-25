// @vitest-environment node
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createLogger, createServer, loadConfigFromFile } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildAgentPrompt } from "./codingAgentPrompts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const configFile = `${root}/vite.config.ts`;
const devServer = (more: Parameters<typeof createServer>[0] = {}) => createServer({ root, configFile, logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }, ...more });

// Each test names every variable the dev proxy reads, so the shell that runs the suite decides nothing.
beforeEach(() => { for (const name of ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "AGENTRUN_URL"]) vi.stubEnv(name, ""); });
afterEach(() => vi.unstubAllEnvs());

it("fetches a development handoff's matching skill through the actual Vite server, preserving API proxy auth and origin", async () => {
  const skill = "# AgentRun Server\n\nInstructions from this configured server's build.\n";
  const seen: { path: string; authorization?: string; origin?: string }[] = [];
  // Only the paths this test asks for are recorded: a host agent that probes each new loopback listener with `GET /`
  // reaches this backend too, and would land in `seen`. A proxied request that lost its path still fails the body check.
  const asked = new Set(["/skills/agentrun-serve/SKILL.md", "/v2/capabilities"]);
  const backend = createHttpServer((request, response) => {
    if (asked.has(request.url!)) seen.push({ path: request.url!, authorization: request.headers.authorization, origin: request.headers.origin });
    response.setHeader("content-type", request.url === "/skills/agentrun-serve/SKILL.md" ? "text/markdown" : "application/json");
    response.end(request.url === "/skills/agentrun-serve/SKILL.md" ? skill : JSON.stringify({ from: "configured server" }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  // Such a probe, made here so the test meets it every run rather than now and then.
  await (await fetch(`${target}/`)).text();
  // The address as a server prints it when it starts, ending in /v2: the page's own /v2 is not added to it twice.
  vi.stubEnv("AGENTRUN_BASE_URL", `${target}/v2`);
  vi.stubEnv("AGENTRUN_TOKEN", "fake-test-dev-proxy");
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    dev = await devServer();
    await dev.listen();
    const origin = `http://127.0.0.1:${(dev.httpServer!.address() as AddressInfo).port}`;
    const skillUrl = buildAgentPrompt(origin).match(/https?:\/\/[^\s]+\/skills\/agentrun-serve\/SKILL\.md/)![0];
    expect(new URL(skillUrl).origin).toBe(origin);
    const response = await fetch(skillUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe(skill);
    expect(seen).toEqual([{ path: "/skills/agentrun-serve/SKILL.md", authorization: undefined, origin: undefined }]);
    expect(await (await fetch(`${origin}/v2/capabilities`, { headers: { origin } })).json()).toEqual({ from: "configured server" });
    expect(seen[1]).toEqual({ path: "/v2/capabilities", authorization: "Bearer fake-test-dev-proxy", origin: target });
  } finally {
    await dev?.close();
    await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
  }
});

it("the dev server says, once, that a local server's token was not sent to a server elsewhere", async () => {
  const warned: string[] = [];
  vi.stubEnv("AGENTRUN_BASE_URL", "https://agentrun.example.test/v2");
  vi.stubEnv("AGENTRUN_TOKEN", "fake-test-dev-proxy");
  const dev = await devServer({ logLevel: "warn", customLogger: { ...createLogger("warn"), warn: (words) => { warned.push(words); } } });
  try {
    expect(warned).toEqual(["AGENTRUN_TOKEN is not sent to https://agentrun.example.test: it goes only to a server on this machine. Set AGENTRUN_API_KEY for this server, or sign in on the page."]);
    expect(dev.config.server.proxy?.["/v2"]).toMatchObject({ target: "https://agentrun.example.test", headers: {} });
  } finally {
    await dev.close();
  }
});

it("the dev server refuses the older AGENTRUN_URL by name; a build and a test run read none of the proxy's variables", async () => {
  vi.stubEnv("AGENTRUN_URL", "https://agentrun.example.test");
  vi.stubEnv("AGENTRUN_TOKEN", "fake-test-dev-proxy");
  await expect(devServer()).rejects.toThrow("AGENTRUN_URL is no longer read. Name the server with AGENTRUN_BASE_URL");
  // A variable left in a shell stops neither `npm test` (this run among them) nor `npm run build`.
  for (const env of [{ command: "serve", mode: "test" }, { command: "build", mode: "production" }] as const) {
    const loaded = await loadConfigFromFile(env, configFile, root, "silent");
    expect(loaded?.config.server?.proxy, `${env.command} in ${env.mode}`).toBeUndefined();
  }
});
