import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Capabilities, Client } from "./lib/client";

/** A host's non-secret identity. Change generation when credentials are replaced without changing the identity. */
export type AgentRunSession = { id: string; authenticated: boolean; label?: string; kind?: "local-owner" | "enterprise"; generation?: string | number };
export type AgentRunWorkspace = { id: string; label?: string };
export type AgentRunExtensionRoute = { id: string; label: string; path: `#/${string}`; render: (context: AgentRunContextValue) => ReactNode };
export type AgentRunContextValue = {
  client: Client;
  session: AgentRunSession;
  serverId: string;
  capabilities: Capabilities | null;
  capabilitiesError: Error | null;
  refreshCapabilities: () => Promise<void>;
  workspace?: AgentRunWorkspace;
  extensionRoutes: readonly AgentRunExtensionRoute[];
  signOut?: () => Promise<void>;
};
export type AgentRunProviderProps = {
  client: Client;
  session: AgentRunSession;
  serverId?: string;
  capabilities?: Capabilities | null;
  workspace?: AgentRunWorkspace;
  extensionRoutes?: readonly AgentRunExtensionRoute[];
  onUnauthorized?: () => void;
  onSignOut?: () => Promise<void>;
  fallback?: ReactNode;
  children?: ReactNode;
};

const Context = createContext<AgentRunContextValue | null>(null);

/** Hosts supply their own identity policy; the standalone app supplies only its local-owner session. All private
 *  component state belongs to a connection, identity, credential generation and optional workspace. */
export function AgentRunProvider(props: AgentRunProviderProps) {
  const held = useRef({ client: props.client, revision: 0 });
  if (held.current.client !== props.client) held.current = { client: props.client, revision: held.current.revision + 1 };
  const serverId = props.serverId ?? props.client.endpoint;
  const key = JSON.stringify([serverId, props.session.id, props.session.generation, props.session.authenticated, props.workspace?.id, held.current.revision]);
  return <Scope key={key} {...props} serverId={serverId} />;
}

function Scope({ client, session, serverId, capabilities: supplied, workspace, extensionRoutes = [], onUnauthorized, onSignOut, fallback, children }: AgentRunProviderProps & { serverId: string }) {
  const [rejected, setRejected] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(supplied ?? null);
  const [capabilitiesError, setCapabilitiesError] = useState<Error | null>(null);
  const active = useRef(true);
  const expired = useRef(onUnauthorized);
  expired.current = onUnauthorized;
  const refreshing = useRef(0);
  const refreshCapabilities = useCallback(async () => {
    const n = ++refreshing.current;
    try {
      const read = await client.capabilities();
      if (active.current && n === refreshing.current) { setCapabilities(read); setCapabilitiesError(null); }
    } catch (e) {
      if (active.current && n === refreshing.current) setCapabilitiesError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }, [client]);
  useLayoutEffect(() => {
    active.current = true;
    client.clearSessionState();
    let refused = false;
    const stop = client.onUnauthorized(() => {
      if (refused) return;
      refused = true;
      setRejected(true);
      setCapabilities(null);
      expired.current?.();
    });
    return () => { active.current = false; refreshing.current++; stop(); client.clearSessionState(); };
  }, [client]);
  useEffect(() => {
    if (supplied !== undefined) setCapabilities(supplied);
    else if (session.authenticated) void refreshCapabilities().catch(() => {});
  }, [supplied, session.authenticated, refreshCapabilities]);
  if (!session.authenticated || rejected) return <>{fallback ?? <p role="status" className="p-8 font-mono text-[13px] text-muted-foreground">The session ended. Sign in again to continue.</p>}</>;
  return <Context.Provider value={{ client, session, serverId, capabilities, capabilitiesError, refreshCapabilities, workspace, extensionRoutes, signOut: onSignOut }}>{children}</Context.Provider>;
}

export function useAgentRun(): AgentRunContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("The console requires an AgentRunProvider.");
  return value;
}
