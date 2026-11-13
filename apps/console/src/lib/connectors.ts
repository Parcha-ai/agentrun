import type { NativeRuntime, NativeTarget } from "./native";

/** Public connector metadata only. Enrollment credentials are returned by a separate owner action. */
export type RemoteConnector = {
  connector_id: string;
  label: string;
  status: "online" | "offline" | "revoked";
  last_seen_at: string | null;
  created_at: string;
  capabilities: { observe: true; native_execution: boolean };
  targets: {
    target_id: string;
    agent_id: string | null;
    name: string;
    runtime: NativeRuntime;
    machine_id: string;
    state: NativeTarget["state"];
    issues: string[];
    capabilities: NativeTarget["capabilities"];
  }[];
};

export type ConnectorEnrollment = {
  enrollment_token: string;
  expires_at: string;
  workspace_id: "local";
};
