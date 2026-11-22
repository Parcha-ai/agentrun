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
