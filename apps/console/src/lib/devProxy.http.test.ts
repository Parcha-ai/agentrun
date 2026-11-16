// @vitest-environment node
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { buildAgentPrompt } from "./codingAgentPrompts";

afterEach(() => vi.unstubAllEnvs());

it("fetches a development handoff's matching skill through the actual Vite server, preserving API proxy auth and origin", async () => {
  const skill = "# AgentRun Server\n\nInstructions from this configured server's build.\n";
  const seen: { path: string; authorization?: string; origin?: string }[] = [];
  const backend = createHttpServer((request, response) => {
    seen.push({ path: request.url!, authorization: request.headers.authorization, origin: request.headers.origin });
    response.setHeader("content-type", request.url === "/skills/agentrun-serve/SKILL.md" ? "text/markdown" : "application/json");
    response.end(request.url === "/skills/agentrun-serve/SKILL.md" ? skill : JSON.stringify({ from: "configured server" }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  vi.stubEnv("AGENTRUN_URL", target);
  vi.stubEnv("AGENTRUN_TOKEN", "fake-test-dev-proxy");
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    dev = await createServer({ root, configFile: `${root}/vite.config.ts`, logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
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
