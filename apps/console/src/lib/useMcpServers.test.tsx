import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "./mcp";
import { useMcpServers } from "./useMcpServers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const server = { name: "gmail", url: "https://mcp.example.test/gmail", auth: { type: "none" }, source: "composio", toolkit: "gmail", credential: null, tools: [] } as McpServer;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

function mount(v2: Parameters<typeof useMcpServers>[0], enabled: boolean, seen: { reload?: () => void; servers?: unknown }) {
  function Probe({ on }: { on: boolean }) {
    const [servers, reload] = useMcpServers(v2, on);
    seen.servers = servers; seen.reload = reload;
    return null;
  }
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  return act(async () => root!.render(createElement(Probe, { on: enabled })));
}

describe("useMcpServers", () => {
  it("reads once enabled, null before, and reads anew when turned off and on", async () => {
    const listMcpServers = vi.fn(async () => ({ servers: [server] }));
    const seen: { reload?: () => void; servers?: unknown } = {};
    await mount({ listMcpServers }, false, seen);
    expect(listMcpServers).not.toHaveBeenCalled();
    expect(seen.servers).toBeNull();
    await mount({ listMcpServers }, true, seen);
    expect(listMcpServers).toHaveBeenCalledTimes(1);
    expect(seen.servers).toEqual([server]);
    await mount({ listMcpServers }, false, seen);
    await mount({ listMcpServers }, true, seen);
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it("says failed, and reload reads again", async () => {
    let fail = true;
    const listMcpServers = vi.fn(async () => { if (fail) throw new Error("offline"); return { servers: [server] }; });
    const seen: { reload?: () => void; servers?: unknown } = {};
    await mount({ listMcpServers }, true, seen);
    expect(seen.servers).toBe("failed");
    fail = false;
    await act(async () => seen.reload!());
    expect(seen.servers).toEqual([server]);
  });

  it("lets only the newest read land: a slow older answer, its failure most of all, never replaces it", async () => {
    const answers: { ok: (v: { servers: McpServer[] }) => void; no: (e: Error) => void }[] = [];
    const listMcpServers = vi.fn(() => new Promise<{ servers: McpServer[] }>((ok, no) => { answers.push({ ok, no }); }));
    const seen: { reload?: () => void; servers?: unknown } = {};
    await mount({ listMcpServers }, true, seen);
    await act(async () => seen.reload!());
    await act(async () => answers[1]!.ok({ servers: [server] }));
    await act(async () => answers[0]!.no(new Error("late")));
    expect(seen.servers).toEqual([server]);
  });

  it("reads nothing on a server that has no MCP list", async () => {
    const seen: { reload?: () => void; servers?: unknown } = {};
    await mount({}, true, seen);
    expect(seen.servers).toBeNull();
  });
});
