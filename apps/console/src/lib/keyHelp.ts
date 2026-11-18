import { ANTHROPIC_KEY_CREDITS } from "@/lib/claudeLogin";

/** Where to get a model provider's key, what one looks like, and what its row says beside it (`note`), by the served key
 *  row's `id` (GET /v2/settings/tool-keys `keys[].id`, which for a model key is serve's MODEL_KEYS id: anthropic, openai,
 *  openrouter). A provider not here gets none of them: the form shows its variable's name alone, as before. The shapes
 *  are hints for the eye only, never checked. */
export const MODEL_KEY_HELP: Readonly<Record<string, { url: string; placeholder: string; note?: string }>> = {
  anthropic: { url: "https://console.anthropic.com/settings/keys", placeholder: "sk-ant-…", note: ANTHROPIC_KEY_CREDITS },
  openai: { url: "https://platform.openai.com/api-keys", placeholder: "sk-…" },
  openrouter: { url: "https://openrouter.ai/keys", placeholder: "sk-or-…" },
};

/** `id`'s help, or undefined for a provider the console has no page for. */
export const keyHelp = (id: string) => (Object.prototype.hasOwnProperty.call(MODEL_KEY_HELP, id) ? MODEL_KEY_HELP[id] : undefined);
