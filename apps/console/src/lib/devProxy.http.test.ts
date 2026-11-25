// @vitest-environment node
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createLogger, createServer, loadConfigFromFile } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildAgentPrompt } from "./codingAgentPrompts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const configFile = `${root}/vite.config.ts`;
// preTransformRequests off: a page asked for here is answered and nothing more. Left on, Vite goes on to transform the
// whole console behind it, and closing the server waits for that, seconds on a busy machine.
const devServer = (more: Parameters<typeof createServer>[0] = {}) => createServer({ root, configFile, logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, preTransformRequests: false }, ...more });

// Each test names every variable the dev proxy reads, so the shell that runs the suite decides nothing.
beforeEach(() => { for (const name of ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "AGENTRUN_URL", "STORYBOOK"]) vi.stubEnv(name, ""); });
afterEach(() => vi.unstubAllEnvs());

it("fetches a development handoff's matching skill through the actual Vite server, preserving API proxy auth and origin; another site's request goes on without the key", async () => {
  const skill = "# AgentRun Server\n\nInstructions from this configured server's build.\n";
  const seen: { path: string; authorization?: string; origin?: string }[] = [];
  // Only the paths this test asks for are recorded: a host agent that probes each new loopback listener with `GET /`
  // reaches this backend too, and would land in `seen`. A proxied request that lost its path still fails the body check.
  const asked = new Set(["/skills/agentrun-serve/SKILL.md", "/v2/capabilities", "/v2/files?path=from-elsewhere.txt", "/v2/agents"]);
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
    // The page that can act with the key says no other site may show it in a frame.
    const page = await fetch(`${origin}/`);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    await page.text();
    const skillUrl = buildAgentPrompt(origin).match(/https?:\/\/[^\s]+\/skills\/agentrun-serve\/SKILL\.md/)![0];
    expect(new URL(skillUrl).origin).toBe(origin);
    const response = await fetch(skillUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe(skill);
    expect(seen).toEqual([{ path: "/skills/agentrun-serve/SKILL.md", authorization: undefined, origin: undefined }]);
    expect(await (await fetch(`${origin}/v2/capabilities`, { headers: { origin } })).json()).toEqual({ from: "configured server" });
    expect(seen[1]).toEqual({ path: "/v2/capabilities", authorization: "Bearer fake-test-dev-proxy", origin: target });
    // A page of another site, open in the same browser, reaches this port too. An upload is a write it can send with no
    // preflight: it goes on as the page sent it, without the developer's key, and the server answers it as it would anyone.
    const elsewhere = "https://elsewhere.example.test";
    await (await fetch(`${origin}/v2/files?path=from-elsewhere.txt`, { method: "POST", headers: { origin: elsewhere, "sec-fetch-site": "cross-site", "content-type": "text/plain" }, body: "x" })).text();
    expect(seen[2]).toEqual({ path: "/v2/files?path=from-elsewhere.txt", authorization: undefined, origin: elsewhere });
    // So does a read by another page on this machine, which a browser calls the same site.
    await (await fetch(`${origin}/v2/agents`, { headers: { "sec-fetch-site": "same-site" } })).text();
    expect(seen[3]).toEqual({ path: "/v2/agents", authorization: undefined, origin: undefined });
    // A command line, which says nothing of where it came from, still carries the key.
    await (await fetch(`${origin}/v2/agents`)).text();
    expect(seen[4]).toEqual({ path: "/v2/agents", authorization: "Bearer fake-test-dev-proxy", origin: undefined });
    expect(seen).toHaveLength(5);
  } finally {
    await dev?.close();
    await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
  }
});

it("the dev server says, once, where it proxies with a key, and that a local server's token was not sent to a server elsewhere", async () => {
  const said: string[] = [];
  const customLogger = { ...createLogger("info"), info: (words: string) => { said.push(`info: ${words}`); }, warn: (words: string) => { said.push(`warn: ${words}`); } };
  // Only the dev proxy's own lines: Vite and its plugins may say more.
  const ours = () => said.filter((line) => /AGENTRUN_|Proxying \/v2/.test(line));
  vi.stubEnv("AGENTRUN_BASE_URL", "https://agentrun.example.test/v2");
  vi.stubEnv("AGENTRUN_TOKEN", "fake-test-dev-proxy");
  let dev = await devServer({ logLevel: "info", customLogger });
  try {
    expect(ours()).toEqual(["warn: AGENTRUN_TOKEN is not sent to https://agentrun.example.test: it goes only to a server on this machine. Set AGENTRUN_API_KEY for this server."]);
    expect(dev.config.server.proxy?.["/v2"]).toMatchObject({ target: "https://agentrun.example.test" });
    expect((dev.config.server.proxy?.["/v2"] as { headers?: unknown }).headers).toEqual({});
  } finally {
    await dev.close();
  }
  said.length = 0;
  vi.stubEnv("AGENTRUN_API_KEY", "fake-test-api-key");
  dev = await devServer({ logLevel: "info", customLogger });
  try {
    expect(ours()).toEqual(["info: Proxying /v2 to https://agentrun.example.test with AGENTRUN_API_KEY."]);
    expect((dev.config.server.proxy?.["/v2"] as { headers?: unknown }).headers).toEqual({ authorization: "Bearer fake-test-api-key" });
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
  // Nor does Storybook, which builds its own server block and never took this proxy: its process says who it is.
  vi.stubEnv("STORYBOOK", "true");
  const storybook = await loadConfigFromFile({ command: "serve", mode: "development" }, configFile, root, "silent");
  expect(storybook?.config.server?.proxy).toBeUndefined();
});
