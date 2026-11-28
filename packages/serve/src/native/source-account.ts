/** Codex 0.171.0's local auth metadata rules, not authentication or token verification.
 * login/auth/manager.rs resolved_mode and account_plan_type, token_data.rs, and
 * manager/workspace_switching.rs selected_workspace_tokens define these projections.
 * Native code itself decodes these saved claims without signature verification. We use them
 * only to refuse unproven policy portability; destination sign-in remains independently required. */
import type { SourceNativeAccount } from "./source-snapshot-types.js";
import { sourceRuntimeProtocol, type SourceRuntime } from "./runtimes.js";
import { valueMatcher } from "../learn/secrets.js";
import { keyShaped } from "../secret-name.js";

const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const unknown = (): SourceNativeAccount => ({ source: "codex-auth-file", mode: "unknown", plan: "unknown" });
const ordinary = new Set(["free", "go", "plus", "pro", "prolite", "promax"]);
const managed = new Set(["team", "self_serve_business_prolite", "self_serve_business_usage_based", "business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise", "edu", "edu_plus", "edu_pro", "sci", "sci_plus"]);
function claims(value: unknown): Record<string, any> | undefined {
  if (typeof value !== "string" || value.length > 32_768) return;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some(part => !part || !/^[A-Za-z0-9_-]+$/.test(part))) return;
  const payload = Buffer.from(parts[1]!, "base64url");
  if (payload.toString("base64url") !== parts[1]) return;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const value = parsed as Record<string, any>, auth = value["https://api.openai.com/auth"], profile = value["https://api.openai.com/profile"];
    const optionalText = (value: unknown) => value == null || typeof value === "string";
    if (!optionalText(value.email) || profile != null && (typeof profile !== "object" || Array.isArray(profile) || !optionalText(profile.email))
      || auth != null && (typeof auth !== "object" || Array.isArray(auth)
        || ["chatgpt_plan_type", "chatgpt_user_id", "user_id", "chatgpt_account_id"].some(key => !optionalText(auth[key]))
        || auth.chatgpt_account_is_fedramp !== undefined && typeof auth.chatgpt_account_is_fedramp !== "boolean")) return;
    return value;
  }
  catch { return; }
  finally { payload.fill(0); }
}

/** Consumes a bounded private buffer. Returns fixed nonsecret labels only: no claims, IDs, email,
 * expiry, token hashes or raw values. Unknown/refresh-due state cannot establish portability. */
export function sourceAccountMetadata(bytes: Uint8Array | null, now = Date.now()): SourceNativeAccount {
  if (bytes === null) return { source: "codex-auth-file", mode: "none", plan: null };
  if (bytes.length > 65_536) return unknown();
  try {
    const auth = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const mode = auth.auth_mode ?? (auth.personal_access_token != null ? "personalAccessToken"
      : auth.bedrock_api_key != null ? "bedrockApiKey" : auth.bedrock_access_keys != null ? "bedrockAccessKeys"
        : auth.OPENAI_API_KEY != null ? "apikey" : "chatgpt");
    if (mode === "apikey") return typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()
      ? { source: "codex-auth-file", mode: "apikey", plan: null } : unknown();
    // External, keyring and host-owned credentials cannot be established by this file projection.
    if (mode !== "chatgpt") return unknown();
    const tokens = object(auth.tokens), id = claims(tokens.id_token), access = claims(tokens.access_token);
    if (!id || !access || typeof tokens.refresh_token !== "string" || !tokens.refresh_token
      || typeof auth.last_refresh !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(auth.last_refresh) || !Number.isFinite(Date.parse(auth.last_refresh))
      || tokens.account_id != null && typeof tokens.account_id !== "string"
      || !Number.isSafeInteger(access.exp) || access.exp * 1000 > 8.64e15 || access.exp * 1000 <= now + 5 * 60_000) return unknown();
    let selected = object(id["https://api.openai.com/auth"]);
    const current = object(access["https://api.openai.com/auth"]), account = tokens.account_id ?? null;
    // The retained ID token may describe a previous workspace. Match native's account/user
    // equality before taking the current access-token plan; an unresolved mismatch stays blocked.
    if (account !== (selected.chatgpt_account_id ?? null)) {
      if (account !== (current.chatgpt_account_id ?? null)
        || (current.chatgpt_user_id ?? current.user_id ?? null) !== (selected.chatgpt_user_id ?? selected.user_id ?? null)) return unknown();
      selected = current;
    }
    const plan = selected.chatgpt_plan_type;
    if (selected.chatgpt_account_is_fedramp === true) return { source: "codex-auth-file", mode: "chatgpt", plan: "managed" };
    return { source: "codex-auth-file", mode: "chatgpt", plan: ordinary.has(plan) ? "ordinary" : managed.has(plan) ? "managed" : "unknown" };
  } catch { return unknown(); }
}

export function sourceAccountMetadataValid(value: unknown): value is SourceNativeAccount {
  const v = object(value);
  return Object.keys(v).length === 3 && v.source === "codex-auth-file"
    && (["none", "apikey"].includes(v.mode) ? v.plan === null : v.mode === "chatgpt" ? ["ordinary", "managed", "unknown"].includes(v.plan) : v.mode === "unknown" && v.plan === "unknown");
}

/** Boolean-only private check, including escaped/percent/base64/hex spellings used by the existing
 * held-secret scanner. The credential strings and matcher exist only for this bounded call. */
export function sourceAccountContainsSecret(bytes: Uint8Array, contents: Iterable<string>, runtime?: SourceRuntime): boolean {
  const privateStore = runtime !== undefined && sourceRuntimeProtocol(runtime) === "pi-settings";
  if (bytes.length > 65_536) return privateStore; // Codex's separate account projection blocks oversized input.
  const values: string[] = [];
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (privateStore && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) return true;
    const pending: { value: unknown; parent: string }[] = [{ value: parsed, parent: "" }];
    for (let count = 0; pending.length; count++) {
      if (count > 10_000) return true;
      const { value, parent } = pending.pop()!;
      if (!value || typeof value !== "object") continue;
      for (const [key, child] of Object.entries(value)) {
        const piSecret = privateStore && (parent === "env" || /^(?:access|refresh|accessToken|refreshToken|clientSecret|codeVerifier|verifier)$/i.test(key));
        if (typeof child === "string" && child && (keyShaped(key) || piSecret)) values.push(child);
        else if (child && typeof child === "object") pending.push({ value: child, parent: key });
      }
    }
    const matches = valueMatcher(values);
    for (const content of contents) if (values.some(value => content.includes(value) || content.includes(JSON.stringify(value).slice(1, -1))) || matches(content)) return true;
    return false;
  } catch { return privateStore; } // Codex's separate account projection blocks malformed input.
}
