import { useEffect, useRef, useState } from "react";
import type { Client } from "./client";
import type { McpServer } from "./mcp";

/** The MCP servers saved in Settings, read while `enabled` (and the server lists them): null while being read, "failed" when
 *  they could not be. `reload` reads them again. Only the newest read lands, so an older one's late answer (a failure most
 *  of all) never replaces it; turning `enabled` off and on again reads anew. */
export function useMcpServers(v2: Partial<Pick<Client, "listMcpServers">>, enabled: boolean): [McpServer[] | null | "failed", () => void] {
  const [servers, setServers] = useState<McpServer[] | null | "failed">(null);
  const asked = useRef(0);
  const list = v2.listMcpServers;
  const reload = () => {
    if (!list || !enabled) return;
    const n = ++asked.current;
    setServers(null);
    list().then((r) => { if (n === asked.current) setServers(r.servers); }, () => { if (n === asked.current) setServers("failed"); });
  };
  useEffect(reload, [list, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return [servers, reload];
}
