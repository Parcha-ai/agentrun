/** Private historical provenance for one observed session's retained usage. It grants no learning authority. */
export type UsageIdentity = {
  native_session_hash: string;
  connection_id: string;
  generation: string;
};

/** Read a server-verified association or its persisted accounting identity, never a wire report.
 * Only verification adds generation; structural validation here does not authenticate a source. */
export function usageIdentityOf(value: unknown): UsageIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { native_session_hash, connection_id, generation } = value as Partial<UsageIdentity>;
  return typeof native_session_hash === "string" && /^[a-f0-9]{64}$/.test(native_session_hash)
    && typeof connection_id === "string" && connection_id.length > 0
    && typeof generation === "string" && generation.length > 0
    ? { native_session_hash, connection_id, generation } : undefined;
}
