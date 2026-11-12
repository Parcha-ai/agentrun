export const nonEmpty = (v: unknown): string => String(v ?? "").trim();

/** Which session may save to a named profile now, by profile: claimed by the local Chrome provider (providers/profiles.ts). */
export const profileHoldings = {
  writers: new Map<string, { tag: string; owner: string; running?: (signal: AbortSignal) => Promise<boolean>; settle?: () => Promise<void> }>(),
};
