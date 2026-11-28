/** A setup-only import awaits a complete snapshot and Move before it may execute. */
export interface SourceDeploymentBinding {
  readonly connector_id: string;
  readonly target_id: string;
}

export function sourceDeploymentOf(body: unknown): SourceDeploymentBinding | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { sourceDeployment?: unknown }).sourceDeployment;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || typeof row.connector_id !== "string" || !/^rc_[a-f0-9]{32}$/.test(row.connector_id)
    || typeof row.target_id !== "string" || !/^[\w.-]{1,160}$/.test(row.target_id)) return undefined;
  return value as SourceDeploymentBinding;
}

/** Provenance of a managed revision made from an authorized source. Source credentials never live here. */
export interface SourceSyncBinding {
  readonly id: string;
  readonly snapshot: string;
  readonly project: string;
  /** Hash of the last applied configuration. An ordinary edit retains this baseline, so a later sync detects it. */
  readonly configuration: string;
}

export function sourceSyncOf(body: unknown): SourceSyncBinding | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { sourceSync?: unknown }).sourceSync;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id)) return undefined;
  for (const key of ["snapshot", "project", "configuration"]) if (typeof row[key] !== "string" || !/^[a-f0-9]{64}$/.test(row[key])) return undefined;
  return value as SourceSyncBinding;
}
