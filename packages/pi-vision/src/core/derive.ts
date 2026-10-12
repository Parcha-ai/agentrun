import { randomBytes } from "node:crypto";
import type { MissCode } from "./contract.js";
import { visionContext, type VisionEnv } from "./env.js";
import type { Kind } from "./kinds.js";
import { detectOnce, type Capability, type Provider, type ProviderCall, type ProviderSource } from "./provider.js";

export type DeriveMiss = { readonly code: MissCode; readonly detail: string };
export type DeriveOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly miss: DeriveMiss };

export type ProviderMissCode = Extract<MissCode, "unreadable" | "over_budget" | "unsupported" | "needs">;

/** What a provider throws for a source it cannot serve, so the miss carries the right code. Any other error is `unreadable`. */
export class ProviderMiss extends Error {
  constructor(readonly code: ProviderMissCode, message: string) {
    super(message);
    this.name = "ProviderMiss";
  }
}

export type DeriveContext = {
  readonly env: VisionEnv;
  /** In the order to try them: a binary first, the zero-install provider last. */
  readonly providers: readonly Provider[];
  /** Where derivations are kept. Without it nothing is kept. */
  readonly deriveDir?: string;
  readonly signal?: AbortSignal;
};

const cause = (error: unknown): string => String((error as Error)?.message ?? error).split("\n")[0]!.trim();

/** `<hash prefix><part>.<provider>-<version>`, without an extension: a derivation is named by what it came from and who made it. */
export const derivedName = (source: Pick<ProviderSource, "sha256">, provider: Pick<Provider, "name">, version: string, part = ""): string =>
  `${source.sha256.slice(0, 16)}${part}.${provider.name}-${version}`.replace(/[^\w.-]/g, "_");

export type Derivations = {
  /** Where `name` is kept, or null when the host keeps nothing. */
  path(name: string): string | null;
  /** The kept bytes, or null when there are none or they cannot be read. */
  read(name: string): Promise<Uint8Array | null>;
  /** Writes to a temp name and renames into place, so a reader never sees a partial file; the path, or null when nothing was kept. */
  keep(name: string, bytes: Uint8Array): Promise<string | null>;
};

export function derivations(ctx: Pick<DeriveContext, "env" | "deriveDir" | "signal">): Derivations {
  const path = (name: string) => (ctx.deriveDir ? `${ctx.deriveDir}/${name}` : null);
  return {
    path,
    async read(name) {
      const at = path(name);
      const read = at ? await ctx.env.readBinaryFile(at, visionContext(ctx.signal)) : null;
      return read?.ok ? read.value : null;
    },
    async keep(name, bytes) {
      const at = path(name);
      if (!at) return null;
      const c = visionContext(ctx.signal);
      const temp = `${at}.${randomBytes(4).toString("hex")}.tmp`;
      const done = (await ctx.env.createDir(ctx.deriveDir!, { recursive: true }, c)).ok && (await ctx.env.writeFile(temp, bytes, c)).ok && (await ctx.env.renameFile(temp, at, c)).ok;
      if (!done) await ctx.env.remove(temp, { force: true }, c);
      return done ? at : null;
    },
  };
}

/** Runs `attempt` with each provider of `job.kind` that has `job.capability` and runs here, in order, until one answers.
 *  A caller that has stopped waiting gets its own error, never another provider. When none answers the miss is `needs`
 *  if none could run, else the code of the first provider's failure with every distinct cause named. */
export async function viaProviders<T>(
  ctx: DeriveContext,
  job: { readonly kind: Kind; readonly capability: Capability; readonly what: string },
  attempt: (provider: Provider, version: string, call: ProviderCall) => Promise<T>,
): Promise<DeriveOutcome<T>> {
  const missed = (code: MissCode, detail: string): { ok: false; miss: DeriveMiss } => ({ ok: false, miss: { code, detail } });
  const scratch = await ctx.env.createTempDir(`pi-vision-${job.kind}-`, visionContext(ctx.signal));
  if (!scratch.ok) return missed("unreadable", `no scratch directory in the environment (${cause(scratch.error)})`);
  const call: ProviderCall = { env: ctx.env, signal: ctx.signal, tempDir: scratch.value };
  const needs: string[] = [];
  const failures = new Map<string, string[]>();
  let code: MissCode | undefined;
  try {
    for (const provider of ctx.providers.filter((p) => p.kinds.includes(job.kind) && p.capabilities.includes(job.capability))) {
      const found = await detectOnce(provider, ctx.env);
      if (!found.available) { needs.push(`${found.needs} (${found.reason})`); continue; }
      try {
        return { ok: true, value: await attempt(provider, found.version, call) };
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        code ??= error instanceof ProviderMiss ? error.code : "unreadable";
        failures.set(cause(error), [...(failures.get(cause(error)) ?? []), provider.name]);
      }
    }
  } finally {
    await ctx.env.remove(scratch.value, { recursive: true, force: true }, visionContext());
  }
  return code
    ? missed(code, [...failures].map(([why, by]) => `${why} (${by.join(", ")})`).join("; "))
    : missed("needs", `reading ${job.what} needs ${needs.join(" or ") || "a provider for it in the host's providers"}`);
}
